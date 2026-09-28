import type { AudioFx, EqBand, PlayerState, PlayerTrack, RepeatMode } from '../types.js';
import { DEFAULT_AUDIO_FX, EQ_BANDS } from '../types.js';
import { AudioGraph, gainToDb } from './audio-graph.js';
import {
  addBlock,
  addToBlock,
  BLOCK_SECONDS,
  closeBlock,
  createBlock,
  createMeter,
  dynamicRangeDb,
  GATE_ABSOLUTE_LUFS,
  integratedLufs,
  type BlockAccumulator,
  type LoudnessMeter,
} from '../lib/loudness.js';
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
/**
 * How much of a track to hear before trusting its loudness.
 *
 * BS.1770 gates out silence and quiet passages, so a measurement needs enough
 * material for the relative gate to be meaningful. Eight seconds is past any
 * intro and well inside the track.
 */
const MEASURE_SECONDS = 8;

/**
 * Frequency bands in the spectrum display.
 *
 * 64 resolves the bass region usefully, which is where a spectrogram earns its
 * keep: a lossy encoder's cutoff and a clipped master both show up there first.
 * The frames are cheap to send — 64 bytes per channel, twenty times a second.
 */
const SPECTRUM_BANDS = 64;

/**
 * How many upcoming tracks to keep resolved.
 *
 * Three is enough that a skip, a crossfade and one more all have a live link,
 * and few enough that seeking through a playlist does not fire a burst of
 * requests for tracks the listener will never reach.
 */
const PRELOAD_AHEAD = 3;

/**
 * How often to refresh those links while a track plays.
 *
 * VK links live one to two hours. A ten-minute track playing for its full length
 * ages the link resolved for the track after next by twenty minutes, so
 * refreshing every few minutes keeps the window valid without polling hard.
 */
const URL_REFRESH_MS = 5 * 60 * 1000;

/**
 * How early the gapless switch is made, in seconds.
 *
 * The incoming stream needs a moment to buffer, and starting it too early would
 * overlap audible material. This is a buffer allowance, not a musical fade:
 * nothing is ramped, so a slightly late switch is silent while an early one is
 * heard.
 */
const GAPLESS_LEAD = 0.25;

export interface PlayerEvents {
  onState(state: PlayerState): void;
  /** Called when a track ends so the host can scrobble and advance. */
  onEnded(track: PlayerTrack): void;
  /**
   * A settled loudness estimate for a track. Reported once per play, because
   * the worker caches it and only needs it the first time.
   */
  onLoudness(key: string, lufs: number, peakDb: number, drDb: number | null): void;
  /** A block reached full scale, i.e. the master itself is clipping. */
  onClip(key: string): void;
  /** One spectrum frame per channel; only sent while it is being displayed. */
  onSpectrum(left: number[], right: number[]): void;
  /** The player wants fresh URLs for these keys; it is about to reach them. */
  onNeedUrls(keys: string[]): void;
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
  /** Loudness of the current track, once it has been measured. */
  private trackLufs: number | null = null;
  private trackPeakDb: number | null = null;
  /** Album loudness, when the worker has figured one out. */
  private albumLufs: number | null = null;
  private outputDevices: { id: string; label: string }[] = [];
  /** Seconds left of the crossfade into the current track, for the meter. */
  private crossfadeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * BS.1770 loudness meter for the track that is playing, so the correction is
   * learned from what is actually audible rather than by decoding the file.
   */
  private meter: LoudnessMeter = createMeter();
  private loudnessKey = '';
  /** Time already folded into the meter, used to close 400 ms blocks. */
  private meterClock = 0;
  private lastSampleAt = 0;
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
    // The listening volume lives in the graph, after the measurement tap: the
    // meters describe the recording, not how loudly it is being played.
    this.graph.setVolume(this.volume, 0.01);

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
      el.addEventListener('play', () => {
        if (slot === this.activeSlot) this.syncMediaSessionState(true);
        this.emit();
      });
      el.addEventListener('pause', () => {
        if (slot === this.activeSlot) this.syncMediaSessionState(false);
        this.emit();
      });
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
    // A gapless album normally never reaches here: the next track is started
    // early by the same timer that would otherwise arm a crossfade. This path is
    // the fallback for when that did not happen (a single-track album, or a
    // stream that reported no duration).
    void this.advance(1);
  }

  /**
   * Arm gapless playback for the current track.
   *
   * The next track is started slightly before this one ends and the two are
   * joined without a fade or a silence, because an album mastered as one
   * continuous piece has no boundary to cover. The switch happens on a short
   * timer rather than at `ended`, because `ended` fires after the element has
   * already stopped — by then the gap has happened.
   */
  private scheduleGapless(): void {
    if (this.gaplessTimer !== null) clearTimeout(this.gaplessTimer);
    this.gaplessTimer = null;
    if (!this.fx.gapless || !this.sameAlbumNext()) return;
    const el = this.el();
    const dur = el.duration;
    if (!Number.isFinite(dur) || dur <= GAPLESS_LEAD + 0.2) return;
    const delayMs = Math.max(0, (dur - el.currentTime - GAPLESS_LEAD) * 1000);
    this.gaplessTimer = setTimeout(() => {
      this.gaplessTimer = null;
      void this.playGaplessNext();
    }, delayMs);
  }

  private gaplessTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start the next track and let the current one finish underneath it.
   *
   * A hard switch at the boundary is what makes it seamless: the second element
   * begins on the same audio clock, at full level, while the first plays out the
   * last few milliseconds. Nothing is ramped, so nothing is heard as a seam.
   */
  private async playGaplessNext(): Promise<void> {
    const nextIdx = advancePos(this.pos, this.order.length, 1, this.repeat === 'all');
    if (nextIdx === null) return;
    const next = this.queue[this.order[nextIdx] ?? -1];
    if (!next) return;

    const outgoing = this.activeSlot;
    const incoming: 0 | 1 = outgoing === 0 ? 1 : 0;
    const inEl = incoming === 0 ? this.audio : this.audio2;
    inEl.src = next.url;
    inEl.currentTime = 0;
    // Both stages at full level: a gapless join has no fade in it.
    this.graph.setFade(outgoing, 1);
    this.graph.setFade(incoming, 1);
    try {
      await inEl.play();
    } catch {
      await this.advance(1);
      return;
    }
    this.activeSlot = incoming;
    this.pos = nextIdx;
    this.events.onEnded(next);
    this.emit();

    // The outgoing element is stopped only once it has actually ended, so its
    // last samples are heard rather than cut.
    const outEl = outgoing === 0 ? this.audio : this.audio2;
    const stop = (): void => {
      outEl.removeEventListener('ended', stop);
      outEl.pause();
      outEl.removeAttribute('src');
      this.graph.setFade(outgoing, 0);
    };
    outEl.addEventListener('ended', stop);
    // Safety net: a stream whose duration was wrong would otherwise leave the
    // old element playing underneath forever.
    setTimeout(stop, (GAPLESS_LEAD + 2) * 1000);
    this.scheduleGapless();
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
    if (this.gaplessTimer !== null) {
      clearTimeout(this.gaplessTimer);
      this.gaplessTimer = null;
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
    this.meter = createMeter();
    this.loudnessKey = t.key;
    this.loudnessReported = false;
    this.clipReported = false;
    this.meterClock = 0;
    this.lastSampleAt = this.ctx.currentTime;
    const el = this.el();
    el.src = t.url;
    el.currentTime = 0;
    try {
      await el.play();
    } catch {
      /* autoplay policy; the caller can retry with a gesture */
    }
    // Both timers are armed; each declines to act when its own mode is off, so
    // the two can never fight over the boundary.
    this.scheduleGapless();
    this.scheduleCrossfade();
    this.startLoudnessSampling();
    // Ask for the next few links straight away: resolving them is a network
    // round-trip each, and waiting until the moment of the transition would mean
    // a gap or a failure.
    this.requestUpcomingUrls();
    // Published here rather than on a metadata event: the OS should show the
    // track as soon as it starts, not once the browser has parsed its header.
    this.publishMediaSession(t);
    this.emit();
  }

  /**
   * Publish the current track to the OS.
   *
   * Without this the system has no idea what is playing: the media keys work
   * because the manifest binds them, but the lock screen, the "now playing"
   * panel and headset buttons are all driven by MediaSession instead.
   */
  private publishMediaSession(track: PlayerTrack): void {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      ms.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: '',
        artwork: track.cover ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
      // Handlers are set once; re-setting them on every track would leak.
      if (this.mediaHandlersSet) return;
      this.mediaHandlersSet = true;
      ms.setActionHandler('play', () => void this.play());
      ms.setActionHandler('pause', () => this.pause());
      ms.setActionHandler('nexttrack', () => void this.next());
      ms.setActionHandler('previoustrack', () => void this.prev());
      ms.setActionHandler('seekto', (d) => {
        if (typeof d.seekTime === 'number') this.seek(d.seekTime);
      });
      ms.setActionHandler('seekforward', () => this.seek(this.el().currentTime + 10));
      ms.setActionHandler('seekbackward', () => this.seek(Math.max(0, this.el().currentTime - 10)));
    } catch {
      /* some handlers are unsupported depending on the platform */
    }
  }

  private mediaHandlersSet = false;

  /** Reflect the transport state so the OS shows the right button. */
  private syncMediaSessionState(playing: boolean): void {
    const ms = navigator.mediaSession;
    if (ms) ms.playbackState = playing ? 'playing' : 'paused';
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
    this.loudnessTimer = setInterval(() => {
      this.sampleLoudness();
      this.pushSpectrum();
    }, 50);
  }

  /**
   * Send a spectrum frame to whoever is listening.
   *
   * The offscreen document owns the analyser and the popup only paints, but a
   * broadcast is not free: pushing 20 frames a second to a popup that is not
   * showing the panel would wake it for nothing. Frames are only sent while a
   * consumer has asked for them.
   */
  private pushSpectrum(): void {
    if (!this.spectrumWanted) return;
    const frame = this.graph.spectrum(SPECTRUM_BANDS);
    this.events.onSpectrum(frame.left, frame.right);
  }

  /** Enable or disable the spectrum push. */
  setSpectrumWanted(on: boolean): void {
    this.spectrumWanted = on;
  }

  private spectrumWanted = false;

  private stopUrlRefresh(): void {
    if (this.urlTimer !== null) {
      clearInterval(this.urlTimer);
      this.urlTimer = null;
    }
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
   * Ask the worker to refresh the links of the next few tracks.
   *
   * Repeated every few minutes while a track plays, because a link resolved at
   * the start of a ten-minute track is two hours old by the time a long queue
   * reaches the end — which is exactly when it stops working.
   */
  private requestUpcomingUrls(): void {
    if (this.urlTimer !== null) clearInterval(this.urlTimer);
    const ask = (): void => {
      const keys = this.upcomingKeys(PRELOAD_AHEAD);
      if (keys.length) this.events.onNeedUrls(keys);
    };
    ask();
    this.urlTimer = setInterval(ask, URL_REFRESH_MS);
  }

  private urlTimer: ReturnType<typeof setInterval> | null = null;

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
    // Gapless wins over crossfade: both act on the boundary between tracks, and
    // running a fade into a track that is supposed to be joined would defeat it.
    if (this.fx.gapless && this.sameAlbumNext()) return;
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
    const cur = this.currentQueueIndex();
    const wasCurrent = index === cur;
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
      const target = cur > index ? cur - 1 : cur;
      const at = this.order.indexOf(target);
      this.pos = at >= 0 ? at : Math.min(this.pos, this.order.length - 1);
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
    // The volume lives inside the graph, after the measurement tap, so the meter
    // and the loudness estimate describe the recording rather than the listening
    // level. The elements keep full scale; the graph owns loudness.
    this.graph.setVolume(this.volume, RAMP_S);
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

  /** Loudness figures for the current track, sent by the worker once measured. */
  setTrackLoudness(lufs: number | null, peakDb: number | null, albumLufs: number | null = null): void {
    this.trackLufs = lufs;
    this.trackPeakDb = peakDb;
    this.albumLufs = albumLufs;
    this.emit();
  }

  /**
   * Replace a queued track's stream URL.
   *
   * The queue is built with URLs resolved at that moment, and VK's links expire
   * in an hour or two — so a queue assembled for an evening holds dead links by
   * the end of it. Refreshing them as playback approaches is what keeps a long
   * queue playable without rebuilding it and losing the listener's place.
   */
  setTrackUrl(key: string, url: string): void {
    let changed = false;
    for (const t of this.queue) {
      if (t.key === key && t.url !== url) {
        t.url = url;
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /**
   * Whether the next track belongs to the same album as the current one.
   *
   * Album identity comes from the catalog entry, since the player only holds
   * track metadata for display. A missing album on either side counts as "not
   * the same", which keeps the seam between unrelated tracks.
   */
  private sameAlbumNext(): boolean {
    const nextIdx = advancePos(this.pos, this.order.length, 1, this.repeat === 'all');
    if (nextIdx === null) return false;
    const cur = this.current();
    const next = this.queue[this.order[nextIdx] ?? -1];
    if (!cur || !next) return false;
    const a = (this.albumOf(cur.key) ?? '').trim().toLowerCase();
    const b = (this.albumOf(next.key) ?? '').trim().toLowerCase();
    return !!a && a === b;
  }

  /** Album title for a key, as supplied by the worker with the queue. */
  private albumOf(key: string): string | null {
    const known = this.albums.get(key);
    if (known !== undefined) return known;
    const t = this.queue.find((q) => q.key === key);
    return t?.album ?? null;
  }

  /** Album titles by track key, pushed by the worker. */
  setAlbums(map: Record<string, string>): void {
    this.albums = new Map(Object.entries(map));
    this.scheduleCrossfade();
  }

  private albums = new Map<string, string>();

  /** Keys of the tracks coming up, in play order, that have no fresh URL yet. */
  upcomingKeys(count: number): string[] {
    const out: string[] = [];
    for (let i = 1; i <= count; i++) {
      const slot = this.pos + i;
      if (slot >= this.order.length) break;
      const t = this.queue[this.order[slot] ?? -1];
      if (t) out.push(t.key);
    }
    return out;
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
      trackLufs: this.trackLufs,
      trackPeakDb: this.trackPeakDb,
      albumLufs: this.albumLufs,
      level: this.graph.level(),
      levels: this.graph.peakLevels(),
      clipped: this.graph.isClipping(),
      limiterDb: this.graph.limiterReductionDb(),
      correlation: this.graph.stereoCorrelation(),
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
      this.meter = createMeter();
      this.meterClock = 0;
    }

    // Every analyser read is folded into the current 400 ms block, so the block
    // is the mean square over a contiguous window rather than one snapshot.
    const now = this.ctx.currentTime;
    const dt = this.lastSampleAt ? Math.min(0.25, Math.max(0, now - this.lastSampleAt)) : 0;
    this.lastSampleAt = now;
    this.meterClock += dt;

    const [zl, zr] = this.graph.kWeightedMeanSquares();
    const peaks = this.graph.truePeakLevels();
    const peakDb = gainToDb(Math.max(peaks[0], peaks[1]));
    // BS.1770 channel weights are 1.0 for left and right.
    this.block = this.block ?? createBlock();
    addToBlock(this.block, zl + zr, peakDb);

    if (this.meterClock < BLOCK_SECONDS) return;
    this.meterClock = 0;
    const closed = closeBlock(this.block);
    this.block = createBlock();
    addBlock(this.meter, closed.lufs, closed.peakDb, BLOCK_SECONDS);

    // Report clipping once per track: a brick-walled master is at full scale for
    // much of its length, and reporting every occurrence would flood the worker.
    if (!this.clipReported && Math.max(peaks[0], peaks[1]) >= 1) {
      this.clipReported = true;
      this.events.onClip(cur.key);
    }

    // Report once enough of the track has been heard for the gates to mean
    // something. Eight seconds is past any intro and well inside the track.
    if (!this.loudnessReported && this.meter.seconds >= MEASURE_SECONDS) {
      const integrated = integratedLufs(this.meter);
      if (integrated !== null && integrated > GATE_ABSOLUTE_LUFS) {
        this.loudnessReported = true;
        this.events.onLoudness(
          cur.key,
          integrated,
          this.meter.truePeakDb,
          dynamicRangeDb(this.meter.truePeakDb, integrated),
        );
      }
    }
  }

  /** Block currently being filled. */
  private block: BlockAccumulator | null = null;

  private loudnessReported = false;
  /** Clipping is reported at most once per track, for the same reason. */
  private clipReported = false;

  private emit(): void {
    this.events.onState(this.state());
  }

  destroy(): void {
    this.stopLoudnessSampling();
    this.stopUrlRefresh();
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
