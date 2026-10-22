/**
 * MPEG-TS → MP3 demuxer for VK HLS segments.
 *
 * VK serves audio as HLS with MPEG-TS segments, but the elementary stream
 * inside is plain MP3 (measured: stream_type 0x03, 320 kbps / 48 kHz on
 * `seg-NN-a2.ts`). Concatenating the segments byte-for-byte produces a `.ts`
 * file; stripping the TS/PES framing instead yields the source MP3, which is
 * what the downloader saves.
 *
 * Returns `null` when the input is not a demuxable audio-only TS (desync,
 * no audio payload, broken PES) so the caller can fall back to saving `.ts`.
 */

const TS_PACKET = 188;
const TS_SYNC = 0x47;

/** PAT program → PMT pid, and PMT audio pid. Parsed, not hardcoded. */
function findAudioPid(ts: Uint8Array): number {
  let pmtPid = -1;
  let audioPid = -1;
  for (let o = 0; o + TS_PACKET <= ts.length; o += TS_PACKET) {
    if (ts[o] !== TS_SYNC) return -1;
    const pid = ((ts[o + 1]! & 0x1f) << 8) | ts[o + 2]!;
    if (pid !== 0 && pid !== pmtPid) continue;
    const start = payloadStart(ts, o);
    if (start < 0) continue;
    const p = skipPointer(ts, o, start);
    if (p < 0 || p + 12 > o + TS_PACKET) continue;
    const secLen = ((ts[p + 1]! & 0x0f) << 8) | ts[p + 2]!;
    if (pid === 0) {
      // PAT: programs start at p+8, 4 bytes each, CRC excluded.
      for (let q = p + 8; q + 4 <= p + 3 + secLen - 4 && q + 4 <= o + TS_PACKET; q += 4) {
        const prog = (ts[q]! << 8) | ts[q + 1]!;
        if (prog !== 0) pmtPid = ((ts[q + 2]! & 0x1f) << 8) | ts[q + 3]!;
      }
    } else {
      // PMT: entries start at p+12+program_info_length.
      const progLen = ((ts[p + 10]! & 0x0f) << 8) | ts[p + 11]!;
      for (let q = p + 12 + progLen; q + 5 <= p + 3 + secLen - 4 && q + 5 <= o + TS_PACKET;) {
        const stype = ts[q]!;
        const epid = ((ts[q + 1]! & 0x1f) << 8) | ts[q + 2]!;
        const esLen = ((ts[q + 3]! & 0x0f) << 8) | ts[q + 4]!;
        // 0x03 = ISO/IEC 11172 audio (MP3), 0x04 = 13818-3 audio, 0x0f = AAC.
        if (stype === 0x03 || stype === 0x04 || stype === 0x0f) audioPid = epid;
        q += 5 + esLen;
      }
      if (audioPid >= 0) return audioPid;
    }
    // PAT and PMT each arrive within the first packets; stop early.
    if (pmtPid >= 0 && pid === pmtPid) break;
  }
  // Fallback: VK's measured layout carries audio on PID 0x100.
  if (audioPid < 0 && hasPid(ts, 0x100)) audioPid = 0x100;
  return audioPid;
}

/** Offset of the TS payload within packet at `o`, or -1 when there is none. */
function payloadStart(ts: Uint8Array, o: number): number {
  const afc = (ts[o + 3]! >> 4) & 3;
  let p = o + 4;
  if (afc & 2) {
    const len = ts[p]!;
    p += 1 + len;
    if (p > o + TS_PACKET) return -1;
  }
  if (!(afc & 1)) return -1;
  return p;
}

/** Skip the pointer_field on PUSI packets; -1 when out of bounds. */
function skipPointer(ts: Uint8Array, o: number, p: number): number {
  if (ts[o + 1]! & 0x40) {
    const skip = 1 + ts[p]!;
    p += skip;
  }
  return p <= o + TS_PACKET ? p : -1;
}

function hasPid(ts: Uint8Array, want: number): boolean {
  for (let o = 0; o + TS_PACKET <= ts.length; o += TS_PACKET) {
    if (ts[o] !== TS_SYNC) return false;
    if ((((ts[o + 1]! & 0x1f) << 8) | ts[o + 2]!) === want) return true;
  }
  return false;
}

export function demuxTsToMp3(ts: Uint8Array): Uint8Array | null {
  if (!ts || ts.length < TS_PACKET || ts[0] !== TS_SYNC) return null;
  const audioPid = findAudioPid(ts);
  if (audioPid < 0) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let o = 0; o + TS_PACKET <= ts.length; o += TS_PACKET) {
    if (ts[o] !== TS_SYNC) return null;
    const pid = ((ts[o + 1]! & 0x1f) << 8) | ts[o + 2]!;
    if (pid !== audioPid) continue;
    let p = payloadStart(ts, o);
    if (p < 0) continue;
    if (ts[o + 1]! & 0x40) {
      // PES header: 00 00 01 <stream-id> <len:2> <flags:2> <hdrlen> …
      if (p + 9 > o + TS_PACKET || ts[p] !== 0 || ts[p + 1] !== 0 || ts[p + 2] !== 1) {
        return null;
      }
      p += 9 + ts[p + 8]!;
      if (p > o + TS_PACKET) return null;
    }
    if (p < o + TS_PACKET) {
      chunks.push(ts.subarray(p, o + TS_PACKET));
      total += o + TS_PACKET - p;
    }
  }
  if (!total) return null;
  const out = new Uint8Array(total);
  let w = 0;
  for (const c of chunks) {
    out.set(c, w);
    w += c.length;
  }
  return out;
}
