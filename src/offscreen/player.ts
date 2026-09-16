import type { EqBand, PlayerState, PlayerTrack, RepeatMode } from '../types.js';
import { EQ_BANDS } from '../types.js';
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
}

export class Player {
  private readonly audio: HTMLAudioElement;
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private readonly bands: BiquadFilterNode[] = [];
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
  private readonly events: PlayerEvents;

  constructor(events: PlayerEvents) {
    this.events = events;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    // Keep playing when the element is not "visible" (it never is, offscreen).
    this.audio.crossOrigin = 'anonymous';

    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volume;

    // Chain: source -> band filters -> gain -> output.
    let node: AudioNode = this.gain;
    for (const hz of EQ_BANDS) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = hz;
      f.Q.value = 1;
      f.gain.value = 0;
      this.bands.push(f);
      node.connect(f);
      node = f;
    }
    node.connect(this.ctx.destination);

    try {
      const src = this.ctx.createMediaElementSource(this.audio);
      src.connect(this.gain);
    } catch {
      // Fall back to the element's own output if the graph cannot be built;
      // playback still works, only the equalizer is unavailable.
    }

    this.audio.addEventListener('ended', () => this.handleEnded());
    this.audio.addEventListener('error', () => this.emit());
    this.audio.addEventListener('timeupdate', () => this.emit());
    this.audio.addEventListener('loadedmetadata', () => this.emit());
    this.audio.addEventListener('play', () => this.emit());
    this.audio.addEventListener('pause', () => this.emit());
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
      this.audio.currentTime = 0;
      void this.audio.play().catch(() => undefined);
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

  private async playCurrent(): Promise<void> {
    const t = this.current();
    if (!t) return;
    await this.resumeContext();
    this.audio.src = t.url;
    this.audio.currentTime = 0;
    try {
      await this.audio.play();
    } catch {
      /* autoplay policy; the caller can retry after a gesture */
    }
    this.emit();
  }

  /** Replace the queue and start at `startIndex` of the list. */
  async setQueue(tracks: PlayerTrack[], startIndex = 0): Promise<void> {
    this.queue = tracks.slice();
    this.rebuildOrder(false);
    if (!this.queue.length) {
      this.audio.pause();
      this.audio.removeAttribute('src');
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
        this.audio.pause();
        this.audio.removeAttribute('src');
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
    await this.audio.play().catch(() => undefined);
    this.emit();
  }

  pause(): void {
    this.audio.pause();
    this.emit();
  }

  async next(): Promise<void> {
    await this.advance(1);
  }

  async prev(): Promise<void> {
    // Match the usual convention: restart the track unless near its start.
    if (this.audio.currentTime > 3 || this.pos <= 0) {
      this.audio.currentTime = 0;
      this.emit();
      return;
    }
    await this.advance(-1);
  }

  seek(seconds: number): void {
    if (!this.current()) return;
    const d = this.audio.duration;
    this.audio.currentTime = Number.isFinite(d) ? Math.max(0, Math.min(seconds, d)) : Math.max(0, seconds);
    this.emit();
  }

  /** Ramp instead of jumping, so volume changes do not click. */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(this.volume, now + RAMP_S);
    this.audio.volume = 1; // the graph owns loudness once connected
    this.emit();
  }

  setEqEnabled(on: boolean): void {
    this.eqEnabled = on;
    this.applyEq();
    this.emit();
  }

  setEqBands(gains: number[]): void {
    this.eqGains = EQ_BANDS.map((_, i) => clampDb(gains[i] ?? 0));
    this.applyEq();
    this.emit();
  }

  private applyEq(): void {
    this.bands.forEach((f, i) => {
      f.gain.value = this.eqEnabled ? (this.eqGains[i] ?? 0) : 0;
    });
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
      playing: !this.audio.paused && !!cur,
      currentTime: Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0,
      duration: Number.isFinite(this.audio.duration) ? this.audio.duration : 0,
      volume: this.volume,
      eqEnabled: this.eqEnabled,
      eqBands: EQ_BANDS.map((hz, i) => ({ hz, gain: this.eqGains[i] ?? 0 })),
    };
  }

  private emit(): void {
    this.events.onState(this.state());
  }

  destroy(): void {
    this.audio.pause();
    this.audio.removeAttribute('src');
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
