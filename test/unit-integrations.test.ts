import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

// chrome.*/fetch are stubbed per test.

import {
  apiSignature,
  fetchLyrics,
  filterPlayable,
  isArtistBlocked,
  isDisliked,
  md5Hex,
  normalizeBlockRules,
  normalizeLastfm,
  normalizeName,
  parseLyricsResponse,
  shouldScrobble,
  skipReason,
} from '../src/lib/integrations.js';
import type { BlockRules } from '../src/types.js';

// Wave 3 unit tests: MD5 (Last.fm mandates it and WebCrypto refuses), signature
// construction, block-list matching, scrobble rules and lyrics parsing.

afterEach(() => {
  vi.restoreAllMocks();
});

const rules = (over: Partial<BlockRules> = {}): BlockRules => ({
  blockedArtists: [],
  disliked: [],
  ...over,
});

describe('integrations: md5', () => {
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

describe('integrations: подпись Last.fm', () => {
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

describe('integrations: блокировка артистов', () => {
  it('нормализация убирает регистр, пунктуацию и диакритику', () => {
    assert.equal(normalizeName('AC/DC'), 'acdc');
    assert.equal(normalizeName('Björk'), 'bjork');
    assert.equal(normalizeName('  Кино  '), 'кино');
    assert.equal(normalizeName('!!!'), '');
  });

  it('блокирует по нормализованному совпадению', () => {
    const r = rules({ blockedArtists: ['AC/DC'] });
    assert.equal(isArtistBlocked('acdc', r), true);
    assert.equal(isArtistBlocked('AC/DC', r), true);
    assert.equal(isArtistBlocked('ACDC', r), true);
    assert.equal(isArtistBlocked('Metallica', r), false);
  });

  it('блокирует вхождение (артист с фитом)', () => {
    const r = rules({ blockedArtists: ['Кино'] });
    assert.equal(isArtistBlocked('Кино feat. Виктор Цой', r), true);
  });

  it('пустые правила ничего не блокируют', () => {
    assert.equal(isArtistBlocked('Кто угодно', rules()), false);
  });

  it('пустая строка в списке не блокирует всё подряд', () => {
    assert.equal(isArtistBlocked('Кто угодно', rules({ blockedArtists: ['', '   '] })), false);
  });
});

describe('integrations: дизлайки и пропуск', () => {
  it('дизлайк опознаётся по ключу owner_id', () => {
    const r = rules({ disliked: ['1_10'] });
    assert.equal(isDisliked('1', '10', r), true);
    assert.equal(isDisliked('1', '11', r), false);
  });

  it('причина пропуска различает артиста и дизлайк', () => {
    const r = rules({ blockedArtists: ['Кино'], disliked: ['1_10'] });
    assert.equal(skipReason({ owner: '1', id: '10', artist: 'Кино' }, r), 'blocked-artist');
    assert.equal(skipReason({ owner: '1', id: '10', artist: 'Мастер' }, r), 'disliked');
    assert.equal(skipReason({ owner: '2', id: '20', artist: 'Мастер' }, r), null);
  });

  it('filterPlayable сохраняет порядок и убирает только запрещённое', () => {
    const r = rules({ blockedArtists: ['Кино'], disliked: ['2_20'] });
    const tracks = [
      { owner: '1', id: '10', artist: 'Мастер' },
      { owner: '1', id: '11', artist: 'Кино' },
      { owner: '2', id: '20', artist: 'Друг' },
      { owner: '3', id: '30', artist: 'Третий' },
    ];
    assert.deepEqual(
      filterPlayable(tracks, r).map((t) => t.id),
      ['10', '30'],
    );
  });
});

describe('integrations: правило скробблинга', () => {
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

describe('integrations: разбор текста и настроек', () => {
  it('текст из ответа VK извлекается и обрезается', () => {
    assert.deepEqual(parseLyricsResponse({ lyrics: { text: '  привет  ', lyrics_id: 7 } }), {
      text: 'привет',
      id: 7,
    });
  });

  it('пустой или отсутствующий текст даёт null', () => {
    assert.equal(parseLyricsResponse({ lyrics: { text: '   ' } }), null);
    assert.equal(parseLyricsResponse({}), null);
    assert.equal(parseLyricsResponse(null), null);
  });

  it('правила из хранилища фильтруются от мусора', () => {
    const r = normalizeBlockRules({ blockedArtists: ['A', '', 5, null], disliked: ['1_2', 3] });
    assert.deepEqual(r.blockedArtists, ['A']);
    assert.deepEqual(r.disliked, ['1_2']);
    assert.deepEqual(normalizeBlockRules(null), { blockedArtists: [], disliked: [] });
  });

  it('креды Last.fm нормализуются', () => {
    const a = normalizeLastfm({ apiKey: ' k ', secret: ' s ', sessionKey: '', username: undefined });
    assert.deepEqual(a, { apiKey: 'k', secret: 's', sessionKey: null, username: null });
    assert.deepEqual(normalizeLastfm(undefined), {
      apiKey: '',
      secret: '',
      sessionKey: null,
      username: null,
    });
  });
});

describe('integrations: резервный источник текстов', () => {
  it('найденный текст возвращается', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ lyrics: '  Первый куплет…  ' }), { status: 200 }),
    );
    const r = await fetchLyrics('Кино', 'Группа крови');
    assert.equal(r.ok, true);
    assert.equal(r.lyrics?.text, 'Первый куплет…');
  });

  it('404 — это «не найдено», а не ошибка сети', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    const r = await fetchLyrics('Кто-то', 'Что-то');
    assert.equal(r.ok, false);
    assert.equal(r.lyrics, null);
    assert.match(String(r.error), /не найден/);
  });

  it('пустой текст не считается найденным', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ lyrics: '   ' }), { status: 200 }));
    const r = await fetchLyrics('A', 'B');
    assert.equal(r.ok, false);
  });

  it('без исполнителя или названия запрос не делается', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    assert.equal((await fetchLyrics('', 'T')).ok, false);
    assert.equal((await fetchLyrics('A', '  ')).ok, false);
    assert.equal(called, false);
  });
});
