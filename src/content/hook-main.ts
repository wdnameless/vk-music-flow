import type { AudioMeta, HookStats, ResponseSample } from '../types.js';

declare global {
  interface Window {
    __VKMF__?: boolean;
    __vkmfStats?: HookStats;
  }
}

(() => {
  if (window.__VKMF__) return;
  window.__VKMF__ = true;

  const post = (t: string, p: unknown) => window.postMessage({ src: 'VKMF', t, p }, '*');
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  const stats: HookStats = { responses: 0, parsed: 0, found: 0, embedded: 0 };
  window.__vkmfStats = stats;

  const samples: ResponseSample[] = [];
  function pushSample(url: string, req: unknown, text: string) {
    if (!text) return;
    if (!(
      text.includes('"artist"') ||
      text.includes('"main_artists"') ||
      text.includes('"audios_ids"') ||
      text.includes('"duration"')
    ))
      return;
    samples.push({
      url: String(url).slice(0, 200),
      req: String(req || '').slice(0, 3000),
      text: text.slice(0, 300000),
    });
    if (samples.length > 3) samples.shift();
  }

  function collectUrls(node: unknown, acc: string[], d = 0): string[] {
    if (!node || d > 6) return acc;
    if (typeof node === 'string') {
      if (
        /^https?:\/\//.test(node) &&
        /(vk-cdn|userapi|mycdn|vkuser|\.mp3|\.m3u8|\/audio)/i.test(node)
      )
        acc.push(node);
      return acc;
    }
    if (typeof node === 'object') {
      for (const k of Object.keys(node as object))
        collectUrls((node as Record<string, unknown>)[k], acc, d + 1);
    }
    return acc;
  }

  interface Thumb {
    src?: string;
  }
  interface AlbumLike {
    title?: unknown;
    year?: unknown;
    thumbs?: unknown;
    thumb?: unknown;
    covers?: unknown;
  }

  function harvest(root: unknown): { out: AudioMeta[]; lyr: Record<string, string> } {
    const out: AudioMeta[] = [];
    const lyr: Record<string, string> = {};
    (function walk(n: unknown, d = 0) {
      if (!n || d > 12) return;
      if (typeof n === 'string') {
        if (n.length > 20 && (n[0] === '{' || n[0] === '[')) {
          try {
            walk(JSON.parse(n), d + 1);
          } catch {
            /* not JSON */
          }
        }
        return;
      }
      if (Array.isArray(n)) {
        n.forEach((x) => walk(x, d + 1));
        return;
      }
      if (typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      let artist = str(o.artist);
      if (!artist && Array.isArray(o.main_artists) && o.main_artists[0])
        artist = str((o.main_artists[0] as { name?: unknown }).name);
      if (!artist && Array.isArray(o.mainArtists) && o.mainArtists[0])
        artist = str((o.mainArtists[0] as { name?: unknown }).name);
      const title = str(o.title);
      if (artist && title && (o.duration || o.url || o.hls)) {
        const id = o.id ?? o.audio_id ?? o.audioId;
        const owner = o.owner_id ?? o.ownerId;
        if (id != null && owner != null) {
          const urls = [...new Set(collectUrls(n, []))];
          const covers: string[] = [];
          const al = (o.album ?? (Array.isArray(o.albums) ? o.albums[0] : null)) as
            AlbumLike | null | undefined;
          if (al) {
            const th = al.thumbs ?? al.thumb ?? al.covers;
            if (Array.isArray(th))
              th.forEach((x: Thumb | null) => x && x.src && covers.push(x.src));
            else if (th && (th as Thumb).src) covers.push((th as Thumb).src!);
            const px = (u: string) => {
              const m = u.match(/(\d+)x(\d+)/);
              return m ? Number(m[1]) * Number(m[2]) : 0;
            };
            covers.sort((a, b) => px(b) - px(a));
          }
          out.push({
            key: `${owner}_${id}`,
            id: String(id),
            owner: String(owner),
            artist,
            title,
            album: str(al && al.title),
            year: (o.year ?? (al && al.year) ?? null) as number | string | null,
            duration: (o.duration ?? null) as number | string | null,
            urls,
            covers,
          });
        }
      }
      const lid = o.id ?? o.audio_id ?? o.audioId;
      if (typeof o.lyrics === 'string' && o.lyrics.length > 30 && lid != null) {
        lyr[String(lid)] = o.lyrics;
      }
      for (const k of Object.keys(o)) walk(o[k], d + 1);
    })(root);
    return { out, lyr };
  }

  const seen = new Set<string>();
  let buf: AudioMeta[] = [];
  let flushT: ReturnType<typeof setTimeout> | undefined;
  function emit(items: AudioMeta[]) {
    for (const a of items) {
      if (!seen.has(a.key)) {
        seen.add(a.key);
        buf.push(a);
      }
    }
    clearTimeout(flushT);
    flushT = setTimeout(() => {
      if (buf.length) {
        post('AUDIOS', buf);
        buf = [];
      }
    }, 300);
  }

  function handleText(url: string, req: unknown, text: string) {
    stats.responses++;
    if (!text || text.length < 50 || text.length > 8e6) return;
    pushSample(url, req, text);
    try {
      const j = JSON.parse(text);
      const { out, lyr } = harvest(j);
      stats.parsed++;
      if (out.length) {
        stats.found += out.length;
        emit(out);
      }
      if (Object.keys(lyr).length) post('LYRICS', lyr);
    } catch {
      /* non-JSON response */
    }
  }

  function balancedFrom(text: string, start: number): string | null {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  function extractEmbedded(text: string): AudioMeta[] {
    const found: AudioMeta[] = [];
    const needle = '"artist"';
    let i = 0;
    let guard = 0;
    while ((i = text.indexOf(needle, i)) !== -1 && guard < 2000) {
      guard++;
      let s = -1;
      for (let j = i; j >= Math.max(0, i - 300); j--) {
        if (text[j] === '{') {
          s = j;
          break;
        }
      }
      if (s !== -1) {
        const frag = balancedFrom(text, s);
        if (frag && frag.length < 100000) {
          try {
            const { out, lyr } = harvest(JSON.parse(frag));
            found.push(...out);
            if (Object.keys(lyr).length) post('LYRICS', lyr);
          } catch {
            /* malformed fragment */
          }
        }
      }
      i += needle.length;
    }
    return found;
  }

  function scanEmbeddedScripts() {
    let n = 0;
    document.querySelectorAll('script').forEach((s) => {
      const t = s.textContent || '';
      if (t.length > 100 && t.length < 6e6 && t.includes('"artist"')) {
        const items = extractEmbedded(t);
        n += items.length;
        if (items.length) {
          stats.found += items.length;
          emit(items);
        }
      }
    });
    stats.embedded = n;
  }

  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { src?: string; t?: string } | null;
    if (e.source !== window || !d || d.src !== 'VKMF_REQ') return;
    if (d.t === 'EMBEDDED') {
      scanEmbeddedScripts();
      post('STATS', { ...stats });
    } else if (d.t === 'SAMPLES') {
      post('SAMPLES', samples);
    }
  });

  const of = window.fetch;
  if (of) {
    window.fetch = async (...a: Parameters<typeof fetch>) => {
      const r = await of.apply(window, a);
      try {
        const init = a[1] as (RequestInit & { params?: unknown }) | undefined;
        const reqBody = (init && (init.body || init.params)) || '';
        r.clone()
          .text()
          .then((t) =>
            handleText((a[0] && (a[0] as { url?: string }).url) || String(a[0]), reqBody, t),
          )
          .catch(() => {
            /* response body unavailable */
          });
      } catch {
        /* ignore */
      }
      return r;
    };
  }

  interface VkmfXHR extends XMLHttpRequest {
    __vkmfUrl?: string;
  }

  const oo = XMLHttpRequest.prototype.open as unknown as (...a: unknown[]) => void;
  const os = XMLHttpRequest.prototype.send as unknown as (...a: unknown[]) => void;
  const xhrProto = XMLHttpRequest.prototype as unknown as {
    open: (...a: unknown[]) => void;
    send: (...a: unknown[]) => void;
  };
  xhrProto.open = function (this: VkmfXHR, ...a: unknown[]): void {
    this.__vkmfUrl = String(a[1]);
    oo.apply(this, a);
  };
  xhrProto.send = function (this: VkmfXHR, ...a: unknown[]): void {
    this.addEventListener('load', () => {
      try {
        const rt = this.responseType;
        if (rt === '' || rt === 'text') handleText(this.__vkmfUrl!, a[0], this.responseText);
        else if (rt === 'json' && this.response)
          handleText(this.__vkmfUrl!, a[0], JSON.stringify(this.response));
      } catch {
        /* ignore */
      }
    });
    os.apply(this, a);
  };
})();
