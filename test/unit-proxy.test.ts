import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildPacScript,
  normalizeProxySettings,
  pacProxyToken,
  pickActiveEntry,
} from '../src/lib/proxy.js';
import { DEFAULT_PROXY_SETTINGS, VK_PROXY_HOSTS, type ProxyEntry, type ProxySettings } from '../src/types.js';

// Wave 1 unit tests: pure proxy config logic (no chrome.* involved).

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
