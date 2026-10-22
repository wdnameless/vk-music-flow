import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

import { RestrictedTrackError, resolveTrackUrls } from '../src/lib/resolve.js';
import type { AudioMeta } from '../src/types.js';

// Tests for download-time URL resolution: API first, hook-captured copy as the
// fallback, and a terminal error for tracks VK will never serve.

const META: AudioMeta = {
  key: '1_10',
  id: '10',
  owner: '1',
  artist: 'A',
  title: 'T',
  album: '',
  year: null,
  duration: 100,
  urls: [],
  covers: [],
  access_key: 'k',
  source: 'api',
};

const seedToken = (): void => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(key: string) {
          return {
            [key]: {
              access_token: 'tok',
              user_id: 1,
              expires: Math.floor(Date.now() / 1000) + 3600,
            },
          };
        },
        async set() {},
        async remove() {},
      },
    },
  };
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  vi.restoreAllMocks();
});

describe('resolve: порядок источников ссылки', () => {
  it('API отдаёт свежую ссылку — она и используется', async () => {
    seedToken();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            response: [
              { owner_id: 1, id: 10, artist: 'A', title: 'T', url: 'https://cdn/fresh.m3u8' },
            ],
          }),
          { status: 200 },
        ),
    );
    const r = await resolveTrackUrls({ ...META, urls: ['https://cdn/stale.mp3'] });
    assert.deepEqual(r.urls, ['https://cdn/fresh.m3u8']);
    assert.equal(r.via, 'api');
  });

  it('без access_key не тратит запрос и берёт ссылку хука', async () => {
    seedToken();
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    const r = await resolveTrackUrls({
      ...META,
      access_key: undefined,
      urls: ['https://cdn/from-hook.m3u8'],
    });
    assert.deepEqual(r.urls, ['https://cdn/from-hook.m3u8']);
    assert.equal(r.via, 'cached');
    assert.equal(called, false, 'без access_key запрос к API бессмысленен');
  });

  it('API пусто, но есть ссылка хука — используем её', async () => {
    seedToken();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ response: [{ owner_id: 1, id: 10, artist: 'A', title: 'T', url: '' }] }),
          {
            status: 200,
          },
        ),
    );
    const r = await resolveTrackUrls({ ...META, urls: ['https://cdn/from-hook.m3u8'] });
    assert.deepEqual(r.urls, ['https://cdn/from-hook.m3u8']);
    assert.equal(r.via, 'cached');
  });

  it('ссылки хука фильтруются от обложек', async () => {
    seedToken();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ response: [{ owner_id: 1, id: 10, artist: 'A', title: 'T', url: '' }] }),
          {
            status: 200,
          },
        ),
    );
    const r = await resolveTrackUrls({
      ...META,
      urls: [
        'https://sun1-24.vkuserphoto.ru/impg/x/cover.jpg?size=300x300',
        'https://cdn/track.m3u8',
      ],
    });
    assert.deepEqual(r.urls, ['https://cdn/track.m3u8']);
  });
});

describe('resolve: недоступные треки', () => {
  it('restricted + нет ссылок → терминальная ошибка', async () => {
    seedToken();
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ response: [] }), { status: 200 }),
    );
    await assert.rejects(
      () => resolveTrackUrls({ ...META, restricted: 2 }),
      (e: Error) => e instanceof RestrictedTrackError,
    );
  });

  it('restricted, но ссылка хука есть → скачиваем (трек реально играется)', async () => {
    seedToken();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            response: [
              { owner_id: 1, id: 10, artist: 'A', title: 'T', url: '', content_restricted: 2 },
            ],
          }),
          { status: 200 },
        ),
    );
    const r = await resolveTrackUrls({ ...META, restricted: 2, urls: ['https://cdn/hook.m3u8'] });
    assert.deepEqual(r.urls, ['https://cdn/hook.m3u8']);
    assert.equal(r.restricted, true, 'флаг сохраняется, чтобы UI мог предупредить');
  });

  it('НЕ restricted и ссылок нет → обычная (повторяемая) ошибка, не терминальная', async () => {
    seedToken();
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ response: [] }), { status: 200 }),
    );
    await assert.rejects(
      () => resolveTrackUrls(META),
      (e: Error) => !(e instanceof RestrictedTrackError) && /ссылку/i.test(e.message),
    );
  });
});
