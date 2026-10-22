import type {
  AudioMeta,
  CollectorCommand,
  HookStats,
  ResponseSample,
  RuntimeMessage,
  ScanResult,
} from '../types.js';

declare global {
  interface Window {
    __VKMF_COLLECTOR__?: boolean;
  }
}

export interface DomAudioRaw {
  id?: unknown;
  artist?: unknown;
  title?: unknown;
  urls?: unknown;
  url?: unknown;
  duration?: unknown;
  cover_url?: unknown;
  access_key?: unknown;
  content_restricted?: unknown;
  restricted?: unknown;
}

export function domNormalize(d: DomAudioRaw): AudioMeta | null {
  const idRaw = String(d.id ?? '');
  const m = idRaw.match(/^(-?\d+)_(\d+)/);
  const artist = String(d.artist || '').trim();
  const title = String(d.title || '').trim();
  if (!m || !artist || !title) return null;
  const owner = m[1]!;
  const id = m[2]!;
  const urls = Array.isArray(d.urls)
    ? (d.urls as string[]).filter((u) => /^https?:\/\//.test(u))
    : typeof d.url === 'string' && /^https?:\/\//.test(d.url)
      ? [d.url]
      : [];
  const accessKey = typeof d.access_key === 'string' ? d.access_key : undefined;
  let restricted: number | undefined;
  if (typeof d.content_restricted === 'number') restricted = d.content_restricted;
  else if (typeof d.restricted === 'number') restricted = d.restricted;

  return {
    key: `${owner}_${id}`,
    id,
    owner,
    artist,
    title,
    album: '',
    year: null,
    duration: (d.duration ?? null) as number | string | null,
    urls,
    covers: typeof d.cover_url === 'string' ? [d.cover_url] : [],
    ...(accessKey ? { access_key: accessKey } : {}),
    ...(restricted !== undefined ? { restricted } : {}),
  };
}

export function isBadgeOrControl(el: Element): boolean {
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'button' || tag === 'svg') return true;
  const role = el.getAttribute?.('role') || '';
  if (role === 'button') return true;
  const testId = el.getAttribute?.('data-testid') || '';
  if (/badge|explicit|action|control|playback/i.test(testId)) return true;
  const className = typeof el.className === 'string' ? el.className : '';
  if (/badge|explicit/i.test(className)) return true;
  const ariaLabel = el.getAttribute?.('aria-label') || '';
  if (/explicit/i.test(ariaLabel)) return true;
  return false;
}

export function cleanText(el: Element): string {
  if (isBadgeOrControl(el)) return '';
  if (typeof el.cloneNode === 'function') {
    const clone = el.cloneNode(true) as Element;
    if (typeof clone.querySelectorAll === 'function') {
      clone
        .querySelectorAll(
          'button, svg, [role="button"], [data-testid*="Badge" i], [data-testid*="badge" i], [data-testid*="Explicit" i], [class*="badge" i], [class*="explicit" i], [aria-label*="explicit" i], .AudioTrackBadge, [data-testid*="Action" i], [data-testid*="Control" i]',
        )
        .forEach((b) => b.remove());
    }
    return (clone.textContent || '').trim();
  }
  return (el.textContent || '').trim();
}

/**
 * Extracts AudioMeta from a single track row.
 * Prefers named title/artist selectors, ignores badges/buttons, and falls back to
 * clean text from MusicTrackRow_Info children.
 */
export function parseTrackRow(row: Element): AudioMeta | null {
  const holder = row.closest?.('[data-audio-id]') ?? row.querySelector?.('[data-audio-id]');
  const key = holder?.getAttribute('data-audio-id') ?? row.getAttribute?.('data-audio-id') ?? '';

  // 1. Prefer named selectors for title and artist
  const titleEl = row.querySelector?.(
    '[data-testid="MusicTrackRow_Title"], [data-testid="MusicTrackTitle"], [data-testid*="Title" i], .audio_row__title, [class*="MusicTrackTitle" i], [class*="TrackRow__title" i]',
  );
  const artistEl = row.querySelector?.(
    '[data-testid="MusicTrackRow_Artist"], [data-testid="MusicTrackRow_Author"], [data-testid="MusicTrackArtist"], [data-testid="MusicTrackAuthor"], [data-testid*="Artist" i], [data-testid*="Author" i], .audio_row__performers, .audio_row__artists, .audio_row__artist, [class*="MusicTrackAuthor" i], [class*="MusicTrackArtist" i], [class*="TrackRow__author" i], [class*="TrackRow__artist" i]',
  );

  let title = '';
  let artist = '';

  if (titleEl && artistEl && titleEl !== artistEl) {
    title = cleanText(titleEl);
    artist = cleanText(artistEl);
  }

  // 2. Fallback: examine children of MusicTrackRow_Info, ignoring badges and controls
  if (!title || !artist) {
    const info = row.querySelector?.('[data-testid="MusicTrackRow_Info"]');
    if (!info) return null;
    const nonBadgeChildren = [...info.children].filter((c) => !isBadgeOrControl(c));
    const parts = nonBadgeChildren.map((c) => cleanText(c)).filter(Boolean);
    if (parts.length < 2) return null;
    title = parts[0]!;
    artist = parts.slice(1).join(' ');
  }

  return domNormalize({ id: key, title, artist });
}

export function domRows(root?: ParentNode): AudioMeta[] {
  const doc = root ?? (typeof document !== 'undefined' ? document : null);
  if (!doc) return [];
  const out: AudioMeta[] = [];
  doc.querySelectorAll('[data-testid="MusicTrackRow"]').forEach((row) => {
    const a = parseTrackRow(row);
    if (a) out.push(a);
  });
  return out;
}

export function domAudios(root?: ParentNode): AudioMeta[] {
  const doc = root ?? (typeof document !== 'undefined' ? document : undefined);
  const out = domRows(doc);
  doc?.querySelectorAll('[data-audio]').forEach((el) => {
    try {
      const a = domNormalize(JSON.parse(el.getAttribute('data-audio')!) as DomAudioRaw);
      if (a) out.push(a);
    } catch {
      /* malformed data-audio */
    }
  });
  return out;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function bestScroller(probe: Element): Element | null {
  let node: Element | null = probe.parentElement;
  let best: Element | null = null;
  let bestScore = 0;
  while (node && node !== document.body) {
    const s = node.scrollHeight - node.clientHeight;
    if (s >= 20 && (best === null || s > bestScore)) {
      bestScore = s;
      best = node;
    }
    node = node.parentElement;
  }
  if (best) return best;
  return document.scrollingElement;
}

function pageName(): string {
  const el = document.querySelector(
    '[class*="playlist_title"], [data-testid="audio_page_title"], h1',
  );
  let name = el && el.textContent ? el.textContent.trim() : '';
  if (!name) name = document.title.replace(/\s*\|\s*ВКонтакте.*$/i, '').trim();
  return name || 'Плейлист';
}

// Content script lifecycle in browser
(() => {
  if (typeof window === 'undefined') return;
  if (window.__VKMF_COLLECTOR__) return;
  window.__VKMF_COLLECTOR__ = true;

  let scanning = false;
  let scanName: string | null = null;
  let lastStats: HookStats | null = null;
  let lastSamples: ResponseSample[] = [];

  const relay = (msg: RuntimeMessage) => {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {
        /* extension context may be inactive */
      });
    } catch {
      /* ignore */
    }
  };

  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { src?: string; t?: string; p?: unknown } | null;
    if (e.source !== window || !d || d.src !== 'VKMF') return;
    if (d.t === 'AUDIOS') {
      const extra = scanning && scanName ? { pl: scanName, scanning: true } : {};
      relay({ t: 'AUDIOS', audios: d.p as AudioMeta[], ...extra });
    } else if (d.t === 'LYRICS') {
      relay({ t: 'LYRICS', map: d.p as Record<string, string> });
    } else if (d.t === 'STATS') {
      lastStats = d.p as HookStats;
    } else if (d.t === 'SAMPLES') {
      lastSamples = d.p as ResponseSample[];
    }
  });

  async function scan(overrideName?: string): Promise<ScanResult> {
    scanName = overrideName || pageName();
    scanning = true;
    lastStats = null;
    window.postMessage({ src: 'VKMF_REQ', t: 'EMBEDDED' }, '*');
    const seenKeys = new Set<string>();
    const probe = () =>
      document.querySelector(
        '[data-audio], .audio_row, [data-testid="MusicTrackRow"], [data-audio-id]',
      );
    let prev = -1;
    let stable = 0;
    const t0 = Date.now();
    try {
      while (stable < 5 && Date.now() - t0 < 240000) {
        for (const a of domAudios()) {
          if (!seenKeys.has(a.key)) {
            seenKeys.add(a.key);
            relay({ t: 'AUDIOS', audios: [a], pl: scanName, scanning: true });
          }
        }
        const p = probe();
        if (p) {
          const sc = bestScroller(p);
          try {
            sc!.scrollTop = sc!.scrollHeight;
          } catch {
            /* not scrollable */
          }
          window.scrollTo(0, document.documentElement.scrollHeight);
        }
        await sleep(650);
        if (seenKeys.size === prev) stable++;
        else stable = 0;
        prev = seenKeys.size;
      }
    } finally {
      scanning = false;
    }
    await sleep(400);
    return { count: seenKeys.size, name: scanName, stats: lastStats };
  }

  chrome.runtime.onMessage.addListener((m: unknown, _s, reply) => {
    const msg = m as CollectorCommand;
    if (msg.cmd === 'PING') {
      reply(true);
      return false;
    }
    if (msg.cmd === 'SCAN') {
      scan(msg.name)
        .then(reply)
        .catch((e: unknown) => reply({ error: String(e) }));
      return true;
    }
    if (msg.cmd === 'SAMPLES') {
      window.postMessage({ src: 'VKMF_REQ', t: 'SAMPLES' }, '*');
      setTimeout(() => reply({ samples: lastSamples }), 200);
      return true;
    }
    return false;
  });

  setInterval(() => {
    if (scanning) return;
    const audios = domAudios();
    if (audios.length) relay({ t: 'AUDIOS', audios });
  }, 4000);
})();
