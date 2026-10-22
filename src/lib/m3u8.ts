export type M3U8KeyMethod = 'NONE' | 'AES-128';

export interface M3U8Key {
  method: M3U8KeyMethod;
  uri: string | null;
  /** Explicit IV from `IV=0x…`; null means "derive from the segment sequence number". */
  iv: Uint8Array | null;
}

export interface M3U8Segment {
  url: string;
  key: M3U8Key | null;
  /** Media sequence number, used as the implicit AES-CBC IV (FIPS-197 / RFC 8216 §5.2). */
  seq: number;
}

export interface M3U8ParseResult {
  variant: string | null;
  segments: M3U8Segment[];
  init: string | null;
}

export const parseIv = (raw: string): Uint8Array | null => {
  const hex = raw.replace(/^0[xX]/, '');
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== 32) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const parseKeyLine = (line: string, abs: (u: string) => string): M3U8Key => {
  const method = (/METHOD=([A-Z0-9-]+)/.exec(line)?.[1] ?? 'NONE').toUpperCase();
  const uriRaw = /URI="([^"]+)"/.exec(line)?.[1];
  const ivRaw = /IV=([^,\s]+)/.exec(line)?.[1];
  if (method !== 'AES-128') return { method: method as M3U8KeyMethod, uri: null, iv: null };
  const iv = ivRaw ? parseIv(ivRaw) : null;
  if (ivRaw && !iv) {
    throw new Error('Некорректный IV для AES-128: ожидается 16 байт (32 hex-символа)');
  }
  return {
    method: 'AES-128',
    uri: uriRaw ? abs(uriRaw) : null,
    iv,
  };
};

export function parseM3U8(text: string, baseUrl: string): M3U8ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines[0] || !lines[0].startsWith('#EXTM3U')) throw new Error('не m3u8');
  const abs = (u: string) => new URL(u, baseUrl).href;

  let variant: string | null = null;
  let bestBw = -1;
  const segments: M3U8Segment[] = [];
  let init: string | null = null;
  let pendingBw = -1;
  // Key state persists until the next EXT-X-KEY (RFC 8216 §4.3.2.4); an
  // `EXT-X-KEY:METHOD=NONE` line switches back to cleartext.
  let key: M3U8Key | null = null;
  let seq = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      const n = parseInt(line.split(':')[1] ?? '', 10);
      if (Number.isFinite(n)) seq = n;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY')) {
      const k = parseKeyLine(line, abs);
      key = k.method === 'NONE' ? null : k;
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const m = line.match(/BANDWIDTH=(\d+)/);
      pendingBw = m ? parseInt(m[1]!, 10) : 0;
      continue;
    }
    if (line.startsWith('#EXT-X-MAP')) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) init = abs(m[1]!);
      continue;
    }
    if (line.startsWith('#')) continue;
    const url = abs(line);
    if (pendingBw >= 0) {
      if (pendingBw > bestBw) {
        bestBw = pendingBw;
        variant = url;
      }
      pendingBw = -1;
    } else {
      segments.push({ url, key, seq });
      seq++;
    }
  }

  return { variant, segments, init };
}
