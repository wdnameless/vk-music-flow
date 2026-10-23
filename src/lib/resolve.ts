import type { AudioMeta } from '../types.js';
import { CaptchaNeededError, isRestricted, resolveStreamUrls } from './vk-api.js';

/**
 * Stream-URL resolution at download time.
 *
 * VK hands out a real `url` through `audio.getById` for every unrestricted
 * track (measured: 104/104 such tracks carried one, stable across repeated
 * calls), and stream URLs expire, so the downloader resolves immediately before
 * fetching rather than trusting whatever the catalog captured earlier.
 *
 * Tracks VK marks `content_restricted` (codes 2/3) carry no URL from ANY
 * endpoint — that is a property of the track, not of the request. For those the
 * caller may still try the page hook as a last resort (a track that plays in
 * the browser demonstrably has a URL somewhere), and only then fail terminally.
 */

/**
 * SSRF capsule: hosts the downloader may fetch (H3).
 *
 * Stream/segment/key URLs arrive from VK API responses and the page hook —
 * both attacker-influenced once the MAIN bridge is spoofed. Mirror of
 * manifest.json host_permissions; the SW asserts every fetch against it.
 */
export const ALLOWED_FETCH_HOSTS = [
  /(^|\.)vk\.com$/i,
  /(^|\.)vk\.ru$/i,
  /(^|\.)vk-cdn\.net$/i,
  /(^|\.)userapi\.com$/i,
  /(^|\.)mycdn\.me$/i,
  /(^|\.)vkuser\.net$/i,
  /(^|\.)vkuservideo\.net$/i,
  /(^|\.)vkusercontent\.ru$/i,
  /(^|\.)vkuseraudio\.ru$/i,
  /(^|\.)vkuserphoto\.ru$/i,
] as const;
export const MAX_SEGMENT_BYTES = 50 * 1024 * 1024;
export const MAX_TRACK_BYTES = 500 * 1024 * 1024;
export const MAX_HLS_DEPTH = 2;

/** True only for https URLs on an allowlisted CDN/API host. */
export function isAllowedFetchUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_FETCH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

/** Distinguishes "cannot ever work" from "try again later". */
export class RestrictedTrackError extends Error {
  constructor(message = 'трек недоступен для скачивания (ограничение VK)') {
    super(message);
    this.name = 'RestrictedTrackError';
  }
}
export interface ResolveOutcome {
  /** Fresh, playable URLs in preference order. */
  urls: string[];
  /** How the URLs were obtained, for diagnostics and UI copy. */
  via: 'api' | 'hook' | 'cached';
  /** True when VK flags the track as restricted. */
  restricted: boolean;
}

/**
 * Resolve fresh playable URLs for one catalog track.
 *
 * Order:
 *  1. VK API via `access_key` — authoritative and current.
 *  2. URLs already in the catalog (captured by the page hook) — a track that
 *     played in the browser has a usable link.
 *  3. If VK marks the track restricted and neither source produced anything,
 *     throw `RestrictedTrackError` so the queue stops retrying it.
 */
export async function resolveTrackUrls(a: AudioMeta): Promise<ResolveOutcome> {
  const restricted = isRestricted({ content_restricted: a.restricted });
  const cached = (a.urls || []).filter(
    (u) => /^https?:\/\//i.test(u) && !/vkuserphoto|\.jpe?g/i.test(u),
  );

  // Without an access_key VK will not return a usable URL for most tracks, so
  // asking anyway just adds a failed round trip per download. Prefer what the
  // page hook captured in that case.
  if (!a.access_key && cached.length) return { urls: cached, via: 'cached', restricted };

  // 1. API: authoritative and current, because VK stream URLs expire.
  const owner = Number(a.owner);
  const id = Number(a.id);
  if (Number.isFinite(owner) && Number.isFinite(id)) {
    try {
      const r = await resolveStreamUrls([{ owner_id: owner, id, access_key: a.access_key }]);
      const url = r.urls[`${owner}_${id}`];
      if (url) return { urls: [url], via: 'api', restricted: false };
    } catch (e) {
      // Captcha must surface, not fall through: cached links are dead too when
      // VK gates the account, and silent retries never solve a human challenge.
      if (e instanceof CaptchaNeededError) throw e;
      /* fall through to the hook-captured copy */
    }
  }

  // 2. Hook-captured URLs (a track that played in the page has a real link).
  if (cached.length) return { urls: cached, via: 'cached', restricted };

  // 3. Nothing usable: terminal when VK says restricted, retryable otherwise
  //    (an unrestricted track may simply have failed to resolve right now).
  if (restricted) throw new RestrictedTrackError();
  throw new Error('не удалось получить ссылку на трек');
}
