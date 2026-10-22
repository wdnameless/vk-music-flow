import type {
  AudioMeta,
  AuthStatus,
  CatalogSection,
  PlaylistRef,
  PlatformId,
  SearchResult,
  StreamRef,
  Track,
  VkAudio,
} from '../types.js';
import type { ProviderCapabilities } from './provider.js';
import { trackKey } from './provider.js';
import type { MusicProvider } from './provider.js';
import { audioMetaFromVk } from '../lib/vk-track.js';
import {
  addAudio,
  authState,
  deleteAudio,
  getCatalogSection,
  getCatalogSections,
  getMyAudios,
  getPlaylistAudios,
  getPlaylists,
  getStreamMix,
  isRestricted,
  resolveStreamUrls,
  searchAudios,
  vkCall,
} from '../lib/vk-api.js';

/**
 * VK implementation of the platform contract.
 *
 * Everything VK-specific about *shape* lives here: id formats, the access_key
 * needed for a later re-resolve, the artwork map, and the `content_restricted`
 * flag. Above this file a track is just a Track.
 *
 * Measured behaviour this encodes (see docs/vknext-recon.md):
 *  - `audio.getById` returns a real, stable stream URL for every track VK does
 *    not mark restricted, so download/playback do not need the page hook.
 *  - `content_restricted` 2/3 means no endpoint will ever return a URL.
 *  - `audio.getPopular` and the radio/`getStreamMix` methods are closed
 *    (error 3), so recommendations stand in for the endless mix.
 */

const VK_CAPABILITIES: ProviderCapabilities = {
  directStream: true,
  paging: true,
  search: true,
  myTracks: true,
  playlists: true,
  recommendations: true,
  restrictionFlags: true,
  downloadable: true,
};

/** Convert a VK API track into the platform-neutral shape. */
export function toTrack(a: VkAudio): Track {
  const nativeId = `${a.owner_id}_${a.id}`;
  return {
    key: trackKey('vk', nativeId),
    platform: 'vk',
    nativeId,
    artist: a.artist || a.main_artists?.[0]?.name || '',
    title: a.title ?? '',
    album: a.album?.title ?? '',
    duration: typeof a.duration === 'number' ? a.duration : null,
    cover: biggestCover(a.thumb),
    restricted: isRestricted(a),
    resolveToken: a.access_key,
  };
}

/** Largest artwork from VK's flat `photo_*` map. */
function biggestCover(thumb: Record<string, string> | undefined): string | null {
  if (!thumb) return null;
  let best: { px: number; url: string } | null = null;
  for (const [k, v] of Object.entries(thumb)) {
    if (!/^photo_\d+$/.test(k) || typeof v !== 'string' || !v) continue;
    const px = Number(k.slice(6));
    if (!best || px > best.px) best = { px, url: v };
  }
  return best?.url ?? null;
}

/** Split `<owner>_<id>` back into the parts VK's API wants. */
function splitNativeId(nativeId: string): { owner: number; id: number } | null {
  const m = /^(-?\d+)_(\d+)$/.exec(nativeId);
  if (!m) return null;
  return { owner: Number(m[1]), id: Number(m[2]) };
}

class VkProvider implements MusicProvider {
  readonly id: PlatformId = 'vk';
  readonly label = 'ВКонтакте';
  readonly capabilities = VK_CAPABILITIES;

  private async accountId(): Promise<number | null> {
    const st = await authState();
    return st.signedIn && st.userId ? st.userId : null;
  }

  async auth(): Promise<AuthStatus> {
    const st = await authState();
    return {
      platform: 'vk',
      signedIn: st.signedIn,
      account: st.userId ? String(st.userId) : null,
      reason: st.reason,
    };
  }

  async myTracks(limit = 100, offset = 0): Promise<Track[]> {
    const id = await this.accountId();
    if (!id) return [];
    return (await getMyAudios(id, limit, offset)).map(toTrack);
  }

  async playlists(): Promise<PlaylistRef[]> {
    const id = await this.accountId();
    if (!id) return [];
    const items = await getPlaylists(id);
    return items.map((p) => ({
      key: trackKey('vk', `${p.owner_id}_${p.id}`),
      platform: 'vk' as const,
      nativeId: `${p.owner_id}_${p.id}`,
      title: p.title,
      trackCount: typeof p.count === 'number' ? p.count : null,
      cover: biggestCover(p.thumb),
      resolveToken: p.access_key,
    }));
  }

  async playlistTracks(ref: PlaylistRef): Promise<Track[]> {
    const parts = splitNativeId(ref.nativeId);
    if (!parts) return [];
    const items = await getPlaylistAudios(parts.owner, parts.id, ref.resolveToken);
    return items.map((a) => ({ ...toTrack(a), collectionId: ref.key }));
  }

  async search(query: string): Promise<SearchResult> {
    return { query, tracks: (await searchAudios(query)).map(toTrack) };
  }

  async recommendations(limit = 50): Promise<Track[]> {
    const id = await this.accountId();
    if (!id) return [];
    // The stream-mix endpoint needs an id VK no longer hands out, so the mix
    // helper falls back to recommendations internally.
    return (await getStreamMix(id, limit)).map(toTrack);
  }

  async sections(): Promise<CatalogSection[]> {
    const id = await this.accountId();
    if (!id) return [];
    return await getCatalogSections(id);
  }

  async sectionTracks(sectionId: string): Promise<Track[]> {
    const blocks = await getCatalogSection(sectionId);
    return blocks.flatMap((b) => b.audios).map(toTrack);
  }

  async resolve(track: Track): Promise<StreamRef> {
    const parts = splitNativeId(track.nativeId);
    if (!parts) throw new Error('некорректный идентификатор трека');
    const r = await resolveStreamUrls([
      { owner_id: parts.owner, id: parts.id, access_key: track.resolveToken },
    ]);
    const url = r.urls[`${parts.owner}_${parts.id}`];
    if (!url) {
      if (track.restricted || r.restricted.length) {
        throw new Error('трек недоступен для воспроизведения (ограничение VK)');
      }
      throw new Error('не удалось получить ссылку на трек');
    }
    return { url, hls: /\.m3u8/i.test(url), via: 'api' };
  }

  async resolveMany(tracks: Track[]): Promise<Record<string, StreamRef>> {
    const triples: { owner: number; id: number; access_key?: string; key: string }[] = [];
    for (const t of tracks) {
      const parts = splitNativeId(t.nativeId);
      if (parts) triples.push({ ...parts, access_key: t.resolveToken, key: t.key });
    }
    if (!triples.length) return {};
    const r = await resolveStreamUrls(
      triples.map((t) => ({ owner_id: t.owner, id: t.id, access_key: t.access_key })),
    );
    const out: Record<string, StreamRef> = {};
    for (const t of triples) {
      const url = r.urls[`${t.owner}_${t.id}`];
      if (url) out[t.key] = { url, hls: /\.m3u8/i.test(url), via: 'api' };
    }
    return out;
  }

  /**
   * VK's catalog entry is exactly what `audioMetaFromVk` produces, so the
   * downloader reuses one conversion rather than a second, drifting copy.
   */
  catalogEntry(track: Track): AudioMeta | null {
    const parts = splitNativeId(track.nativeId);
    if (!parts) return null;
    return audioMetaFromVk({
      id: parts.id,
      owner_id: parts.owner,
      artist: track.artist,
      title: track.title,
      album: track.album ? { title: track.album } : undefined,
      duration: track.duration ?? undefined,
      access_key: track.resolveToken,
      thumb: track.cover ? { src: track.cover } : undefined,
      content_restricted: track.restricted ? 3 : undefined,
    });
  }

  async setLiked(track: Track, liked: boolean): Promise<void> {
    const parts = splitNativeId(track.nativeId);
    if (!parts) throw new Error('некорректный идентификатор трека');
    if (liked) await addAudio(parts.owner, parts.id);
    else await deleteAudio(parts.owner, parts.id);
  }

  /** Lyrics: VK's own endpoint is unreachable (needs a lyrics_id VK no longer
   *  returns), so this is exposed for the integrations layer to fall back. */
  async rawCall<T = unknown>(method: string, params: Record<string, string | number | undefined>) {
    return await vkCall<T>(method, params);
  }
}

/** The single VK provider instance. */
export const vkProvider = new VkProvider();
