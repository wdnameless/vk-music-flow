import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  apiSignature,
  flushScrobbles,
  isSessionInvalid,
  md5Hex,
  scrobbleBatch,
  shouldScrobble,
} from '../src/lib/lastfm.js';
import type { ScrobbleQueueItem } from '../src/types.js';

// Last.fm client: MD5 (mandated by the signature scheme, absent from WebCrypto),
// signature construction, and the scrobble threshold.

describe('lastfm: md5', () => {
  // RFC 1321 test vectors — the signature is worthless if these are wrong.
  it('совпадает с векторами RFC 1321', () => {
    assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(md5Hex('a'), '0cc175b9c0f1b6a831c399e269772661');
    assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
    assert.equal(md5Hex('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0');
    assert.equal(md5Hex('abcdefghijklmnopqrstuvwxyz'), 'c3fcd3d76192e4007dfb496cca67e13b');
  });

  it('переводит кириллицу в UTF-8 перед хешированием', () => {
    // "Кино" as UTF-8
    const expected = md5Hex(new TextDecoder().decode(new TextEncoder().encode('Кино')));
    assert.equal(md5Hex('Кино'), expected);
    assert.equal(md5Hex('Кино').length, 32);
  });

  it('различает строки, отличающиеся на один символ', () => {
    assert.notEqual(md5Hex('track'), md5Hex('tracks'));
  });
});

describe('lastfm: подпись запроса', () => {
  it('сортирует параметры и отбрасывает format', () => {
    const sig = apiSignature({ b: '2', a: '1', format: 'json' }, 'sec');
    // md5('a1b2sec')
    assert.equal(sig, md5Hex('a1b2sec'));
  });

  it('исключает callback, но не остальные параметры', () => {
    const sig = apiSignature({ callback: 'x', a: '1' }, 's');
    assert.equal(sig, md5Hex('a1s'));
  });

  it('меняется при смене секрета', () => {
    const p = { a: '1' };
    assert.notEqual(apiSignature(p, 'one'), apiSignature(p, 'two'));
  });
});

describe('lastfm: правило скробблинга', () => {
  it('без авторизации не скробблим', () => {
    assert.equal(shouldScrobble(300, 200, false), false);
  });

  it('короче 30 секунд не скробблим', () => {
    assert.equal(shouldScrobble(20, 600, true), false);
  });

  it('порог — половина длительности, но не больше 4 минут', () => {
    // Last.fm: scrobble at half the track OR 4 minutes, whichever comes FIRST.
    // A 10-minute track therefore qualifies at 240s, not 300s.
    assert.equal(shouldScrobble(239, 600, true), false);
    assert.equal(shouldScrobble(240, 600, true), true);
    // A short track qualifies at its own half.
    assert.equal(shouldScrobble(59, 120, true), false);
    assert.equal(shouldScrobble(60, 120, true), true);
  });

  it('4 минуты — потолок для очень длинных', () => {
    assert.equal(shouldScrobble(240, 3600, true), true);
  });

  it('без известной длительности достаточно 30 секунд', () => {
    assert.equal(shouldScrobble(30, null, true), true);
    assert.equal(shouldScrobble(29, null, true), false);
  });
});

describe('lastfm: проверка инвалидности сессии (isSessionInvalid)', () => {
  it('только код 9 считается мёртвой сессией, 11 и 16 — временные (R18)', () => {
    assert.equal(isSessionInvalid(9), true, 'код 9 — инвалидная сессия');
    assert.equal(isSessionInvalid(16), false, 'код 16 — временная ошибка, сессия жива');
    assert.equal(isSessionInvalid(11), false, 'код 11 — сервис офлайн, сессия жива');
    assert.equal(isSessionInvalid(undefined), false);
    assert.equal(isSessionInvalid(4), false);
  });
});

describe('lastfm: пакетный скробблинг и очередь (scrobbleBatch & flushScrobbles)', () => {
  const creds = { apiKey: 'key', secret: 'sec', sessionKey: 'sk' };
  const item = (i: number): ScrobbleQueueItem => ({
    artist: 'Artist',
    title: `Track ${i}`,
    duration: 180,
    startedAt: 1700000000000 + i * 1000,
  });

  it('scrobbleBatch возвращает необработанный хвост rest > 50 (R17)', async () => {
    const items = Array.from({ length: 65 }, (_, i) => item(i));
    const originalFetch = globalThis.fetch;
    try {
      let bodyText = '';
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        void input;
        bodyText = String(init?.body ?? '');
        return new Response(
          JSON.stringify({ scrobbles: { '@attr': { accepted: 50, ignored: 0 } } }),
          { status: 200 },
        );
      }) as typeof fetch;
      const res = await scrobbleBatch(items, creds);
      assert.equal(res.ok, true);
      assert.equal(res.accepted, 50);
      assert.ok(Array.isArray(res.rest), 'rest должен быть массивом');
      assert.equal(res.rest?.length, 15, 'остаток должен содержать 15 треков');
      assert.equal(res.rest?.[0]?.title, 'Track 50');
      // body has artist[49] but not artist[50]
      const p = new URLSearchParams(bodyText);
      assert.ok(p.has('artist[49]'));
      assert.equal(p.has('artist[50]'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('scrobbleBatch возвращает полный rest при ошибке отправки', async () => {
    const items = Array.from({ length: 10 }, (_, i) => item(i));
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: 16, message: 'There was a temporary error' }), {
          status: 200,
        });
      const res = await scrobbleBatch(items, creds);
      assert.equal(res.ok, false);
      assert.equal(res.code, 16);
      assert.equal(res.rest?.length, 10);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('flushScrobbles отправляет все пачки и складывает rest обратно в очередь (R17)', async () => {
    const queue = Array.from({ length: 120 }, (_, i) => item(i));
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    try {
      globalThis.fetch = (async () => {
        callCount++;
        if (callCount <= 2) {
          // First 2 batches (50 + 50) succeed
          return new Response(
            JSON.stringify({ scrobbles: { '@attr': { accepted: 50, ignored: 0 } } }),
            { status: 200 },
          );
        }
        // Third batch fails
        return new Response(JSON.stringify({ error: 16, message: 'Temporary failure' }), {
          status: 200,
        });
      }) as typeof fetch;

      const res = await flushScrobbles(queue, creds);
      assert.equal(res.ok, false);
      assert.equal(res.sent, 100);
      assert.equal(res.pending, 20);
      assert.equal(queue.length, 20, 'в очереди должно остаться ровно 20 неотправленных элементов');
      assert.equal(queue[0]?.title, 'Track 100');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
