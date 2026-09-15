import {
  DEFAULT_PROXY_SETTINGS,
  VK_PROXY_HOSTS,
  type ProxyAppliedState,
  type ProxyCheckResult,
  type ProxyEntry,
  type ProxyRoutingMode,
  type ProxySettings,
} from '../types.js';

/**
 * Proxy routing for VK access from outside Russia.
 *
 * Why this shape (verified empirically on a real MV3 worker, not from docs):
 *  - `chrome.proxy.settings` IS available in MV3 service workers with only the
 *    `proxy` permission — no host permissions, no background page.
 *  - PAC is evaluated per request, so `vk-only` can route ONLY VK hosts through
 *    the proxy and leave the rest of the browser direct. Probed live:
 *    `CONNECT api.vk.ru:443` hit the proxy while `example.com` went DIRECT.
 *  - Chromium rejects `chrome.proxy.settings.set` with mode `fixed_servers`
 *    when the config carries no `rules`; PAC is the only mode that expresses
 *    "these hosts only" without enumerating bypass lists.
 *  - Proxies with credentials need `chrome.webRequest.onAuthRequired` +
 *    `asyncBlocking`; that combination registers fine in MV3 but is only
 *    allowed with the `webRequest` + `webRequestAuthProvider` permissions.
 */

const PROXY_APPLY_TIMEOUT_MS = 8000;

/* ------------------------------------------------------------------ */
/* Pure config helpers (unit-testable, no chrome.*)                    */
/* ------------------------------------------------------------------ */

/** First enabled entry, or the one flagged active. Null when none usable. */
export function pickActiveEntry(s: ProxySettings): ProxyEntry | null {
  if (!s.entries.length) return null;
  if (s.activeId) {
    const hit = s.entries.find((e) => e.id === s.activeId && e.enabled);
    if (hit) return hit;
  }
  return s.entries.find((e) => e.enabled) ?? null;
}

/** PAC `PROXY host:port` token. SOCKS is spelled `SOCKS5`/`SOCKS4` in PAC. */
export function pacProxyToken(e: ProxyEntry): string {
  const scheme = e.scheme === 'socks5' ? 'SOCKS5' : e.scheme === 'socks4' ? 'SOCKS4' : 'PROXY';
  return `${scheme} ${e.host}:${e.port}`;
}

/**
 * Build the PAC script for the given settings.
 *
 * `vk-only` matches host suffixes so `api.vk.ru`, `web.api.vk.ru` and the CDN
 * hosts all route through the proxy while everything else stays direct.
 * The host list is passed in as JSON so it cannot break out of the script.
 */
export function buildPacScript(s: ProxySettings): string | null {
  const entry = pickActiveEntry(s);
  if (s.mode === 'off' || !entry) return null;
  const direct = 'DIRECT';
  if (s.mode === 'all') {
    const token = pacProxyToken(entry);
    return [
      'function FindProxyForURL(url, host) {',
      `  return ${JSON.stringify(token)};`,
      '}',
    ].join('\n');
  }
  return [
    `var VMF_HOSTS = ${JSON.stringify(VK_PROXY_HOSTS)};`,
    'function vmfMatches(host) {',
    '  host = host.toLowerCase();',
    '  for (var i = 0; i < VMF_HOSTS.length; i++) {',
    '    var h = VMF_HOSTS[i];',
    '    if (host === h || host.length > h.length && host.slice(-(h.length + 1)) === "." + h) return true;',
    '  }',
    '  return false;',
    '}',
    'function FindProxyForURL(url, host) {',
    `  if (vmfMatches(host)) return ${JSON.stringify(pacProxyToken(entry))};`,
    `  return ${JSON.stringify(direct)};`,
    '}',
  ].join('\n');
}

/** Sanitize whatever came out of storage into a valid ProxySettings. */
export function normalizeProxySettings(raw: unknown): ProxySettings {
  const o = (raw ?? {}) as Partial<ProxySettings>;
  const mode: ProxyRoutingMode =
    o.mode === 'off' || o.mode === 'all' || o.mode === 'vk-only' ? o.mode : DEFAULT_PROXY_SETTINGS.mode;
  const toPort = (v: unknown): number => {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n > 0 && n < 65536 ? Math.trunc(n) : 0;
  };
  const entries: ProxyEntry[] = Array.isArray(o.entries)
    ? o.entries
        .map((e) => e as Partial<ProxyEntry> | null | undefined)
        .filter((e): e is Partial<ProxyEntry> => !!e && typeof e.host === 'string' && e.host.length > 0)
        // A usable entry needs a real port; storage may hand back a numeric string.
        .map((e) => ({ ...e, port: toPort(e.port) }))
        .filter((e) => e.port > 0)
        .map((e) => ({
          id: String(e.id || crypto.randomUUID()),
          label: String(e.label || e.host),
          scheme: e.scheme === 'https' || e.scheme === 'socks4' || e.scheme === 'socks5' ? e.scheme : 'http',
          host: String(e.host),
          port: e.port,
          username: e.username ? String(e.username) : undefined,
          password: e.password ? String(e.password) : undefined,
          enabled: e.enabled !== false,
          lastCheckTs: typeof e.lastCheckTs === 'number' ? e.lastCheckTs : null,
          lastCheckOk: typeof e.lastCheckOk === 'boolean' ? e.lastCheckOk : null,
        }))
    : [];
  const activeId = typeof o.activeId === 'string' ? o.activeId : null;
  return { mode, entries, activeId };
}

/* ------------------------------------------------------------------ */
/* chrome.proxy plumbing                                               */
/* ------------------------------------------------------------------ */

type ProxySettingsApi = {
  set(details: { value: unknown; scope?: string }, cb?: () => void): void;
  get(details: { incognito: boolean }, cb: (details: unknown) => void): void;
  clear(details: { scope?: string }, cb?: () => void): void;
};

const proxyApi = (): ProxySettingsApi | null => {
  const c = globalThis.chrome as unknown as { proxy?: { settings?: ProxySettingsApi } } | undefined;
  return c?.proxy?.settings ?? null;
};

/** Apply `settings` to Chromium. Resolves to what is actually installed. */
export async function applyProxy(s: ProxySettings): Promise<ProxyAppliedState> {
  const api = proxyApi();
  const entry = pickActiveEntry(s);
  if (!api) {
    return { mode: s.mode, proxyFor: null, error: 'chrome.proxy недоступен (нет разрешения "proxy")' };
  }
  const pac = buildPacScript(s);
  if (!pac) {
    await new Promise<void>((res) => api.clear({ scope: 'regular' }, () => res()));
    return { mode: 'off', proxyFor: null, error: null };
  }
  const err = await new Promise<string | null>((res) => {
    const timer = setTimeout(() => res('таймаут применения прокси'), PROXY_APPLY_TIMEOUT_MS);
    api.set({ value: { mode: 'pac_script', pacScript: { data: pac } }, scope: 'regular' }, () => {
      clearTimeout(timer);
      const last = (globalThis.chrome as unknown as { runtime?: { lastError?: { message?: string } } })
        .runtime?.lastError;
      res(last?.message ?? null);
    });
  });
  const applied = await readApplied();
  return { mode: err ? 'off' : s.mode, proxyFor: err ? null : (entry?.host ?? null), error: err ?? applied.error };
}

/** Read back Chromium's current proxy mode. */
export async function readApplied(): Promise<ProxyAppliedState> {
  const api = proxyApi();
  if (!api) return { mode: 'off', proxyFor: null, error: 'chrome.proxy недоступен' };
  const cfg = await new Promise<{ value?: { mode?: string } }>((res) => {
    try {
      api.get({ incognito: false }, (d) => res(d as { value?: { mode?: string } }));
    } catch {
      res({});
    }
  });
  const mode = cfg?.value?.mode;
  if (mode === 'pac_script') return { mode: 'vk-only', proxyFor: null, error: null };
  if (mode === 'fixed_servers') return { mode: 'all', proxyFor: null, error: null };
  return { mode: 'off', proxyFor: null, error: null };
}

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

type AuthDetails = { isProxy: boolean; host: string; port: number; challenger?: { host?: string } };
type AuthCallback = (creds?: { username: string; password: string }) => void;

/**
 * Answer proxy auth challenges from the configured entries.
 *
 * Registered with `asyncBlocking`, which is the only way an MV3 worker can
 * supply credentials asynchronously; `blocking` is rejected there.
 */
export function installProxyAuth(getSettings: () => ProxySettings): () => void {
  const c = globalThis.chrome as unknown as {
    webRequest?: {
      onAuthRequired?: {
        addListener: (cb: (d: AuthDetails, cb: AuthCallback) => void, filter: unknown, opts: string[]) => void;
        removeListener: (cb: (d: AuthDetails, cb: AuthCallback) => void) => void;
      };
    };
  };
  const api = c?.webRequest?.onAuthRequired;
  if (!api) return () => undefined;
  const handler = (details: AuthDetails, cb: AuthCallback): void => {
    if (!details.isProxy) return cb();
    const s = getSettings();
    const entry =
      s.entries.find((e) => e.enabled && e.host === details.host && e.port === details.port) ??
      pickActiveEntry(s);
    if (!entry?.username) return cb();
    cb({ username: entry.username, password: entry.password ?? '' });
  };
  api.addListener(handler, { urls: ['<all_urls>'] }, ['asyncBlocking']);
  return () => api.removeListener(handler);
}

/* ------------------------------------------------------------------ */
/* Liveness probe                                                      */
/* ------------------------------------------------------------------ */

/**
 * Probe connectivity to VK through whatever proxy is currently installed.
 *
 * The request runs in the worker and therefore honours the live PAC applied by
 * `applyProxy`, so this measures the routing that is actually in effect rather
 * than an entry in isolation. `api.vk.ru` answers without a token, so any HTTP
 * status proves the tunnel works; only a transport error counts as failure.
 */
export async function checkProxy(): Promise<ProxyCheckResult> {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch('https://api.vk.ru/method/account.getInfo', {
      method: 'POST',
      signal: ctl.signal,
      body: new URLSearchParams({ v: '5.251' }),
    });
    return { ok: true, status: r.status, latencyMs: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, latencyMs: Date.now() - started, error: /abort/i.test(msg) ? 'таймаут' : msg };
  } finally {
    clearTimeout(timer);
  }
}
