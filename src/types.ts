// Shared typed contracts (Phase 0 structure + Phase 1 storage/queue additions).

/** A harvested track object, produced by hook-main / collector, stored in the SW catalog. */
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
  | { t: 'GET_JOURNAL' };

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
