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

(() => {
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

  interface DomAudioRaw {
    id?: unknown;
    artist?: unknown;
    title?: unknown;
    urls?: unknown;
    url?: unknown;
    duration?: unknown;
    cover_url?: unknown;
  }

  function domNormalize(d: DomAudioRaw): AudioMeta | null {
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
    };
  }

  function domAudios(): AudioMeta[] {
    const out: AudioMeta[] = [];
    document.querySelectorAll('[data-audio]').forEach((el) => {
      try {
        const a = domNormalize(JSON.parse(el.getAttribute('data-audio')!) as DomAudioRaw);
        if (a) out.push(a);
      } catch {
        /* malformed data-audio */
      }
    });
    return out;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  async function scan(overrideName?: string): Promise<ScanResult> {
    scanName = overrideName || pageName();
    scanning = true;
    lastStats = null;
    window.postMessage({ src: 'VKMF_REQ', t: 'EMBEDDED' }, '*');
    const seenKeys = new Set<string>();
    const probe = () => document.querySelector('[data-audio], .audio_row');
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
