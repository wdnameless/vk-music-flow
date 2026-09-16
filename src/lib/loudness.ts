/**
 * Loudness measurement and normalisation.
 *
 * This is BS.1770 / EBU R128 loudness, not RMS. The distinction matters: RMS
 * measures energy, loudness measures *perceived* energy. Two tracks with the
 * same RMS can differ by several dB in perceived level, because hearing is far
 * more sensitive between 2 and 5 kHz than below 100 Hz. K-weighting applies a
 * high-pass at 38 Hz and a high shelf above 1.5 kHz so the measurement follows
 * the ear, and gating discards silence so a quiet intro or a fade-out cannot
 * drag the average down.
 *
 * The measurement runs while the track plays, from the analysers already in the
 * audio graph. Decoding each file to analyse it would cost a full transfer per
 * track for a number that is stable across the whole track, and the listener
 * would wait for it. Sampling what is audible is free and is exactly what needs
 * correcting.
 *
 * Units: LUFS for loudness (negative, around -14 for modern masters), dBFS for
 * peaks. A 1 kHz sine at -20 dBFS in both channels reads -20 LUFS, which is the
 * calibration of the standard.
 */

/** Target level in LUFS. -14 is what the major streaming services normalise to. */
export const DEFAULT_TARGET_DB = -14;

/**
 * Absolute gate: blocks quieter than this are ignored entirely.
 *
 * -70 LUFS is the value in BS.1770. Without it, a track that fades out would
 * average its silence into the result.
 */
export const GATE_ABSOLUTE_LUFS = -70;

/**
 * Relative gate, in LU below the ungated loudness.
 *
 * This is the other half of the standard: once the absolute gate has removed
 * silence, the relative gate removes quiet *material* (a breakdown, a solo
 * passage) so a track with a dynamic structure is judged by its loud parts.
 */
export const GATE_RELATIVE_LU = -10;

/** Block length for the measurement, in seconds. BS.1770 specifies 400 ms. */
export const BLOCK_SECONDS = 0.4;

/** True-peak ceiling in dBFS. */
export const PEAK_CEILING_DB = -1;

/**
 * A gated loudness accumulator.
 *
 * Blocks are stored rather than averaged on the fly, because gating is defined
 * over the whole set: the relative threshold depends on the ungated mean, so the
 * individual blocks must still be available when it is computed.
 */
export interface LoudnessMeter {
  /** Loudness per 400 ms block, in LUFS. */
  blocks: number[];
  /** Loudest true peak seen, in dBFS. */
  truePeakDb: number;
  /** Seconds of audio folded in. */
  seconds: number;
}

export function createMeter(): LoudnessMeter {
  return { blocks: [], truePeakDb: -120, seconds: 0 };
}

/**
 * Fold one block into the meter.
 *
 * `lufs` is the momentary loudness of the block; `peakDb` its true peak.
 */
export function addBlock(meter: LoudnessMeter, lufs: number | null, peakDb: number, blockSeconds: number): void {
  meter.seconds += blockSeconds;
  if (Number.isFinite(peakDb) && peakDb > meter.truePeakDb) meter.truePeakDb = peakDb;
  if (lufs === null || !Number.isFinite(lufs)) return;
  meter.blocks.push(lufs);
}

/** Mean of the values, or null when there are none. */
function mean(values: number[]): number | null {
  if (!values.length) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Gated integrated loudness in LUFS, or null when nothing qualifies.
 *
 * Both gates are applied in the order the standard defines: the absolute gate
 * first, then the relative one computed from what survived.
 */
export function integratedLufs(meter: LoudnessMeter): number | null {
  const audible = meter.blocks.filter((b) => b > GATE_ABSOLUTE_LUFS);
  if (!audible.length) return null;
  const ungated = mean(audible);
  if (ungated === null) return null;
  const relative = ungated + GATE_RELATIVE_LU;
  const gated = audible.filter((b) => b > relative);
  // The relative gate can in principle reject everything if the distribution is
  // pathological; falling back to the absolute-gated mean is better than
  // reporting nothing at all.
  return mean(gated.length ? gated : audible);
}

/**
 * Gain that brings a track at `lufs` up to `target`, never exceeding the peak
 * ceiling.
 *
 * Both limits are needed. Matching loudness alone would push a quiet-on-average
 * track with loud transients (classical, a lot of electronic music) past full
 * scale; matching peaks alone would leave the original level differences in
 * place, which is the problem being solved.
 */
export function normalisationGain(lufs: number, truePeakDb: number, targetLufs: number): number {
  if (!Number.isFinite(lufs) || lufs <= GATE_ABSOLUTE_LUFS) return 0;
  const byLoudness = targetLufs - lufs;
  const byPeak = PEAK_CEILING_DB - truePeakDb;
  return Math.min(byLoudness, byPeak);
}

/** Decibels to a linear gain, guarding against -Infinity and NaN. */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return Math.pow(10, db / 20);
}

/** Linear gain to decibels, guarding against log(0). */
export function gainToDb(gain: number): number {
  if (!(gain > 0)) return -120;
  return 20 * Math.log10(gain);
}

/**
 * Dynamic range in dB, as `crest factor`: peak minus loudness.
 *
 * The usual streaming "DR" number. It is a rough but honest indicator of how
 * compressed a master is — a modern brick-walled track lands around 5-7 dB, a
 * well-mastered dynamic one around 12-18.
 */
export function dynamicRangeDb(truePeakDb: number, lufs: number | null): number | null {
  if (lufs === null || !Number.isFinite(truePeakDb)) return null;
  return truePeakDb - lufs;
}
