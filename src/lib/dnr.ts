import type { HeaderRule } from '../types.js';

/**
 * declarativeNetRequest rules.
 *
 * This is not optional polish: VK's web_token endpoint answers
 * `{"type":"error","error_info":"wrong origin"}` to any request whose Origin is
 * not `https://vk.ru/`, and `Origin` is a FORBIDDEN fetch header — a script
 * cannot set it. Verified on the live logged-in profile from an extension
 * context; page context works only because the browser sets Origin itself.
 * declarativeNetRequest is therefore the only way a tabless client can
 * authenticate, which is exactly why the reference extension ships these rules.
 */

/** Hostname of this extension (`<id>` for unpacked installs). */
export function selfHost(): string {
  const c = globalThis.chrome as unknown as { runtime?: { getURL?: (p: string) => string } } | undefined;
  try {
    return new URL(c?.runtime?.getURL?.('/') ?? 'https://invalid/').hostname;
  } catch {
    return 'invalid';
  }
}

/** Origin VK accepts for its own web client. */
export const VK_ORIGIN = 'https://vk.ru/';

/** Android Genius client identity the reference build impersonates. */
export const GENIUS_UA = 'Genius/4.2.1 (Android; Android 13; Pixel 6)';
export const GENIUS_VERSION = '4.2.1';

/** Rules this extension owns. Ids are stable so installs are idempotent. */
export function headerRules(): HeaderRule[] {
  return [
    // 1-3: without the spoofed Origin, VK rejects token minting and the web API.
    { id: 1, urlFilter: 'https://login.vk.ru/?act=web_token', headers: [{ name: 'origin', value: VK_ORIGIN }], ownOriginOnly: true },
    { id: 2, urlFilter: 'https://vk.ru/al_audio.php*', headers: [{ name: 'origin', value: VK_ORIGIN }], ownOriginOnly: true },
    { id: 3, urlFilter: 'https://api.vk.ru/*', headers: [{ name: 'origin', value: VK_ORIGIN }], ownOriginOnly: true },
    // 3b: web.api.vk.ru is what the site itself calls; needed by any tabless client.
    { id: 8, urlFilter: 'https://web.api.vk.ru/*', headers: [{ name: 'origin', value: VK_ORIGIN }], ownOriginOnly: true },
    // 4: Genius only serves lyrics to its Android client.
    {
      id: 4,
      urlFilter: 'https://api.genius.com/*',
      headers: [
        { name: 'user-agent', value: GENIUS_UA },
        { name: 'x-genius-android-version', value: GENIUS_VERSION },
      ],
      ownOriginOnly: true,
    },
    // 5: drop framing guards so extension pages may embed VK documents.
    { id: 5, urlFilter: '*', headers: [], ownOriginOnly: true },
    // 7: VK moved to .ru; keep legacy links working.
    { id: 7, urlFilter: 'vk.com', headers: [], ownOriginOnly: true },
  ];
}

/** Build the chrome.declarativeNetRequest rule objects. */
export function toDnrRules(host = selfHost()): unknown[] {
  const rules: unknown[] = [];
  for (const r of headerRules()) {
    if (r.id === 7) {
      rules.push({
        id: r.id,
        priority: 1,
        action: { type: 'redirect', redirect: { transform: { host: 'vk.ru' } } },
        condition: { urlFilter: r.urlFilter, initiatorDomains: [host] },
      });
      continue;
    }
    if (r.id === 5) {
      rules.push({
        id: r.id,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' },
          ],
        },
        condition: { urlFilter: r.urlFilter, initiatorDomains: [host] },
      });
      continue;
    }
    rules.push({
      id: r.id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: r.headers.map((h) => ({ header: h.name, operation: 'set', value: h.value })),
      },
      condition: r.ownOriginOnly
        ? { urlFilter: r.urlFilter, initiatorDomains: [host] }
        : { urlFilter: r.urlFilter },
    });
  }
  return rules;
}

type DnrApi = {
  getDynamicRules(): Promise<{ id: number }[]>;
  updateDynamicRules(opts: { addRules?: unknown[]; removeRuleIds?: number[] }): Promise<void>;
};

const dnrApi = (): DnrApi | null => {
  const c = globalThis.chrome as unknown as { declarativeNetRequest?: DnrApi } | undefined;
  return c?.declarativeNetRequest ?? null;
};

/** Install (idempotently) every rule this extension owns. */
export async function installDnrRules(): Promise<{ ok: boolean; ids: number[]; error: string | null }> {
  const api = dnrApi();
  if (!api) return { ok: false, ids: [], error: 'declarativeNetRequest недоступен' };
  try {
    const existing = (await api.getDynamicRules()).map((r) => r.id);
    const rules = toDnrRules();
    await api.updateDynamicRules({ addRules: rules, removeRuleIds: existing });
    const now = (await api.getDynamicRules()).map((r) => r.id).sort((a, b) => a - b);
    return { ok: true, ids: now, error: null };
  } catch (e) {
    return { ok: false, ids: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Inspect what is currently installed. */
export async function readDnrRules(): Promise<{ ok: boolean; ids: number[]; error: string | null }> {
  const api = dnrApi();
  if (!api) return { ok: false, ids: [], error: 'declarativeNetRequest недоступен' };
  try {
    const ids = (await api.getDynamicRules()).map((r) => r.id).sort((a, b) => a - b);
    return { ok: true, ids, error: null };
  } catch (e) {
    return { ok: false, ids: [], error: e instanceof Error ? e.message : String(e) };
  }
}
