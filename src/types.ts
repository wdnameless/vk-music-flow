// Shared typed contracts (Phase 0: structure + typing only, no behavior change).

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

/** User-tunable download settings (persisted alongside the catalog). */
export interface Settings {
  conc: number;
  gapMs: number;
  baseDir: string;
}

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
  | { t: 'GET_STATE' };

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
