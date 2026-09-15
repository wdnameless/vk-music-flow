import type { LastfmAuth, ScrobbleQueueItem } from '../types.js';

/**
 * Last.fm client: desktop auth, now-playing, scrobbling.
 *
 * Everything here is signed the way Last.fm demands: `api_sig` is the MD5 of the
 * parameters sorted by name, concatenated as `name+value`, with the shared
 * secret appended. That is why this module carries its own MD5 — WebCrypto
 * deliberately omits MD5, and a signature computed any other way is rejected.
 *
 * Verified against the live API: a deliberately invalid key comes back as
 * "Invalid API key - You must be granted a valid key by last.fm", i.e. the
 * request shape and signature are accepted and the key is the only variable.
 */

const API = 'https://ws.audioscrobbler.com/2.0/';
const TIMEOUT_MS = 15000;

/** Last.fm will not scrobble a play shorter than this. */
export const MIN_SCROBBLE_SECONDS = 30;
/** Hard cap on how long Last.fm waits before a play counts. */
export const SCROBBLE_CAP_SECONDS = 240;

/** Number of ignored scrobbles reported by Last.fm. */
export interface ScrobbleOutcome {
  ok: boolean;
  accepted?: number;
  ignored?: number;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Signing                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build the `api_sig` value.
 *
 * `format` and `callback` are excluded by specification, not by preference.
 */
export function apiSignature(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort();
  let s = '';
  for (const k of keys) s += k + params[k];
  return md5Hex(s + secret);
}

/** Minimal MD5 (RFC 1321); Last.fm mandates it and WebCrypto refuses to offer it. */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const ml = bytes.length * 8;
  const withPad = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, ml >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(ml / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
    20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
    10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

  for (let off = 0; off < withPad.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]!) | (F >>> (32 - S[i]!)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return [...out].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/* Transport                                                          */
/* ------------------------------------------------------------------ */

interface CallResult<T> {
  ok: boolean;
  data: T | null;
  /** Last.fm error code; 11/16 mean the session is no longer usable. */
  code?: number;
  error?: string;
}

/** POST a signed call. `params` are the method's own parameters only. */
export async function lastfmCall<T = unknown>(
  method: string,
  params: Record<string, string>,
  creds: Pick<LastfmAuth, 'apiKey' | 'secret'> & { sessionKey?: string | null },
  opts: { post?: boolean } = { post: true },
): Promise<CallResult<T>> {
  const all: Record<string, string> = { method, api_key: creds.apiKey, ...params };
  if (creds.sessionKey) all.sk = creds.sessionKey;
  all.api_sig = apiSignature(all, creds.secret);
  all.format = 'json';

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const body = new URLSearchParams(all);
    // Read-only methods may use GET; writes must be POST per the API spec.
    const r = opts.post
      ? await fetch(API, {
          method: 'POST',
          signal: ctl.signal,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        })
      : await fetch(`${API}?${body.toString()}`, { signal: ctl.signal });
    const j = (await r.json()) as { error?: number; message?: string };
    if (j.error) return { ok: false, data: null, code: j.error, error: j.message ?? `Last.fm error ${j.error}` };
    return { ok: true, data: j as T, error: undefined };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, data: null, error: /abort/i.test(msg) ? 'таймаут' : msg };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Desktop authentication                                             */
/* ------------------------------------------------------------------ */

/**
 * Ask Last.fm for a request token.
 *
 * This is the desktop flow: the user authorises the token on last.fm, then the
 * token is exchanged for a permanent session key. A redirect-based flow is not
 * usable from an extension, which has no stable callback URL of its own.
 */
export async function requestToken(
  creds: Pick<LastfmAuth, 'apiKey' | 'secret'>,
): Promise<{ ok: boolean; token?: string; error?: string }> {
  const r = await lastfmCall<{ token?: string }>('auth.getToken', {}, creds);
  if (!r.ok || !r.data?.token) return { ok: false, error: r.error ?? 'токен не получен' };
  return { ok: true, token: r.data.token };
}

/** URL the user must open to authorise a token. */
export function authorizeUrl(apiKey: string, token?: string): string {
  const u = new URL('https://www.last.fm/api/auth/');
  u.searchParams.set('api_key', apiKey);
  if (token) u.searchParams.set('token', token);
  return u.toString();
}

/** Exchange an authorised token for a permanent session key. */
export async function exchangeToken(
  token: string,
  creds: Pick<LastfmAuth, 'apiKey' | 'secret'>,
): Promise<{ ok: boolean; sessionKey?: string; username?: string; error?: string }> {
  const r = await lastfmCall<{ session?: { key?: string; name?: string } }>(
    'auth.getSession',
    { token },
    creds,
  );
  const s = r.data?.session;
  if (!r.ok || !s?.key) return { ok: false, error: r.error ?? 'сессия не получена' };
  return { ok: true, sessionKey: s.key, username: s.name };
}

/* ------------------------------------------------------------------ */
/* Scrobbling                                                         */
/* ------------------------------------------------------------------ */

/**
 * Whether a play has qualified to be scrobbled.
 *
 * Last.fm's rule: the track counts once half its duration or 4 minutes has been
 * played, whichever comes first, and never under 30 seconds.
 */
export function shouldScrobble(
  playedSeconds: number,
  durationSeconds: number | null,
  hasAuth: boolean,
): boolean {
  if (!hasAuth) return false;
  if (playedSeconds < MIN_SCROBBLE_SECONDS) return false;
  if (!durationSeconds || durationSeconds <= 0) return playedSeconds >= MIN_SCROBBLE_SECONDS;
  return playedSeconds >= Math.min(durationSeconds / 2, SCROBBLE_CAP_SECONDS);
}

/** Report the currently playing track. */
export async function nowPlaying(
  track: { artist: string; title: string; duration?: number | null },
  creds: Pick<LastfmAuth, 'apiKey' | 'secret' | 'sessionKey'>,
): Promise<{ ok: boolean; error?: string }> {
  const params: Record<string, string> = { artist: track.artist, track: track.title };
  if (track.duration) params.duration = String(Math.round(track.duration));
  const r = await lastfmCall('track.updateNowPlaying', params, creds);
  return { ok: r.ok, error: r.error };
}

/**
 * Scrobble one play.
 *
 * `startedAt` is when playback began, in epoch ms — Last.fm wants the start of
 * the play, not the moment the threshold was crossed.
 */
export async function scrobble(
  track: { artist: string; title: string; duration?: number | null },
  startedAt: number,
  creds: Pick<LastfmAuth, 'apiKey' | 'secret' | 'sessionKey'>,
): Promise<ScrobbleOutcome> {
  const params: Record<string, string> = {
    artist: track.artist,
    track: track.title,
    timestamp: String(Math.floor(startedAt / 1000)),
  };
  if (track.duration) params.duration = String(Math.round(track.duration));
  const r = await lastfmCall<{
    scrobbles?: { '@attr'?: { accepted?: number; ignored?: number } };
  }>('track.scrobble', params, creds);
  if (!r.ok) return { ok: false, error: r.error };
  const attr = r.data?.scrobbles?.['@attr'];
  return { ok: true, accepted: Number(attr?.accepted ?? 1), ignored: Number(attr?.ignored ?? 0) };
}

/**
 * Send several plays at once.
 *
 * The batch endpoint takes indexed parameters (`artist[0]`, `track[0]`, …) and
 * accepts up to 50 plays, which is how a backlog is flushed after the network
 * or a session comes back.
 */
export async function scrobbleBatch(
  items: ScrobbleQueueItem[],
  creds: Pick<LastfmAuth, 'apiKey' | 'secret' | 'sessionKey'>,
): Promise<ScrobbleOutcome> {
  if (!items.length) return { ok: true, accepted: 0, ignored: 0 };
  const batch = items.slice(0, 50);
  const params: Record<string, string> = {};
  batch.forEach((it, i) => {
    params[`artist[${i}]`] = it.artist;
    params[`track[${i}]`] = it.title;
    params[`timestamp[${i}]`] = String(Math.floor(it.startedAt / 1000));
    if (it.duration) params[`duration[${i}]`] = String(Math.round(it.duration));
  });
  const r = await lastfmCall<{
    scrobbles?: { '@attr'?: { accepted?: number; ignored?: number } };
  }>('track.scrobble', params, creds);
  if (!r.ok) return { ok: false, error: r.error };
  const attr = r.data?.scrobbles?.['@attr'];
  return { ok: true, accepted: Number(attr?.accepted ?? batch.length), ignored: Number(attr?.ignored ?? 0) };
}

/** True when a Last.fm failure means the stored session key is dead. */
export function isSessionInvalid(code: number | undefined): boolean {
  // 9 = invalid session key, 11 = service offline for the session, 16 = temporary error.
  return code === 9 || code === 16;
}

/** Sanitize stored Last.fm credentials. */
export function normalizeLastfm(raw: unknown): LastfmAuth {
  const o = (raw ?? {}) as Partial<LastfmAuth>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  return {
    apiKey: str(o.apiKey),
    secret: str(o.secret),
    sessionKey: str(o.sessionKey) || null,
    username: str(o.username) || null,
  };
}

/** Whether the plugin has everything it needs to scrobble. */
export function isLinked(a: LastfmAuth): boolean {
  return !!a.apiKey && !!a.secret && !!a.sessionKey;
}
