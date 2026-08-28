export interface Id3Meta {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | string | null;
  track?: number | string | null;
}

function syncsafe(n: number): number[] {
  return [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
}

export function stripTag(bytes: Uint8Array): Uint8Array {
  if (!(bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)) return bytes;
  const size =
    (((bytes[6] ?? 0) & 0x7f) << 21) |
    (((bytes[7] ?? 0) & 0x7f) << 14) |
    (((bytes[8] ?? 0) & 0x7f) << 7) |
    ((bytes[9] ?? 0) & 0x7f);
  const flags = bytes[5] ?? 0;
  let total = 10 + size;
  if (flags & 0x10) total += 10;
  return bytes.subarray(Math.min(total, bytes.length));
}

function frame(id: string, payload: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(id);
  const size = syncsafe(payload.length);
  const flags = new Uint8Array([0, 0]);
  return concat([head, new Uint8Array(size), flags, payload]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function textPayload(value: string | number): Uint8Array {
  const body = new Uint8Array([...new TextEncoder().encode(String(value)), 0x00]);
  return concat([new Uint8Array([3]), body]);
}

function usltPayload(lyrics: string): Uint8Array {
  return concat([
    new Uint8Array([3]),
    new TextEncoder().encode('eng'),
    new Uint8Array([0x00]),
    new Uint8Array([...new TextEncoder().encode(String(lyrics)), 0x00]),
  ]);
}

function apicPayload(imgBytes: Uint8Array): Uint8Array {
  let mime = 'image/jpeg';
  if (imgBytes[0] === 0x89 && imgBytes[1] === 0x50 && imgBytes[2] === 0x4e && imgBytes[3] === 0x47)
    mime = 'image/png';
  return concat([
    new Uint8Array([3]),
    new TextEncoder().encode(mime),
    new Uint8Array([0x00]),
    new Uint8Array([3]),
    new Uint8Array([0x00]),
    imgBytes,
  ]);
}

function buildFrameList(
  meta: Id3Meta,
  coverBytes: Uint8Array | null,
  lyrics: string | null | undefined,
): Uint8Array[] {
  const f: Uint8Array[] = [];
  if (meta.title) f.push(frame('TIT2', textPayload(meta.title)));
  if (meta.artist) f.push(frame('TPE1', textPayload(meta.artist)));
  if (meta.album) f.push(frame('TALB', textPayload(meta.album)));
  if (meta.track) f.push(frame('TRCK', textPayload(String(meta.track))));
  if (meta.year) f.push(frame('TDRC', textPayload(String(meta.year))));
  if (lyrics) f.push(frame('USLT', usltPayload(lyrics)));
  if (coverBytes && coverBytes.length > 100) f.push(frame('APIC', apicPayload(coverBytes)));
  return f;
}

export function buildTag(
  meta: Id3Meta,
  coverBytes: Uint8Array | null,
  lyrics: string | null | undefined,
): Uint8Array | null {
  const frames = buildFrameList(meta, coverBytes, lyrics);
  if (!frames.length) return null;
  let len = 0;
  for (const fr of frames) len += fr.length;
  const header = concat([
    new TextEncoder().encode('ID3'),
    new Uint8Array([4, 0]),
    new Uint8Array([0]),
    new Uint8Array(syncsafe(len)),
  ]);
  return concat([header, ...frames]);
}
