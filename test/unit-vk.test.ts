import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

import { tokenUsable } from '../src/lib/vk-auth.js';
import { getAudiosById, isRestricted, resolveStreamUrls, vkCall } from '../src/lib/vk-api.js';
import type { VkAudio, VkToken } from '../src/types.js';

// Wave 2 unit tests: token lifecycle + VK API error handling.
// chrome.* is stubbed per test; no network is touched unless the test says so.

type StorageMock = { store: Record<string, unknown> };

function installChrome(mock: StorageMock): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: mock.store[key] };
        },
        async set(items: Record<string, unknown>) {
          Object.assign(mock.store, items);
        },
        async remove(key: string) {
          delete mock.store[key];
        },
      },
    },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  vi.restoreAllMocks();
});

describe('vk-auth: срок жизни токена', () => {
  const now = 1_700_000_000;
  const tok = (expires: number): VkToken => ({ access_token: 't', user_id: 1, expires });

  it('свежий токен пригоден', () => {
    assert.equal(tokenUsable(tok(now + 3600), now), true);
  });

  it('токен в пределах запаса уже не пригоден (обновляем заранее)', () => {
    // margin is 300s: 200s left is too close to rely on
    assert.equal(tokenUsable(tok(now + 200), now), false);
    assert.equal(tokenUsable(tok(now + 301), now), true);
  });

  it('истёкший токен непригоден', () => {
    assert.equal(tokenUsable(tok(now - 1), now), false);
  });

  it('токен без expires непригоден — не полагаемся на неизвестное', () => {
    assert.equal(tokenUsable(tok(0), now), false);
  });
});

describe('vk-api: обёртка вызовов', () => {
  const token: VkToken = { access_token: 'tok', user_id: 42, expires: Math.floor(Date.now() / 1000) + 3600 };

  it('успешный ответ отдаётся как есть', async () => {
    installChrome({ store: {} });
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ response: { count: 1, items: [{ id: 7 }] } }), { status: 200 }),
    );
    const r = await vkCall<{ count: number }>('audio.get', {}, { token });
    assert.equal(r.ok, true);
    assert.equal(r.data?.count, 1);
    assert.equal(r.authFailure, false);
  });

  it('токен уходит в тело запроса вместе с v', async () => {
    installChrome({ store: {} });
    let body = '';
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ response: {} }), { status: 200 });
    });
    await vkCall('audio.get', { owner_id: 42, count: 5 }, { token });
    const p = new URLSearchParams(body);
    assert.equal(p.get('access_token'), 'tok');
    assert.equal(p.get('owner_id'), '42');
    assert.equal(p.get('count'), '5');
    assert.ok(p.get('v'), 'версия API обязана быть в теле');
  });

  it('undefined-параметры не попадают в тело', async () => {
    installChrome({ store: {} });
    let body = '';
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ response: {} }), { status: 200 });
    });
    await vkCall('audio.get', { owner_id: 42, access_key: undefined }, { token });
    assert.equal(new URLSearchParams(body).has('access_key'), false);
  });

  it('ошибка VK приходит с HTTP 200 и распознаётся как ошибка', async () => {
    installChrome({ store: {} });
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: { error_code: 15, error_msg: 'Access denied' } }), { status: 200 }),
    );
    const r = await vkCall('audio.get', {}, { token });
    assert.equal(r.ok, false);
    assert.equal(r.data, null);
    assert.equal(r.authFailure, false);
    assert.match(String(r.error?.error_msg), /Access denied/);
  });

  it('код 5 (мёртвый токен) помечается как authFailure и не зацикливается', async () => {
    installChrome({ store: {} });
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response(JSON.stringify({ error: { error_code: 5, error_msg: 'User authorization failed' } }), {
        status: 200,
      });
    });
    const r = await vkCall('audio.get', {}, { token });
    assert.equal(r.authFailure, true);
    // one attempt + at most one re-mint attempt, never an infinite refresh loop
    assert.ok(calls <= 3, `ожидалось не более 3 запросов, было ${calls}`);
  });

  it('без сессии не идёт в VK API (минтинг токена — отдельный запрос)', async () => {
    installChrome({ store: {} });
    const called: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => {
      called.push(String(u));
      // the token endpoint rejects the session; nothing else must be tried
      return new Response(JSON.stringify({ type: 'error', error_info: 'unauthorized' }), { status: 200 });
    });
    const r = await vkCall('audio.get', {}, { token: null });
    assert.equal(r.authFailure, true);
    assert.equal(
      called.some((u) => u.includes('api.vk.ru')),
      false,
      'метод API не должен вызываться без токена',
    );
  });
});

describe('vk-api: разрешение ссылок (resolveStreamUrls)', () => {
  const nowSec = Math.floor(Date.now() / 1000);

  const seed = () =>
    installChrome({
      store: { vmf_vk_token_v1: { access_token: 'tok', user_id: 42, expires: nowSec + 3600 } },
    });

  it('ограниченные треки отделяются от ненайденных', async () => {
    seed();
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          response: [
            { owner_id: 1, id: 10, artist: 'A', title: 'ok', url: 'https://cdn/a.m3u8' },
            { owner_id: 1, id: 11, artist: 'B', title: 'locked', url: '', content_restricted: 2 },
            { owner_id: 1, id: 12, artist: 'C', title: 'also locked', url: '', content_restricted: 3 },
            { owner_id: 1, id: 13, artist: 'D', title: 'no url, no flag', url: '' },
          ],
        }),
        { status: 200 },
      ),
    );
    const r = await resolveStreamUrls([
      { owner_id: 1, id: 10 },
      { owner_id: 1, id: 11 },
      { owner_id: 1, id: 12 },
      { owner_id: 1, id: 13 },
      { owner_id: 1, id: 99 },
    ]);
    assert.deepEqual(r.urls, { '1_10': 'https://cdn/a.m3u8' });
    assert.deepEqual(r.restricted.sort(), ['1_11', '1_12']);
    // absent from the response, and a track without url+flag, are both "missing"
    assert.deepEqual(r.missing.sort(), ['1_13', '1_99']);
  });

  it('isRestricted распознаёт только коды 2 и 3', () => {
    assert.equal(isRestricted({ content_restricted: 2 } as VkAudio), true);
    assert.equal(isRestricted({ content_restricted: 3 } as VkAudio), true);
    assert.equal(isRestricted({ content_restricted: undefined } as VkAudio), false);
    assert.equal(isRestricted({ content_restricted: 1 } as VkAudio), false);
    assert.equal(isRestricted(null), false);
  });

  it('пустой список не делает запрос', async () => {
    seed();
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    const r = await resolveStreamUrls([]);
    assert.deepEqual(r, { urls: {}, restricted: [], missing: [] });
    assert.equal(called, false);
  });
});

describe('vk-api: getAudiosById', () => {
  const nowSec = Math.floor(Date.now() / 1000);

  it('собирает тройки owner_id_id_access_key через запятую', async () => {
    // seed a cached token so the call goes straight to the API
    installChrome({
      store: { vmf_vk_token_v1: { access_token: 'tok', user_id: 42, expires: nowSec + 3600 } },
    });
    let body = '';
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ response: [{ id: 1 }] }), { status: 200 });
    });
    await getAudiosById([
      { owner_id: -1, id: 2, access_key: 'k' },
      { owner_id: 3, id: 4 },
    ]);
    const audios = new URLSearchParams(body).get('audios');
    assert.equal(audios, '-1_2_k,3_4');
  });

  it('пустой список не делает запрос', async () => {
    installChrome({ store: {} });
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    assert.deepEqual(await getAudiosById([]), []);
    assert.equal(called, false);
  });
});
