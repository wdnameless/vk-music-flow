import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { apiSignature, md5Hex, shouldScrobble } from '../src/lib/lastfm.js';

// Last.fm client: MD5 (mandated by the signature scheme, absent from WebCrypto),
// signature construction, and the scrobble threshold.

describe('lastfm: md5', () => {
  // RFC 1321 test vectors — the signature is worthless if these are wrong.
  it('совпадает с векторами RFC 1321', () => {
    assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(md5Hex('a'), '0cc175b9c0f1b6a831c399e269772661');
    assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
    assert.equal(md5Hex('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0');
    assert.equal(
      md5Hex('abcdefghijklmnopqrstuvwxyz'),
      'c3fcd3d76192e4007dfb496cca67e13b',
    );
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
