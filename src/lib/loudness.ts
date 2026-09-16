/**
 * Loudness measurement and normalisation.
 *
 * VK tracks come from wildly different masters: an old recording and a modern
 * "brick-walled" master can differ by more than 12 dB, so a playlist forces the
 * listener to keep reaching for the volume.
 *
 * The measurement runs while the track plays, from the analyser that is already
 * in the audio graph. The alternative — downloading and decoding each file to
 * analyse it — costs a full transfer per track for a number that is stable
 * across the whole track, and the user would wait for it. Sampling what is
 * actually audible is both free and exactly what needs correcting.
 *
 * The result is cached per track, so only the first play is uncorrected.
 */

/** Target level in dBFS. -14 is what the major streaming services normalise to. */
export const DEFAULT_TARGET_DB = -14;

/**
 * Enough samples for the running average to settle.
 *
 * The player polls at 20 Hz, so this is about eight seconds of playback: long
 * enough to be past an intro, short enough that the correction lands early in
 * the track's next play rather than in its middle.
 */
export const MIN_SAMPLES = 160;

/** A running estimate of a track's loudness, accumulated across frames. */
export interface LoudnessAccumulator {
  /** Sum of squared sample values (linear, 0..1). */
  sumSquares: number;
  /** Highest absolute sample seen (linear, 0..1). */
  peak: number;
  /** Number of frames folded in. */
  frames: number;
}

export function createAccumulator(): LoudnessAccumulator {
  return { sumSquares: 0, peak: 0, frames: 0 };
}

/**
 * Fold one peak sample into the accumulator.
 *
 * `value` is a linear peak magnitude (0..1), i.e. the loudest excursion the
 * analyser saw in that window.
 *
 * Averaging the peaks themselves would be wrong — `mean(peak)` is dominated by
 * transients and reports roughly -3 dBFS for any modern master. Loudness is a
 * property of energy, so the square of the peak is accumulated and the mean of
 * those squares is what becomes the RMS. The peak field is tracked separately
 * and never reset, so it stays a true maximum.
 */
export function accumulate(acc: LoudnessAccumulator, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  acc.sumSquares += value * value;
  // `value` can legitimately be 0 for a silent stretch, which must not count as
  // a peak; the accumulator starts at 0 and only ever rises.
  if (value > acc.peak) acc.peak = value;
  acc.frames++;
}

/** Whether enough has been sampled for the estimate to be worth using. */
export function isMeasured(acc: LoudnessAccumulator): boolean {
  return acc.frames >= MIN_SAMPLES;
}

/** Integrated RMS in dBFS, or null while there is nothing to report. */
export function rmsDb(acc: LoudnessAccumulator): number | null {
  if (!acc.frames) return null;
  const mean = acc.sumSquares / acc.frames;
  if (!(mean > 0)) return -120;
  return 10 * Math.log10(mean);
}

/**
 * True peak in dBFS, or null when nothing has been sampled.
 *
 * A result of exactly 0 dBFS is normal: it is what a fully limited master
 * looks like, and those are the tracks that need the most correction.
 */
export function peakDb(acc: LoudnessAccumulator): number | null {
  if (!acc.frames) return null;
  if (!(acc.peak > 0)) return -120;
  return 20 * Math.log10(acc.peak);
}
