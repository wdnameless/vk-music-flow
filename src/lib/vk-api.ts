import type { VkApiResponse, VkAudio, VkPlaylist, VkToken } from '../types.js';
import { VK_API_VERSION, clearToken, getToken } from './vk-auth.js';

/**
 * Thin client for `api.vk.ru/method`.
 *
 * Measured against the live API:
 *  - Every method is POSTed as form-encoded `access_token` + `v` (+ params).
 *  - `audio.get` / `audio.getById` return metadata only — `url` is `""`. VK no
 *    longer serves playable links through its API, so the player and the
 *    downloader both have to obtain a stream URL another way (see resolve.ts).
 *  - Errors come back as `{ error: { error_code, error_msg } }` with HTTP 200,
 *    so an HTTP-status check alone is not enough; error_code 5 means the token
 *    died and must be re-minted.
 *
 * `Origin` is injected by our declarativeNetRequest rules, not here — it is a
 * forbidden fetch header.
 */

const API_BASE = 'https://api.vk.ru/method';
const REQUEST_TIMEOUT_MS = 20000;
/** VK: 5 = auth failed / invalid token. */
const ERR_AUTH = 5;
const ERR_TOO_MANY = 6;
const ERR_FLOOD = 9;
const MAX_RETRIES = 3;

/** Hosts the API talks to; used to keep API traffic on the selected proxy. */
export const VK_API_HOSTS: readonly string[] = ['api.vk.ru', 'web.api.vk.ru'];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Error code carried by a VK error envelope, when present. */
function errorCode(err: unknown): number | null {
  const e = err as { error_code?: unknown } | null;
  const n = Number(e?.error_code);
  return Number.isFinite(n) ? n : null;
}

/**
 * Call one VK API method, retrying the transient failures VK reports in-band
 * (too many requests / flood) and re-minting the token once when it expires.
 */
export async function vkCall<T>(
  method: string,
  params: Record<string, string | number | undefined> = {},
  opts: { token?: VkToken | null; retries?: number } = {},
): Promise<VkApiResponse<T>> {
  let token = opts.token ?? (await getToken());
  if (!token) {
    return {
      ok: false,
      data: null,
      error: { error_msg: 'not signed in to VK' },
      authFailure: true,
    };
  }

  const max = opts.retries ?? MAX_RETRIES;
  for (let attempt = 0; attempt <= max; attempt++) {
    const body = new URLSearchParams({ access_token: token.access_token, v: VK_API_VERSION });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') body.set(k, String(v));
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    let json: { response?: T; error?: Record<string, unknown> } | null;
    try {
      const r = await fetch(`${API_BASE}/${method}`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!r.ok) {
        // Transport-level failure: back off and retry.
        if (attempt < max) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        return { ok: false, data: null, error: { error_msg: `HTTP ${r.status}` }, authFailure: false };
      }
      json = (await r.json()) as { response?: T; error?: Record<string, unknown> };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < max) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return { ok: false, data: null, error: { error_msg: /abort/i.test(msg) ? 'timeout' : msg }, authFailure: false };
    } finally {
      clearTimeout(timer);
    }

    if (json.error) {
      const code = errorCode(json.error);
      if (code === ERR_AUTH) {
        // Mint once more, then give up — otherwise a bad session loops forever.
        if (attempt === 0) {
          await clearToken();
          const fresh = await getToken(true);
          if (fresh) {
            token = fresh;
            continue;
          }
        }
        return { ok: false, data: null, error: json.error, authFailure: true };
      }
      if ((code === ERR_TOO_MANY || code === ERR_FLOOD) && attempt < max) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return { ok: false, data: null, error: json.error, authFailure: false };
    }
    return { ok: true, data: (json.response ?? null) as T, error: null, authFailure: false };
  }
  return { ok: false, data: null, error: { error_msg: 'retries exhausted' }, authFailure: false };
}

/* ------------------------------------------------------------------ */
/* High-level helpers                                                  */
/* ------------------------------------------------------------------ */

/** The signed-in user's own tracks. */
export async function getMyAudios(ownerId: number, count = 50, offset = 0): Promise<VkAudio[]> {
  const r = await vkCall<{ count: number; items: VkAudio[] }>('audio.get', {
    owner_id: ownerId,
    count,
    offset,
  });
  return r.ok ? (r.data?.items ?? []) : [];
}

/**
 * Fetch tracks by explicit `owner_id`/`id`/`access_key` triples.
 *
 * VK caps this at a few hundred ids per call and wants them comma-separated as
 * `<owner>_<id>[_<access_key>]`.
 */
export async function getAudiosById(
  triples: { owner_id: number; id: number; access_key?: string }[],
): Promise<VkAudio[]> {
  if (!triples.length) return [];
  const audios = triples
    .map((t) => `${t.owner_id}_${t.id}${t.access_key ? `_${t.access_key}` : ''}`)
    .join(',');
  const r = await vkCall<VkAudio[]>('audio.getById', { audios });
  return r.ok ? (r.data ?? []) : [];
}

/** The user's own playlists/albums. */
export async function getPlaylists(ownerId: number): Promise<VkPlaylist[]> {
  const r = await vkCall<{ count: number; items: VkPlaylist[] }>('audio.getPlaylists', {
    owner_id: ownerId,
    count: 100,
  });
  return r.ok ? (r.data?.items ?? []) : [];
}

/** Tracks inside one playlist. */
export async function getPlaylistAudios(
  ownerId: number,
  playlistId: number,
  accessKey?: string,
): Promise<VkAudio[]> {
  const r = await vkCall<{ count: number; items: VkAudio[] }>('audio.get', {
    owner_id: ownerId,
    album_id: playlistId,
    access_key: accessKey,
    count: 200,
  });
  return r.ok ? (r.data?.items ?? []) : [];
}

/** Search the music catalog. */
export async function searchAudios(q: string, count = 30): Promise<VkAudio[]> {
  const r = await vkCall<{ count: number; items: VkAudio[] }>('audio.search', { q, count });
  return r.ok ? (r.data?.items ?? []) : [];
}

/**
 * Tracks VK refuses to hand a stream URL for.
 *
 * Measured on a 117-track sample: every track WITHOUT `content_restricted`
 * carried a playable `url`, while every one with `content_restricted` 2 or 3
 * carried none — in `audio.get`, in `audio.getById` and without `access_key`.
 * It is a property of the track, not of the request, so retrying is pointless.
 */
export function isRestricted(a: VkAudio | null): boolean {
  const cr = a?.content_restricted;
  return cr === 2 || cr === 3;
}

/**
 * Resolve playable stream URLs for specific tracks.
 *
 * `audio.getById` returns a real `url` for every unrestricted track (verified:
 * identical URL across repeated `get`/`getById` calls), so the downloader does
 * NOT need the network hook to obtain links. Restricted tracks come back with
 * an empty `url` and are reported separately rather than retried.
 *
 * Call this at download time, not ahead of it: VK stream URLs expire.
 */
export async function resolveStreamUrls(
  triples: { owner_id: number; id: number; access_key?: string }[],
): Promise<{
  urls: Record<string, string>;
  restricted: string[];
  missing: string[];
}> {
  const urls: Record<string, string> = {};
  const restricted: string[] = [];
  const missing: string[] = [];
  const CHUNK = 50;
  for (let i = 0; i < triples.length; i += CHUNK) {
    const batch = triples.slice(i, i + CHUNK);
    const items = await getAudiosById(batch);
    const byKey = new Map(items.map((a) => [`${a.owner_id}_${a.id}`, a]));
    for (const t of batch) {
      const key = `${t.owner_id}_${t.id}`;
      const a = byKey.get(key);
      if (!a) missing.push(key);
      else if (a.url) urls[key] = a.url;
      else if (isRestricted(a)) restricted.push(key);
      else missing.push(key);
    }
  }
  return { urls, restricted, missing };
}

/** Recommendations derived from the user's own listening. */
export async function getRecommendations(ownerId: number, count = 30): Promise<VkAudio[]> {
  const r = await vkCall<{ items: VkAudio[] }>('audio.getRecommendations', {
    user_id: ownerId,
    count,
  });
  return r.ok ? (r.data?.items ?? []) : [];
}

/** Popular tracks. */
export async function getPopular(count = 30): Promise<VkAudio[]> {
  const r = await vkCall<{ items: VkAudio[] }>('audio.getPopular', { count, only_original: 0 });
  return r.ok ? (r.data?.items ?? []) : [];
}

/** Auth state for the UI. */
export async function authState(): Promise<{
  signedIn: boolean;
  userId: number | null;
  expiresAt: number | null;
  reason: string | null;
}> {
  const t = await getToken();
  if (!t) {
    return { signedIn: false, userId: null, expiresAt: null, reason: 'Не удалось войти в VK — проверь вход на vk.ru и прокси.' };
  }
  return { signedIn: true, userId: t.user_id, expiresAt: t.expires, reason: null };
}

/** Hosts the API client touches, for proxy routing decisions. */
export function apiHosts(): readonly string[] {
  return VK_API_HOSTS;
}
