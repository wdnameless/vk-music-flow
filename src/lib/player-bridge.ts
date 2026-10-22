import type { PlayerCommand, PlayerState } from '../types.js';

/**
 * Service-worker side of the offscreen player.
 *
 * The worker owns no media element, so it creates (once) an offscreen document
 * and relays commands into it. Keeping this in one module means the rest of the
 * worker only ever talks to `sendToPlayer` / `playerSnapshot`.
 *
 * `chrome.offscreen` reasons: AUDIO_PLAYBACK is the documented one for playing
 * audio; WORKERS is added because the offscreen document also parses HLS
 * manifests while resolving tracks, which needs no DOM and is allowed to run in
 * a worker context.
 */

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const MESSAGE_TIMEOUT_MS = 20000;

type OffscreenApi = {
  createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
  hasDocument?(): Promise<boolean>;
};

type RuntimeCtx = {
  getContexts?(filter: { contextTypes: string[] }): Promise<{ contextType: string }[]>;
};

const offscreenApi = (): OffscreenApi | null => {
  const c = globalThis.chrome as unknown as { offscreen?: OffscreenApi } | undefined;
  return c?.offscreen ?? null;
};

const runtimeCtx = (): RuntimeCtx =>
  (globalThis.chrome as unknown as { runtime?: RuntimeCtx }).runtime ?? {};

/** True when the offscreen document already exists. */
async function hasOffscreen(): Promise<boolean> {
  const rt = runtimeCtx();
  if (rt.getContexts) {
    try {
      const ctxs = await rt.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (ctxs.length) return true;
    } catch {
      /* fall through to creating it */
    }
  }
  return false;
}

/** Latest state pushed by the offscreen document, for the popup to read. */
let lastState: PlayerState | null = null;
/** Set while the document is being created, so concurrent calls wait. */
let creating: Promise<void> | null = null;

export function rememberPlayerState(s: PlayerState): void {
  lastState = s;
}

export function playerSnapshot(): PlayerState | null {
  return lastState;
}

/**
 * Ensure the offscreen document exists.
 *
 * Creation is not idempotent in Chrome: a second call while one exists throws,
 * so presence is checked first and concurrent callers share one promise.
 */
export async function ensureOffscreen(): Promise<boolean> {
  if (await hasOffscreen()) return true;
  if (!creating) {
    const api = offscreenApi();
    if (!api) return false;
    creating = api
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['AUDIO_PLAYBACK', 'WORKERS'],
        justification: 'Воспроизведение музыки ВКонтакте без открытой вкладки.',
      })
      .catch(() => {
        /* already created by a racing call — treated as success below */
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
  return await hasOffscreen();
}

/** Send one command into the offscreen document and return its reply. */
export async function sendToPlayer(cmd: PlayerCommand): Promise<unknown> {
  const ok = await ensureOffscreen();
  if (!ok) return null;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), MESSAGE_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage(cmd, (reply?: unknown) => {
        clearTimeout(timer);
        // Reading lastError silences "Unchecked runtime.lastError" when the
        // document is mid-teardown; the timeout path is the real failure signal.
        void chrome.runtime.lastError;
        resolve(reply ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** Tear the document down (used when playback stops for good). */
export async function closeOffscreen(): Promise<void> {
  const api = offscreenApi();
  if (!api) return;
  try {
    if (await hasOffscreen()) await api.closeDocument();
  } catch {
    /* nothing to close */
  }
}
