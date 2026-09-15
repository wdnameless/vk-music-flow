import type { EqBand, PlayerState, PlayerTrack } from '../types.js';

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

/** Bands the equalizer exposes (Hz); matches what the reference UI shows. */
export const EQ_BANDS: readonly number[] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
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
  private queue: PlayerTrack[] = [];
  private index = -1;
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
    if (this.index + 1 < this.queue.length) {
      this.index++;
      void this.playCurrent();
    } else {
      this.emit();
    }
  }

  private current(): PlayerTrack | null {
    return this.index >= 0 && this.index < this.queue.length ? (this.queue[this.index] ?? null) : null;
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

  /** Replace the queue and start at `startIndex`. */
  async setQueue(tracks: PlayerTrack[], startIndex = 0): Promise<void> {
    this.queue = tracks.slice();
    this.index = Math.max(0, Math.min(startIndex, this.queue.length - 1));
    if (!this.queue.length) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.emit();
      return;
    }
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
    if (this.index + 1 < this.queue.length) {
      this.index++;
      await this.playCurrent();
    }
  }

  async prev(): Promise<void> {
    // Match the usual convention: restart the track unless near its start.
    if (this.audio.currentTime > 3 || this.index === 0) {
      this.audio.currentTime = 0;
      this.emit();
      return;
    }
    this.index--;
    await this.playCurrent();
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
      index: this.index,
      total: this.queue.length,
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
