import type { BlockRules, LastfmAuth, LyricsResult } from '../types.js';

/**
 * Listening preferences and third-party integrations.
 *
 * Rules are matched case-insensitively on a normalized copy of the string, so
 * "AC/DC", "acdc" and "АС/DC" collapse the same way. Normalization strips
 * punctuation and diacritics rather than doing fuzzy matching: a blocklist that
 * guesses wrong is worse than one that misses.
 */

/** Normalize for comparison: lowercase, strip accents and non-alphanumerics. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

/** True when the artist is on the block list. */
export function isArtistBlocked(artist: string, rules: BlockRules): boolean {
  const a = normalizeName(artist);
  if (!a) return false;
  return rules.blockedArtists.some((b) => {
    const n = normalizeName(b);
    return n.length > 0 && (a === n || a.includes(n));
  });
}

/** True when the track has been disliked. */
export function isDisliked(ownerId: string, id: string, rules: BlockRules): boolean {
  return rules.disliked.includes(`${ownerId}_${id}`);
}

/**
 * Whether a track may play, and why not when it may not.
 *
 * Returns a reason so the UI can explain the skip instead of silently jumping,
 * which is what makes an automatic skip feel broken.
 */
export function skipReason(
  track: { owner: string; id: string; artist: string },
  rules: BlockRules,
): 'blocked-artist' | 'disliked' | null {
  if (isArtistBlocked(track.artist, rules)) return 'blocked-artist';
  if (isDisliked(track.owner, track.id, rules)) return 'disliked';
  return null;
}

/** Filter a queue down to the playable tracks, preserving order. */
export function filterPlayable<T extends { owner: string; id: string; artist: string }>(
  tracks: T[],
  rules: BlockRules,
): T[] {
  return tracks.filter((t) => skipReason(t, rules) === null);
}

/** Sanitize stored block rules (chrome.storage can hold anything). */
export function normalizeBlockRules(raw: unknown): BlockRules {
  const o = (raw ?? {}) as Partial<BlockRules>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
  return { blockedArtists: strings(o.blockedArtists), disliked: strings(o.disliked) };
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

/* ------------------------------------------------------------------ */
/* Lyrics                                                             */
/* ------------------------------------------------------------------ */

/**
 * Lyrics lookup.
 *
 * Measured: `audio.getLyrics` requires a `lyrics_id`, and VK no longer returns
 * that field from ANY endpoint — `audio.get`, `audio.getById` and `audio.search`
 * all came back without it across 20+ tracks (0/20 had it, and the method
 * answers error_code 100 for every parameter shape tried). The VK route is
 * therefore dead, not merely undocumented.
 *
 * `lyrics.ovh` is used instead: a public, key-less service with the same shape
 * for every track, which keeps this working without shipping a credential.
 */

const LYRICS_ENDPOINT = 'https://api.lyrics.ovh/v1';

export interface LyricsFetchResult {
  ok: boolean;
  lyrics: LyricsResult | null;
  error?: string;
}

/** Fetch lyrics for one track from the fallback provider. */
export async function fetchLyrics(artist: string, title: string): Promise<LyricsFetchResult> {
  if (!artist.trim() || !title.trim()) return { ok: false, lyrics: null, error: 'нет исполнителя или названия' };
  const url = `${LYRICS_ENDPOINT}/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.status === 404) return { ok: false, lyrics: null, error: 'текст не найден' };
    if (!r.ok) return { ok: false, lyrics: null, error: `HTTP ${r.status}` };
    const j = (await r.json()) as { lyrics?: string };
    const text = (j.lyrics ?? '').trim();
    if (!text) return { ok: false, lyrics: null, error: 'текст не найден' };
    return { ok: true, lyrics: { text } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, lyrics: null, error: /abort/i.test(msg) ? 'таймаут' : msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a VK `audio.getLyrics` response.
 *
 * Retained for the case where VK starts populating `lyrics_id` again; today it
 * is unreachable because that field is never returned.
 */
export function parseLyricsResponse(response: unknown): LyricsResult | null {
  const r = response as { lyrics?: { text?: string; lyrics_id?: number } } | null;
  const text = r?.lyrics?.text;
  if (typeof text !== 'string' || !text.trim()) return null;
  return { text: text.trim(), id: r?.lyrics?.lyrics_id };
}

/* ------------------------------------------------------------------ */
/* Last.fm scrobbling                                                 */
/* ------------------------------------------------------------------ */

const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';

/** Last.fm refuses to scrobble tracks shorter than this. */
export const MIN_SCROBBLE_SECONDS = 30;

/**
 * Whether a play should be scrobbled.
 *
 * Last.fm's own rule: a track counts once at least half its length or 4 minutes
 * has played, whichever comes first, and never under 30 seconds.
 */
export function shouldScrobble(
  playedSeconds: number,
  durationSeconds: number | null,
  hasAuth: boolean,
): boolean {
  if (!hasAuth) return false;
  if (playedSeconds < MIN_SCROBBLE_SECONDS) return false;
  if (!durationSeconds || durationSeconds <= 0) return playedSeconds >= MIN_SCROBBLE_SECONDS;
  const half = durationSeconds / 2;
  return playedSeconds >= Math.min(half, 240);
}

/** Signature Last.fm requires: md5 of sorted params + secret. */
export function apiSignature(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort();
  let s = '';
  for (const k of keys) s += k + params[k];
  return md5Hex(s + secret);
}

/**
 * Minimal MD5 (RFC 1321) — Last.fm's signature scheme mandates it, and WebCrypto
 * deliberately does not provide it.
 */
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

/** POST a signed call to Last.fm. Returns the raw JSON or null on failure. */
export async function lastfmCall(
  method: string,
  params: Record<string, string>,
  creds: { apiKey: string; secret: string; sessionKey?: string },
): Promise<{ ok: boolean; error?: string; raw?: unknown }> {
  const all: Record<string, string> = {
    method,
    api_key: creds.apiKey,
    ...params,
  };
  if (creds.sessionKey) all.sk = creds.sessionKey;
  all.api_sig = apiSignature(all, creds.secret);
  all.format = 'json';

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(LASTFM_API, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(all),
    });
    const j = (await r.json()) as { error?: number; message?: string };
    if (j.error) return { ok: false, error: j.message ?? `Last.fm error ${j.error}`, raw: j };
    return { ok: true, raw: j };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Report the currently playing track ("now playing"). */
export async function lastfmNowPlaying(
  track: { artist: string; title: string; duration?: number | null },
  creds: { apiKey: string; secret: string; sessionKey: string },
): Promise<{ ok: boolean; error?: string }> {
  const params: Record<string, string> = { artist: track.artist, track: track.title };
  if (track.duration) params.duration = String(Math.round(track.duration));
  return await lastfmCall('track.updateNowPlaying', params, creds);
}

/** Scrobble a completed play. */
export async function lastfmScrobble(
  track: { artist: string; title: string; duration?: number | null },
  startedAt: number,
  creds: { apiKey: string; secret: string; sessionKey: string },
): Promise<{ ok: boolean; error?: string }> {
  const params: Record<string, string> = {
    artist: track.artist,
    track: track.title,
    timestamp: String(Math.floor(startedAt / 1000)),
  };
  if (track.duration) params.duration = String(Math.round(track.duration));
  return await lastfmCall('track.scrobble', params, creds);
}
