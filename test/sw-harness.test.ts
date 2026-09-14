import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { persistRootHandle } from '../src/storage/fs.js';
import type {
  JournalEntry,
  JournalResponse,
  RootDirHandle,
  StorageStateResult,
} from '../src/types.js';
import { createFakeIndexedDB, makeFakeFsRoot, type FakeFsRoot } from './mock-fs.js';

// Port of test/sw-harness.mjs (v0.2.2 baseline): mocks chrome.*, drives the
// service-worker pipeline end-to-end and keeps the original 10 checks.
// Phase 1 appends storage (fsa) + retry cases at the bottom of this file.

type DlListener = (d: { id: number; state?: { current?: string } }) => void;

const captured = new Map<string, Uint8Array>();
const blobUrls = new Map<string, Blob | Uint8Array>();
let uid = 0;
let dlId = 1;
let flakyCount = 0; // Phase 1 (c): fetch fails twice, then succeeds

const adtsSeg = (): Uint8Array =>
  new Uint8Array([0xff, 0xf1, 0x50, 0x80, ...new Array(60).fill(0x11)]);
const mp3Body = new Uint8Array([0xff, 0xfb, 0x90, 0x00, ...new Array(80).fill(0xaa)]);
const oldTagSize = 24;
const syncsafe = (n: number): number[] => [
  (n >>> 21) & 127,
  (n >>> 14) & 127,
  (n >>> 7) & 127,
  n & 127,
];
const oldPayload = new Uint8Array(oldTagSize);
oldPayload.set(new TextEncoder().encode('OLDTAG_MARKER').slice(0, oldTagSize - 3));
const oldTag = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, ...syncsafe(oldTagSize), ...oldPayload]);
const directWithOldTag = new Uint8Array([...oldTag, ...mp3Body]);
const cover = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(1100).fill(0x77)]);

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
  if (u.includes('/master.m3u8'))
    return body(
      new TextEncoder().encode(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nv.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nhi.m3u8\n',
      ),
    );
  if (u.includes('/hi.m3u8') || u.includes('/v.m3u8'))
    return body(
      new TextEncoder().encode(
        '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.aac\n#EXTINF:4,\nseg1.aac\n#EXTINF:4,\nseg2.aac\n',
      ),
    );
  if (u.endsWith('seg0.aac')) return body(adtsSeg());
  if (u.endsWith('seg1.aac')) return body(adtsSeg());
  if (u.endsWith('seg2.aac')) return body(adtsSeg());
  if (
    u.endsWith('slowtrack.aac') ||
    u.endsWith('slowtrack2.aac') ||
    u.endsWith('slowtrack4.aac') ||
    u.endsWith('fasttrack.aac')
  )
    return body(adtsSeg());
  if (u.includes('/direct.mp3')) return body(directWithOldTag);
  if (u.includes('/cover.jpg')) return body(cover);
  if (u.includes('/flaky.mp3')) {
    flakyCount++;
    if (flakyCount <= 2)
      return {
        ok: false,
        status: 503,
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    return body(adtsSeg());
  }
  return {
    ok: false,
    status: 404,
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}) as unknown as typeof globalThis.fetch;

const msgListeners: Array<
  (m: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean | undefined
> = [];

// Baseline fixture data
const audioA = {
  key: '55_101',
  id: '101',
  owner: '55',
  artist: 'Кино',
  title: 'Группа крови',
  album: 'Альбом',
  year: 2024,
  duration: 289,
  urls: ['https://cdn/direct.mp3'],
  covers: ['https://cdn/cover.jpg'],
};
const audioB = {
  key: '55_102',
  id: '102',
  owner: '55',
  artist: 'Мастер',
  title: 'HLS Track',
  album: '',
  year: null,
  duration: 180,
  urls: ['https://cdn/master.m3u8'],
  covers: [],
};

type Send = (m: unknown) => Promise<unknown[]>;

const results: {
  st: { playlists: Record<string, number> };
  captured: typeof captured;
  sizeAfterFirstRun: number;
  f1: string | undefined;
  f2: string | undefined;
  f3: string | undefined;
  frameIds: () => string;
  tailOk: () => boolean;
} = {} as never;

let send: Send = async () => [];

const dlListeners: DlListener[] = [];

const store = new Map<string, unknown>();

// Phase 1 (race/pause) plumbing: every chrome.downloads.download call is
// logged; filenames containing 'Slow' stay pending until the test emits
// their completion manually, and the pump alarm is fireable from tests.
const dlLog: string[] = [];
const slowIds = new Map<string, number>();
const alarmListeners: Array<(al: { name: string }) => void> = [];

const mockChrome = {
  storage: {
    local: {
      get: async (keys?: unknown) => {
        if (typeof keys === 'string') return { [keys]: store.get(keys) };
        return Object.fromEntries(store);
      },
      set: async (items: Record<string, unknown>) => {
        // deep-clone on write, mirroring chrome's structured-clone isolation
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
  alarms: {
    create: () => undefined,
    onAlarm: {
      emit: (name: string) => {
        for (const f of alarmListeners) f({ name });
      },
      addListener: (f: (al: { name: string }) => void) => {
        alarmListeners.push(f);
      },
    },
  },
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
      dlLog.push(filename);
      const blob = blobUrls.get(url);
      if (blob) {
        const bytes =
          blob instanceof Uint8Array ? blob : new Uint8Array(await (blob as Blob).arrayBuffer());
        captured.set(filename, bytes);
      }
      const id = dlId++;
      if (filename.includes('Slow')) {
        // stays in-flight until a Phase 1 race/pause test completes it
        slowIds.set(filename, id);
        return id;
      }
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

beforeAll(async () => {
  const origFetch = globalThis.fetch;
  const origCoo = URL.createObjectURL;
  const origRoo = URL.revokeObjectURL;

  (globalThis as { fetch: unknown }).fetch = mockFetch;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (blob: Blob) => {
    const u = 'blob:mock/' + ++uid;
    blobUrls.set(u, blob);
    return u;
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (globalThis as unknown as { chrome: unknown }).chrome = mockChrome;

  try {
    await import('../src/background/sw.js');
  } finally {
    // keep process mocks alive until afterAll; restore later
    afterCleanup.push(() => {
      (globalThis as { fetch: unknown }).fetch = origFetch;
      (URL as unknown as { createObjectURL: unknown }).createObjectURL = origCoo;
      (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = origRoo;
      delete (globalThis as Record<string, unknown>).chrome;
    });
  }

  await new Promise((r) => setTimeout(r, 100));

  send = (m: unknown) =>
    Promise.all(
      msgListeners.map(
        (f) =>
          new Promise<unknown>((res) => {
            const done = f(m, null, res);
            if (!done) res(null);
          }),
      ),
    );

  await send({ t: 'AUDIOS', audios: [audioA, audioB] });
  await send({ t: 'LYRICS', map: { 101: 'Группа крови на рукаве...' } });
  await send({ t: 'AUDIOS', audios: [audioA], pl: 'Тест', scanning: true });
  await send({ t: 'AUDIOS', audios: [audioB], pl: 'Тест', scanning: true });

  const st = ((await send({ t: 'GET_STATE' }))[0] ?? {}) as {
    playlists: Record<string, number>;
  };
  results.st = st;

  await send({ t: 'ENQUEUE', names: ['Тест'] });
  for (let i = 0; i < 40 && captured.size < 2; i++) await new Promise((r) => setTimeout(r, 250));

  // exact snapshot at the baseline's check moment: an unexpected extra
  // top-level download must fail this, just like `captured.size === 2` did
  results.sizeAfterFirstRun = captured.size;

  const names = [...captured.keys()].sort();
  results.captured = captured;
  results.f1 = names.find((n) => n.endsWith('.mp3'));
  results.f2 = names.find((n) => n.endsWith('.aac'));

  results.frameIds = () => {
    const b1 = captured.get(results.f1!);
    if (!b1) return '';
    let off = 10;
    const ids: string[] = [];
    while (off < b1.length - 10) {
      const id = String.fromCharCode(...b1.subarray(off, off + 4));
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const sz =
        (((b1[off + 4] ?? 0) & 127) << 21) |
        (((b1[off + 5] ?? 0) & 127) << 14) |
        (((b1[off + 6] ?? 0) & 127) << 7) |
        ((b1[off + 7] ?? 0) & 127);
      ids.push(id);
      off += 10 + sz;
    }
    return ids.join(',');
  };
  results.tailOk = () => {
    const b1 = captured.get(results.f1!);
    if (!b1) return false;
    const frameIds = results.frameIds();
    // recompute body offset from frame walk
    let off = 10;
    if (frameIds) {
      while (off < b1.length - 10) {
        const id = String.fromCharCode(...b1.subarray(off, off + 4));
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const sz =
          (((b1[off + 4] ?? 0) & 127) << 21) |
          (((b1[off + 5] ?? 0) & 127) << 14) |
          (((b1[off + 6] ?? 0) & 127) << 7) |
          ((b1[off + 7] ?? 0) & 127);
        off += 10 + sz;
      }
    }
    const tail = b1.subarray(off);
    return tail.length === mp3Body.length && [...tail].every((v, i) => v === mp3Body[i]);
  };

  await send({ t: 'SETTINGS', patch: { baseDir: 'Music\\VK Extra/..' } });
  await send({ t: 'AUDIOS', audios: [audioA], pl: 'Тест2', scanning: true });
  await send({ t: 'ENQUEUE', names: ['Тест2'] });
  for (let i = 0; i < 40 && captured.size < 3; i++) await new Promise((r) => setTimeout(r, 250));

  results.f3 = [...captured.keys()].find((n) => n.includes('Тест2'));

  // let trailing persist()/sleep timers fire while mocks are still installed
  await new Promise((r) => setTimeout(r, 800));
});

const afterCleanup: Array<() => void> = [];
afterAll(() => {
  for (const f of afterCleanup) f();
});

describe('service worker: конвейер загрузки', () => {
  it('плейлист «Тест» собран из скан-сообщений', () => {
    expect(results.st.playlists['Тест']).toBe(2);
  });

  it('загружено 2 файла', () => {
    // exact baseline parity: exactly two files downloaded after ENQUEUE
    expect(results.sizeAfterFirstRun).toBe(2);
    expect([...captured.keys()].filter((n) => n.startsWith('VK Music/Тест/')).length).toBe(2);
  });

  it('имя mp3', () => {
    expect(results.f1).toBe('VK Music/Тест/01 Кино - Группа крови.mp3');
  });

  it('имя aac', () => {
    expect(results.f2).toBe('VK Music/Тест/02 Мастер - HLS Track.aac');
  });

  it('ID3v2.4 записан в начало файла', () => {
    const b1 = captured.get(results.f1!);
    expect(b1).toBeTruthy();
    const s1 = new TextDecoder().decode(b1!);
    expect(s1.slice(0, 3)).toBe('ID3');
    expect(b1![3]).toBe(4);
  });

  it('старый тег срезан', () => {
    const b1 = captured.get(results.f1!);
    const s1 = new TextDecoder().decode(b1!);
    expect(s1.includes('OLDTAG_MARKER')).toBe(false);
  });

  it('фреймы тега', () => {
    expect(results.frameIds()).toBe('TIT2,TPE1,TALB,TRCK,TDRC,USLT,APIC');
  });

  it('аудио-данные не повреждены', () => {
    expect(results.tailOk()).toBe(true);
  });

  it('HLS собран из 3 сегментов ADTS', () => {
    const b2 = captured.get(results.f2!);
    expect(b2).toBeTruthy();
    expect(b2!.length).toBe(192);
    expect(b2![0]).toBe(0xff);
    expect(b2![1]).toBe(0xf1);
  });

  it('кастомный baseDir + защита от ".."', () => {
    expect(results.f3).toBe('Music/VK Extra/Тест2/01 Кино - Группа крови.mp3');
  });
});

/* ================= Phase 1 additions (run after baseline checks) ================= */

const audioC = {
  key: '55_103',
  id: '103',
  owner: '55',
  artist: 'Флэйк',
  title: 'Flaky Song',
  album: '',
  year: null,
  duration: 60,
  urls: ['https://cdn/flaky.mp3'],
  covers: [],
};

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(fn: () => Promise<boolean>, timeoutMs = 30000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleepMs(100);
  }
}

async function journalEntry(id: string): Promise<JournalEntry | undefined> {
  const r = ((await send({ t: 'GET_JOURNAL' }))[0] ?? {}) as Partial<JournalResponse>;
  return (r.entries ?? []).find((e) => `${e.pl}/${e.key}` === id);
}

const fsRoot: FakeFsRoot = makeFakeFsRoot('MyMusic');

describe('Phase 1 (a): fsa mode пишет в выбранный каталог', () => {
  let pickPerm = '';
  let writtenPath = '';
  let writtenBytes: Uint8Array | undefined;

  beforeAll(async () => {
    (globalThis as Record<string, unknown>).indexedDB = createFakeIndexedDB();
    afterCleanup.push(() => {
      delete (globalThis as Record<string, unknown>).indexedDB;
    });
    // the popup would have picked + persisted the handle on a user gesture;
    // here we persist it directly into the fake IDB
    await persistRootHandle(fsRoot.handle as RootDirHandle);
    const ss = ((await send({ t: 'PICK_DIR_RESULT', ok: true, rootName: 'MyMusic' }))[0] ??
      {}) as StorageStateResult;
    pickPerm = ss.permission;
    await send({ t: 'SETTINGS', patch: { minIntervalMs: 0, jitterMs: 0 } });
    await send({ t: 'AUDIOS', audios: [audioA], pl: 'ФСА', scanning: true });
    await send({ t: 'ENQUEUE', names: ['ФСА'] });
    await pollUntil(async () => fsRoot.writes.has('ФСА/01 Кино - Группа крови.mp3'));
    writtenPath = [...fsRoot.writes.keys()].find((p) => p.startsWith('ФСА/')) ?? '';
    writtenBytes = fsRoot.writes.get(writtenPath);
    await send({ t: 'CANCEL' });
  }, 60000);

  it('после выбора папки режим fsa активен и permission granted', () => {
    expect(pickPerm).toBe('granted');
  });

  it('файл лежит по <Playlist>/NN. Artist - Title.ext (без baseDir)', () => {
    expect(writtenPath).toBe('ФСА/01 Кино - Группа крови.mp3');
    expect(fsRoot.dirCreates).toContain('ФСА:create');
    expect(fsRoot.fileCreates).toContain('ФСА/01 Кино - Группа крови.mp3:create');
  });

  it('записаны именно байты с ID3-тегом', () => {
    expect(writtenBytes).toBeTruthy();
    expect(String.fromCharCode(...writtenBytes!.slice(0, 3))).toBe('ID3');
    // same body as the downloads-mode file produced earlier
    const dl = results.captured.get('VK Music/Тест/01 Кино - Группа крови.mp3');
    expect(dl!.length).toBe(writtenBytes!.length);
  });
});

describe('Phase 1 (b): permission prompt → failed с storage-permission-needed, без фолбэка', () => {
  let entry: JournalEntry | undefined;
  let dlBefore = 0;
  let dlAfter = 0;
  let wrBefore = 0;
  let wrAfter = 0;

  beforeAll(async () => {
    fsRoot.perms.query = 'prompt';
    fsRoot.perms.request = 'prompt';
    dlBefore = captured.size;
    wrBefore = fsRoot.writes.size;
    await send({ t: 'AUDIOS', audios: [audioB], pl: 'ФСА2', scanning: true });
    await send({ t: 'ENQUEUE', names: ['ФСА2'] });
    const seen = await pollUntil(
      async () => (await journalEntry('ФСА2/55_102'))?.status === 'failed',
    );
    expect(seen).toBe(true);
    entry = await journalEntry('ФСА2/55_102');
    dlAfter = captured.size;
    wrAfter = fsRoot.writes.size;
    await send({ t: 'CANCEL' });
    fsRoot.perms.query = 'granted';
    fsRoot.perms.request = 'granted';
  }, 60000);

  it('предмет помечен failed с явной ошибкой прав', () => {
    expect(entry?.status).toBe('failed');
    expect(entry?.lastError).toContain('storage-permission-needed');
    expect(entry?.attempts).toBe(0); // терминальная ошибка: без retry-шторма
  });

  it('ни chrome.downloads, ни FSA-запись не сработали (нет тихого фолбэка)', () => {
    expect(dlAfter).toBe(dlBefore);
    expect(wrAfter).toBe(wrBefore);
  });
});

describe('Phase 1 (c): retry — два падения, затем успех (attempts=2 → done)', () => {
  let entry: JournalEntry | undefined;

  beforeAll(async () => {
    await send({
      t: 'SETTINGS',
      patch: {
        storageMode: 'downloads',
        minIntervalMs: 0,
        jitterMs: 0,
        baseBackoffMs: 5,
        maxBackoffMs: 25,
      },
    });
    await send({ t: 'AUDIOS', audios: [audioC], pl: 'Флэки', scanning: true });
    await send({ t: 'ENQUEUE', names: ['Флэки'] });
    const seen = await pollUntil(async () => {
      const e = await journalEntry('Флэки/55_103');
      return e?.status === 'done' || e?.status === 'failed';
    });
    expect(seen).toBe(true);
    entry = await journalEntry('Флэки/55_103');
    await send({ t: 'CANCEL' });
  }, 60000);

  it('загрузка завершилась после 2 ретраев', () => {
    expect(entry?.status).toBe('done');
    expect(entry?.attempts).toBe(2);
    expect(flakyCount).toBeGreaterThanOrEqual(3);
  });
});

/* ---- alarm emitter helpers for the race + pause/resume regression tests ---- */

const fireAlarm = (name: string): void => {
  (mockChrome.alarms.onAlarm as unknown as { emit: (n: string) => void }).emit(name);
};

const completeSlow = (file: string): void => {
  const id = slowIds.get(file);
  if (id === undefined) throw new Error('no pending slow download: ' + file);
  (mockChrome.downloads.onChanged as unknown as { emit: DlListener }).emit({
    id,
    state: { current: 'complete' },
  });
  slowIds.delete(file);
};

const dlCount = (file: string): number => dlLog.filter((n) => n === file).length;

describe('Phase 1 (pause/resume): PAUSE останавливает старты, RESUME докачивает, CANCEL хранит done', () => {
  let slowFile = '';

  beforeAll(async () => {
    // one worker so the 2nd item cannot sneak in before PAUSE lands
    await send({ t: 'SETTINGS', patch: { conc: 1, minIntervalMs: 0, jitterMs: 0, gapMs: 30 } });
    await send({
      t: 'AUDIOS',
      audios: [
        {
          key: '99_902',
          id: '902',
          owner: '99',
          artist: 'Улитка',
          title: 'Slow Track 2',
          album: '',
          year: null,
          duration: 600,
          urls: ['https://cdn/slowtrack2.aac'],
          covers: [],
        },
        {
          key: '99_903',
          id: '903',
          owner: '99',
          artist: 'Рыжий',
          title: 'Fast Track',
          album: '',
          year: null,
          duration: 30,
          urls: ['https://cdn/fasttrack.aac'],
          covers: [],
        },
      ],
      pl: 'Пауза',
      scanning: true,
    });
    await send({ t: 'ENQUEUE', names: ['Пауза'] });
    const started = await pollUntil(async () => dlLog.some((n) => n.includes('Slow Track 2')));
    expect(started).toBe(true); // guard: the ENQUEUE must actually have started the first item here
    slowFile = dlLog.find((n) => n.includes('Slow Track 2')) ?? '';
    await send({ t: 'PAUSE' });
    // the in-flight download is allowed to finish; the loop must NOT start #2
    completeSlow(slowFile);
    const done1 = await pollUntil(
      async () => (await journalEntry('Пауза/99_902'))?.status === 'done',
    );
    expect(done1).toBe(true); // guard: in-flight completes normally under PAUSE
    await sleepMs(400); // grace window: a buggy resume-pump would have started #2
  }, 60000);

  it('после PAUSE второй трек не стартовал и ждёт в очереди/журнале', async () => {
    expect(dlLog.some((n) => n.includes('Fast Track'))).toBe(false);
    const e = await journalEntry('Пауза/99_903');
    expect(e?.status).toBe('queued');
    const st = ((await send({ t: 'GET_STATE' }))[0] ?? {}) as {
      queue?: { pl: string }[];
      paused?: boolean;
    };
    expect(st.paused).toBe(true);
    expect((st.queue ?? []).filter((q) => q.pl === 'Пауза').length).toBe(1);
  });

  it('RESUME докачивает оставшийся трек ровно один раз', async () => {
    await send({ t: 'RESUME' });
    const seen = await pollUntil(
      async () => (await journalEntry('Пауза/99_903'))?.status === 'done',
    );
    expect(seen).toBe(true);
    const file = dlLog.find((n) => n.includes('Fast Track')) ?? '';
    expect(dlCount(file)).toBe(1);
  });

  it('CANCEL не порождает загрузок и сохраняет done', async () => {
    const before = dlLog.length;
    await send({ t: 'CANCEL' });
    await sleepMs(300);
    expect(dlLog.length).toBe(before);
    const jr = ((await send({ t: 'GET_JOURNAL' }))[0] ?? {}) as {
      counts?: Record<string, number>;
      entries?: { pl: string; status: string }[];
    };
    const donePl = (jr.entries ?? []).filter((e) => e.pl === 'Пауза' && e.status === 'done');
    expect(donePl.length).toBe(2); // cancel keeps done lines
    expect((jr.counts?.done ?? 0) >= 2).toBe(true); // total journal done across tests
    const st = ((await send({ t: 'GET_STATE' }))[0] ?? {}) as { queue?: { pl: string }[] };
    expect((st.queue ?? []).filter((q) => q.pl === 'Пауза').length).toBe(0);
  });
});

describe('Phase 1 (гонка): vmf-pump во время in-flight не портит живое состояние', () => {
  let targetFile = '';

  beforeAll(async () => {
    await send({ t: 'SETTINGS', patch: { conc: 1, minIntervalMs: 0, jitterMs: 0, gapMs: 30 } });
    await send({
      t: 'AUDIOS',
      audios: [
        {
          key: '99_901',
          id: '901',
          owner: '99',
          artist: 'Улитка',
          title: 'Slow Track',
          album: '',
          year: null,
          duration: 600,
          urls: ['https://cdn/slowtrack.aac'],
          covers: [],
        },
      ],
      pl: 'Гонка',
      scanning: true,
    });
    await send({ t: 'ENQUEUE', names: ['Гонка'] });
    const started = await pollUntil(async () => dlLog.some((n) => n.includes('Гонка/')));
    expect(started).toBe(true);
    targetFile = dlLog.find((n) => n.includes('Гонка/')) ?? '';
    // item is downloading RIGHT NOW (journal says 'downloading', queue is empty):
    // hammer the pump alarm like a real >60s download gets hammered
    fireAlarm('vmf-pump');
    await sleepMs(150);
    fireAlarm('vmf-pump');
    await sleepMs(150);
  }, 60000);

  it('будильник не откатывает настройки к персистентному снимку', async () => {
    // the alarm must NOT re-run cold-start load(): that merges the debounced
    // storage snapshot over live state and silently reverts user settings
    const st = ((await send({ t: 'GET_STATE' }))[0] ?? {}) as {
      settings?: { conc?: number; minIntervalMs?: number; gapMs?: number };
    };
    expect(st.settings?.conc).toBe(1);
    expect(st.settings?.minIntervalMs).toBe(0);
    expect(st.settings?.gapMs).toBe(30);
  });

  it('будильник не воскрешает очередь из журнала', async () => {
    const st = ((await send({ t: 'GET_STATE' }))[0] ?? {}) as { queue?: { pl: string }[] };
    expect((st.queue ?? []).filter((q) => q.pl === 'Гонка').length).toBe(0);
  });

  it('после завершения файл загружен ровно один раз (нет uniquify-двойника)', async () => {
    completeSlow(targetFile);
    const seen = await pollUntil(
      async () => (await journalEntry('Гонка/99_901'))?.status === 'done',
    );
    expect(seen).toBe(true);
    await sleepMs(700); // buggy path: worker pops the resurrected dup in this window
    expect(dlCount(targetFile)).toBe(1);
    expect(dlLog.some((n) => /\(1\)\.aac$/.test(n))).toBe(false); // no " (1)" uniquify twin
    const e = await journalEntry('Гонка/99_901');
    expect(e?.attempts).toBe(0);
    await send({ t: 'CANCEL' });
  });
});

describe('Phase 1 (гонка): RESUME во время in-flight не клонирует загрузку', () => {
  let targetFile = '';

  beforeAll(async () => {
    await send({ t: 'SETTINGS', patch: { conc: 1, minIntervalMs: 0, jitterMs: 0, gapMs: 30 } });
    await send({
      t: 'AUDIOS',
      audios: [
        {
          key: '99_904',
          id: '904',
          owner: '99',
          artist: 'Улитка',
          title: 'Slow Track 4',
          album: '',
          year: null,
          duration: 600,
          urls: ['https://cdn/slowtrack4.aac'],
          covers: [],
        },
      ],
      pl: 'Пауза2',
      scanning: true,
    });
    await send({ t: 'ENQUEUE', names: ['Пауза2'] });
    const started = await pollUntil(async () => dlLog.some((n) => n.includes('Пауза2/')));
    expect(started).toBe(true);
    targetFile = dlLog.find((n) => n.includes('Пауза2/')) ?? '';
    // PAUSE→RESUME while the single worker still sits inside runItem: the
    // journal line reads 'downloading' and only the in-flight guard tells the
    // rehydrator that this line belongs to a live worker, not a dead one
    await send({ t: 'PAUSE' });
    await send({ t: 'RESUME' });
  }, 60000);

  it('RESUME не ставит in-flight предмет обратно в очередь', async () => {
    const st = ((await send({ t: 'GET_STATE' }))[0] ?? {}) as { queue?: { pl: string }[] };
    expect((st.queue ?? []).filter((q) => q.pl === 'Пауза2').length).toBe(0);
  });

  it('докачка после RESUME ровно одна', async () => {
    completeSlow(targetFile);
    const seen = await pollUntil(
      async () => (await journalEntry('Пауза2/99_904'))?.status === 'done',
    );
    expect(seen).toBe(true);
    await sleepMs(700);
    expect(dlCount(targetFile)).toBe(1);
    await send({ t: 'CANCEL' });
  });
});
