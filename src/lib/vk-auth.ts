import type { VkToken } from '../types.js';

/**
 * VK authorization for a tabless client.
 *
 * Mechanics established by probing the live site (not from documentation):
 *  - The web client mints its own API token by POSTing to
 *    `https://login.vk.ru/?act=web_token` with `{version, app_id}` and the
 *    browser's VK session cookies. No OAuth redirect, no client secret.
 *  - That endpoint answers `{"type":"error","error_info":"wrong origin"}` unless
 *    the request carries `Origin: https://vk.ru/`. `Origin` is a forbidden fetch
 *    header, so it MUST come from a declarativeNetRequest rule (see lib/dnr.ts).
 *  - The token is a bearer for `api.vk.ru/method/*` with `v=5.251`; it expires,
 *    so it is cached with its expiry and refreshed with a safety margin.
 *
 * Everything here runs in the service worker; the caller is responsible for
 * having installed the DNR rules first (done in `load()`).
 */

/** App id the VK web client uses; the token is scoped to it. */
export const VK_APP_ID = '6287487';
/** API version the modern web client negotiates. */
export const VK_API_VERSION = '5.251';
/** Refresh this many seconds before the stated expiry. */
const EXPIRY_MARGIN_S = 300;
const REQUEST_TIMEOUT_MS = 15000;

const TOKEN_KEY = 'vmf_vk_token_v1';

interface Stored {
  access_token: string;
  user_id: number;
  /** Unix seconds, as reported by VK. */
  expires: number;
}

type StorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
};

const storage = (): StorageArea | null => {
  const c = globalThis.chrome as unknown as { storage?: { local?: StorageArea } } | undefined;
  return c?.storage?.local ?? null;
};

/** True when the cached token is still usable (with the refresh margin). */
export function tokenUsable(
  t: Pick<VkToken, 'expires'>,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  return !!t.expires && t.expires - nowSec > EXPIRY_MARGIN_S;
}

/**
 * Mint a fresh token from the browser's VK session.
 *
 * Returns null (rather than throwing) when the user is simply not signed in to
 * VK, which is a normal state the UI must be able to render.
 */
export async function fetchToken(): Promise<VkToken | null> {
  const url = new URL('https://login.vk.ru/');
  url.searchParams.set('act', 'web_token');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url.toString(), {
      method: 'POST',
      credentials: 'include',
      signal: ctl.signal,
      headers: { 'x-requested-with': 'XMLHttpRequest' },
      body: new URLSearchParams({ version: '1', app_id: VK_APP_ID }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      type?: string;
      data?: { access_token?: string; user_id?: number; expires?: number };
    };
    if (j.type !== 'okay' || !j.data?.access_token) return null;
    return {
      access_token: j.data.access_token,
      user_id: Number(j.data.user_id) || 0,
      expires: Number(j.data.expires) || 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Cached token, refreshed on demand. */
export async function getToken(force = false): Promise<VkToken | null> {
  const area = storage();
  if (!force && area) {
    try {
      const o = await area.get(TOKEN_KEY);
      const t = o[TOKEN_KEY] as Stored | undefined;
      if (t?.access_token && tokenUsable(t)) {
        return { access_token: t.access_token, user_id: t.user_id, expires: t.expires };
      }
    } catch {
      /* fall through to a fresh mint */
    }
  }
  const fresh = await fetchToken();
  if (fresh && area) {
    try {
      await area.set({ [TOKEN_KEY]: fresh satisfies Stored });
    } catch {
      /* cache is best-effort */
    }
  }
  return fresh;
}

/** Drop the cached token (sign-out, or after repeated 5xx auth failures). */
export async function clearToken(): Promise<void> {
  try {
    await storage()?.remove(TOKEN_KEY);
  } catch {
    /* nothing cached */
  }
}
