export function sanitize(name: string): string {
  return (
    String(name)
      // eslint-disable-next-line no-control-regex -- deliberate: strip Windows-illegal control chars
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .slice(0, 120)
      .trim()
  );
}

export function sanitizePath(p: string | null | undefined): string {
  return String(p || '')
    .split(/[\\/]+/)
    .map((s) => sanitize(s))
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

export function pad(n: number, w: number): string {
  return String(n).padStart(Math.max(2, w), '0');
}

export function sniffExt(b: Uint8Array | null | undefined): string {
  if (!b || b.length < 4) return 'bin';
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3';
  if (b[0] === 0xff) {
    const x = b[1] ?? 0;
    if (x === 0xf1 || x === 0xf9 || (x & 0xfe) === 0xf0) return 'aac';
    if ((x & 0xe0) === 0xe0) return 'mp3';
    return 'bin';
  }
  if (b[0] === 0x47 && b.length > 188 && b[188] === 0x47) return 'ts';
  return 'bin';
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
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
