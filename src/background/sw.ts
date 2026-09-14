import { buildTag, stripTag } from '../lib/id3.js';
import { parseM3U8, type M3U8ParseResult } from '../lib/m3u8.js';
import { sanitize, pad, sniffExt, concatBytes, sanitizePath } from '../lib/util.js';
import { computeBackoff, computeStartDelay } from '../lib/backoff.js';
import { chromeStorageJournalKv, Journal, journalId } from '../lib/journal.js';
import {
  clearRootHandle,
  ensurePermission,
  loadRootHandle,
  StoragePermissionError,
  writeToRoot,
} from '../storage/fs.js';
import { DEFAULT_SETTINGS } from '../types.js';
import type {
  AudioMeta,
  FailedItem,
  FlowState,
  JournalResponse,
  QueueItem,
  RuntimeMessage,
  StateSnapshot,
  StorageStateResult,
} from '../types.js';

const SKEY = 'vmf_state_v1';

let S: FlowState = {
  audios: {},
  lyrics: {},
  playlists: {},
  queue: [],
  failed: [],
  done: {},
  settings: { ...DEFAULT_SETTINGS },
};

let pumping = false;
let stopFlag = false; // CANCEL: stop loops + drop pending
let paused = false; // PAUSE: stop new starts, keep in-flight running
/** Journal ids executing in THIS SW instance — rehydrate must never re-queue them. */
const inFlight = new Set<string>();
/** Cold-start hydration, resolved exactly once per SW instance. Every boot
 *  trigger below must reuse it: load() merges persisted state over live state,
 *  so a second call rolls back settings changed since boot and resurrects
 *  queue lines the workers are executing right now. */
let booted: Promise<void> | undefined;
let lastStartAt = 0; // rate limiter anchor (time of last download start)

/** Persistent queue journal in chrome.storage.local (survives SW termination). */
const journal = new Journal(chromeStorageJournalKv());

async function load(): Promise<void> {
  try {
    const o = await chrome.storage.local.get(SKEY);
    if (o[SKEY]) S = { ...S, ...(o[SKEY] as Partial<FlowState>) };
    // defaults-fill: pre-Phase-1 persisted states lack the new settings keys
    S.settings = { ...DEFAULT_SETTINGS, ...S.settings };
    if (!S.settings.baseDir) S.settings.baseDir = 'VK Music';
  } catch {
    /* keep defaults */
  }
  try {
    await journal.hydrate();
    await rehydrateQueueFromJournal();
  } catch {
    /* journal unavailable — plain in-session queueing still works */
  }
}

/** Re-pump every journal line still pending (resume after SW death). */
async function rehydrateQueueFromJournal(): Promise<void> {
  let ch = false;
  for (const e of journal.pendingEntries()) {
    const id = journalId(e);
    const doneKey = e.pl + '/' + e.key;
    if (S.done[doneKey]) {
      await journal.setStatus(id, 'done');
      continue;
    }
    // A 'downloading' line only means "interrupted" for a COLD start. In a live
    // SW the worker holds it in flight; re-queueing it would download a twin.
    if (inFlight.has(id)) continue;
    if (
      !S.queue.some((q) => q.pl === e.pl && q.key === e.key) &&
      !S.failed.some((f) => f.key === e.key && f.pl === e.pl)
    ) {
      S.queue.push({ key: e.key, pl: e.pl, idx: e.idx, w: e.w });
      ch = true;
    }
  }
  if (ch) persist();
}

let saveT: ReturnType<typeof setTimeout> | undefined;
function persist(): void {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    chrome.storage.local.set({ [SKEY]: JSON.parse(JSON.stringify(S)) }).catch(() => {
      /* best-effort */
    });
  }, 400);
}

function mergeAudio(a: AudioMeta): boolean {
  const ex = S.audios[a.key];
  if (!ex) {
    S.audios[a.key] = a;
    return true;
  }
  let ch = false;
  for (const u of a.urls || [])
    if (!ex.urls.includes(u)) {
      ex.urls.push(u);
      ch = true;
    }
  for (const c of a.covers || [])
    if (!ex.covers.includes(c)) {
      ex.covers.push(c);
      ch = true;
    }
  if (!ex.artist && a.artist) {
    ex.artist = a.artist;
    ch = true;
  }
  if (!ex.title && a.title) {
    ex.title = a.title;
    ch = true;
  }
  if (!ex.album && a.album) {
    ex.album = a.album;
    ch = true;
  }
  if (!ex.duration && a.duration) {
    ex.duration = a.duration;
    ch = true;
  }
  return ch;
}

function attachToPlaylist(name: string | undefined | null, key: string): void {
  if (!name) return;
  if (!S.playlists[name]) S.playlists[name] = [];
  const arr = S.playlists[name]!;
  if (!arr.includes(key)) arr.push(key);
}

type HandlerResult =
  | StateSnapshot
  | { ok: boolean }
  | { queued: number }
  | JournalResponse
  | StorageStateResult
  | null;

async function handle(m: RuntimeMessage): Promise<HandlerResult> {
  switch (m.t) {
    case 'AUDIOS': {
      let ch = false;
      for (const a of m.audios || []) {
        if (mergeAudio(a)) ch = true;
        if (m.scanning && m.pl) {
          attachToPlaylist(m.pl, a.key);
          ch = true;
        }
      }
      if (ch) persist();
      return { ok: true };
    }
    case 'LYRICS': {
      Object.assign(S.lyrics, m.map || {});
      persist();
      return { ok: true };
    }
    case 'ENQUEUE': {
      stopFlag = false;
      paused = false;
      const names = m.names || [];
      for (const name of names) {
        const arr = S.playlists[name] || [];
        const w = String(Math.max(1, arr.length)).length;
        arr.forEach((key, i) => {
          const idx = i + 1;
          const doneKey = name + '/' + key;
          if (S.done[doneKey]) return;
          if (S.queue.some((q) => q.pl === name && q.key === key)) return;
          S.queue.push({ key, pl: name, idx, w });
        });
      }
      for (const qj of S.queue) await journal.ensure(qj);
      persist();
      pump();
      return { queued: S.queue.length };
    }
    case 'CANCEL': {
      stopFlag = true;
      paused = false;
      S.queue = [];
      await journal.dropPending();
      persist();
      return { ok: true };
    }
    case 'PAUSE': {
      paused = true;
      persist();
      return { ok: true };
    }
    case 'RESUME': {
      paused = false;
      stopFlag = false;
      await rehydrateQueueFromJournal();
      persist();
      pump();
      return { ok: true };
    }
    case 'GET_JOURNAL': {
      return journalSnap();
    }
    case 'GET_STORAGE_STATE': {
      return await storageState();
    }
    case 'CLEAR_DIR': {
      await clearRootHandle();
      S.settings = { ...S.settings, rootName: undefined };
      persist();
      return await storageState();
    }
    case 'PICK_DIR_RESULT': {
      if (m.ok && m.rootName) {
        S.settings = { ...S.settings, rootName: m.rootName, storageMode: 'fsa' };
      }
      persist();
      return await storageState();
    }
    case 'RETRY_FAILED': {
      stopFlag = false;
      paused = false;
      const f = S.failed.splice(0, S.failed.length);
      for (const it of f) {
        const doneKey = it.pl + '/' + it.key;
        delete S.done[doneKey];
        if (!S.queue.some((q) => q.pl === it.pl && q.key === it.key)) S.queue.push(it);
      }
      for (const it of f) await journal.ensure(it);
      persist();
      pump();
      return { ok: true };
    }
    case 'CLEAR_FAILED': {
      S.failed = [];
      persist();
      return { ok: true };
    }
    case 'SETTINGS': {
      S.settings = { ...S.settings, ...m.patch };
      persist();
      return { ok: true };
    }
    case 'RESET': {
      S = {
        audios: {},
        lyrics: {},
        playlists: {},
        queue: [],
        failed: [],
        done: {},
        settings: S.settings,
      };
      await journal.clear();
      persist();
      return { ok: true };
    }
    case 'GET_STATE': {
      return snap();
    }
  }
  return null;
}

function journalSnap(): JournalResponse {
  return { ok: true, paused, counts: journal.counts(), entries: journal.list() };
}

async function storageState(): Promise<StorageStateResult> {
  const h = await loadRootHandle();
  const permission = h ? await ensurePermission(h, false) : 'none';
  return { mode: S.settings.storageMode, rootName: S.settings.rootName ?? null, permission };
}

function snap(): StateSnapshot {
  return {
    playlists: Object.fromEntries(Object.entries(S.playlists).map(([k, v]) => [k, v.length])),
    queue: S.queue.map((q) => {
      const au = S.audios[q.key];
      return { pl: q.pl, idx: q.idx, a: au ? { artist: au.artist, title: au.title } : null };
    }),
    failed: S.failed.map((f) => {
      const au = S.audios[f.key];
      return { pl: f.pl, err: f.error, a: au ? { artist: au.artist, title: au.title } : null };
    }),
    doneCount: Object.keys(S.done).length,
    settings: S.settings,
    totalAudios: Object.keys(S.audios).length,
    journal: journal.counts(),
    paused,
  };
}

function fail(item: QueueItem | FailedItem, err: unknown): void {
  const doneKey = item.pl + '/' + item.key;
  if (S.done[doneKey]) delete S.done[doneKey];
  if (!S.failed.some((f) => f.key === item.key && f.pl === item.pl)) {
    S.failed.push({
      key: item.key,
      pl: item.pl,
      idx: item.idx,
      w: item.w,
      error: String(err).slice(0, 200),
      ts: Date.now(),
    });
  } else {
    const f = S.failed.find((f) => f.key === item.key && f.pl === item.pl)!;
    f.error = String(err).slice(0, 200);
    f.ts = Date.now();
  }
  persist();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const slots = Math.min(5, Math.max(1, +S.settings.conc || 2));
    await Promise.all(Array.from({ length: slots }, () => workerLoop()));
  } finally {
    pumping = false;
  }
}

/** Rate limiter: keep >= minIntervalMs (+ anti-ban jitter) between download starts. */
async function gateStart(): Promise<void> {
  const wait = computeStartDelay(
    lastStartAt,
    Math.max(0, +S.settings.minIntervalMs || 0),
    Math.max(0, +S.settings.jitterMs || 0),
  );
  if (wait > 0) await sleep(wait);
  lastStartAt = Date.now();
}

async function workerLoop(): Promise<void> {
  while (true) {
    if (stopFlag || paused) break;
    const item = S.queue.shift();
    if (!item) break;
    await gateStart();
    if (stopFlag || paused) {
      S.queue.unshift(item);
      break;
    }
    persist();
    const id = journalId(item);
    inFlight.add(id);
    await journal.setStatus(id, 'downloading');
    let attempts = journal.attemptCount(id);
    const max = Math.max(1, Math.floor(+S.settings.maxAttempts || DEFAULT_SETTINGS.maxAttempts));
    try {
      for (;;) {
        try {
          await runItem(item);
          await journal.setStatus(id, 'done');
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (e instanceof StoragePermissionError) {
            // surface per-item, no silent downloads-fallback, no retry storm
            await journal.noteError(id, msg);
            await journal.setStatus(id, 'failed');
            fail(item, msg);
            break;
          }
          attempts++;
          await journal.bumpAttempt(id, msg);
          if (attempts >= max) {
            await journal.setStatus(id, 'failed');
            fail(item, msg);
            break;
          }
          await sleep(
            computeBackoff(
              attempts,
              Math.max(0, +S.settings.baseBackoffMs || DEFAULT_SETTINGS.baseBackoffMs),
              Math.max(0, +S.settings.maxBackoffMs || DEFAULT_SETTINGS.maxBackoffMs),
              Math.max(0, +S.settings.jitterMs),
            ),
          );
          if (stopFlag || paused) {
            await journal.setStatus(id, 'queued');
            S.queue.unshift(item);
            break;
          }
        }
      }
    } finally {
      // requeued items leave the set with the line already back to 'queued',
      // so rehydration may pick them up; finished ones stay out of it forever
      inFlight.delete(id);
    }
    await sleep(+S.settings.gapMs || 400);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runItem(item: QueueItem): Promise<void> {
  const a = S.audios[item.key];
  if (!a) throw new Error('трек не найден в каталоге');
  const doneKey = item.pl + '/' + item.key;
  if (S.done[doneKey]) return;

  let body = await getAudioBytes(a);
  const ext = sniffExt(body);

  if (ext === 'mp3') {
    body = stripTag(body);
    const cover = await getCover(a);
    const lyrics = S.lyrics[String(a.id)] || '';
    const tag = buildTag(
      { title: a.title, artist: a.artist, album: a.album, year: a.year, track: item.idx },
      cover,
      lyrics,
    );
    if (tag) body = concatBytes([tag, body]);
  }

  const label = `${pad(item.idx, item.w)} ${sanitize(`${a.artist} - ${a.title}`)}.${ext}`;
  if (S.settings.storageMode === 'fsa') {
    // Write straight into the user-picked folder: <Playlist>/NN. Artist - Title.ext
    const root = await loadRootHandle();
    if (!root) throw new StoragePermissionError();
    const perm = await ensurePermission(root, false);
    if (perm !== 'granted') {
      throw new StoragePermissionError(`storage-permission-needed (${perm})`);
    }
    await writeToRoot(root, `${sanitize(item.pl)}/${label}`, body);
  } else {
    const base = sanitizePath(S.settings.baseDir) || 'VK Music';
    await saveBlob(body, `${base}/${sanitize(item.pl)}/${label}`);
  }

  S.done[doneKey] = Date.now();
  const fi = S.failed.findIndex((f) => f.key === item.key && f.pl === item.pl);
  if (fi !== -1) S.failed.splice(fi, 1);
  persist();
}

async function rawFetch(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function getAudioBytes(a: AudioMeta): Promise<Uint8Array> {
  const direct = (a.urls || []).find((u) => !/\.m3u8/i.test(u));
  if (direct) {
    const b = await rawFetch(direct);
    if (!(b[0] === 0x23 && b[1] === 0x45 && b[2] === 0x58)) return b;
    const txt = new TextDecoder().decode(b);
    return assembleHls(txt, direct);
  }
  const hls = (a.urls || []).find((u) => /\.m3u8/i.test(u)) || (a.urls || [])[0];
  if (!hls) throw new Error('нет доступных ссылок');
  const txt = await (await fetch(hls)).text();
  return assembleHls(txt, hls);
}

async function assembleHls(txt: string, baseUrl: string): Promise<Uint8Array> {
  let p: M3U8ParseResult = parseM3U8(txt, baseUrl);
  if (p.variant) {
    const r = await fetch(p.variant);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    p = parseM3U8(await r.text(), p.variant);
  }
  if (!p.segments.length) throw new Error('плейлист без сегментов');
  const parts: Uint8Array[] = [];
  if (p.init) parts.push(await rawFetch(p.init));
  let i = 0;
  for (const s of p.segments) {
    if (i > 5000) break;
    let seg = await rawFetch(s);
    if (seg[0] === 0x23 && seg[1] === 0x45 && seg[2] === 0x58) {
      seg = await assembleHls(new TextDecoder().decode(seg), s);
    }
    parts.push(seg);
    i++;
  }
  const out = concatBytes(parts);
  if (!out.length) throw new Error('пустой результат');
  return out;
}

async function getCover(a: AudioMeta): Promise<Uint8Array | null> {
  for (const c of (a.covers || []).slice(0, 3)) {
    try {
      const b = await rawFetch(c);
      if (b.length > 1024 && b.length < 4e6) return b;
    } catch {
      /* try next cover */
    }
  }
  return null;
}

const pendingDl = new Map<number, { res: () => void; rej: (err: Error) => void }>();

chrome.downloads.onChanged.addListener((d) => {
  const w = pendingDl.get(d.id);
  if (!w) return;
  if (d.state) {
    if (d.state.current === 'complete') {
      pendingDl.delete(d.id);
      w.res();
    } else if (d.state.current === 'interrupted') {
      pendingDl.delete(d.id);
      w.rej(new Error((d.error as unknown as string) || 'прервано'));
    }
  }
});

function waitDone(id: number, timeoutMs?: number): Promise<void> {
  return new Promise((res, rej) => {
    pendingDl.set(id, { res, rej });
    setTimeout(() => {
      if (pendingDl.delete(id)) rej(new Error('таймаут загрузки'));
    }, timeoutMs || 900000);
  });
}

async function saveBlob(bytes: Uint8Array, fname: string): Promise<void> {
  // runtime value is always a Uint8Array backed by a plain ArrayBuffer here
  const blob = new Blob([bytes as unknown as BlobPart]);
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({
      url,
      filename: fname,
      conflictAction: 'uniquify',
    });
    await waitDone(id);
  } finally {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
}

/** Reuse the one cold-start hydration for all four boot triggers below. */
const boot = (): Promise<void> => (booted ??= load());

chrome.runtime.onMessage.addListener((m: unknown, _sender, sendResponse) => {
  handle(m as RuntimeMessage)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ error: String(e) }));
  return true;
});

chrome.alarms.create('vmf-pump', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((al) => {
  if (al.name === 'vmf-pump') {
    void boot().then(pump);
  }
});
chrome.runtime.onStartup.addListener(() => {
  stopFlag = false;
  paused = false;
  void boot().then(pump);
});
chrome.runtime.onInstalled.addListener(() => {
  void boot().then(pump);
});

void boot().then(pump);
