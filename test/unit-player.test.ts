import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { clampDb, flatEq } from '../src/offscreen/player.js';
import { EQ_BANDS } from '../src/types.js';

// Wave 2 unit tests for the parts of the offscreen player that are pure logic.
// The audio element and WebAudio graph need a real document, so they are covered
// by the live-browser verification instead.

describe('player: эквалайзер', () => {
  it('полосы покрывают заявленный диапазон 31 Гц … 16 кГц', () => {
    assert.equal(EQ_BANDS[0], 31);
    assert.equal(EQ_BANDS[EQ_BANDS.length - 1], 16000);
    assert.equal(EQ_BANDS.length, 10);
  });

  it('полосы строго возрастают — иначе фильтры встанут вразнобой', () => {
    for (let i = 1; i < EQ_BANDS.length; i++) {
      assert.ok(EQ_BANDS[i]! > EQ_BANDS[i - 1]!, `полоса ${i} не больше предыдущей`);
    }
  });

  it('усиление зажимается в ±12 дБ', () => {
    assert.equal(clampDb(0), 0);
    assert.equal(clampDb(12), 12);
    assert.equal(clampDb(-12), -12);
    assert.equal(clampDb(999), 12);
    assert.equal(clampDb(-999), -12);
  });

  it('NaN и бесконечность превращаются в 0, а не в битый фильтр', () => {
    // Infinity is not finite, so it takes the safe default rather than clamping
    // to ±12: a corrupt reading must not become maximum amplification.
    assert.equal(clampDb(Number.NaN), 0);
    assert.equal(clampDb(Number.POSITIVE_INFINITY), 0);
    assert.equal(clampDb(Number.NEGATIVE_INFINITY), 0);
    assert.equal(clampDb(12.0001), 12);
  });

  it('плоская кривая содержит по полосе на каждую частоту и нули', () => {
    const flat = flatEq();
    assert.equal(flat.length, EQ_BANDS.length);
    assert.ok(flat.every((b, i) => b.hz === EQ_BANDS[i] && b.gain === 0));
  });
});

describe('T4.5 R32: parseIv и валидация 16 байт', () => {
  it('parseIv возвращает 16 байт для корректного 32-hex IV', async () => {
    const { parseIv } = await import('../src/lib/m3u8.js');
    const iv = parseIv('0x000102030405060708090a0b0c0d0e0f');
    assert.ok(iv);
    assert.equal(iv.length, 16);
    assert.equal(iv[0], 0x00);
    assert.equal(iv[15], 0x0f);
  });

  it('parseIv возвращает null при длине != 16 байт (32 hex)', async () => {
    const { parseIv, parseM3U8 } = await import('../src/lib/m3u8.js');
    assert.equal(parseIv('0x1234'), null);
    assert.equal(parseIv('12345678'), null);
    assert.throws(
      () =>
        parseM3U8(
          '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x1234\n#EXTINF:5,\ns.ts\n',
          'https://cdn.example/a/',
        ),
      /Некорректный IV для AES-128: ожидается 16 байт/,
    );
  });
});

describe('T4.5 R33: apicPayload распознаёт WebP', () => {
  it('WebP с RIFF....WEBP получает mime image/webp', async () => {
    const { apicPayload } = await import('../src/lib/id3.js');
    // RIFF (4 bytes) + len (4 bytes) + WEBP (4 bytes) + payload
    const webpBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x20, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
      ...new Array(100).fill(0),
    ]);
    const payload = apicPayload(webpBytes);
    const str = new TextDecoder('latin1').decode(payload);
    assert.ok(str.includes('image/webp'), 'должен содержать image/webp');
  });

  it('PNG и JPEG сохраняют свои MIME', async () => {
    const { apicPayload } = await import('../src/lib/id3.js');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(50).fill(0)]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(50).fill(0)]);
    const pngPayload = new TextDecoder('latin1').decode(apicPayload(png));
    const jpegPayload = new TextDecoder('latin1').decode(apicPayload(jpeg));
    assert.ok(pngPayload.includes('image/png'));
    assert.ok(jpegPayload.includes('image/jpeg'));
  });
});

describe('T4.5 R28, R29, R30, R31: player логика', () => {
  class MockAudio {
    src = '';
    currentTime = 0;
    duration = 100;
    paused = true;
    preload = 'auto';
    crossOrigin = 'anonymous';
    sinkId = '';
    listeners: Record<string, (() => void)[]> = {};
    addEventListener(event: string, fn: () => void) {
      (this.listeners[event] ??= []).push(fn);
    }
    removeEventListener(event: string, fn: () => void) {
      this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== fn);
    }
    async play() {
      this.paused = false;
      for (const f of this.listeners['play'] ?? []) f();
    }
    pause() {
      this.paused = true;
      for (const f of this.listeners['pause'] ?? []) f();
    }
    removeAttribute(attr: string) {
      if (attr === 'src') this.src = '';
    }
    async setSinkId(id: string) {
      this.sinkId = id;
    }
  }

  const param = (v: number) => ({ value: v, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, cancelScheduledValues: () => undefined, setTargetAtTime: () => undefined });
  class MockAudioContext {
    state = 'running';
    currentTime = 0;
    sinkId = '';
    createMediaElementSource() {
      return { connect: () => undefined };
    }
    createGain() {
      const gp = (v: number) => ({ value: v, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, cancelScheduledValues: () => undefined, setTargetAtTime: () => undefined });
      return {
        gain: gp(1),
        connect: () => undefined,
        disconnect: () => undefined,
      };
    }
    createBiquadFilter() {
      return {
        frequency: param(1000),
        gain: param(0),
        Q: param(0.5),
        type: 'peaking',
        connect: () => undefined,
        disconnect: () => undefined,
      };
    }
    createDynamicsCompressor() {
      const cp = (v: number) => ({ value: v, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, cancelScheduledValues: () => undefined, setTargetAtTime: () => undefined });
      return {
        threshold: cp(0),
        knee: cp(0),
        ratio: cp(1),
        attack: cp(0),
        release: cp(0),
        reduction: 0,
        connect: () => undefined,
        disconnect: () => undefined,
      };
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        frequencyBinCount: 1024,
        getFloatTimeDomainData: () => undefined,
        getByteFrequencyData: () => undefined,
        connect: () => undefined,
      };
    }
    createChannelSplitter() {
      return { connect: () => undefined };
    }
    createChannelMerger() {
      return { connect: () => undefined };
    }
    get destination() {
      return {};
    }
    async resume() {
      this.state = 'running';
    }
    async close() {
      this.state = 'closed';
    }
    async setSinkId(id: string) {
      this.sinkId = id;
    }
  }

  it('R28: setOutputDevice адресует AudioContext, фолбэк — audio элементы', async () => {
    const g = globalThis as Record<string, unknown>;
    const origAudio = g.Audio;
    const origCtx = g.AudioContext;
    g.Audio = MockAudio;
    g.AudioContext = MockAudioContext;
    try {
      const { Player } = await import('../src/offscreen/player.js');
      const p = new Player({
        onState: () => {},
        onEnded: () => {},
        onLoudness: () => {},
        onClip: () => {},
        onNeedUrls: () => {}, onSpectrum: () => {},
      });
      await p.setOutputDevice('audio-ctx-dev');
      assert.equal(p.state().outputDeviceId, 'audio-ctx-dev');
      assert.equal((p as unknown as { ctx: { sinkId: string } }).ctx.sinkId, 'audio-ctx-dev');

      // Fallback: ctx without setSinkId (own prop shadows the class method)
      (p as unknown as { ctx: { setSinkId?: unknown } }).ctx.setSinkId = undefined;
      await p.setOutputDevice('fallback-dev');
      assert.equal(p.state().outputDeviceId, 'fallback-dev');
      assert.equal((p as unknown as { audio: { sinkId: string } }).audio.sinkId, 'fallback-dev');
      assert.equal((p as unknown as { audio2: { sinkId: string } }).audio2.sinkId, 'fallback-dev');
      p.destroy();
    } finally {
      g.Audio = origAudio;
      g.AudioContext = origCtx;
    }
  });

  it('R29: destroy() очищает gaplessTimer и crossfadeTimer', async () => {
    const g = globalThis as Record<string, unknown>;
    const origAudio = g.Audio;
    const origCtx = g.AudioContext;
    g.Audio = MockAudio;
    g.AudioContext = MockAudioContext;
    try {
      const { Player } = await import('../src/offscreen/player.js');
      const p = new Player({
        onState: () => {},
        onEnded: () => {},
        onLoudness: () => {},
        onClip: () => {},
        onNeedUrls: () => {}, onSpectrum: () => {},
      });
      // Arm timers
      (p as unknown as { gaplessTimer: ReturnType<typeof setTimeout> | null }).gaplessTimer = setTimeout(() => {}, 10000);
      (p as unknown as { crossfadeTimer: ReturnType<typeof setTimeout> | null }).crossfadeTimer = setTimeout(() => {}, 10000);
      p.destroy();
      assert.equal((p as unknown as { gaplessTimer: unknown }).gaplessTimer, null);
      assert.equal((p as unknown as { crossfadeTimer: unknown }).crossfadeTimer, null);
    } finally {
      g.Audio = origAudio;
      g.AudioContext = origCtx;
    }
  });

  it('R30: sampleLoudness не трогает замер при несоответствии ключа трека', async () => {
    const g = globalThis as Record<string, unknown>;
    const origAudio = g.Audio;
    const origCtx = g.AudioContext;
    g.Audio = MockAudio;
    g.AudioContext = MockAudioContext;
    try {
      const { Player } = await import('../src/offscreen/player.js');
      const p = new Player({
        onState: () => {},
        onEnded: () => {},
        onLoudness: () => {},
        onClip: () => {},
        onNeedUrls: () => {}, onSpectrum: () => {},
      });
      (p as unknown as { loudnessKey: string }).loudnessKey = 'key_A';
      // Call sampleLoudness when current is null or key differs
      (p as unknown as { sampleLoudness: () => void }).sampleLoudness();
      // loudnessKey remained key_A (no desync or overwriting)
      assert.equal((p as unknown as { loudnessKey: string }).loudnessKey, 'key_A');
      p.destroy();
    } finally {
      g.Audio = origAudio;
      g.AudioContext = origCtx;
    }
  });

  it('R31: MediaSession публикуется и синхронизирует состояние воспроизведения', async () => {
    const g = globalThis as Record<string, unknown>;
    const origAudio = g.Audio;
    const origCtx = g.AudioContext;
    g.Audio = MockAudio;
    g.AudioContext = MockAudioContext;
    const mediaSession = { metadata: null as unknown, playbackState: 'none', setActionHandler: () => {} };
    (globalThis as Record<string, unknown>).MediaMetadata = class { constructor(public init: unknown) {} };
    (navigator as unknown as { mediaSession: unknown }).mediaSession = mediaSession;
    try {
      const { Player } = await import('../src/offscreen/player.js');
      const p = new Player({
        onState: () => {},
        onEnded: () => {},
        onLoudness: () => {},
        onClip: () => {},
        onNeedUrls: () => {}, onSpectrum: () => {},
      });
      await p.setQueue([
        { key: '1', id: '1', owner: '1', artist: 'Artist 1', title: 'Title 1', url: 'https://cdn/1.mp3', duration: 120, cover: null },
      ], 0);
      assert.ok(mediaSession.metadata);
      assert.equal(mediaSession.playbackState, 'playing');
      p.pause();
      assert.equal(mediaSession.playbackState, 'paused');
      p.destroy();
    } finally {
      g.Audio = origAudio;
      g.AudioContext = origCtx;
      delete (navigator as unknown as { mediaSession?: unknown }).mediaSession;
    }
  });
});
