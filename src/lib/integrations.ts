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

/** Split collaboration artists into individual normalized tokens. */
export function splitArtistTokens(artist: string): string[] {
  const parts = artist.split(
    /(?:[\n,;&+•·|~()\[\]{}]|\s[-–—/x×]\s|\b(?:feat\.?|ft\.?|featuring|vs\.?|with)\b)/iu,
  );
  return parts.map((s) => normalizeName(s)).filter((s) => s.length > 0);
}

/** True when the artist is on the block list. */
export function isArtistBlocked(artist: string, rules: BlockRules): boolean {
  if (!artist || !artist.trim()) return false;
  const a = normalizeName(artist);
  if (!a) return false;
  const tokens = splitArtistTokens(artist);
  return rules.blockedArtists.some((b) => {
    const n = normalizeName(b);
    if (!n) return false;
    return a === n || tokens.includes(n);
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
