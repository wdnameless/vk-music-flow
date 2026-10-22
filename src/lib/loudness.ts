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

/**
 * Convert a K-weighted mean square into loudness in LUFS.
 *
 * `z` is the channel-weighted mean square of the block. This is the same
 * formula as the momentary path, exposed so a block assembled from several
 * samples uses exactly the same calibration.
 */
export function lufsFromMeanSquare(z: number): number | null {
  if (!(z > 0)) return null;
  return -0.691 + 10 * Math.log10(z);
}

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
export function addBlock(
  meter: LoudnessMeter,
  lufs: number | null,
  peakDb: number,
  blockSeconds: number,
): void {
  meter.seconds += blockSeconds;
  if (Number.isFinite(peakDb) && peakDb > meter.truePeakDb) meter.truePeakDb = peakDb;
  if (lufs === null || !Number.isFinite(lufs)) return;
  meter.blocks.push(lufs);
}

/**
 * An in-progress 400 ms block.
 *
 * A block must be a *contiguous* window: BS.1770 defines it as the mean square
 * over 400 ms, not as one instantaneous reading. Assembling it from every
 * analyser read within the window is what makes the figure a measurement rather
 * than a sample — taking only the last read captures about a tenth of the audio
 * and makes the result jump around with whatever happened to be playing at that
 * instant.
 */
export interface BlockAccumulator {
  sum: number;
  count: number;
  peakDb: number;
}

export function createBlock(): BlockAccumulator {
  return { sum: 0, count: 0, peakDb: -120 };
}

/** Fold one analyser read into the block. */
export function addToBlock(block: BlockAccumulator, z: number, peakDb: number): void {
  if (Number.isFinite(z) && z >= 0) {
    block.sum += z;
    block.count++;
  }
  if (Number.isFinite(peakDb) && peakDb > block.peakDb) block.peakDb = peakDb;
}

/** Close the block: its loudness and true peak, ready to be folded into a meter. */
export function closeBlock(block: BlockAccumulator): { lufs: number | null; peakDb: number } {
  const z = block.count ? block.sum / block.count : 0;
  return { lufs: lufsFromMeanSquare(z), peakDb: block.peakDb };
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
 * Reference level for ReplayGain tags.
 *
 * ReplayGain 2.0 measures against -18 LUFS, not the -14 the streaming services
 * use. Writing our own -14 figures into the tags would make every file play 4 dB
 * louder in foobar2000 than here, so the conversion happens at the tag boundary
 * and nowhere else.
 */
export const REPLAYGAIN_REFERENCE_LUFS = -18;

/** Convert a loudness measurement into a ReplayGain gain value, in dB. */
export function replayGainDb(lufs: number, reference = REPLAYGAIN_REFERENCE_LUFS): number {
  return reference - lufs;
}

/** ReplayGain stores peaks as linear amplitude, not decibels. */
export function replayGainPeak(truePeakDb: number): number {
  return dbToGain(truePeakDb);
}

/**
 * Album loudness from its tracks.
 *
 * The correct figure is the gated loudness of the album measured as one
 * continuous programme, which would need every block of every track retained.
 * Averaging the tracks' energies is the standard approximation and is what
 * ReplayGain implementations do: it is the energy mean, not the arithmetic mean,
 * so a quiet interlude cannot pull the album level up.
 */
export function albumLufs(trackLufs: number[]): number | null {
  const usable = trackLufs.filter((v) => Number.isFinite(v) && v > GATE_ABSOLUTE_LUFS);
  if (!usable.length) return null;
  let sum = 0;
  for (const v of usable) sum += Math.pow(10, v / 10);
  return 10 * Math.log10(sum / usable.length);
}

/** Whether to even out every track or preserve an album's internal dynamics. */
export type LoudnessMode = 'off' | 'track' | 'album';

/**
 * Gain for one track under the chosen mode.
 *
 * `album` preserves the differences between tracks of the same album, which is
 * the point of mastering one as a set: a quiet ballad is supposed to be quiet
 * next to the loud opener. Normalising per track would flatten that intention.
 */
export function modeGain(
  trackLufs: number,
  trackPeakDb: number,
  album: { lufs: number; peakDb: number } | null,
  target: number,
  mode: LoudnessMode,
): number {
  if (mode === 'off') return 0;
  if (mode === 'album' && album !== null) {
    // Album gain is ONE value for the whole album, limited by the album's
    // loudest peak — not a per-track figure that happens to use the album
    // loudness. Deriving it from each track's own peak would leave the tracks
    // gaining different amounts, which is exactly the difference the mode is
    // supposed to preserve.
    return normalisationGain(album.lufs, album.peakDb, target);
  }
  // The peak limit applies in both modes: not clipping is not a level-matching
  // question.
  return normalisationGain(trackLufs, trackPeakDb, target);
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
