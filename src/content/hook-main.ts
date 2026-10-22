import type { AudioMeta, HookStats, ResponseSample } from '../types.js';

declare global {
  interface Window {
    __VKMF__?: boolean;
    __vkmfStats?: HookStats;
  }
}

const post = (t: string, p: unknown) => {
  if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
    window.postMessage({ src: 'VKMF', t, p }, '*');
  }
};
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * True only for audio payload URLs.
 *
 * Real VK host names: `vkuseraudio.ru` (HLS/mp3) vs `vkuserphoto.ru` (artwork).
 * The old pattern listed `vkuser`, which is a PREFIX OF BOTH — so 300x300 album
 * JPEGs matched, `urls` filled with images, and `getAudioBytes` (which prefers
 * the first non-m3u8 URL) downloaded a ~2 KB cover instead of the track.
 */
function isAudioUrl(u: string): boolean {
  if (!/^https?:\/\//i.test(u)) return false;
  if (/vkuserphoto|vkuserimages|\/impg\/|\/ig2\/|\/s\/v1\/ig/i.test(u)) return false;
  if (/\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(u)) return false;
  if (/[?&]type=(audio|photo)/i.test(u) && !/\.(mp3|m3u8)(\?|$)/i.test(u)) return false;
  return /(vkuseraudio|vk-cdn|userapi|mycdn|\.mp3|\.m3u8|\/audio)/i.test(u);
}

/** Artwork URL, excluding the audio payload hosts. */
function isCoverUrl(u: string): boolean {
  if (!/^https?:\/\//i.test(u) || !/^https:/i.test(u)) return false;
  if (/vkuseraudio|\.(mp3|m3u8)(\?|$)/i.test(u)) return false;
  return /(userphoto|impg|\.jpe?g|\.png|\.webp)(\?|$|\.)/i.test(u);
}

/** Highest-resolution URL out of a `photo_34…photo_1200` thumbnail map. */
function coverFromThumb(thumb: unknown): string[] {
  if (!thumb || typeof thumb !== 'object') return [];
  const entries = Object.entries(thumb as Record<string, unknown>)
    .filter(([k, v]) => /^photo_\d+$/.test(k) && typeof v === 'string' && isCoverUrl(v as string))
    .map(([k, v]) => [Number(k.slice(6)), v as string] as const);
  if (!entries.length) {
    const only = (thumb as { src?: unknown }).src;
    return typeof only === 'string' && isCoverUrl(only) ? [only] : [];
  }
  entries.sort((a, b) => b[0] - a[0]);
  return entries.map(([, v]) => v);
}

function collectUrls(node: unknown, acc: string[], d = 0): string[] {
  if (!node || d > 6) return acc;
  if (typeof node === 'string') {
    if (isAudioUrl(node)) acc.push(node);
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

export function harvest(root: unknown): { out: AudioMeta[]; lyr: Record<string, string> } {
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
        // Legacy/API shape: album.thumbs[] / album.thumb.
        if (al) {
          const th = al.thumbs ?? al.thumb ?? al.covers;
          if (Array.isArray(th)) th.forEach((x: Thumb | null) => x && x.src && covers.push(x.src));
          else if (th && (th as Thumb).src) covers.push((th as Thumb).src!);
        }
        // Real web-player shape: a flat `thumb.photo_34…photo_1200` map.
        covers.push(...coverFromThumb(o.thumb), ...coverFromThumb(o.cover));
        const px = (u: string) => {
          const m = u.match(/(\d+)x(\d+)/);
          return m ? Number(m[1]) * Number(m[2]) : 0;
        };
        covers.sort((a, b) => px(b) - px(a));
        const dedupCovers = [...new Set(covers)].filter(isCoverUrl);

        // Preserve access_key and restricted (R21)
        const accessKey =
          typeof o.access_key === 'string'
            ? o.access_key
            : typeof o.accessKey === 'string'
              ? o.accessKey
              : undefined;
        let restrictedNum: number | undefined;
        if (typeof o.content_restricted === 'number') {
          restrictedNum = o.content_restricted;
        } else if (typeof o.restricted === 'number') {
          restrictedNum = o.restricted;
        } else if (
          typeof o.content_restricted === 'string' &&
          !isNaN(Number(o.content_restricted))
        ) {
          restrictedNum = Number(o.content_restricted);
        } else if (typeof o.restricted === 'string' && !isNaN(Number(o.restricted))) {
          restrictedNum = Number(o.restricted);
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
          covers: dedupCovers,
          ...(accessKey ? { access_key: accessKey } : {}),
          ...(restrictedNum !== undefined ? { restricted: restrictedNum } : {}),
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

export function balancedFrom(text: string, start: number): string | null {
  const stack: string[] = [];
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
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.length === 0 || stack.pop() !== c) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Forward bracket-balanced embedded parser (R20).
 * Scans forward through text, maintaining bracket hierarchy without backward truncation,
 * ensuring nested properties before "artist" are fully preserved.
 */
function tryParseFragment(frag: string, targetOut: AudioMeta[], seen: Set<string>): boolean {
  if (frag.length >= 5000000) return false;
  try {
    const parsed = JSON.parse(frag);
    const { out, lyr } = harvest(parsed);
    if (out.length > 0) {
      for (const item of out) {
        if (!seen.has(item.key)) {
          seen.add(item.key);
          targetOut.push(item);
        }
      }
      if (Object.keys(lyr).length) post('LYRICS', lyr);
      return true;
    }
  } catch {
    /* non-JSON fragment */
  }
  return false;
}

export function extractEmbedded(text: string): AudioMeta[] {
  const seenKeys = new Set<string>();
  const found: AudioMeta[] = [];

  interface Frame {
    start: number;
    char: '{' | '[';
    hasArtist: boolean;
  }

  const stack: Frame[] = [];
  let inDouble = false;
  let inSingle = false;
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inDouble) {
      if (esc) {
        esc = false;
      } else if (c === '\\') {
        esc = true;
      } else if (c === '"') {
        inDouble = false;
      }
      continue;
    }

    if (inSingle) {
      if (esc) {
        esc = false;
      } else if (c === '\\') {
        esc = true;
      } else if (c === "'") {
        inSingle = false;
      }
      continue;
    }

    if (c === '"') {
      const isArtist =
        text.slice(i, i + 8) === '"artist"' ||
        text.slice(i, i + 14) === '"main_artists"' ||
        text.slice(i, i + 13) === '"mainArtists"';
      if (isArtist && stack.length > 0) {
        stack[stack.length - 1]!.hasArtist = true;
      }
      inDouble = true;
      continue;
    }

    if (c === "'") {
      inSingle = true;
      continue;
    }

    if (c === '{' || c === '[') {
      stack.push({ start: i, char: c, hasArtist: false });
      continue;
    }

    if (c === '}' || c === ']') {
      if (stack.length === 0) continue;
      const expectedChar = c === '}' ? '{' : '[';
      let targetFrame: Frame | undefined;
      const top = stack[stack.length - 1]!;
      if (top.char === expectedChar) {
        targetFrame = stack.pop();
      } else {
        let matchIdx = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s]!.char === expectedChar) {
            matchIdx = s;
            break;
          }
        }
        if (matchIdx !== -1) {
          targetFrame = stack[matchIdx];
          stack.length = matchIdx;
        }
      }

      if (targetFrame?.hasArtist) {
        const frag = text.slice(targetFrame.start, i + 1);
        const parsedOk = tryParseFragment(frag, found, seenKeys);
        if (!parsedOk && stack.length > 0) {
          stack[stack.length - 1]!.hasArtist = true;
        }
      }
    }
  }

  return found;
}

/**
 * Filters responses to only clone textual bodies (R22).
 * Skips binary media (audio, video, image, font, octet-stream) and oversized responses (> 8MB).
 */
export function shouldProcessResponse(
  contentType: string | null | undefined,
  url: string,
  contentLength?: number | null,
): boolean {
  if (contentLength && contentLength > 8e6) {
    return false;
  }

  if (
    /\.(mp3|aac|ts|m4s|m4a|mp4|webm|ogg|wav|flac|jpg|jpeg|png|webp|gif|svg|woff2?|ttf|eot|zip|wasm)(\?|$)/i.test(
      url,
    )
  ) {
    return false;
  }

  const ct = (contentType || '').trim().toLowerCase();

  if (ct) {
    if (
      ct.startsWith('audio/') ||
      ct.startsWith('video/') ||
      ct.startsWith('image/') ||
      ct.startsWith('font/') ||
      ct.includes('octet-stream') ||
      ct.includes('application/wasm') ||
      ct.includes('application/zip') ||
      ct.includes('application/x-protobuf')
    ) {
      return false;
    }

    if (
      ct.includes('json') ||
      ct.includes('text') ||
      ct.includes('javascript') ||
      ct.includes('xml') ||
      ct.includes('x-www-form-urlencoded')
    ) {
      return true;
    }

    return false;
  }

  if (contentLength && contentLength > 2e6) {
    return false;
  }

  return true;
}

// Browser content script lifecycle
(() => {
  if (typeof window === 'undefined') return;
  if (window.__VKMF__) return;
  window.__VKMF__ = true;

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
        const rawUrl = (a[0] && (a[0] as { url?: string }).url) || String(a[0]);
        const ct = r.headers.get('content-type');
        const clHeader = r.headers.get('content-length');
        const cl = clHeader ? parseInt(clHeader, 10) : undefined;
        if (shouldProcessResponse(ct, rawUrl, cl)) {
          const init = a[1] as (RequestInit & { params?: unknown }) | undefined;
          const reqBody = (init && (init.body || init.params)) || '';
          r.clone()
            .text()
            .then((t) => handleText(rawUrl, reqBody, t))
            .catch(() => {
              /* response body unavailable */
            });
        }
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
        const url = this.__vkmfUrl || '';
        let ct: string | null = null;
        try {
          ct = this.getResponseHeader('content-type');
        } catch {
          /* header unavailable */
        }
        if (shouldProcessResponse(ct, url)) {
          if (rt === '' || rt === 'text') handleText(url, a[0], this.responseText);
          else if (rt === 'json' && this.response)
            handleText(url, a[0], JSON.stringify(this.response));
        }
      } catch {
        /* ignore */
      }
    });
    os.apply(this, a);
  };
})();
