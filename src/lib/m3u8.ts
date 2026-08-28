export interface M3U8ParseResult {
  variant: string | null;
  segments: string[];
  init: string | null;
}

export function parseM3U8(text: string, baseUrl: string): M3U8ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines[0] || !lines[0].startsWith('#EXTM3U')) throw new Error('не m3u8');
  const abs = (u: string) => new URL(u, baseUrl).href;

  let variant: string | null = null;
  let bestBw = -1;
  const segments: string[] = [];
  let init: string | null = null;
  let pendingBw = -1;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const m = line.match(/BANDWIDTH=(\d+)/);
      pendingBw = m ? parseInt(m[1]!, 10) : 0;
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
      segments.push(url);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('#EXT-X-MAP')) {
      const m = lines[i]!.match(/URI="([^"]+)"/);
      if (m) init = abs(m[1]!);
    }
  }

  return { variant, segments, init };
}
