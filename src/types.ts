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

/** One equalizer band state. */
export interface EqBand {
  hz: number;
  gain: number;
}

/** Player snapshot pushed to the UI. */
export interface PlayerState {
  track: PlayerTrack | null;
  index: number;
  total: number;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  eqEnabled: boolean;
  eqBands: EqBand[];
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

/** A declarativeNetRequest rule owned by this extension (see lib/dnr.ts). */
export interface HeaderRule {
  id: number;
  urlFilter: string;
  headers: { name: string; value: string }[];
  /** Restrict to requests initiated by our own extension pages/worker. */
  ownOriginOnly?: boolean;
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
  | { t: 'LASTFM_LINK'; token: string };

/** Commands the worker relays into the offscreen document. */
export type PlayerCommand =
  | { t: 'P_PLAY_QUEUE'; tracks: PlayerTrack[]; startIndex?: number }
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
