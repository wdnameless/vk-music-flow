import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decodeDownloadUrl, installServiceWorkerEnv } from './mock-fs.js';

// Phase 1 (d): persistent journal + resume across MV3 SW (re-)start.
// Fresh import of sw.ts with chrome.storage PRE-SEEDED with a state (empty
// queue!) but a journal full of pending lines: the engine must re-hydrate
// the queue from the journal on module init and finish the missing file,
// while a line whose work is already recorded as done gets closed out
// without re-downloading.

type DlListener = (d: { id: number; state?: { current?: string } }) => void;

const captured = new Map<string, Uint8Array>();
let dlId = 1;

const adts = new Uint8Array([0xff, 0xf1, 0x50, 0x80, ...new Array(60).fill(0x33)]);

interface MockResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

const mockFetch = (async (url: string | URL | Request): Promise<MockResponse> => {
  const u = String(url);
  const body = (b: Uint8Array): MockResponse => ({
    ok: true,
    status: 200,
    text: async () => new TextDecoder().decode(b),
    arrayBuffer: async () =>
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
  });
  if (u.endsWith('/r1.aac') || u.endsWith('/r2.aac')) return body(adts);
  return {
    ok: false,
    status: 404,
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}) as unknown as typeof globalThis.fetch;

const seedState = {
  audios: {
    '88_301': {
      key: '88_301',
      id: '301',
      owner: '88',
      artist: 'Восстановлен',
      title: 'Трек с диска',
      album: '',
      year: null,
      duration: 120,
      urls: ['https://x.vk-cdn.net/r1.aac'],
      covers: [],
    },
    '88_302': {
      key: '88_302',
      id: '302',
      owner: '88',
      artist: 'Восстановлен',
      title: 'Второй трек',
      album: '',
      year: null,
      duration: 90,
      urls: ['https://x.vk-cdn.net/r2.aac'],
      covers: [],
    },
  },
  lyrics: {},
  playlists: { Возобновлено: ['88_301', '88_302'] },
  queue: [], // <- crashed before queue was repopulated; journal is the source
  failed: [],
  done: { 'Возобновлено/88_302': 1 }, // <- that one already finished on disk
  settings: {
    conc: 2,
    gapMs: 100,
    baseDir: 'VK Music',
    storageMode: 'downloads',
    maxAttempts: 3,
    baseBackoffMs: 5,
    maxBackoffMs: 25,
    minIntervalMs: 0,
    jitterMs: 0,
  },
};

const seedJournal = {
  v: 1 as const,
  items: {
    'Возобновлено/88_301': {
      key: '88_301',
      pl: 'Возобновлено',
      idx: 1,
      w: 2,
      status: 'downloading', // interrupted in-flight -> must restart
      attempts: 1,
      lastError: 'HTTP 500',
      ts: 1,
    },
    'Возобновлено/88_302': {
      key: '88_302',
      pl: 'Возобновлено',
      idx: 2,
      w: 2,
      status: 'queued', // journal stale-lag: state says done already
      attempts: 0,
      lastError: null,
      ts: 1,
    },
  },
};

const store = new Map<string, unknown>([
  ['vmf_state_v1', JSON.parse(JSON.stringify(seedState))],
  ['vmf_journal_v1', JSON.parse(JSON.stringify(seedJournal))],
]);

const msgListeners: Array<
  (m: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean | undefined
> = [];
const dlListeners: DlListener[] = [];

const mockChrome = {
  storage: {
    local: {
      get: async (keys?: unknown) => {
        if (typeof keys === 'string') return { [keys]: store.get(keys) };
        return Object.fromEntries(store);
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) {
          store.set(k, JSON.parse(JSON.stringify(v)) as unknown);
        }
      },
    },
  },
  runtime: {
    onMessage: {
      addListener: (f: (typeof msgListeners)[number]) => {
        msgListeners.push(f);
      },
    },
    onStartup: { addListener: () => undefined },
    onInstalled: { addListener: () => undefined },
  },
  alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
  downloads: {
    onChanged: {
      addListener: (f: DlListener) => {
        dlListeners.push(f);
      },
      emit(d: { id: number; state?: { current?: string } }) {
        for (const f of dlListeners) f(d);
      },
    },
    async download({ url, filename }: { url: string; filename: string }) {
      const bytes = decodeDownloadUrl(url);
      if (bytes) captured.set(filename, bytes);
      const id = dlId++;
      setTimeout(
        () =>
          (mockChrome.downloads.onChanged as unknown as { emit: DlListener }).emit({
            id,
            state: { current: 'complete' },
          }),
        15,
      );
      return id;
    },
  },
};

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(m: unknown): Promise<unknown[]> {
  return Promise.all(
    msgListeners.map(
      (f) =>
        new Promise<unknown>((res) => {
          const done = f(m, null, res);
          if (!done) res(null);
        }),
    ),
  );
}

async function journal(id: string) {
  const r = ((await send({ t: 'GET_JOURNAL' }))[0] ?? {}) as {
    entries?: { pl: string; key: string; status: string; attempts: number }[];
    counts?: Record<string, number>;
  };
  return { entry: (r.entries ?? []).find((e) => `${e.pl}/${e.key}` === id), counts: r.counts };
}

let entry1: Awaited<ReturnType<typeof journal>>['entry'];
let counts: Awaited<ReturnType<typeof journal>>['counts'];
let persistedJournal: { items: Record<string, { status: string; attempts: number }> } | undefined;
let stateSnap: { journal: Record<string, number>; doneCount: number } | undefined;

const cleanups: Array<() => void> = [];

beforeAll(async () => {
  const origFetch = globalThis.fetch;
  cleanups.push(installServiceWorkerEnv());
  cleanups.push(() => {
    (globalThis as { fetch: unknown }).fetch = origFetch;
    delete (globalThis as Record<string, unknown>).chrome;
  });
  (globalThis as { fetch: unknown }).fetch = mockFetch;
  (globalThis as unknown as { chrome: unknown }).chrome = mockChrome;

  // import = SW cold start: load() re-hydrates from the seeded journal, pump() resumes
  await import('../src/background/sw.js');

  const t0 = Date.now();
  while (captured.size < 1 && Date.now() - t0 < 15000) await sleepMs(100);
  await sleepMs(800); // let trailing persist/setStatus settle

  const j1 = await journal('Возобновлено/88_301');
  entry1 = j1.entry;
  counts = j1.counts;
  persistedJournal = store.get('vmf_journal_v1') as typeof persistedJournal;
  stateSnap = (await send({ t: 'GET_STATE' }))[0] as typeof stateSnap;
}, 60000);

afterAll(() => {
  for (const f of cleanups) f();
});

describe('Phase 1 (d): восстановление очереди из журнала при старте SW', () => {
  it('незавершённый трек докачан без нового ENQUEUE', () => {
    expect(captured.get('VK Music/Возобновлено/01 Восстановлен - Трек с диска.aac')).toBeTruthy();
  });

  it('уже готовый трек НЕ перезагружается и закрывается в журнале', () => {
    expect([...captured.keys()].filter((k) => k.includes('Второй трек')).length).toBe(0);
  });

  it('журнал: докачанный — done (attempts сохранены), отставший — done', () => {
    expect(persistedJournal?.items['Возобновлено/88_301']?.status).toBe('done');
    expect(persistedJournal?.items['Возобновлено/88_301']?.attempts).toBe(1);
    expect((entry1?.status ?? '') === 'done').toBe(true);
    expect(persistedJournal?.items['Возобновлено/88_302']?.status).toBe('done');
  });

  it('счётчики журнала и снимок состояния согласованы', () => {
    expect(counts?.done).toBe(2);
    expect(counts?.queued).toBe(0);
    expect(stateSnap?.journal.done).toBe(2);
    expect(stateSnap?.doneCount).toBe(2);
  });
});
