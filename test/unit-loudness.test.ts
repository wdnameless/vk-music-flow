import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { dbToGain, gainToDb, nightSettings, normalisationGain } from '../src/offscreen/audio-graph.js';
import { accumulate, createAccumulator, isMeasured, MIN_SAMPLES, peakDb, rmsDb } from '../src/lib/loudness.js';

// Normalisation is the difference between a playlist that can be left alone and
// one that has to be babysat, so the arithmetic is worth pinning: a wrong sign
// or a missing peak limit is silent in a unit test but audible immediately.

describe('звук: децибелы', () => {
  it('переводит дБ в усиление и обратно', () => {
    assert.equal(dbToGain(0), 1);
    assert.ok(Math.abs(dbToGain(-6) - 0.5012) < 0.001);
    assert.ok(Math.abs(dbToGain(6) - 1.9953) < 0.001);
    assert.ok(Math.abs(gainToDb(1)) < 1e-9);
    assert.ok(Math.abs(gainToDb(dbToGain(-12)) + 12) < 1e-9);
  });

  it('не падает на нуле и бесконечности', () => {
    assert.equal(gainToDb(0), -120);
    assert.equal(dbToGain(-Infinity), 1, 'иначе -Infinity дал бы NaN в графе');
    assert.equal(dbToGain(NaN), 1);
  });
});

describe('звук: нормализация громкости', () => {
  it('поднимает тихий мастер, но не выше запаса по пикам', () => {
    // -26 dBFS programme material wants +12 dB to reach a -14 target, but its
    // peaks sit at -8, so +7 is all that fits. The peak limit wins, which is the
    // whole point: matching the RMS alone would clip.
    assert.equal(normalisationGain(-26, -8, -14), 7);
    // With peaks far below full scale the RMS target is what applies.
    assert.equal(normalisationGain(-26, -18, -14), 12);
  });

  it('опускает громкий мастер, а не только поднимает тихий', () => {
    // This is the case that matters for VK: most modern tracks are loud.
    const g = normalisationGain(-2.9, 0, -14);
    assert.ok(g < 0, 'громкий трек должен быть тише');
    assert.ok(Math.abs(g - -11.1) < 0.01);
  });

  it('ограничивает усиление по пикам, чтобы не было клиппинга', () => {
    // Quiet on average but with peaks at full scale (classical, some electronic
    // music). Matching only the RMS would push the peaks past 0 dBFS.
    const g = normalisationGain(-20, -0.2, -14);
    assert.ok(g < 6, 'пик должен ограничить усиление');
    assert.ok(Math.abs(g - -0.8) < 1e-9, `ожидалось -0.8, получено ${g}`);
  });

  it('никогда не требует усиления выше запаса по пикам', () => {
    for (const rms of [-30, -20, -14, -8, -3]) {
      for (const peak of [-12, -6, -1, 0]) {
        const g = normalisationGain(rms, peak, -14);
        assert.ok(peak + g <= -0.9, `rms ${rms} peak ${peak}: пик вышел за шкалу`);
      }
    }
  });

  it('на тишине не меняет усиление', () => {
    // A silent window must not produce a huge gain that would then blast the
    // next track when audio starts.
    assert.equal(normalisationGain(-120, -120, -14), 0);
    assert.equal(normalisationGain(NaN, 0, -14), 0);
  });
});

describe('звук: ночной режим', () => {
  it('усиливает компрессию вместе с силой', () => {
    const soft = nightSettings(0);
    const hard = nightSettings(1);
    assert.ok(hard.threshold < soft.threshold, 'сильнее — ниже порог');
    assert.ok(hard.ratio > soft.ratio, 'сильнее — выше степень сжатия');
    assert.ok(hard.release < soft.release, 'сильнее — быстрее отпускает');
  });

  it('держит параметры в осмысленных пределах', () => {
    for (const a of [-1, 0, 0.5, 1, 2]) {
      const n = nightSettings(a);
      assert.ok(n.threshold <= 0 && n.threshold >= -40, `порог ${n.threshold}`);
      assert.ok(n.ratio >= 1 && n.ratio <= 8, `степень ${n.ratio}`);
      assert.ok(n.release > 0 && n.release <= 1, `восстановление ${n.release}`);
    }
  });
});

describe('звук: измерение громкости', () => {
  it('не сообщает результат, пока не набрано достаточно отсчётов', () => {
    const acc = createAccumulator();
    for (let i = 0; i < MIN_SAMPLES - 1; i++) accumulate(acc, 0.5);
    assert.equal(isMeasured(acc), false);
    accumulate(acc, 0.5);
    assert.equal(isMeasured(acc), true);
  });

  it('усредняет энергию, а не амплитуду', () => {
    // Half the samples at full scale and half silent is -3 dB of energy, not
    // -6: getting this wrong makes every measurement read low.
    const acc = createAccumulator();
    for (let i = 0; i < 100; i++) accumulate(acc, i % 2 ? 0 : 1);
    const db = rmsDb(acc);
    assert.ok(db !== null && Math.abs(db - -3.01) < 0.05, `получено ${db}`);
  });

  it('запоминает истинный пик, а не средний', () => {
    const acc = createAccumulator();
    for (let i = 0; i < 100; i++) accumulate(acc, 0.1);
    accumulate(acc, 1);
    for (let i = 0; i < 100; i++) accumulate(acc, 0.1);
    assert.equal(peakDb(acc), 0, 'пик должен остаться на полной шкале');
    const rms = rmsDb(acc);
    assert.ok(rms !== null && rms < -15, 'среднее при этом гораздо ниже');
  });

  it('полная шкала даёт 0 дБ, а не отбрасывается', () => {
    // A peak of exactly 0 dBFS is normal for a limited master; treating it as
    // "no signal" would skip normalisation for the loudest tracks.
    const acc = createAccumulator();
    for (let i = 0; i < MIN_SAMPLES; i++) accumulate(acc, 1);
    assert.equal(peakDb(acc), 0);
  });

  it('игнорирует мусорные значения', () => {
    const acc = createAccumulator();
    accumulate(acc, NaN);
    accumulate(acc, -1);
    accumulate(acc, Infinity);
    assert.equal(acc.frames, 0);
  });

  it('на пустом накопителе не выдумывает числа', () => {
    const acc = createAccumulator();
    assert.equal(rmsDb(acc), null);
    assert.equal(peakDb(acc), null);
    assert.equal(isMeasured(acc), false);
  });
});
