import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

// chrome.*/fetch are stubbed per test.

import { fetchLyrics,
  filterPlayable,
  isArtistBlocked,
  isDisliked,
  normalizeBlockRules,
  normalizeName,
  parseLyricsResponse,
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
