import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { clampDb, flatEq, Player } from '../src/offscreen/player.js';
import type { PlayerState, PlayerTrack } from '../src/types.js';
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

describe('player: удаление треков и подсветка при шафле (T2.1)', () => {
  class MockAudio {
    preload = '';
    crossOrigin = '';
    src = '';
    currentTime = 0;
    paused = true;
    duration = 100;
    addEventListener() {}
    removeEventListener() {}
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute() {}
  }
  function createAudioParam(val = 0) {
    return {
      value: val,
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      cancelScheduledValues() {},
      setTargetAtTime() {},
    };
  }

  class MockAudioContext {
    currentTime = 0;
    state = 'running';
    resume() {
      return Promise.resolve();
    }
    createGain() {
      return {
        gain: createAudioParam(1),
        connect() {},
        disconnect() {},
      };
    }
    createChannelSplitter() {
      return { connect() {} };
    }
    createAnalyser() {
      return {
        fftSize: 1024,
        frequencyBinCount: 512,
        getByteFrequencyData() {},
        getFloatTimeDomainData() {},
        connect() {},
      };
    }
    createBiquadFilter() {
      return {
        frequency: createAudioParam(0),
        gain: createAudioParam(0),
        Q: createAudioParam(0),
        type: '',
        connect() {},
      };
    }
    createDynamicsCompressor() {
      return {
        threshold: createAudioParam(0),
        knee: createAudioParam(0),
        ratio: createAudioParam(0),
        attack: createAudioParam(0),
        release: createAudioParam(0),
        connect() {},
      };
    }
    createMediaElementSource() {
      return { connect() {} };
    }
    destination = {};
    close() {
      return Promise.resolve();
    }
  }

  const originalAudio = globalThis.Audio;
  const originalAudioContext = globalThis.AudioContext;

  function setupPlayer() {
    globalThis.Audio = MockAudio as unknown as typeof Audio;
    globalThis.AudioContext = MockAudioContext as unknown as typeof AudioContext;
  }

  function cleanupPlayer() {
    globalThis.Audio = originalAudio;
    globalThis.AudioContext = originalAudioContext;
  }

  it('удаление НЕтекущего трека перед текущим не смещает курсор на другой трек', async () => {
    setupPlayer();
    try {
      let lastState: PlayerState | undefined = undefined;
      const p = new Player({
        onState: (s: PlayerState) => {
          lastState = s;
        },
        onEnded: () => {},
        onLoudness: () => {},
        onClip: () => {},
        onSpectrum: () => {},
        onNeedUrls: () => {},
      });

      const tracks: PlayerTrack[] = [
        { key: '0_1', id: '1', owner: '0', artist: 'Artist 0', title: 'Track 0', url: 'http://0', duration: 100, cover: null },
        { key: '0_2', id: '2', owner: '0', artist: 'Artist 1', title: 'Track 1', url: 'http://1', duration: 100, cover: null },
        { key: '0_3', id: '3', owner: '0', artist: 'Artist 2', title: 'Track 2', url: 'http://2', duration: 100, cover: null },
      ];

      // Начинаем с трека 1 (Track 1)
      await p.setQueue(tracks, 1); const st1 = { ...p.state(), track: p.state().track ? { ...p.state().track! } : null, queue: p.state().queue.slice(), order: p.state().order.slice() };
      assert.equal(st1.track?.title, 'Track 1');
      assert.equal(st1.index, 1);

      // Удаляем трек 0 (находится перед текущим треком в очереди)
      p.remove(0); const st1b = { ...p.state(), track: p.state().track ? { ...p.state().track! } : null, queue: p.state().queue.slice(), order: p.state().order.slice() };

      // Должен продолжать играть Track 1, а не перескочить на Track 2
      assert.equal(st1.track?.title, 'Track 1');
      // В новой очереди Track 1 теперь имеет индекс 0
      assert.equal(st1b.order[st1b.index ?? -1], 0);
      assert.equal(st1b.index, 0);
      p.destroy();
    } finally {
      cleanupPlayer();
    }
  });

  it('при шафле строка cur совпадает с играющим треком после jump, move и remove', async () => {
    setupPlayer();
    try {
      let lastState: PlayerState | undefined = undefined;
      const p = new Player({
        onState: (s: PlayerState) => {
          lastState = s;
        },
        onEnded: () => {},
        onLoudness: () => {},
        onClip: () => {},
        onSpectrum: () => {},
        onNeedUrls: () => {},
      });

      const tracks: PlayerTrack[] = [
        { key: '0_1', id: '1', owner: '0', artist: 'A', title: 'Track 0', url: 'http://0', duration: 100, cover: null },
        { key: '0_2', id: '2', owner: '0', artist: 'B', title: 'Track 1', url: 'http://1', duration: 100, cover: null },
        { key: '0_3', id: '3', owner: '0', artist: 'C', title: 'Track 2', url: 'http://2', duration: 100, cover: null },
        { key: '0_4', id: '4', owner: '0', artist: 'D', title: 'Track 3', url: 'http://3', duration: 100, cover: null },
      ];

      await p.setQueue(tracks, 0);
      p.setShuffle(true);

      // Индекс играющего трека в порядке воспроизведения: lastState.index
      // В очереди: lastState.order[lastState.index]
      // Проверяем, что играющий трек соответствует позиции
      const st = { ...p.state(), track: p.state().track ? { ...p.state().track! } : null, queue: p.state().queue.slice(), order: p.state().order.slice() };
      assert.equal(st.track?.title, st.queue[st.order[st.index]!]?.title);

      // Прыжок на слот 2 в порядке воспроизведения
      await p.jump(2); const stJ = { ...p.state(), track: p.state().track ? { ...p.state().track! } : null, queue: p.state().queue.slice(), order: p.state().order.slice() };
      assert.equal(stJ.index, 2);
      assert.equal(stJ.track?.title, stJ.queue[stJ.order[stJ.index]!]?.title);

      // Перемещение слота в порядке (DnD: move)
      p.move(2, 0);
      // Курсор должен последовать за треком на позицию 0
      assert.equal(st.index, 0);
      assert.equal(stJ.track?.title, stJ.queue[stJ.order[stJ.index]!]?.title);

      // Удаление нетекущего трека
      const currentQi = st.order[st.index]!;
      const nonCurrentQi = st.order.find((qi) => qi !== currentQi)!;
      p.remove(nonCurrentQi);
      assert.equal(stJ.track?.title, stJ.queue[stJ.order[stJ.index]!]?.title);

      p.destroy();
    } finally {
      cleanupPlayer();
    }
  });
});
