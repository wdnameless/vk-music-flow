import type { AudioMeta, VkAudio } from '../types.js';

/**
 * Conversion from VK API track objects into the catalog shape used by the
 * downloader.
 *
 * The catalog entry must be self-sufficient for a later download: it keeps
 * `access_key` (needed to re-resolve a stream URL, since VK links expire) and
 * `restricted` (so an undownloadable track fails terminally instead of being
 * retried forever).
 */

/** Best artwork URL from VK's flat `photo_*` thumbnail map (largest first). */
export function coverUrls(thumb: Record<string, string> | undefined): string[] {
  if (!thumb || typeof thumb !== 'object') return [];
  const sized = Object.entries(thumb)
    .filter(([k, v]) => /^photo_\d+$/.test(k) && typeof v === 'string' && v)
    .map(([k, v]) => [Number(k.slice(6)), v as string] as const)
    .sort((a, b) => b[0] - a[0]);
  if (sized.length) return sized.map(([, v]) => v);
  // Some responses use a bare `src` instead of the sized map.
  const src = (thumb as { src?: unknown }).src;
  return typeof src === 'string' && src ? [src] : [];
}

/** Artist name, falling back to VK's `main_artists` list. */
export function artistOf(a: VkAudio): string {
  if (a.artist) return String(a.artist).trim();
  const main = a.main_artists?.[0]?.name;
  return typeof main === 'string' ? main.trim() : '';
}

/**
 * Convert one API track into a catalog entry.
 *
 * `urls` is deliberately left empty: links from VK expire, so the downloader
 * resolves a fresh one at download time via `access_key`.
 */
export function audioMetaFromVk(a: VkAudio): AudioMeta | null {
  const id = a.id;
  const owner = a.owner_id;
  if (id === undefined || owner === undefined || id === null || owner === null) return null;
  const artist = artistOf(a);
  const title = String(a.title ?? '').trim();
  if (!artist && !title) return null;
  return {
    key: `${owner}_${id}`,
    id: String(id),
    owner: String(owner),
    artist,
    title,
    album: a.album?.title ?? '',
    year: null,
    duration: typeof a.duration === 'number' ? a.duration : null,
    urls: [],
    covers: coverUrls(a.thumb),
    access_key: a.access_key,
    restricted: a.content_restricted,
    source: 'api',
  };
}

/** Convert a batch, dropping entries VK returned in an unusable shape. */
export function audioMetaListFromVk(items: VkAudio[]): AudioMeta[] {
  const out: AudioMeta[] = [];
  for (const it of items) {
    const m = audioMetaFromVk(it);
    if (m) out.push(m);
  }
  return out;
}
