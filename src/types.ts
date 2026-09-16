// Shared typed contracts (Phase 0 structure + Phase 1 storage/queue additions).

/* ------------------------------------------------------------------ */
/* Wave 1 — network layer: proxy routing + header rules.              */
/*                                                                    */
/* Verified against a real MV3 service worker on the live VK profile: */
/*  - chrome.proxy.settings.set/get/clear exist in MV3 with the       */
/*    "proxy" permission; PAC routing is per-host (api.vk.ru went     */
/*    through the proxy while example.com stayed DIRECT).             */
/*  - VK refuses tabless auth from an extension origin with           */
/*    `{"type":"error","error_info":"wrong origin"}`; `Origin` is a   */
/*    forbidden fetch header, so declarativeNetRequest MUST spoof it. */
/* ------------------------------------------------------------------ */

export type ProxyScheme = 'http' | 'https' | 'socks4' | 'socks5';

/** One user-supplied proxy endpoint. */
export interface ProxyEntry {
  id: string;
  label: string;
  scheme: ProxyScheme;
  host: string;
  port: number;
  username?: string;
  password?: string;
  enabled: boolean;
  /** Last liveness probe result (epoch ms), null when never probed. */
  lastCheckTs?: number | null;
  lastCheckOk?: boolean | null;
}

export type ProxyRoutingMode =
  /** Direct connection, proxy ignored. */
  | 'off'
  /** Only VK hosts go through the proxy (default: keeps the rest of the browser untouched). */
  | 'vk-only'
  /** Everything goes through the proxy. */
  | 'all';

/** Persisted proxy configuration. */
export interface ProxySettings {
  mode: ProxyRoutingMode;
  entries: ProxyEntry[];
  /** id of the entry used when mode !== 'off'; null = first enabled entry. */
  activeId: string | null;
}

export const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  mode: 'vk-only',
  entries: [],
  activeId: null,
};

/** Hosts routed through the proxy in `vk-only` mode. */
export const VK_PROXY_HOSTS: readonly string[] = [
  'vk.com',
  'vk.ru',
  'login.vk.ru',
  'api.vk.ru',
  'web.api.vk.ru',
  'vk-cdn.net',
  'userapi.com',
  'mycdn.me',
  'vkuser.net',
  'vkuservideo.net',
  'vkusercontent.ru',
  'vkuseraudio.ru',
  'vkuserphoto.ru',
];

/** GET_PROXY_STATE / SET_PROXY_* response. */
export interface ProxyStateResult {
  ok: true;
  settings: ProxySettings;
  /** What Chromium currently has installed, as reported by chrome.proxy.settings.get. */
  applied: ProxyAppliedState;
}

export interface ProxyAppliedState {
  mode: ProxyRoutingMode;
  /** Host routed through the proxy, or null when direct. */
  proxyFor: string | null;
  error: string | null;
}

/** Proxy liveness probe outcome. */
export interface ProxyCheckResult {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Wave 2 — VK API layer.                                             */
/* ------------------------------------------------------------------ */

/** A minted VK API bearer (see lib/vk-auth.ts). */
export interface VkToken {
  access_token: string;
  user_id: number;
  /** Unix seconds. */
  expires: number;
}

/** Auth state the popup renders. */
export interface VkAuthState {
  signedIn: boolean;
  userId: number | null;
  expiresAt: number | null;
  /** Human-readable reason when signedIn === false. */
  reason: string | null;
}

/**
 * Uniform response for every catalog request, so the UI can render one shape
 * whether it asked for own tracks, a playlist, search or recommendations.
 */
export interface VkCatalogResult<T> {
  ok: boolean;
  items: T[];
  /** Present when ok === false (typically "not signed in to VK"). */
  reason?: string | null;
}

/** One track as returned by api.vk.ru/method (only fields we use). */
export interface VkAudio {
  id: number;
  owner_id: number;
  artist: string;
  title: string;
  duration?: number;
  access_key?: string;
  /** Usually "" — VK stopped serving playable URLs from the API. */
  url?: string;
  thumb?: Record<string, string>;
  album?: { id?: number; title?: string } | null;
  main_artists?: { name?: string }[];
  lyrics_id?: number;
  /**
   * VK's playback restriction marker. 2/3 mean the track has no stream URL at
   * all (measured: 13/13 such tracks returned an empty `url` from every
   * endpoint), so it can neither be played nor downloaded.
   */
  content_restricted?: number;
  /** Present on ads/promoted entries. */
  ads?: unknown;
  is_explicit?: boolean;
}

/** A playlist / album entry. */
export interface VkPlaylist {
  id: number;
  owner_id: number;
  title: string;
  count?: number;
  /** Present for community/album playlists. */
  access_key?: string;
  thumb?: Record<string, string>;
}

/** One navigable section of the VK music catalogue ("My music", "Radio", …). */
export interface VkCatalogSection {
  id: string;
  title: string;
}

/** One block inside a section (a titled shelf of tracks or playlists). */
export interface VkCatalogBlock {
  id: string;
  title: string;
  /** VK's block kind, e.g. `music_audios`, `music_playlists`, `none`. */
  type: string;
  /** Tracks when the block carries any; VK often returns them lazily. */
  audios: VkAudio[];
  playlists: VkPlaylist[];
}

/** Generic VK API envelope. */
export interface VkApiResponse<T> {
  ok: boolean;
  data: T | null;
  error: { error_code?: number; error_msg?: string; error_info?: string } | null;
  /** True when the failure looks like an expired/invalid token. */
  authFailure: boolean;
}

/* ------------------------------------------------------------------ */
/* Wave 2 — playback (offscreen document).                            */
/*                                                                    */
/* Measured: Chromium plays VK's AES-128 HLS directly in an           */
/* HTMLAudioElement (play() resolves, duration is real, currentTime   */
/* advances), so no HLS library is involved. An offscreen document is */
/* required because an MV3 worker has no HTMLMediaElement.           */
/* ------------------------------------------------------------------ */

/** One playable track in the player queue. */
export interface PlayerTrack {
  /** Catalog key, `<owner>_<id>`. */
  key: string;
  id: string;
  owner: string;
  artist: string;
  title: string;
  /** Freshly resolved stream URL (VK links expire). */
  url: string;
  duration: number | null;
  cover: string | null;
}

/**
 * Equalizer bands in Hz, shared by the player (which builds the filters) and the
 * UI (which renders one fader per band), so the two cannot drift apart.
 */
export const EQ_BANDS: readonly number[] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** One equalizer band state. */
export interface EqBand {
  hz: number;
  gain: number;
}

/** Player snapshot pushed to the UI. */
/** How the queue advances when a track ends. */
export type RepeatMode = 'off' | 'all' | 'one';

/* ------------------------------------------------------------------ */
/* Sound processing.                                                  */
/*                                                                    */
/* Everything here runs in the WebAudio graph of the offscreen        */
/* document, between the media element and the output.                */
/* ------------------------------------------------------------------ */

/** Loudness normalisation. `track` also covers albums: VK gives no album gain. */
export type LoudnessMode = 'off' | 'track';

export interface AudioFx {
  /** Target level in dBFS; -14 matches what streaming services use. */
  normalize: LoudnessMode;
  normalizeTargetDb: number;
  /** Seconds of overlap between tracks; 0 disables crossfade. */
  crossfadeSec: number;
  /** Night mode: gentle compression so quiet passages stay audible. */
  nightMode: boolean;
  /** How hard night mode works, 0..1. */
  nightAmount: number;
  /** Low-shelf boost in dB. */
  bassDb: number;
  /** Pre-gain in dB, applied before the limiter. */
  preampDb: number;
}

export const DEFAULT_AUDIO_FX: AudioFx = {
  normalize: 'track',
  normalizeTargetDb: -14,
  crossfadeSec: 0,
  nightMode: false,
  nightAmount: 0.5,
  bassDb: 0,
  preampDb: 0,
};

/**
 * Measured loudness of one track, cached so it is measured only once.
 *
 * Values are BS.1770: `lufs` is gated integrated loudness, `truePeakDb` the
 * over-sampled peak. The field names say which unit, because mixing the two up
 * is the classic way to get a normaliser that is 6 dB out.
 */
export interface LoudnessEntry {
  /** Gated integrated loudness, in LUFS. */
  lufs: number;
  /** True peak in dBFS. */
  truePeakDb: number;
  /** Crest factor (peak minus loudness) in dB; a rough "DR" figure. */
  drDb: number | null;
  /** When it was measured, so a future format change can invalidate the cache. */
  measuredAt: number;
}

export interface PlayerState {
  track: PlayerTrack | null;
  /** Position within the play order, i.e. a cursor into `order`. */
  index: number;
  total: number;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  eqEnabled: boolean;
  eqBands: EqBand[];
  /* Queue controls. The list and the play order are separate: shuffling
     permutes `order`, not `queue`, so turning shuffle off restores the user's
     own order and dragging stays meaningful while shuffled. */
  shuffle: boolean;
  repeat: RepeatMode;
  /** Effective normalisation gain for the current track, in dB. */
  normGainDb: number;
  /** Measured loudness of the current track, in LUFS, once known. */
  trackLufs: number | null;
  /** Measured true peak of the current track, in dBFS. */
  trackPeakDb: number | null;
  /** Output level for the meter, 0..1. */
  level: number;
  /** Per-channel levels, 0..1, for a stereo meter. */
  levels: [number, number];
  /** True for a moment after a full-scale sample, for the clip indicator. */
  clipped: boolean;
  /** Where audio is going, when a specific device is chosen. */
  outputDeviceId: string;
  outputDevices: { id: string; label: string }[];
  /** The queue in the user's order. */
  queue: PlayerTrack[];
  /** Play order as indices into `queue`. */
  order: number[];
}

/* ------------------------------------------------------------------ */
/* Wave 3 — listening preferences and integrations.                    */
/* ------------------------------------------------------------------ */

/** Block list / dislike state that the player consults before each track. */
export interface BlockRules {
  /** Artist names; matched case- and punctuation-insensitively. */
  blockedArtists: string[];
  /** Disliked tracks as `<owner>_<id>`. */
  disliked: string[];
}

export const DEFAULT_BLOCK_RULES: BlockRules = { blockedArtists: [], disliked: [] };

/** Lyrics lookup outcome. */
export interface LyricsResult {
  text: string;
  id?: number;
}

/** Last.fm credentials (session key obtained via desktop auth). */
export interface LastfmAuth {
  apiKey: string;
  secret: string;
  sessionKey: string | null;
  username: string | null;
}

/**
 * One play waiting to be scrobbled.
 *
 * Scrobbles are queued rather than sent inline: Last.fm is routinely unreachable
 * (it is blocked in some networks, exactly like VK here), and losing a play
 * because a request timed out is worse than sending it late. The queue is
 * persisted and flushed on the next opportunity.
 */
export interface ScrobbleQueueItem {
  artist: string;
  title: string;
  duration: number | null;
  /** Epoch ms when playback started. */
  startedAt: number;
}

/** A declarativeNetRequest rule owned by this extension (see lib/dnr.ts). */
export interface HeaderRule {
  id: number;
  urlFilter: string;
  headers: { name: string; value: string }[];
  /** Restrict to requests initiated by our own extension pages/worker. */
  ownOriginOnly?: boolean;
}

/* ------------------------------------------------------------------ */
/* Universal player — platform-neutral model.                         */
/*                                                                    */
/* VK is the only implementation today; Spotify and YouTube are       */
/* planned. Nothing above this layer may mention a specific service,  */
/* so adding one does not touch the popup or the player.              */
/* ------------------------------------------------------------------ */

export type PlatformId = 'vk' | 'spotify' | 'youtube';

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  vk: 'ВКонтакте',
  spotify: 'Spotify',
  youtube: 'YouTube',
};

/** A track as the UI and player see it, independent of the source service. */
export interface Track {
  /** Globally unique: `<platform>:<native id>`. */
  key: string;
  platform: PlatformId;
  /** Id within the platform, e.g. `-2001001383_127001383` for VK. */
  nativeId: string;
  artist: string;
  title: string;
  album: string;
  duration: number | null;
  cover: string | null;
  /** True when the platform reports the track as unplayable. */
  restricted: boolean;
  /**
   * Platform-specific handle needed to re-resolve a stream later (VK's
   * `access_key`). Kept opaque above this layer.
   */
  resolveToken?: string;
  /** The account's own playlist/album this track came from, when known. */
  collectionId?: string;
}

/** Which list the UI is asking a provider for. */
export type PlatformKind =
  | 'my-tracks'
  | 'playlists'
  | 'playlist'
  | 'recommendations'
  | 'sections'
  | 'section'
  | 'search';

/** A playlist or album the user can open. */
export interface PlaylistRef {
  key: string;
  platform: PlatformId;
  nativeId: string;
  title: string;
  trackCount: number | null;
  cover: string | null;
  /** Opaque handle the provider needs to list the tracks. */
  resolveToken?: string;
}

/** A navigable catalogue section ("My music", "Radio", …). */
export interface CatalogSection {
  id: string;
  title: string;
}

/** A fresh playable stream for a track. */
export interface StreamRef {
  /**
   * Direct URL when the platform exposes one. Empty for platforms that stream
   * through their own SDK (Spotify), which the player must handle.
   */
  url: string;
  /** MIME hint, when the platform provides one. */
  mime?: string;
  /** True when the URL is a manifest that must be assembled/decrypted. */
  hls?: boolean;
  /** Epoch ms after which the URL is expected to stop working. */
  expiresAt?: number;
  /**
   * Which source answered (fresh API call, cached copy, …), for diagnostics
   * and for the UI to explain a degraded result.
   */
  via?: 'api' | 'cached' | 'sdk';
}

/** Sign-in state for one platform. */
export interface AuthStatus {
  platform: PlatformId;
  signedIn: boolean;
  /** Account id/name when known. */
  account: string | null;
  /** Why sign-in is unavailable, when it is. */
  reason: string | null;
}

/** Search results plus the query that produced them. */
export interface SearchResult {
  query: string;
  tracks: Track[];
}

/** A harvested track object, produced by hook-main / collector / VK API, stored in the SW catalog. */
export interface AudioMeta {
  key: string;
  id: string;
  owner: string;
  artist: string;
  title: string;
  album: string;
  year: number | string | null;
  duration: number | string | null;
  urls: string[];
  covers: string[];
  /**
   * VK `access_key` for this track. Required to re-resolve a fresh stream URL
   * at download time, so it is persisted with the catalog entry.
   */
  access_key?: string;
  /**
   * VK's playback restriction marker (2/3 = no stream URL exists at all).
   * Carried through so the queue can fail it terminally instead of retrying.
   */
  restricted?: number;
  /** Where this entry came from: the VK API, or the page network hook. */
  source?: 'api' | 'hook' | 'dom';
}

/** One queued download job (playlist-relative). */
export interface QueueItem {
  key: string;
  pl: string;
  idx: number;
  w: number;
}

/** A queue item that failed, with error text and timestamp. */
export interface FailedItem extends QueueItem {
  error: string;
  ts: number;
}

/* ------------------------------------------------------------------ */
/* Phase 1 — minimal structural types for the File System Access API. */
/* Deliberately NOT augmenting lib.dom: Chromium ships these methods  */
/* while the DOM lib historically does not, and identical global      */
/* declarations risk "must have identical signatures" merge errors    */
/* across TS versions. Everything is used structurally via casts.     */
/* ------------------------------------------------------------------ */

/** Permission state as reported by query/requestPermission. */
export type FsPermissionStatus = 'granted' | 'prompt' | 'denied';

export interface FsWritableLike {
  write(data: Blob | Uint8Array | ArrayBuffer): Promise<void>;
  close(): Promise<void>;
}

export interface FileWriteHandle {
  createWritable(opts?: { mode?: 'create' | 'readwrite' }): Promise<FsWritableLike>;
}

/** Directory surface we rely on: child dirs/files + permission + name. */
export interface RootDirHandle {
  readonly name: string;
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<FsPermissionStatus>;
  requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<FsPermissionStatus>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<RootDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileWriteHandle>;
}

/** Result of a writeToRoot chain: final relative path + file handle. */
export interface WrittenFile {
  path: string;
  handle: FileWriteHandle;
}

/* ----------------------------------------------- */
/* Phase 1 — queue journal (persisted, resumable). */
/* ----------------------------------------------- */

export type JournalStatus = 'queued' | 'downloading' | 'done' | 'failed' | 'skipped';

/** One journal line: everything needed to re-hydrate a queue item. */
export interface JournalEntry extends QueueItem {
  status: JournalStatus;
  attempts: number;
  lastError: string | null;
  ts: number;
}

/** Persisted journal record (schema-tagged for future migrations). */
export interface JournalRecord {
  v: 1;
  items: Record<string, JournalEntry>;
}

export interface JournalCounts {
  queued: number;
  downloading: number;
  done: number;
  failed: number;
  skipped: number;
}

/** GET_JOURNAL response. */
export interface JournalResponse {
  ok: true;
  paused: boolean;
  counts: JournalCounts;
  entries: JournalEntry[];
}

/** GET_STORAGE_STATE / CLEAR_DIR / PICK_DIR_RESULT response. */
export interface StorageStateResult {
  mode: 'fsa' | 'downloads';
  rootName: string | null;
  /** 'none' = no folder handle persisted yet. */
  permission: FsPermissionStatus | 'none';
}

/** User-tunable download settings (persisted alongside the catalog). */
export interface Settings {
  conc: number;
  gapMs: number;
  baseDir: string;
  /** 'fsa' = write into the user-picked folder (File System Access API); 'downloads' = chrome.downloads. */
  storageMode: 'fsa' | 'downloads';
  /** Display name of the picked root directory (handle itself lives in IndexedDB). */
  rootName?: string;
  /** Named equalizer curves, band gains in the player's band order. */
  eqPresets?: Record<string, number[]>;
  /**
   * Player preferences. The offscreen document is torn down whenever playback
   * goes idle, so without these the volume jumped back to full and the
   * equalizer switched itself off on every new track.
   */
  playerVolume?: number;
  playerEqEnabled?: boolean;
  playerEqGains?: number[];
  /**
   * The play queue and its controls, without stream URLs (those expire). A
   * recreated offscreen document re-resolves each entry before restoring it.
   */
  playerQueue?: { key: string; id: string; owner: string; artist: string; title: string; duration: number | null; cover: string | null }[];
  playerQueueIndex?: number;
  playerShuffle?: boolean;
  playerRepeat?: RepeatMode;
  /** Sound processing settings. */
  audioFx?: AudioFx;
  /** Chosen audio output; empty means the system default. */
  outputDeviceId?: string;
  /**
   * Measured loudness per track key. Kept in the catalog rather than in memory
   * so a track is analysed once ever, not once per playback session.
   */
  loudness?: Record<string, LoudnessEntry>;
  // Phase 1 queue tuning (anti-ban / resilience):
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  minIntervalMs: number;
  jitterMs: number;
}

/** Single source of truth for defaults (SW + tests). */
export const DEFAULT_SETTINGS: Settings = {
  conc: 2,
  gapMs: 450,
  baseDir: 'VK Music',
  storageMode: 'downloads',
  maxAttempts: 3,
  baseBackoffMs: 1000,
  maxBackoffMs: 30000,
  minIntervalMs: 500,
  jitterMs: 250,
};

/** Full persisted service-worker state (S under key vmf_state_v1). */
export interface FlowState {
  audios: Record<string, AudioMeta>;
  lyrics: Record<string, string>;
  playlists: Record<string, string[]>;
  queue: QueueItem[];
  failed: FailedItem[];
  done: Record<string, number>;
  settings: Settings;
}

/** Slim, popup-facing projection of FlowState returned by GET_STATE. */
export interface StateSnapshot {
  playlists: Record<string, number>;
  queue: { pl: string; idx: number; a: { artist: string; title: string } | null }[];
  failed: { pl: string; err: string; a: { artist: string; title: string } | null }[];
  doneCount: number;
  settings: Settings;
  totalAudios: number;
  journal: JournalCounts;
  paused: boolean;
}

/** Runtime messages sent to the background service worker. */
export type RuntimeMessage =
  | { t: 'AUDIOS'; audios?: AudioMeta[]; pl?: string; scanning?: boolean }
  | { t: 'LYRICS'; map?: Record<string, string> }
  | { t: 'ENQUEUE'; names?: string[] }
  | { t: 'CANCEL' }
  | { t: 'RETRY_FAILED' }
  | { t: 'CLEAR_FAILED' }
  | { t: 'SETTINGS'; patch?: Partial<Settings> }
  | { t: 'RESET' }
  | { t: 'GET_STATE' }
  // Phase 1 slice A — storage:
  | { t: 'PICK_DIR_RESULT'; ok: boolean; rootName?: string; error?: string }
  | { t: 'GET_STORAGE_STATE' }
  | { t: 'CLEAR_DIR' }
  // Phase 1 slice B — queue control (CANCEL already existed above):
  | { t: 'PAUSE' }
  | { t: 'RESUME' }
  | { t: 'GET_JOURNAL' }
  // Wave 1 — proxy / network:
  | { t: 'GET_PROXY_STATE' }
  | { t: 'SET_PROXY_ENTRIES'; entries: ProxyEntry[] }
  | { t: 'SET_PROXY_MODE'; mode: ProxyRoutingMode }
  | { t: 'SET_PROXY_ACTIVE'; id: string | null }
  | { t: 'CHECK_PROXY'; id?: string }
  | { t: 'GET_DNR_STATE' }
  | { t: 'INSTALL_DNR' }
  // Wave 2 — VK session / catalog:
  | { t: 'GET_VK_AUTH' }
  | { t: 'VK_LOGIN' }
  | { t: 'VK_LOGOUT' }
  | { t: 'VK_MY_AUDIOS'; count?: number; offset?: number }
  | { t: 'VK_PLAYLISTS' }
  | { t: 'VK_PLAYLIST_AUDIOS'; ownerId: number; playlistId: number; accessKey?: string }
  | { t: 'VK_SEARCH'; q: string }
  | { t: 'VK_RECOMMENDATIONS' }
  /** Catalogue navigation: sections, then the blocks inside one section. */
  | { t: 'VK_SECTIONS' }
  | { t: 'VK_SECTION'; sectionId: string }
  /** Endless personalised mix ("Волна"). */
  | { t: 'VK_MIX' }
  /* Platform-neutral API (works for any registered provider): */
  | { t: 'P_LIST'; platform?: PlatformId; kind: PlatformKind; id?: string }
  | { t: 'P_PLATFORMS' }
  | { t: 'P_AUTH'; platform: PlatformId }
  | { t: 'P_RESOLVE'; keys: string[] }
  | { t: 'P_LIKE'; key: string; liked: boolean; track?: Track }
  /** Queue an explicit set of tracks for download, from any list in the UI. */
  | { t: 'P_ENQUEUE'; tracks: Track[]; name?: string }
  /* Equalizer presets */
  | { t: 'GET_PRESETS' }
  | { t: 'SAVE_PRESET'; name: string; gains: number[] }
  | { t: 'APPLY_PRESET'; name: string }
  /**
   * Put a set of resolved VK tracks into the download queue under `name`.
   * The SW converts them to catalog entries (keeping access_key/restricted) so
   * the downloader can re-resolve a fresh URL at download time.
   */
  | { t: 'VK_ENQUEUE'; name: string; audios: VkAudio[] }
  // Wave 2 — playback (worker -> offscreen, and offscreen -> worker):
  | { t: 'PLAYER_READY' }
  | { t: 'PLAYER_STATE'; state: PlayerState }
  | { t: 'PLAYER_ENDED'; track: PlayerTrack }
  // Playback control (popup -> worker -> offscreen):
  | { t: 'PLAY_LIST'; key: string; tracks: PlayerTrack[]; startIndex?: number }
  | { t: 'PLAY_TOGGLE' }
  | { t: 'PLAY_NEXT' }
  | { t: 'PLAY_PREV' }
  | { t: 'PLAY_SEEK'; seconds: number }
  | { t: 'PLAY_VOLUME'; volume: number }
  /* Queue control. */
  | { t: 'PLAY_SHUFFLE'; on: boolean }
  | { t: 'PLAY_REPEAT'; mode: RepeatMode }
  | { t: 'PLAY_INSERT'; tracks: PlayerTrack[]; next?: boolean }
  | { t: 'PLAY_REMOVE'; index: number }
  | { t: 'PLAY_MOVE'; from: number; to: number }
  | { t: 'PLAY_JUMP'; index: number }
  /* Sound processing. */
  | { t: 'PLAY_FX'; fx: Partial<AudioFx> }
  | { t: 'PLAY_OUTPUT'; deviceId: string }
  | { t: 'GET_DEVICES' }
  /** Tracks whose master was measured clipping at full scale. */
  | { t: 'GET_CLIPPED' }
  /** Ask the player to start or stop pushing spectrum frames. */
  | { t: 'PLAY_SPECTRUM'; on: boolean }
  | { t: 'GET_PLAYER_STATE' }
  | { t: 'EQ_SET'; enabled: boolean; gains: number[] }
  /**
   * Resolve a fresh stream URL for one track (playback and download both need
   * this, because VK stream URLs expire). `via` reports which source answered.
   */
  | {
      t: 'RESOLVE_TRACK';
      key: string;
      owner: string;
      id: string;
      accessKey?: string;
      artist: string;
      title: string;
      duration: number | null;
      cover: string | null;
      restricted?: number;
      urls?: string[];
    }
  // Wave 3 — listening preferences + integrations:
  | { t: 'GET_BLOCK_RULES' }
  | { t: 'SET_BLOCKED_ARTISTS'; artists: string[] }
  | { t: 'TOGGLE_DISLIKE'; owner: string; id: string }
  | { t: 'GET_LYRICS'; owner: string; id: string; lyricsId?: number }
  | { t: 'GET_LASTFM' }
  | { t: 'SET_LASTFM'; apiKey: string; secret: string; sessionKey?: string; username?: string }
  /** Step 1 of desktop auth: mint a request token, return the authorise URL. */
  | { t: 'LASTFM_GET_TOKEN' }
  /** Step 2: exchange the authorised token for a session key. */
  | { t: 'LASTFM_LINK'; token?: string }
  | { t: 'LASTFM_UNLINK' }
  /** Push the queued scrobbles now (used after the network or session returns). */
  | { t: 'LASTFM_FLUSH' }
  | { t: 'LASTFM_NOW_PLAYING'; track: { artist: string; title: string; duration?: number | null } };

/** Commands the worker relays into the offscreen document. */
export type PlayerCommand =
  | { t: 'P_PLAY_QUEUE'; tracks: PlayerTrack[]; startIndex?: number }
  | { t: 'P_SHUFFLE'; on: boolean }
  | { t: 'P_REPEAT'; mode: RepeatMode }
  /** Insert after the current track, or append to the end. */
  | { t: 'P_INSERT'; tracks: PlayerTrack[]; next?: boolean }
  /** Remove one entry from the queue by its position in `queue`. */
  | { t: 'P_REMOVE'; index: number }
  /** Reorder playback: move slot `from` to slot `to` in the play order. */
  | { t: 'P_MOVE'; from: number; to: number }
  /** Jump to a position in the play order. */
  | { t: 'P_JUMP'; index: number }
  /* Sound processing. */
  | { t: 'P_FX'; fx: Partial<AudioFx> }
  /** Loudness of the track about to play, used to set the normalisation gain. */
  | { t: 'P_GAIN'; gainDb: number }
  | { t: 'P_OUTPUT'; deviceId: string }
  | { t: 'P_DEVICES' }
  /** Echo the measured loudness back so the UI can show it. */
  | { t: 'P_LOUDNESS'; lufs: number | null; peakDb: number | null }
  /** Start or stop streaming spectrum frames to the UI. */
  | { t: 'P_SPECTRUM'; on: boolean }
  /** The offscreen player reports a settled loudness measurement. */
  /** The offscreen player reports a settled BS.1770 measurement. */
  | { t: 'PLAYER_LOUDNESS'; key: string; lufs: number; peakDb: number; drDb: number | null }
  /** The offscreen player reports a sample at or over full scale. */
  | { t: 'PLAYER_CLIP'; key: string }
  /** One spectrum frame per channel, pushed while the panel is open. */
  | { t: 'PLAYER_SPECTRUM'; on: boolean }
  | { t: 'P_PLAY' }
  | { t: 'P_PAUSE' }
  | { t: 'P_NEXT' }
  | { t: 'P_PREV' }
  | { t: 'P_SEEK'; seconds: number }
  | { t: 'P_VOLUME'; volume: number }
  | { t: 'P_EQ_ENABLED'; enabled: boolean }
  | { t: 'P_EQ_BANDS'; gains: number[] }
  | { t: 'P_STATE' };

/** Commands the popup sends to the isolated-world collector content script. */
export type CollectorCommand =
  { cmd: 'PING' } | { cmd: 'SCAN'; name?: string } | { cmd: 'SAMPLES' };

/** Result shape returned by collector SCAN. */
export interface ScanResult {
  count?: number;
  name?: string;
  error?: string;
  stats?: { responses: number; parsed: number; found: number; embedded: number } | null;
}

/** Hook diagnostics stats mirrored across the window postMessage bridge. */
export interface HookStats {
  responses: number;
  parsed: number;
  found: number;
  embedded: number;
}

/** A captured API response sample (diagnostics copy flow). */
export interface ResponseSample {
  url: string;
  req: string;
  text: string;
}
