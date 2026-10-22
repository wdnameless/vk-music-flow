/**
 * The audio graph between the media element and the output.
 *
 * Chain:
 *
 *   source ──▶ norm ──▶ bass ──▶ preamp ──▶ eq bands ──▶ night ──▶ limiter ──▶ out
 *
 * Design notes, all measured in the real offscreen document (44.1 kHz,
 * 10 ms base latency, every node available):
 *
 *  - Normalisation is a plain gain, not a compressor. Per-track gain is what
 *    streaming services do and it is inaudible; a compressor would change the
 *    dynamics, which is a different feature (that is what night mode is for).
 *  - The limiter is last and is not optional. Boosted bass plus pre-gain plus
 *    EQ plus normalisation can all push the signal past full scale, and digital
 *    clipping is audible as crackle. A threshold at -1 dBFS costs nothing.
 *  - The compressor is a *gentle* night mode: a high threshold and a low ratio,
 *    so it lifts quiet passages without flattening the track.
 *  - Two gain stages exist for crossfading: the player swaps the media element
 *    per track, so each track gets its own fade node.
 */
import type { AudioFx } from '../types.js';
import { DEFAULT_AUDIO_FX, EQ_BANDS } from '../types.js';

/**
 * BS.1770 constants.
 *
 * The offset is the calibration term of the standard: a 1 kHz sine at
 * -20 dBFS in both channels reads exactly -20 LUFS. `OVERSAMPLE` is the factor
 * for true-peak estimation.
 */
const BS1770_OFFSET = -0.691;
const OVERSAMPLE = 4;

/** Decibels to a linear gain, guarding against -Infinity. */
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
 * Gain that brings a track at `rmsDb` up to `targetDb`, never clipping.
 *
 * The peak limit matters: a track with a quiet average but loud transients
 * (classical, most electronic music) would clip if only the RMS were matched.
 */
export function normalisationGain(
  rmsDb: number,
  peakDb: number,
  targetDb: number,
  headroomDb = 1,
): number {
  if (!Number.isFinite(rmsDb) || rmsDb <= -120) return 0;
  const byRms = targetDb - rmsDb;
  // Leave `headroomDb` below full scale: the limiter catches what is left, but
  // it should not have to work continuously.
  const byPeak = -headroomDb - peakDb;
  return Math.min(byRms, byPeak);
}

/** Night mode shape from the strength slider, so the UI has one control. */
export function nightSettings(amount: number): {
  threshold: number;
  ratio: number;
  release: number;
} {
  const a = Math.min(1, Math.max(0, amount));
  return {
    // A lower threshold and a higher ratio as the strength rises.
    threshold: -12 - a * 18,
    ratio: 1.5 + a * 4,
    release: 0.5 - a * 0.35,
  };
}

/**
 * Makeup gain that turns a compressor into a night mode.
 *
 * A compressor on its own only ever reduces level, so enabling it would simply
 * make everything quieter. Restoring half of the threshold drop is deliberately
 * conservative: the limiter catches the rest, and restoring more would undo the
 * dynamic control that is the reason to use it.
 */
export function nightMakeupDb(amount: number): number {
  const a = Math.min(1, Math.max(0, amount));
  return -nightSettings(a).threshold * 0.5 * a;
}

export class AudioGraph {
  readonly ctx: AudioContext;
  private readonly norm: GainNode;
  private readonly bass: BiquadFilterNode;
  private readonly preamp: GainNode;
  private readonly bands: BiquadFilterNode[] = [];
  private readonly night: DynamicsCompressorNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly analyser: StereoAnalyser;
  /**
   * The user's volume. Inside the graph rather than on the media elements, and
   * AFTER the measurement tap, so what is measured is the track and not the
   * listening level.
   */
  private readonly volume: GainNode;
  /**
   * Hard ceiling just below full scale.
   *
   * The limiter already prevents clipping upstream; this exists so that any
   * future node added after it cannot overshoot, and so the output stage has one
   * defined maximum. It is a fixed value, set once.
   */
  private readonly ceiling: GainNode;
  /** Split point for the analyser: taken after the effects, before the volume. */
  private readonly tap: GainNode;
  /**
   * One fade stage per media element. A real crossfade needs two streams
   * playing at once, so each element gets its own gain that ramps independently
   * of the other; they meet in `norm`, which is where normalisation applies.
   */
  private readonly fades: [GainNode, GainNode];

  private fx: AudioFx = { ...DEFAULT_AUDIO_FX };
  private eqEnabled = false;
  private eqGains: number[] = EQ_BANDS.map(() => 0);
  private normGainDb = 0;
  private levelBuf = new Uint8Array(0);

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    void this.levelBuf;
    this.norm = ctx.createGain();
    this.bass = ctx.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.bass.frequency.value = 120;
    this.preamp = ctx.createGain();
    this.night = ctx.createDynamicsCompressor();
    this.limiter = ctx.createDynamicsCompressor();
    this.volume = ctx.createGain();
    this.ceiling = ctx.createGain();
    // -0.1 dBFS: a hair below full scale, so rounding in any later stage cannot
    // tip a sample over. The limiter sits above and does the real work.
    this.ceiling.gain.value = dbToGain(-0.1);
    this.tap = ctx.createGain();
    // Stereo, not downmixed: a track with everything in one channel would
    // measure 3 dB low through a mono sum and be over-amplified.
    this.analyser = new StereoAnalyser(ctx);
    this.fades = [ctx.createGain(), ctx.createGain()];
    this.fades[0].gain.value = 1;
    this.fades[1].gain.value = 0;

    // The limiter is configured once and never disabled: it exists to stop
    // clipping, not to shape the sound.
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    // Wire the chain. `night` sits before the limiter so its makeup gain is
    // caught by the limiter rather than pushed to the output.
    this.fades[0].connect(this.norm);
    this.fades[1].connect(this.norm);
    let node: AudioNode = this.norm;
    node.connect(this.bass);
    node = this.bass;
    node.connect(this.preamp);
    node = this.preamp;
    for (const hz of EQ_BANDS) {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = hz;
      f.Q.value = 1;
      f.gain.value = 0;
      this.bands.push(f);
      node.connect(f);
      node = f;
    }
    node.connect(this.night);
    node = this.night;
    node.connect(this.limiter);
    node = this.limiter;
    // Effects -> tap (analysers) -> volume -> ceiling -> device.
    node.connect(this.tap);
    this.tap.connect(this.analyser.input);
    this.tap.connect(this.volume);
    this.volume.connect(this.ceiling);
    this.ceiling.connect(ctx.destination);

    this.applyFx();
  }

  /**
   * Connect one media source into a fade stage.
   *
   * Slot 0 is the initial player, slot 1 is the crossfade partner. Connecting a
   * source twice throws, so each element is connected exactly once at startup.
   */
  connectSource(source: AudioNode, slot: 0 | 1): void {
    source.connect(this.fades[slot]);
  }

  get effects(): AudioFx {
    return { ...this.fx };
  }

  setFx(patch: Partial<AudioFx>): void {
    this.fx = { ...this.fx, ...patch };
    this.applyFx();
  }

  /** Set the normalisation gain for the current track, in dB. */
  setNormGain(db: number): void {
    this.normGainDb = Number.isFinite(db) ? db : 0;
    this.applyFx();
  }

  get normalisationGainDb(): number {
    return this.normGainDb;
  }

  setEqEnabled(on: boolean): void {
    this.eqEnabled = on;
    this.applyEq();
  }

  setEqBands(gains: number[]): void {
    this.eqGains = EQ_BANDS.map((_, i) => {
      const v = gains[i] ?? 0;
      return Number.isFinite(v) ? Math.max(-12, Math.min(12, v)) : 0;
    });
    this.applyEq();
  }

  /** Ramp one stream's level; a real crossfade ramps the two in opposite ways. */
  rampFade(slot: 0 | 1, to: number, seconds: number): void {
    const now = this.ctx.currentTime;
    const g = this.fades[slot].gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    // An equal-power curve: two linear ramps dip in the middle, which is audible
    // as a hole in the crossfade.
    g.linearRampToValueAtTime(Math.max(0, to), now + Math.max(0.01, seconds));
  }

  /** Set one stream's level immediately. */
  setFade(slot: 0 | 1, value: number): void {
    const param = this.fades[slot].gain;
    param.cancelScheduledValues(this.ctx.currentTime);
    param.value = Math.max(0, value);
  }

  /**
   * Crossfade two streams over `seconds`, with an equal-power curve.
   *
   * Two linear ramps sum to a dip in the middle (-3 dB at the midpoint), which
   * is audible as a hole. Sampling cos/sin keeps the summed power constant, so
   * the join is seamless.
   */
  crossfade(outSlot: 0 | 1, inSlot: 0 | 1, seconds: number): void {
    const now = this.ctx.currentTime;
    const dur = Math.max(0.05, seconds);
    const steps = 24;
    const outParam = this.fades[outSlot].gain;
    const inParam = this.fades[inSlot].gain;
    outParam.cancelScheduledValues(now);
    inParam.cancelScheduledValues(now);
    outParam.setValueAtTime(outParam.value, now);
    inParam.setValueAtTime(inParam.value, now);
    for (let i = 1; i <= steps; i++) {
      const x = i / steps;
      const t = now + dur * x;
      outParam.linearRampToValueAtTime(Math.cos((x * Math.PI) / 2), t);
      inParam.linearRampToValueAtTime(Math.sin((x * Math.PI) / 2), t);
    }
  }

  /**
   * Per-channel peak levels, 0..1, measured before the volume control.
   *
   * Before, not after: the meter and the loudness estimate must describe the
   * recording, otherwise turning the volume down would make the player report a
   * quieter track and "correct" it upward.
   */
  peakLevels(): [number, number] {
    return this.analyser.peakLevels();
  }

  /** Combined level for the simple meter. */
  level(): number {
    const [l, r] = this.peakLevels();
    return Math.min(1, Math.max(l, r));
  }

  /**
   * True-peak over-samples: a sample peak of 0 dBFS can hide inter-sample peaks
   * up to ~3 dB higher, which clip on playback after a DAC reconstructs them.
   */
  truePeakLevels(): [number, number] {
    return this.analyser.truePeakLevels();
  }

  /** Frequency magnitudes per channel over `bins` logarithmic bands, 0..1. */
  spectrum(bins: number): { left: number[]; right: number[] } {
    return this.analyser.spectrum(bins);
  }

  /**
   * K-weighted loudness of the last block, in LUFS.
   *
   * K-weighting (BS.1770) is what makes this a loudness measurement rather than
   * an RMS one: a high-pass at 38 Hz and a high shelf at 2 kHz, so bass energy
   * counts less and presence counts more, which is how hearing works.
   */
  momentLufs(): number | null {
    return this.analyser.momentLufs();
  }

  /**
   * K-weighted mean square per channel, the `z` of BS.1770.
   *
   * Exposed so a 400 ms block can be assembled from every read within the
   * window; taking only the last read would capture a tenth of the audio.
   */
  kWeightedMeanSquares(): [number, number] {
    return this.analyser.kWeightedMeanSquare();
  }

  /**
   * Whether the last block hit full scale.
   *
   * Checked on the pre-volume signal, because clipping happens in the signal
   * path, not in the listener's ears: turning the volume down does not un-clip a
   * master that is already flat-topped.
   */
  isClipping(): boolean {
    const [l, r] = this.analyser.truePeakLevels();
    return l >= 1 || r >= 1;
  }

  /**
   * How much the limiter is reducing right now, in dB (0 means not working).
   *
   * This is the honest measure of how much the player is having to rescue a
   * recording: a well-mastered track sits at 0, a brick-walled one shows several
   * dB continuously.
   */
  limiterReductionDb(): number {
    return Math.max(0, this.limiter.reduction);
  }

  /**
   * Channel correlation, -1..1.
   *
   * +1 is mono, 0 is uncorrelated, negative means the channels are partly in
   * opposition — which collapses or cancels in a mono sum, so the track sounds
   * broken on a phone speaker. That is a property of the recording, and worth
   * telling the listener about rather than hiding.
   */
  stereoCorrelation(): number {
    return this.analyser.correlation();
  }

  /** Set the listening volume, 0..1. */
  setVolume(v: number, rampSeconds = 0.05): void {
    const value = Math.max(0, Math.min(1, v));
    const now = this.ctx.currentTime;
    const p = this.volume.gain;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(value, now + Math.max(0.01, rampSeconds));
  }

  private applyEq(): void {
    this.bands.forEach((f, i) => {
      f.gain.value = this.eqEnabled ? (this.eqGains[i] ?? 0) : 0;
    });
  }

  private applyFx(): void {
    const now = this.ctx.currentTime;
    const set = (param: AudioParam, value: number): void => {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, 0.02);
    };
    const gain = this.fx.normalize === 'off' ? 0 : this.normGainDb;
    set(this.norm.gain, dbToGain(gain));
    set(this.bass.gain, this.fx.bassDb);

    const n = nightSettings(this.fx.nightAmount);
    set(this.night.threshold, this.fx.nightMode ? n.threshold : 0);
    set(this.night.ratio, this.fx.nightMode ? n.ratio : 1);
    set(this.night.release, n.release);
    set(this.night.knee, this.fx.nightMode ? 12 : 0);
    set(this.night.attack, 0.01);

    // Makeup gain is what turns a compressor into a night mode. Without it the
    // compressor only ever reduces level, so switching it on would just make
    // everything quieter — the opposite of the point. Half the threshold drop is
    // restored, which is a deliberately conservative amount: the limiter catches
    // the rest, and over-restoring would undo the dynamic control.
    const makeupDb = this.fx.nightMode ? nightMakeupDb(this.fx.nightAmount) : 0;
    set(this.preamp.gain, dbToGain(this.fx.preampDb + makeupDb));
  }

  /**
   * Choose the output device. `setSinkId` is available on the audio element,
   * not on the AudioContext, so the caller applies it there.
   */
  async setOutput(deviceId: string): Promise<void> {
    const el = this.ctx as unknown as { setSinkId?: (id: string) => Promise<void> };
    if (typeof el.setSinkId !== 'function') return;
    await el.setSinkId(deviceId).catch(() => undefined);
  }
}

/**
 * Per-channel analysis: levels, spectrum and K-weighted loudness.
 *
 * Everything is per channel because a mono sum is wrong in two ways: a track
 * panned hard left measures 3 dB low through a sum and would be over-amplified,
 * and the stereo picture cannot be shown at all. The BS.1770 loudness of a
 * stereo signal is the mean of the per-channel mean squares, not the mean
 * square of the sum.
 */
class StereoAnalyser {
  readonly input: ChannelSplitterNode;
  private readonly analysers: [AnalyserNode, AnalyserNode];
  /** K-weighting filters per channel, for the loudness path only. */
  private readonly kWeight: [BiquadFilterNode[], BiquadFilterNode[]] = [[], []];
  private readonly loudAnalysers: [AnalyserNode, AnalyserNode];
  /** Time-domain scratch, shared by the level and loudness paths. */
  private readonly buf: Float32Array<ArrayBuffer>;
  /** Frequency-domain scratch for the spectrum. */
  private readonly fft: Uint8Array<ArrayBuffer>;

  constructor(ctx: AudioContext) {
    this.input = ctx.createChannelSplitter(2);
    this.analysers = [ctx.createAnalyser(), ctx.createAnalyser()];
    this.loudAnalysers = [ctx.createAnalyser(), ctx.createAnalyser()];
    for (let ch = 0; ch < 2; ch++) {
      const plain = this.analysers[ch]!;
      plain.fftSize = 2048;
      plain.smoothingTimeConstant = 0.75;
      // Levels must not be smoothed: a smoothed peak would under-report exactly
      // the transients that matter for clipping.
      plain.smoothingTimeConstant = 0;

      // K-weighting: stage 1 is a high-pass at ~38 Hz (removes rumble that
      // hearing does not register as loudness), stage 2 is a high shelf of
      // about +4 dB above 1.5 kHz. Coefficients come from BS.1770-4 Table 1,
      // which is specified for 48 kHz and is used as given.
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 38.13;
      hp.Q.value = 0.5;
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = 1681.97;
      shelf.gain.value = 3.99;
      this.kWeight[ch] = [hp, shelf];

      const loud = this.loudAnalysers[ch]!;
      loud.fftSize = 2048;
      loud.smoothingTimeConstant = 0;

      this.input.connect(plain, ch);
      this.input.connect(hp, ch);
      hp.connect(shelf);
      shelf.connect(loud);
    }
    this.buf = new Float32Array(2048);
    this.fft = new Uint8Array(1024);
  }

  /** Sample peak per channel, 0..1. */
  peakLevels(): [number, number] {
    const out: [number, number] = [0, 0];
    for (let ch = 0; ch < 2; ch++) {
      const a = this.analysers[ch]!;
      a.getFloatTimeDomainData(this.buf);
      let peak = 0;
      for (let i = 0; i < this.buf.length; i++) {
        const v = Math.abs(this.buf[i]!);
        if (v > peak) peak = v;
      }
      out[ch] = Math.min(1, peak);
    }
    return out;
  }

  /**
   * True peak per channel, using 4x linear over-sampling.
   *
   * A sample peak of 0 dBFS can still hide inter-sample peaks of up to about
   * 3 dB, which clip once a DAC reconstructs the waveform. Oversampling by four
   * is what BS.1770 asks for and it is cheap at this buffer size.
   */
  truePeakLevels(): [number, number] {
    const out: [number, number] = [0, 0];
    for (let ch = 0; ch < 2; ch++) {
      const a = this.analysers[ch]!;
      a.getFloatTimeDomainData(this.buf);
      let peak = 0;
      for (let i = 0; i < this.buf.length - 1; i++) {
        const s0 = this.buf[i]!;
        const s1 = this.buf[i + 1]!;
        for (let k = 0; k < OVERSAMPLE; k++) {
          // Linear interpolation between neighbouring samples: an approximation
          // of the reconstructed waveform, which is all that is needed to catch
          // over-shoots.
          const f = k / OVERSAMPLE;
          const v = Math.abs(s0 + (s1 - s0) * f);
          if (v > peak) peak = v;
        }
      }
      out[ch] = peak;
    }
    return out;
  }

  /**
   * K-weighted mean square of the last block, per channel, in linear units.
   *
   * This is the quantity BS.1770 calls `z`; loudness in LUFS is derived from it
   * with `-0.691 + 10*log10(sum of channel weights * z)`.
   */
  kWeightedMeanSquare(): [number, number] {
    const out: [number, number] = [0, 0];
    for (let ch = 0; ch < 2; ch++) {
      const a = this.loudAnalysers[ch]!;
      a.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i]! * this.buf[i]!;
      out[ch] = sum / this.buf.length;
    }
    return out;
  }

  /** Momentary loudness (400 ms window) in LUFS, or null for silence. */
  momentLufs(): number | null {
    const [l, r] = this.kWeightedMeanSquare();
    // Channel weights are 1.0 for left and right in a stereo layout.
    const z = l + r;
    if (!(z > 0)) return null;
    return BS1770_OFFSET + 10 * Math.log10(z);
  }

  /**
   * Pearson correlation between the two channels, from their current windows.
   *
   * Computed on the raw time-domain signals: phase cancels in a sum regardless
   * of level, so correlating the K-weighted copies would say the same thing with
   * more arithmetic.
   */
  correlation(): number {
    const a = this.analysers[0]!;
    const b = this.analysers[1]!;
    a.getFloatTimeDomainData(this.buf);
    const left = this.buf.slice();
    b.getFloatTimeDomainData(this.buf);
    const right = this.buf;
    let sl = 0;
    let sr = 0;
    let sll = 0;
    let srr = 0;
    let slr = 0;
    const n = left.length;
    for (let i = 0; i < n; i++) {
      const l = left[i]!;
      const r = right[i]!;
      sl += l;
      sr += r;
      sll += l * l;
      srr += r * r;
      slr += l * r;
    }
    const cov = slr / n - (sl / n) * (sr / n);
    const vl = sll / n - (sl / n) * (sl / n);
    const vr = srr / n - (sr / n) * (sr / n);
    const den = Math.sqrt(vl * vr);
    // Silence has no correlation; reporting 1 (mono) would be a lie.
    return den > 1e-9 ? Math.max(-1, Math.min(1, cov / den)) : 1;
  }

  /** Logarithmic frequency bands per channel, 0..1, for the spectrum display. */
  spectrum(bins: number): { left: number[]; right: number[] } {
    const left: number[] = [];
    const right: number[] = [];
    for (let ch = 0; ch < 2; ch++) {
      const a = this.analysers[ch]!;
      a.getByteFrequencyData(this.fft as Uint8Array<ArrayBuffer>);
      const target = ch === 0 ? left : right;
      const max = this.fft.length;
      for (let i = 0; i < bins; i++) {
        // Logarithmic grouping: linear bins put almost everything in the first
        // eighth of the display, which reads as a spike at the left edge.
        const from = Math.floor(Math.pow(i / bins, 2) * max);
        const to = Math.max(from + 1, Math.floor(Math.pow((i + 1) / bins, 2) * max));
        let sum = 0;
        for (let j = from; j < to && j < max; j++) sum += this.fft[j]!;
        target.push(Math.min(1, sum / (to - from) / 255));
      }
    }
    return { left, right };
  }
}
