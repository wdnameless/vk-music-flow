import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Port of test/sw-harness.mjs (v0.2.2 baseline): mocks chrome.*, drives the
// service-worker pipeline end-to-end and keeps the original 10 checks.

type DlListener = (d: { id: number; state?: { current?: string } }) => void;

const captured = new Map<string, Uint8Array>();
const blobUrls = new Map<string, Blob | Uint8Array>();
let uid = 0;
let dlId = 1;

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
  if (u.includes('/direct.mp3')) return body(directWithOldTag);
  if (u.includes('/cover.jpg')) return body(cover);
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
  f1: string | undefined;
  f2: string | undefined;
  f3: string | undefined;
  frameIds: () => string;
  tailOk: () => boolean;
} = {} as never;

let send: Send = async () => [];

const dlListeners: DlListener[] = [];

const mockChrome = {
  storage: { local: { get: async () => ({}), set: async () => undefined } },
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
      const blob = blobUrls.get(url);
      if (blob) {
        const bytes =
          blob instanceof Uint8Array ? blob : new Uint8Array(await (blob as Blob).arrayBuffer());
        captured.set(filename, bytes);
      }
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
    expect(captured.size).toBeGreaterThanOrEqual(2);
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
