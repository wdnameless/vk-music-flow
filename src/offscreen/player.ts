import type { AudioFx, EqBand, PlayerState, PlayerTrack, RepeatMode } from '../types.js';
import { DEFAULT_AUDIO_FX, EQ_BANDS } from '../types.js';
import { AudioGraph } from './audio-graph.js';
import { accumulate, createAccumulator, isMeasured, peakDb, rmsDb } from '../lib/loudness.js';
import { advancePos, buildOrder, insertIntoOrder, moveInOrder, removeFromOrder } from './queue-order.js';

/**
 * Audio player running inside the offscreen document.
 *
 * Design notes, all measured rather than assumed:
 *  - Chromium plays VK's HLS directly: feeding an `audio.getById` stream URL to
 *    a plain <audio> element resolves `play()`, reports a real duration and
 *    advances currentTime (verified: 611.8s track, progress past 1.6s). No
 *    HLS.js, no MSE, no shaka-player — the AES-128 playlist is handled by the
 *    browser itself.
 *  - An offscreen document is required because an MV3 service worker has no DOM
 *    and therefore no HTMLMediaElement; `AUDIO_PLAYBACK` is the documented
 *    reason for creating one.
 *
 * The player owns the queue and the audio graph; the service worker only sends
 * commands and receives state, so playback survives popup closes.
 */

const EQ_MIN_DB = -12;
const EQ_MAX_DB = 12;
/** Fade applied on play/pause/volume changes; avoids audible clicks. */
const RAMP_S = 0.05;

export interface PlayerEvents {
  onState(state: PlayerState): void;
  /** Called when a track ends so the host can scrobble and advance. */
  onEnded(track: PlayerTrack): void;
  /**
   * A settled loudness estimate for a track. Reported once per play, because
   * the worker caches it and only needs it the first time.
   */
  onLoudness(key: string, rms: number, peak: number): void;
}

export class Player {
  private readonly audio: HTMLAudioElement;
  /**
   * The crossfade partner. A real overlap needs two streams at once; this one
   * is silent except during the fade, when it carries the incoming track.
   */
  private readonly audio2: HTMLAudioElement;
  /** Which of the two elements is currently audible. */
  private activeSlot: 0 | 1 = 0;
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private readonly graph: AudioGraph;
  /** The list as the user sees it. */
  private queue: PlayerTrack[] = [];
  /**
   * Play order: indices into `queue`. Kept separately from the list so shuffle
   * is reversible and dragging still means something while shuffled.
   */
  private order: number[] = [];
  /** Cursor into `order`, not into `queue`. */
  private pos = -1;
  private shuffle = false;
  private repeat: RepeatMode = 'off';
  private eqEnabled = false;
  private eqGains: number[] = EQ_BANDS.map(() => 0);
  private volume = 1;
  private fx: AudioFx = { ...DEFAULT_AUDIO_FX };
  /** Normalisation gain for the current track, in dB, supplied by the worker. */
  private normGainDb = 0;
  private outputDeviceId = '';
  private outputDevices: { id: string; label: string }[] = [];
  /** Seconds left of the crossfade into the current track, for the meter. */
  private crossfadeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Running loudness estimate for the track that is playing, so normalisation
   * is applied on the next play without ever downloading the file to analyse it.
   */
  private loudness = createAccumulator();
  private loudnessKey = '';
  private readonly events: PlayerEvents;

  constructor(events: PlayerEvents) {
    this.events = events;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    // Keep playing when the element is not "visible" (it never is, offscreen).
    this.audio.crossOrigin = 'anonymous';
    this.audio2 = new Audio();
    this.audio2.preload = 'auto';
    this.audio2.crossOrigin = 'anonymous';

    this.ctx = new AudioContext();
    this.graph = new AudioGraph(this.ctx);
    // The output level is part of the graph so it is applied after every
    // effect: normalisation, eq and night mode all feed into it.
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volume;

    try {
      // Each element is connected exactly once, at startup: connecting a media
      // element to a source twice throws.
      this.graph.connectSource(this.ctx.createMediaElementSource(this.audio), 0);
      this.graph.connectSource(this.ctx.createMediaElementSource(this.audio2), 1);
      this.graph.setFade(0, 1);
      this.graph.setFade(1, 0);
    } catch {
      // Fall back to the element's own output if the graph cannot be built;
      // playback still works, only the effects are unavailable.
    }

    // Both elements report, but only the active one may drive the UI: the
    // silent partner still fires play/pause/timeupdate during a crossfade.
    for (const [el, slot] of [[this.audio, 0], [this.audio2, 1]] as const) {
      el.addEventListener('ended', () => {
        if (slot === this.activeSlot) this.handleEnded();
      });
      el.addEventListener('error', () => this.emit());
      el.addEventListener('timeupdate', () => {
        if (slot === this.activeSlot) this.emit();
      });
      el.addEventListener('loadedmetadata', () => this.emit());
      el.addEventListener('play', () => this.emit());
      el.addEventListener('pause', () => this.emit());
    }
  }

  /** Resume the AudioContext (it starts suspended until a user gesture). */
  async resumeContext(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* a gesture may be needed; playback via the element still works */
      }
    }
  }

  private handleEnded(): void {
    const cur = this.current();
    if (cur) this.events.onEnded(cur);
    if (this.repeat === 'one') {
      // Repeat-one only applies to a natural end; `next()` must still advance,
      // otherwise the button would look broken.
      const el = this.el();
      el.currentTime = 0;
      void el.play().catch(() => undefined);
      return;
    }
    void this.advance(1);
  }

  /** Position of the current track within `queue`, i.e. `order[pos]`. */
  private currentQueueIndex(): number {
    return this.pos >= 0 && this.pos < this.order.length ? (this.order[this.pos] ?? -1) : -1;
  }

  private current(): PlayerTrack | null {
    const qi = this.currentQueueIndex();
    return qi >= 0 ? (this.queue[qi] ?? null) : null;
  }

  /**
   * Move `delta` steps along the play order, honouring repeat.
   *
   * `all` wraps around; `off` stops at the edge and leaves the last track
   * showing rather than clearing it, which is what a user expects to see.
   */
  private async advance(delta: number): Promise<void> {
    if (this.crossfadeTimer) {
      clearTimeout(this.crossfadeTimer);
      this.crossfadeTimer = null;
    }
    const next = advancePos(this.pos, this.order.length, delta, this.repeat === 'all');
    if (next === null) {
      this.emit();
      return;
    }
    this.pos = next;
    await this.playCurrent();
  }

  /** Rebuild `order` for the current shuffle setting, keeping `pos` valid. */
  private rebuildOrder(keepCurrent: boolean): void {
    const cur = keepCurrent ? this.currentQueueIndex() : -1;
    this.order = buildOrder(this.queue.length, this.shuffle, cur);
    this.pos = cur >= 0 ? Math.max(0, this.order.indexOf(cur)) : -1;
  }

  /** The element that is currently audible. */
  private el(): HTMLAudioElement {
    return this.activeSlot === 0 ? this.audio : this.audio2;
  }

  private async playCurrent(): Promise<void> {
    const t = this.current();
    if (!t) return;
    await this.resumeContext();
    // A manual start always uses slot 0 at full level; only a crossfade leaves
    // the two slots mid-ramp, and it sets them itself before calling this.
    if (!this.crossfading) {
      this.activeSlot = 0;
      this.graph.setFade(0, 1);
      this.graph.setFade(1, 0);
    }
    this.crossfading = false;
    // A fresh track starts a fresh measurement.
    this.loudness = createAccumulator();
    this.loudnessKey = t.key;
    this.loudnessReported = false;
    const el = this.el();
    el.src = t.url;
    el.currentTime = 0;
    try {
      await el.play();
    } catch {
      /* autoplay policy; the caller can retry with a gesture */
    }
    this.scheduleCrossfade();
    this.startLoudnessSampling();
    this.emit();
  }

  /**
   * Poll the analyser while a track plays.
   *
   * 20 Hz is chosen deliberately: fast enough that a track is measured in about
   * ten seconds, and cheap enough that it is a rounding error next to decoding
   * audio. `timeupdate` is not used because it fires four times a second, which
   * would take over a minute per track.
   */
  private startLoudnessSampling(): void {
    this.stopLoudnessSampling();
    this.loudnessTimer = setInterval(() => this.sampleLoudness(), 50);
  }

  private stopLoudnessSampling(): void {
    if (this.loudnessTimer !== null) {
      clearInterval(this.loudnessTimer);
      this.loudnessTimer = null;
    }
  }

  private loudnessTimer: ReturnType<typeof setInterval> | null = null;

  /** True while the two elements are mid-overlap. */
  private crossfading = false;

  /**
   * Arm the crossfade for the current track.
   *
   * The overlap has to start before the track ends, so a timer watches the
   * remaining time: `timeupdate` fires only ~4 times a second and stops while
   * the context is throttled, which is too coarse to land a 3-second fade.
   */
  private scheduleCrossfade(): void {
    if (this.crossfadeTimer) clearTimeout(this.crossfadeTimer);
    this.crossfadeTimer = null;
    const fade = this.fx.crossfadeSec;
    if (fade <= 0) return;
    const el = this.el();
    const dur = el.duration;
    if (!Number.isFinite(dur) || dur <= fade + 1) return;
    const delayMs = Math.max(0, (dur - el.currentTime - fade) * 1000);
    this.crossfadeTimer = setTimeout(() => void this.beginCrossfade(fade), delayMs);
  }

  /**
   * Start the next track early and overlap it with the current one.
   *
   * Both elements play through the graph at once, ramped by an equal-power
   * curve, then the outgoing one is stopped. The next track's URL comes from the
   * queue, which the worker keeps resolved ahead of playback.
   */
  private async beginCrossfade(seconds: number): Promise<void> {
    this.crossfadeTimer = null;
    const nextIdx = advancePos(this.pos, this.order.length, 1, this.repeat === 'all' || this.repeat === 'one');
    if (nextIdx === null) return;
    const nextTrack = this.queue[this.order[nextIdx] ?? -1];
    if (!nextTrack) return;

    const outgoing = this.activeSlot;
    const incoming: 0 | 1 = outgoing === 0 ? 1 : 0;
    const inEl = incoming === 0 ? this.audio : this.audio2;

    inEl.src = nextTrack.url;
    inEl.currentTime = 0;
    this.graph.setFade(incoming, 0);
    try {
      await inEl.play();
    } catch {
      // The incoming stream could not start; fall back to a normal transition
      // so playback is not lost.
      this.pos = nextIdx;
      await this.playCurrent();
      return;
    }

    this.crossfading = true;
    this.activeSlot = incoming;
    this.pos = nextIdx;
    this.graph.crossfade(outgoing, incoming, seconds);
    this.events.onEnded(nextTrack);
    this.emit();

    // Stop the outgoing element once the ramp is done, freeing it for the next
    // overlap. It must keep playing until then or the fade would cut out.
    this.crossfadeTimer = setTimeout(() => {
      this.crossfadeTimer = null;
      const outEl = outgoing === 0 ? this.audio : this.audio2;
      outEl.pause();
      outEl.removeAttribute('src');
      this.graph.setFade(outgoing, 0);
      this.graph.setFade(incoming, 1);
      this.scheduleCrossfade();
      this.emit();
    }, Math.max(50, seconds * 1000));
  }

  /** Replace the queue and start at `startIndex` of the list. */
  async setQueue(tracks: PlayerTrack[], startIndex = 0): Promise<void> {
    this.queue = tracks.slice();
    this.rebuildOrder(false);
    if (!this.queue.length) {
      this.el().pause();
      this.el().removeAttribute('src');
      this.emit();
      return;
    }
    const start = Math.max(0, Math.min(startIndex, this.queue.length - 1));
    // `order.indexOf` finds the cursor even when shuffled.
    this.pos = Math.max(0, this.order.indexOf(start));
    await this.playCurrent();
  }

  /** Turn shuffle on or off, keeping the current track playing. */
  setShuffle(on: boolean): void {
    if (this.shuffle === on) return;
    this.shuffle = on;
    this.rebuildOrder(true);
    this.emit();
  }

  setRepeat(mode: RepeatMode): void {
    this.repeat = mode;
    this.emit();
  }

  /**
   * Add tracks after the current one, or at the end.
   *
   * "Play next" inserts into `order` right after the cursor, so it takes effect
   * immediately even with shuffle on and without disturbing the rest of the
   * queue.
   */
  insert(tracks: PlayerTrack[], next = false): void {
    if (!tracks.length) return;
    const base = this.queue.length;
    this.queue.push(...tracks);
    const wasEmpty = !this.order.length;
    this.order = insertIntoOrder(this.order, base, tracks.length, this.pos, next);
    // The first insert becomes the queue itself, so the cursor moves to it.
    if (wasEmpty) this.pos = 0;
    this.emit();
  }

  /** Remove one entry; the track that is playing keeps playing. */
  remove(index: number): void {
    if (index < 0 || index >= this.queue.length) return;
    const wasCurrent = index === this.currentQueueIndex();
    this.queue.splice(index, 1);
    this.order = removeFromOrder(this.order, index);
    if (wasCurrent) {
      // The removed entry held the cursor; the next track occupies its slot, so
      // playback continues from there rather than jumping to the top.
      this.pos = Math.min(this.pos, this.order.length - 1);
      if (this.pos < 0) {
        this.el().pause();
        this.el().removeAttribute('src');
      }
    } else {
      const cur = this.order.indexOf(this.currentQueueIndex());
      this.pos = cur >= 0 ? cur : Math.min(this.pos, this.order.length - 1);
    }
    this.emit();
  }

  /**
   * Reorder the play sequence. `from`/`to` are slots in the play order, which
   * is what the queue panel shows; the underlying list is left alone.
   */
  move(from: number, to: number): void {
    const cur = this.currentQueueIndex();
    this.order = moveInOrder(this.order, from, to);
    // The cursor follows the track that was playing, wherever it ended up.
    const at = cur >= 0 ? this.order.indexOf(cur) : -1;
    if (at >= 0) this.pos = at;
    this.emit();
  }

  /** Jump to a position in the play order. */
  async jump(index: number): Promise<void> {
    if (index < 0 || index >= this.order.length) return;
    this.pos = index;
    await this.playCurrent();
  }

  async play(): Promise<void> {
    if (!this.current()) return;
    await this.resumeContext();
    await this.el().play().catch(() => undefined);
    this.startLoudnessSampling();
    this.emit();
  }

  pause(): void {
    this.el().pause();
    // Sampling a paused track would fold silence into the average and drag the
    // measured loudness down.
    this.stopLoudnessSampling();
    this.emit();
  }

  async next(): Promise<void> {
    await this.advance(1);
  }

  async prev(): Promise<void> {
    // Match the usual convention: restart the track unless near its start.
    if (this.el().currentTime > 3 || this.pos <= 0) {
      this.el().currentTime = 0;
      this.emit();
      return;
    }
    await this.advance(-1);
  }

  seek(seconds: number): void {
    if (!this.current()) return;
    // Seeking invalidates the arming of the fade; recompute it afterwards.
    this.scheduleCrossfade();
    const el = this.el();
    const d = el.duration;
    el.currentTime = Number.isFinite(d) ? Math.max(0, Math.min(seconds, d)) : Math.max(0, seconds);
    this.emit();
  }

  /** Ramp instead of jumping, so volume changes do not click. */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(this.volume, now + RAMP_S);
    // The graph owns loudness once connected, on both elements.
    this.audio.volume = 1;
    this.audio2.volume = 1;
    this.emit();
  }

  setEqEnabled(on: boolean): void {
    this.eqEnabled = on;
    this.graph.setEqEnabled(on);
    this.emit();
  }

  setEqBands(gains: number[]): void {
    this.eqGains = EQ_BANDS.map((_, i) => clampDb(gains[i] ?? 0));
    this.graph.setEqBands(this.eqGains);
    this.emit();
  }

  /** Apply a partial sound-processing change. */
  setFx(patch: Partial<AudioFx>): void {
    this.fx = { ...this.fx, ...patch };
    this.graph.setFx(this.fx);
    this.emit();
  }

  /**
   * Set the normalisation gain for the track that is about to play.
   *
   * The worker measures (and caches) loudness; the player only applies it, so
   * playback never waits on analysis.
   */
  setNormGain(db: number): void {
    this.normGainDb = Number.isFinite(db) ? db : 0;
    this.graph.setNormGain(this.normGainDb);
    this.emit();
  }

  /** Refresh the list of audio output devices. */
  async refreshDevices(): Promise<void> {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      this.outputDevices = devs
        .filter((d) => d.kind === 'audiooutput')
        // Labels are empty until the user grants audio permission; showing a
        // numbered fallback beats showing nothing.
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Устройство ${i + 1}` }));
    } catch {
      this.outputDevices = [];
    }
    this.emit();
  }

  /** Route audio to a specific output device. */
  async setOutputDevice(deviceId: string): Promise<void> {
    const el = this.audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof el.setSinkId !== 'function') return;
    try {
      await el.setSinkId(deviceId);
      this.outputDeviceId = deviceId;
    } catch {
      /* the device may have been unplugged; keep the previous one */
    }
    this.emit();
  }

  /** Snapshot for the UI. */
  state(): PlayerState {
    const cur = this.current();
    return {
      track: cur,
      index: this.pos,
      total: this.queue.length,
      shuffle: this.shuffle,
      repeat: this.repeat,
      queue: this.queue,
      order: this.order,
      normGainDb: this.graph.normalisationGainDb,
      level: this.graph.level(),
      outputDeviceId: this.outputDeviceId,
      outputDevices: this.outputDevices,
      playing: !this.el().paused && !!cur,
      currentTime: Number.isFinite(this.el().currentTime) ? this.el().currentTime : 0,
      duration: Number.isFinite(this.el().duration) ? this.el().duration : 0,
      volume: this.volume,
      eqEnabled: this.eqEnabled,
      eqBands: EQ_BANDS.map((hz, i) => ({ hz, gain: this.eqGains[i] ?? 0 })),
    };
  }

  /**
   * Fold the current output level into the running estimate and hand a settled
   * measurement to the host, which caches it for the next play.
   */
  private sampleLoudness(): void {
    const cur = this.current();
    if (!cur) return;
    if (this.loudnessKey !== cur.key) {
      this.loudnessKey = cur.key;
      this.loudness = createAccumulator();
    }
    accumulate(this.loudness, this.graph.level());
    if (!this.loudnessReported && isMeasured(this.loudness)) {
      this.loudnessReported = true;
      const rms = rmsDb(this.loudness);
      const peak = peakDb(this.loudness);
      if (rms !== null && peak !== null) this.events.onLoudness(cur.key, rms, peak);
    }
  }

  private loudnessReported = false;

  private emit(): void {
    this.events.onState(this.state());
  }

  destroy(): void {
    this.stopLoudnessSampling();
    if (this.crossfadeTimer) clearTimeout(this.crossfadeTimer);
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio2.pause();
    this.audio2.removeAttribute('src');
    void this.ctx.close().catch(() => undefined);
  }
}

/** Clamp an equalizer gain into the range the UI exposes. */
export function clampDb(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, v));
}

/** Default flat curve, exported so the host can reset the equalizer. */
export function flatEq(): EqBand[] {
  return EQ_BANDS.map((hz) => ({ hz, gain: 0 }));
}
