import { describe, expect, it } from 'vitest';

import { demuxTsToMp3 } from '../src/lib/tsdemux.js';

/** Build one 188-byte TS packet. */
function packet(pid: number, payload: Uint8Array, pusi = false, afc: 1 | 2 | 3 = 1): Uint8Array {
  const p = new Uint8Array(188).fill(0xff);
  p[0] = 0x47;
  p[1] = ((pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f)) & 0xff;
  p[2] = pid & 0xff;
  p[3] = (afc << 4) | 0x0;
  let off = 4;
  if (afc & 2) {
    p[off] = 0; // adaptation length 0
    off += 1;
  }
  if (afc & 1) p.set(payload.subarray(0, 188 - off), off);
  return p;
}

/** Minimal PAT: program 1 → PMT pid 0x1000. */
function pat(): Uint8Array {
  const s = new Uint8Array(16);
  s[0] = 0; // pointer_field
  s.set([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00], 1);
  s.set([0x00, 0x01, 0xf0, 0x00], 9); // program 1 → pid 0x1000
  return packet(0, s, true);
}

/** Minimal PMT: stream_type 0x03 (MP3) on pid 0x100. */
function pmt(): Uint8Array {
  const s = new Uint8Array(21);
  s[0] = 0;
  s.set([0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00], 1);
  s.set([0xe1, 0x00, 0xf0, 0x00], 9); // PCR pid 0x100, prog len 0
  s.set([0x03, 0xe1, 0x00, 0xf0, 0x00], 13); // type 0x03, pid 0x100
  return packet(0x1000, s, true);
}

/** Audio packet with a PES header + raw payload. */
function audio(payload: Uint8Array, first: boolean, hdrLen = 0): Uint8Array {
  if (!first) return packet(0x100, payload, false);
  const pes = new Uint8Array(9 + hdrLen + payload.length);
  pes.set([0x00, 0x00, 0x01, 0xc0, 0x00, 0x00, 0x80, 0x80, hdrLen], 0);
  pes.set(payload, 9 + hdrLen);
  return packet(0x100, pes, true);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('tsdemux: TS → MP3', () => {
  it('извлекает MP3-пейлоад через PAT/PMT/PES', () => {
    const a = new Uint8Array(100).map((_, i) => i & 0xff);
    const b = new Uint8Array(184).map((_, i) => (255 - i) & 0xff);
    const ts = concat([pat(), pmt(), audio(a, true), audio(b, false)]);
    const out = demuxTsToMp3(ts);
    expect(out).not.toBeNull();
    // First audio packet: 188 - 4 - 9 = 175 bytes of `a` fit, rest continues.
    const full = concat([a, b]);
    expect(out!.length).toBe(175 + 184);
    expect(out!.subarray(0, 100)).toEqual(a);
    expect(out!.subarray(175, 175 + 184)).toEqual(b.subarray(0, 184));
    expect(full.length).toBeGreaterThan(0);
  });

  it('пропускает adaptation field и пакеты без пейлоада', () => {
    const a = new Uint8Array(50).fill(0xab);
    const noPayload = packet(0x100, new Uint8Array(0), false, 2);
    const ts = concat([pat(), pmt(), noPayload, audio(a, true)]);
    const out = demuxTsToMp3(ts);
    expect(out).not.toBeNull();
    expect(out!.subarray(0, 50)).toEqual(a);
  });

  it('возвращает null на рассинхроне', () => {
    const ts = concat([pat(), pmt(), audio(new Uint8Array(10), true)]);
    ts[188] = 0x00;
    expect(demuxTsToMp3(ts)).toBeNull();
  });

  it('возвращает null на пустом входе и не-TS', () => {
    expect(demuxTsToMp3(new Uint8Array(0))).toBeNull();
    expect(demuxTsToMp3(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(demuxTsToMp3(new Uint8Array(188).fill(0xff))).toBeNull();
  });

  it('возвращает null при битом PES-заголовке', () => {
    const bad = packet(0x100, new Uint8Array(20).fill(0x11), true);
    const ts = concat([pat(), pmt(), bad]);
    expect(demuxTsToMp3(ts)).toBeNull();
  });

  it('фолбэк на PID 0x100 без PMT', () => {
    const a = new Uint8Array(30).fill(0xcd);
    const ts = concat([audio(a, true), audio(a, false)]);
    const out = demuxTsToMp3(ts);
    expect(out).not.toBeNull();
    expect(out!.subarray(0, 30)).toEqual(a);
  });
});
