import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';

import { computeBackoff, computeStartDelay } from '../src/lib/backoff.js';
import {
  deserializeJournal,
  type JournalKv,
  Journal,
  journalId,
  serializeJournal,
} from '../src/lib/journal.js';
import {
  ensurePermission,
  loadRootHandle,
  persistRootHandle,
  clearRootHandle,
  writeToRoot,
} from '../src/storage/fs.js';
import type { FsPermissionStatus, JournalEntry, QueueItem, RootDirHandle } from '../src/types.js';
import { installFakeIndexedDB, makeFakeFsRoot } from './mock-fs.js';

// Phase 1 unit tests: pure logic only (backoff/jitter bounds, mock-FS write
// chain, journal codec, permission mapping, IDB handle round-trip via fake).

const q = (pl: string, key: string, idx = 1, w = 2): QueueItem => ({ key, pl, idx, w });
const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  key: '55_1',
  pl: 'P',
  idx: 1,
  w: 2,
  status: 'queued',
  attempts: 0,
  lastError: null,
  ts: 111,
  ...over,
});

const uninstallers: Array<() => void> = [];
afterEach(() => {
  while (uninstallers.length) (uninstallers.pop() as () => void)();
});

describe('backoff: экспоненциальный ретрай с джиттером', () => {
  it('rand=0 -> ровно min(max, base*2^attempt)', () => {
    assert.equal(computeBackoff(0, 1000, 30000, 0), 1000);
    assert.equal(computeBackoff(1, 1000, 30000, 0), 2000);
    assert.equal(computeBackoff(4, 1000, 30000, 0), 16000);
    assert.equal(computeBackoff(5, 1000, 30000, 0), 30000); // cap
    assert.equal(computeBackoff(50, 1000, 30000, 0), 30000); // cap, no overflow
  });
  it('границы джиттера: [exp, exp+jitter)', () => {
    const lo = computeBackoff(2, 100, 5000, 700, () => 0);
    const hi = computeBackoff(2, 100, 5000, 700, () => 0.9999999);
    assert.equal(lo, 400);
    assert.ok(hi >= 1099 && hi <= 1100);
  });
  it('монотонность и потолок с джиттером', () => {
    for (let a = 0; a < 12; a++) {
      const d = computeBackoff(a, 500, 30000, 400);
      const cap = Math.min(30000, 500 * 2 ** a);
      assert.ok(d >= cap && d <= cap + 400, `attempt ${a}: ${d}`);
    }
  });
  it('computeStartDelay: wait после последнего старта', () => {
    assert.equal(computeStartDelay(1000, 500, 0, 1100), 400); // 1100-1000=100 since
    assert.equal(computeStartDelay(1000, 500, 0, 2000), 0); // interval elapsed
    const d = computeStartDelay(1000, 500, 100, 1400, () => 0.5);
    assert.equal(d, 100 + 50); // remaining 100 plus half jitter
  });
});

describe('writeToRoot: цепочка getDirectoryHandle/getFileHandle/createWritable', () => {
  it('создаёт вложенные папки, файл и пишет байты', async () => {
    const fs = makeFakeFsRoot('MusicDisk');
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const res = await writeToRoot(fs.handle as RootDirHandle, 'Рок/годный/01 A - B.mp3', bytes);
    assert.equal(res.path, 'Рок/годный/01 A - B.mp3');
    assert.ok(fs.dirCreates.includes('Рок:create'));
    assert.ok(fs.dirCreates.includes('Рок/годный:create'));
    assert.ok(fs.fileCreates.includes('Рок/годный/01 A - B.mp3:create'));
    const written = fs.writes.get('Рок/годный/01 A - B.mp3');
    assert.ok(written);
    assert.deepEqual([...written], [1, 2, 3, 4, 5]);
  });
  it('вырезает ., .. и пустые сегменты', async () => {
    const fs = makeFakeFsRoot();
    const res = await writeToRoot(
      fs.handle as RootDirHandle,
      'a//../b/./c.bin',
      new Uint8Array([9]),
    );
    assert.equal(res.path, 'a/b/c.bin');
    assert.ok(!fs.dirCreates.some((d) => d.startsWith('..')));
  });
  it('плоский путь = файл в корне', async () => {
    const fs = makeFakeFsRoot();
    const res = await writeToRoot(fs.handle as RootDirHandle, 'top.aac', new Uint8Array([7, 7]));
    assert.equal(res.path, 'top.aac');
    assert.equal(fs.writes.get('top.aac')?.length, 2);
  });
});

describe('ensurePermission: маппинг статусов', () => {
  const mk = (query: FsPermissionStatus, request: FsPermissionStatus) => ({
    queryPermission: async () => query,
    requestPermission: async () => request,
  });
  it('granted без запроса', async () => {
    assert.equal(await ensurePermission(mk('granted', 'granted'), false), 'granted');
  });
  it('prompt + request=false -> prompt (без жеста не просим)', async () => {
    assert.equal(await ensurePermission(mk('prompt', 'granted'), false), 'prompt');
  });
  it('prompt + request=true -> granted', async () => {
    assert.equal(await ensurePermission(mk('prompt', 'granted'), true), 'granted');
  });
  it('prompt + request=true -> prompt (отказ в диалоге)', async () => {
    assert.equal(await ensurePermission(mk('prompt', 'prompt'), true), 'prompt');
  });
  it('denied -> denied', async () => {
    assert.equal(await ensurePermission(mk('denied', 'granted'), false), 'denied');
  });
  it('исключение в query -> denied', async () => {
    const boom = {
      queryPermission: async (): Promise<FsPermissionStatus> => {
        throw new Error('nope');
      },
      requestPermission: async (): Promise<FsPermissionStatus> => 'granted',
    };
    assert.equal(await ensurePermission(boom, true), 'denied');
  });
});

describe('журнал: сериализация/десериализация', () => {
  it('round-trip сохраняет все поля', () => {
    const list = [
      entry(),
      entry({ pl: 'Q', key: '55_2', status: 'failed', attempts: 3, lastError: 'HTTP 500' }),
    ];
    const back = deserializeJournal(JSON.parse(JSON.stringify(serializeJournal(list))));
    assert.equal(back.length, 2);
    assert.deepEqual(back[1], list[1]);
    assert.equal(journalId(list[1]!), 'Q/55_2');
  });
  it('мусор и кривые записи отфильтровываются', () => {
    assert.deepEqual(deserializeJournal(null), []);
    assert.deepEqual(deserializeJournal({ v: 2, items: {} }), []);
    const bad: unknown = {
      v: 1,
      items: {
        good: entry(),
        badStatus: { ...entry(), key: 'k2', status: 'exploded' },
        badNum: { ...entry(), key: 'k3', idx: NaN },
        notObj: 'wat',
      },
    };
    assert.deepEqual(
      deserializeJournal(bad).map((e) => e.key),
      ['55_1'],
    );
  });
  it('Journal: ensure/persist/attemptCount/pendingEntries/dropPending', async () => {
    let saved: unknown = null;
    const kv: JournalKv = {
      load: async () => saved,
      save: async (v) => {
        saved = JSON.parse(JSON.stringify(v));
      },
    };
    const j = new Journal(kv);
    await j.hydrate();
    await j.ensure(q('A', 'k1'));
    await j.ensure(q('A', 'k2'));
    assert.equal(j.counts().queued, 2);
    assert.equal(j.pendingEntries().length, 2);
    const id1 = journalId(q('A', 'k1'));
    await j.setStatus(id1, 'downloading');
    await j.bumpAttempt(id1, 'HTTP 503');
    assert.equal(j.attemptCount(id1), 1);
    await j.setStatus(id1, 'failed');
    assert.equal(j.counts().failed, 1);
    await j.dropPending();
    assert.equal(j.counts().queued, 0);
    assert.equal(j.counts().failed, 1);
    // persistence round-trips through the kv
    const j2 = new Journal(kv);
    await j2.hydrate();
    assert.equal(j2.attemptCount(id1), 1);
  });
});

describe('handle-хранилище: IndexedDB round-trip (фейк)', () => {
  it('persist -> load -> clear', async () => {
    uninstallers.push(installFakeIndexedDB());
    const fs = makeFakeFsRoot('DiskY');
    const h = fs.handle as RootDirHandle;
    await persistRootHandle(h);
    assert.equal(await loadRootHandle(), h);
    await clearRootHandle();
    assert.equal(await loadRootHandle(), null);
  });
  it('load без indexedDB -> null (graceful)', async () => {
    // no fake installed and node env has no indexedDB
    assert.equal(await loadRootHandle(), null);
  });
});
