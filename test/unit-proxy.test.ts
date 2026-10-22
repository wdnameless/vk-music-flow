import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildPacScript,
  checkProxy,
  installProxyAuth,
  MAX_PROXY_AUTH_RETRIES,
  normalizeProxySettings,
  pacProxyToken,
  pickActiveEntry,
  resetProxyAuthFailures,
} from '../src/lib/proxy.js';
import { toDnrRules } from '../src/lib/dnr.js';
import { DEFAULT_PROXY_SETTINGS, VK_PROXY_HOSTS, type ProxyEntry, type ProxySettings } from '../src/types.js';

// Wave 1 unit tests: proxy config logic, plus the contracts it hands to chrome.*.

const entry = (over: Partial<ProxyEntry> = {}): ProxyEntry => ({
  id: 'p1',
  label: 'test',
  scheme: 'socks5',
  host: '10.0.0.1',
  port: 1080,
  enabled: true,
  lastCheckTs: null,
  lastCheckOk: null,
  ...over,
});

const settings = (over: Partial<ProxySettings> = {}): ProxySettings => ({
  ...DEFAULT_PROXY_SETTINGS,
  entries: [entry()],
  ...over,
});

describe('proxy: выбор активного прокси', () => {
  it('берёт явно выбранный, если он включён', () => {
    const s = settings({ entries: [entry({ id: 'a' }), entry({ id: 'b' })], activeId: 'b' });
    assert.equal(pickActiveEntry(s)?.id, 'b');
  });

  it('игнорирует выбранный выключенный и падает на первый включённый', () => {
    const s = settings({
      entries: [entry({ id: 'a', enabled: false }), entry({ id: 'b' })],
      activeId: 'a',
    });
    assert.equal(pickActiveEntry(s)?.id, 'b');
  });

  it('null, когда нет ни одного включённого', () => {
    const s = settings({ entries: [entry({ enabled: false })] });
    assert.equal(pickActiveEntry(s), null);
  });

  it('null для пустого списка', () => {
    assert.equal(pickActiveEntry(settings({ entries: [] })), null);
  });
});

describe('proxy: PAC-скрипт', () => {
  it('null в режиме off', () => {
    assert.equal(buildPacScript(settings({ mode: 'off' })), null);
  });

  it('null без доступных записей — не подменяем маршрут молча', () => {
    assert.equal(buildPacScript(settings({ entries: [] })), null);
  });

  it('режим all: всё через прокси', () => {
    const pac = buildPacScript(settings({ mode: 'all' }))!;
    assert.match(pac, /SOCKS5 10\.0\.0\.1:1080/);
    assert.doesNotMatch(pac, /DIRECT/);
  });

  it('режим vk-only: VK-хосты через прокси, остальное DIRECT', () => {
    const pac = buildPacScript(settings({ mode: 'vk-only' }))!;
    assert.match(pac, /SOCKS5 10\.0\.0\.1:1080/);
    assert.match(pac, /DIRECT/);
    assert.match(pac, /VMF_HOSTS/);
    // the host list must be embedded, not referenced externally
    assert.ok(VK_PROXY_HOSTS.every((h) => pac.includes(JSON.stringify(h).slice(1, -1))));
  });

  it('PAC-скрипт синтаксически исполним и матчит поддомены', () => {
    const pac = buildPacScript(settings({ mode: 'vk-only' }))!;
    // evaluate the generated script with a stub FindProxyForURL consumer
    const run = new Function(`${pac}; return FindProxyForURL;`)() as (u: string, h: string) => string;
    const viaProxy = run('https://api.vk.ru/method/x', 'api.vk.ru');
    const viaProxyDeep = run('https://web.api.vk.ru/method/x', 'web.api.vk.ru');
    const viaProxyCdn = run('https://cs9-3v4.vkuseraudio.ru/s/v1/ac/x/index.m3u8', 'cs9-3v4.vkuseraudio.ru');
    const direct = run('https://example.com/', 'example.com');
    // suffix matching must not leak to lookalike domains
    const lookalike = run('https://notvk.ru/', 'notvk.ru');
    const lookalike2 = run('https://evilvk.com/', 'evilvk.com');
    assert.match(viaProxy, /SOCKS5/);
    assert.match(viaProxyDeep, /SOCKS5/);
    assert.match(viaProxyCdn, /SOCKS5/);
    assert.equal(direct, 'DIRECT');
    assert.equal(lookalike, 'DIRECT');
    assert.equal(lookalike2, 'DIRECT');
  });

  it('схемы прокси транслируются в PAC-токены', () => {
    assert.equal(pacProxyToken(entry({ scheme: 'http' })), 'PROXY 10.0.0.1:1080');
    assert.equal(pacProxyToken(entry({ scheme: 'socks5' })), 'SOCKS5 10.0.0.1:1080');
    assert.equal(pacProxyToken(entry({ scheme: 'socks4' })), 'SOCKS4 10.0.0.1:1080');
  });
});

describe('proxy: нормализация сохранённых настроек', () => {
  it('мусор превращается в defaults, а не падает', () => {
    assert.deepEqual(normalizeProxySettings(null), {
      mode: DEFAULT_PROXY_SETTINGS.mode,
      entries: [],
      activeId: null,
    });
    assert.deepEqual(normalizeProxySettings('nonsense'), {
      mode: DEFAULT_PROXY_SETTINGS.mode,
      entries: [],
      activeId: null,
    });
  });

  it('неизвестный режим откатывается к vk-only', () => {
    assert.equal(normalizeProxySettings({ mode: 'turbo' }).mode, 'vk-only');
  });

  it('записи без host/port отбрасываются, валидные — сохраняются', () => {
    const s = normalizeProxySettings({
      entries: [{ host: '1.1.1.1', port: 1080 }, { label: 'no host' }, null, { host: '2.2.2.2' }],
    });
    assert.equal(s.entries.length, 1);
    assert.equal(s.entries[0]!.host, '1.1.1.1');
  });

  it('credentials и схема сохраняются, дефолты подставляются', () => {
    const s = normalizeProxySettings({
      entries: [{ id: 'x', host: 'proxy.local', port: 8080, username: 'u', password: 'p', scheme: 'https' }],
    });
    const e = s.entries[0]!;
    assert.equal(e.username, 'u');
    assert.equal(e.password, 'p');
    assert.equal(e.scheme, 'https');
    assert.equal(e.enabled, true);
  });

  it('неизвестная схема откатывается к http', () => {
    const s = normalizeProxySettings({ entries: [{ host: 'h', port: 1, scheme: 'quic' }] });
    assert.equal(s.entries[0]!.scheme, 'http');
  });

  it('нечисловой порт отбрасывается, числовая строка принимается', () => {
    assert.equal(normalizeProxySettings({ entries: [{ host: 'h', port: 'abc' }] }).entries.length, 0);
    // chrome.storage round-trips can hand back numeric strings
    const s = normalizeProxySettings({ entries: [{ host: 'h', port: '1080' }] });
    assert.equal(s.entries.length, 1);
    assert.equal(s.entries[0]!.port, 1080);
  });

  it('порт вне диапазона отбрасывается', () => {
    assert.equal(normalizeProxySettings({ entries: [{ host: 'h', port: 0 }] }).entries.length, 0);
    assert.equal(normalizeProxySettings({ entries: [{ host: 'h', port: 70000 }] }).entries.length, 0);
    assert.equal(normalizeProxySettings({ entries: [{ host: 'h', port: 65535 }] }).entries.length, 1);
  });
});


describe('proxy: ответ на запрос авторизации', () => {
  /** Capture the listener the module registers with chrome.webRequest. */
  const capture = (getSettings: () => ProxySettings) => {
    type Handler = (d: unknown, cb: (r?: unknown) => void) => void;
    let handler: Handler | null = null;
    const original = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      webRequest: {
        onAuthRequired: {
          addListener: (h: Handler) => {
            handler = h;
          },
          removeListener: () => undefined,
        },
      },
    };
    installProxyAuth(getSettings);
    (globalThis as { chrome?: unknown }).chrome = original;
    assert.ok(handler, 'обработчик должен регистрироваться');
    return handler as Handler;
  };

  const asked = (handler: (d: unknown, cb: (r?: unknown) => void) => void, details: unknown) => {
    let seen: unknown;
    handler(details, (r) => {
      seen = r;
    });
    return seen;
  };

  it('отдаёт пароль вложенным в authCredentials', () => {
    // Chrome rejects the whole response unless the pair sits under
    // authCredentials, and every proxied request then fails with no clue why.
    const handler = capture(() => settings({ entries: [entry({ username: 'u', password: 'p' })] }));
    assert.deepEqual(asked(handler, { isProxy: true, host: '10.0.0.1', port: 1080 }), {
      authCredentials: { username: 'u', password: 'p' },
    });
  });

  it('молчит, когда челлендж не от прокси', () => {
    const handler = capture(() => settings({ entries: [entry({ username: 'u', password: 'p' })] }));
    assert.equal(asked(handler, { isProxy: false, host: '10.0.0.1', port: 1080 }), undefined);
  });

  it('молчит, когда у записи нет логина', () => {
    const handler = capture(() => settings({ entries: [entry()] }));
    assert.equal(asked(handler, { isProxy: true, host: '10.0.0.1', port: 1080 }), undefined);
  });

  it('сверяет авторизацию с details.challenger (host и port) (R13)', () => {
    resetProxyAuthFailures();
    const targetEntry = entry({ id: 'p_corp', host: 'proxy.corp.internal', port: 8080, username: 'user_corp', password: 'pwd' });
    const fallbackEntry = entry({ id: 'p_def', host: 'default.proxy', port: 1080, username: 'user_def', password: 'def' });
    const handler = capture(() => settings({ entries: [targetEntry, fallbackEntry] }));

    // details.host is the destination web server, details.challenger is the proxy challenge
    const res = asked(handler, {
      isProxy: true,
      host: 'api.vk.ru',
      port: 443,
      challenger: { host: 'proxy.corp.internal', port: 8080 },
    });
    assert.deepEqual(res, {
      authCredentials: { username: 'user_corp', password: 'pwd' },
    });
  });

  it('счётчик подряд отклонённых авторизаций (407) останавливается на пороге и помечает lastCheckOk=false (R14)', () => {
    resetProxyAuthFailures();
    const badEntry = entry({ id: 'p_bad', host: 'bad.proxy', port: 1080, username: 'u', password: 'wrong' });
    const handler = capture(() => settings({ entries: [badEntry] }));

    for (let i = 0; i < MAX_PROXY_AUTH_RETRIES; i++) {
      const res = asked(handler, { isProxy: true, host: 'bad.proxy', port: 1080 });
      assert.deepEqual(res, { authCredentials: { username: 'u', password: 'wrong' } });
    }
    // Next attempt exceeds threshold: should stop (call cb() without credentials) and mark entry failed
    const stopped = asked(handler, { isProxy: true, host: 'bad.proxy', port: 1080 });
    assert.equal(stopped, undefined);
    assert.equal(badEntry.lastCheckOk, false);
  });
});

describe('proxy: liveness probe (checkProxy)', () => {
  it('407 и 502 от прокси возвращают ok: false (R15)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response('Proxy Auth Required', { status: 407 });
      const r407 = await checkProxy();
      assert.equal(r407.ok, false);
      assert.equal(r407.status, 407);

      globalThis.fetch = async () => new Response('Bad Gateway', { status: 502 });
      const r502 = await checkProxy();
      assert.equal(r502.ok, false);
      assert.equal(r502.status, 502);

      globalThis.fetch = async () => new Response('{"response":{}}', { status: 200 });
      const r200 = await checkProxy();
      assert.equal(r200.ok, true);
      assert.equal(r200.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('dnr: перенос ссылок vk.com на vk.ru', () => {
  it('сохраняет поддомен при редиректе', () => {
    type Rule = { id: number; action: { redirect?: { regexSubstitution?: string } }; condition: { regexFilter?: string } };
    const rule = (toDnrRules('someextensionid') as Rule[]).find((r) => r.id === 7);
    assert.ok(rule, 'правило 7 должно устанавливаться');
    const re = new RegExp(rule.condition.regexFilter!);
    // Chrome writes backreferences as \1; String.replace wants $1.
    const sub = rule.action.redirect!.regexSubstitution!.replace(/\\(\d)/g, '$$$1');
    const rewrite = (u: string) => u.replace(re, sub);
    // The API client lives on api.vk.ru, so collapsing the subdomain turns every
    // API call into a request to the wrong host.
    assert.equal(rewrite('https://api.vk.com/method/users.get?v=5.199'), 'https://api.vk.ru/method/users.get?v=5.199');
    assert.equal(rewrite('https://login.vk.com/?act=login'), 'https://login.vk.ru/?act=login');
    assert.equal(rewrite('https://vk.com/feed'), 'https://vk.ru/feed');
    assert.equal(rewrite('https://notvk.com/x'), 'https://notvk.com/x');
  });
});
