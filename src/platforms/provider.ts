import type {
  AuthStatus,
  CatalogSection,
  PlatformId,
  PlaylistRef,
  SearchResult,
  StreamRef,
  Track,
} from '../types.js';

/**
 * Platform abstraction.
 *
 * The extension is being built to serve several music services from one UI, so
 * everything platform-specific lives behind this interface and nothing above it
 * may mention VK. VK is the only implementation today; Spotify and YouTube are
 * planned and need no changes to the popup or the player when they land.
 *
 * Deliberate design choices:
 *  - `Track.key` is globally unique (`<platform>:<native id>`) so a queue can
 *    hold tracks from different services, and so persisted state never depends
 *    on one platform's id shape.
 *  - `resolve()` returns a StreamRef rather than a bare URL: YouTube needs a
 *    time-limited, sometimes separate audio/video stream, and Spotify streams
 *    through its own SDK rather than a fetchable URL. A plain string would have
 *    to be widened later, breaking every caller.
 *  - `capabilities` lets the UI hide what a platform cannot do instead of
 *    offering buttons that silently fail.
 */

/** Per-platform feature flags the UI reads to decide what to render. */
export interface ProviderCapabilities {
  /** Direct playable URL available without the platform's own SDK. */
  directStream: boolean;
  /** Track list can be paginated beyond the first page. */
  paging: boolean;
  /** Server-side search. */
  search: boolean;
  /** The account's own saved tracks. */
  myTracks: boolean;
  /** Playlists/albums can be enumerated. */
  playlists: boolean;
  /** Personalised recommendations or an endless mix. */
  recommendations: boolean;
  /** The platform can tell us a track is not playable at all. */
  restrictionFlags: boolean;
  /** Downloading the audio is permitted by the platform's own terms. */
  downloadable: boolean;
}

export interface MusicProvider {
  readonly id: PlatformId;
  /** Human name for the source picker. */
  readonly label: string;
  readonly capabilities: ProviderCapabilities;

  /** Whether the user is signed in and the session is usable. */
  auth(): Promise<AuthStatus>;

  /** The signed-in account's own tracks (favourites / library). */
  myTracks(limit?: number, offset?: number): Promise<Track[]>;

  /** The account's playlists or albums. */
  playlists(): Promise<PlaylistRef[]>;

  /** Tracks inside one playlist. */
  playlistTracks(ref: PlaylistRef): Promise<Track[]>;

  /** Server-side search. */
  search(query: string): Promise<SearchResult>;

  /** Personalised mix; empty when the platform has no equivalent. */
  recommendations(limit?: number): Promise<Track[]>;

  /** Navigable catalogue sections, when the platform has a catalogue. */
  sections(): Promise<CatalogSection[]>;

  /** Tracks for one catalogue section. */
  sectionTracks(sectionId: string): Promise<Track[]>;

  /** Obtain a playable stream for a track, as fresh as possible. */
  resolve(track: Track): Promise<StreamRef>;

  /** Resolve several tracks at once where the platform supports batching. */
  resolveMany(tracks: Track[]): Promise<Record<string, StreamRef>>;

  /**
   * Add/remove a track from the account's library. Optional: the UI hides the
   * control when a platform cannot do it, rather than showing a dead button.
   */
  setLiked?(track: Track, liked: boolean): Promise<void>;
}

/** Build the globally unique key for a track on a platform. */
export function trackKey(platform: PlatformId, nativeId: string): string {
  return `${platform}:${nativeId}`;
}

/** Split a global key back into its platform and native id. */
export function parseTrackKey(key: string): { platform: PlatformId; nativeId: string } {
  const i = key.indexOf(':');
  if (i < 0) return { platform: 'vk', nativeId: key };
  return {
    platform: key.slice(0, i) as PlatformId,
    nativeId: key.slice(i + 1),
  };
}
