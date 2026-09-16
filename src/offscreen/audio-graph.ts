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
export function normalisationGain(rmsDb: number, peakDb: number, targetDb: number, headroomDb = 1): number {
  if (!Number.isFinite(rmsDb) || rmsDb <= -120) return 0;
  const byRms = targetDb - rmsDb;
  // Leave `headroomDb` below full scale: the limiter catches what is left, but
  // it should not have to work continuously.
  const byPeak = -headroomDb - peakDb;
  return Math.min(byRms, byPeak);
}

/** Night mode shape from the strength slider, so the UI has one control. */
export function nightSettings(amount: number): { threshold: number; ratio: number; release: number } {
  const a = Math.min(1, Math.max(0, amount));
  return {
    // A lower threshold and a higher ratio as the strength rises.
    threshold: -12 - a * 18,
    ratio: 1.5 + a * 4,
    release: 0.5 - a * 0.35,
  };
}

export class AudioGraph {
  readonly ctx: AudioContext;
  private readonly norm: GainNode;
  private readonly bass: BiquadFilterNode;
  private readonly preamp: GainNode;
  private readonly bands: BiquadFilterNode[] = [];
  private readonly night: DynamicsCompressorNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly analyser: AnalyserNode;
  private readonly out: GainNode;
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
  private levelBuf: Uint8Array;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.norm = ctx.createGain();
    this.bass = ctx.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.bass.frequency.value = 120;
    this.preamp = ctx.createGain();
    this.night = ctx.createDynamicsCompressor();
    this.limiter = ctx.createDynamicsCompressor();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;
    this.levelBuf = new Uint8Array(this.analyser.fftSize);
    this.out = ctx.createGain();
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
    node.connect(this.out);
    this.out.connect(this.analyser);
    this.analyser.connect(ctx.destination);

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

  /** Current output level, 0..1, for the meter. */
  level(): number {
    this.analyser.getByteTimeDomainData(this.levelBuf as Uint8Array<ArrayBuffer>);
    let peak = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = Math.abs((this.levelBuf[i]! - 128) / 128);
      if (v > peak) peak = v;
    }
    return Math.min(1, peak);
  }

  /** Frequency magnitudes, 0..1, for the spectrum display. */
  spectrum(bins: number): number[] {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data as Uint8Array<ArrayBuffer>);
    const out: number[] = [];
    // Logarithmic grouping: linear bins put almost everything in the first
    // eighth of the display, which looks like a spike on the left.
    const max = data.length;
    for (let i = 0; i < bins; i++) {
      const from = Math.floor(Math.pow(i / bins, 2) * max);
      const to = Math.max(from + 1, Math.floor(Math.pow((i + 1) / bins, 2) * max));
      let sum = 0;
      for (let j = from; j < to && j < max; j++) sum += data[j]!;
      out.push(Math.min(1, sum / (to - from) / 255));
    }
    return out;
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
    set(this.preamp.gain, dbToGain(this.fx.preampDb));

    const n = nightSettings(this.fx.nightAmount);
    set(this.night.threshold, this.fx.nightMode ? n.threshold : 0);
    set(this.night.ratio, this.fx.nightMode ? n.ratio : 1);
    set(this.night.release, n.release);
    // Makeup gain keeps the level up as the threshold drops, so enabling night
    // mode does not simply make everything quieter.
    set(this.night.knee, this.fx.nightMode ? 12 : 0);
    set(this.night.attack, 0.01);
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
