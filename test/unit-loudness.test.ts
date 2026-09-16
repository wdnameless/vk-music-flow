import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { dbToGain, gainToDb, nightMakeupDb, nightSettings } from '../src/offscreen/audio-graph.js';
import {
  addBlock,
  addToBlock,
  BLOCK_SECONDS,
  closeBlock,
  createBlock,
  createMeter,
  DEFAULT_TARGET_DB,
  dynamicRangeDb,
  GATE_ABSOLUTE_LUFS,
  integratedLufs,
  lufsFromMeanSquare,
  normalisationGain,
  PEAK_CEILING_DB,
} from '../src/lib/loudness.js';

// Loudness normalisation is the difference between a playlist that can be left
// alone and one that has to be babysat, so the arithmetic is pinned here. Two
// classes of mistake are invisible until they reach a listener: a wrong sign, and
// a missing peak limit.

/** Build a meter from a list of block loudnesses. */
const meterOf = (blocks: (number | null)[], peakDb = -1) => {
  const m = createMeter();
  for (const b of blocks) addBlock(m, b, peakDb, 0.4);
  return m;
};

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

describe('звук: интегрированная громкость по BS.1770', () => {
  it('на постоянном сигнале даёт ровно его уровень', () => {
    // The meter is fed block loudnesses, so a constant signal must come back
    // unchanged: this is the identity the calibration of the standard relies on.
    const m = meterOf(Array(20).fill(-23));
    assert.equal(integratedLufs(m), -23);
  });

  it('абсолютный гейт выбрасывает тишину', () => {
    // Without the gate a fade-out would average its silence into the result and
    // report the track as much quieter than it is.
    const quiet = meterOf([...Array(10).fill(-16), ...Array(10).fill(-90)]);
    assert.equal(integratedLufs(quiet), -16);
  });

  it('относительный гейт выбрасывает тихие фрагменты', () => {
    // A breakdown or a solo passage is quiet *material*, not silence. Judging a
    // track by its loud parts is the point of the relative gate.
    const dynamic = meterOf([...Array(10).fill(-10), ...Array(10).fill(-30)]);
    const lufs = integratedLufs(dynamic);
    assert.ok(lufs !== null && Math.abs(lufs - -10) < 0.001, `получено ${lufs}`);
  });

  it('на одной тишине не выдумывает число', () => {
    assert.equal(integratedLufs(meterOf([null, null])), null);
    assert.equal(integratedLufs(meterOf(Array(5).fill(-90))), null);
    assert.equal(integratedLufs(createMeter()), null);
  });

  it('не отбрасывает всё, если распределение вырождено', () => {
    // A pathological block set must still produce a number rather than nothing.
    const flat = meterOf(Array(30).fill(-20));
    assert.equal(integratedLufs(flat), -20);
  });

  it('порог абсолютного гейта соответствует стандарту', () => {
    assert.equal(GATE_ABSOLUTE_LUFS, -70);
  });
});

describe('звук: сборка 400-мс блока', () => {
  it('усредняет все замеры внутри окна, а не берёт последний', () => {
    // A block defined by one instantaneous read captures a tenth of the audio
    // and jumps around with whatever happened to be playing at that moment.
    const b = createBlock();
    addToBlock(b, 0.01, -30);
    addToBlock(b, 0.04, -20);
    const { lufs, peakDb } = closeBlock(b);
    assert.ok(lufs !== null && Math.abs(lufs - lufsFromMeanSquare(0.025)!) < 1e-9);
    assert.equal(peakDb, -20, 'пик берётся максимумом, а не средним');
  });

  it('блок длиной 400 мс по стандарту', () => {
    assert.equal(BLOCK_SECONDS, 0.4);
  });

  it('пустой блок не выдумывает громкость', () => {
    const { lufs, peakDb } = closeBlock(createBlock());
    assert.equal(lufs, null);
    assert.equal(peakDb, -120);
  });

  it('игнорирует мусорные отсчёты', () => {
    const b = createBlock();
    addToBlock(b, NaN, NaN);
    addToBlock(b, -1, -5);
    assert.equal(b.count, 0, 'отрицательная энергия невозможна');
  });

  it('формула LUFS совпадает с калибровкой стандарта', () => {
    // A 1 kHz sine at -20 dBFS in both channels must read -20 LUFS; that is the
    // definition the whole scale is built on.
    const z = Math.pow(10, (-20 - -0.691) / 10);
    const lufs = lufsFromMeanSquare(z);
    assert.ok(lufs !== null && Math.abs(lufs - -20) < 1e-9, `получено ${lufs}`);
    assert.equal(lufsFromMeanSquare(0), null);
  });
});

describe('звук: нормализация', () => {
  it('поднимает тихий мастер до целевого уровня', () => {
    assert.equal(normalisationGain(-26, -20, DEFAULT_TARGET_DB), 12);
  });

  it('опускает громкий мастер, а не только поднимает тихий', () => {
    // The case that matters for VK: most modern tracks are loud.
    const g = normalisationGain(-2.9, -0.5, DEFAULT_TARGET_DB);
    assert.ok(g < 0, 'громкий трек должен быть тише');
    assert.ok(Math.abs(g - -11.1) < 0.01, `получено ${g}`);
  });

  it('ограничивает усиление по пикам, чтобы не было клиппинга', () => {
    // Quiet on average, loud transients: matching loudness alone would clip.
    const g = normalisationGain(-20, -0.2, DEFAULT_TARGET_DB);
    assert.equal(g, PEAK_CEILING_DB - -0.2);
  });

  it('никогда не выпускает пик за потолок', () => {
    for (const lufs of [-30, -20, -14, -8, -3]) {
      for (const peak of [-12, -6, -1, 0]) {
        const g = normalisationGain(lufs, peak, DEFAULT_TARGET_DB);
        assert.ok(peak + g <= PEAK_CEILING_DB + 1e-9, `lufs ${lufs} peak ${peak}: пик вышел за шкалу`);
      }
    }
  });

  it('на тишине не меняет усиление', () => {
    // A silent measurement must not produce a huge gain that would then blast
    // the next track when audio starts.
    assert.equal(normalisationGain(GATE_ABSOLUTE_LUFS - 10, -60, DEFAULT_TARGET_DB), 0);
    assert.equal(normalisationGain(NaN, 0, DEFAULT_TARGET_DB), 0);
  });
});

describe('звук: динамический диапазон', () => {
  it('считает crest factor как пик минус громкость', () => {
    assert.equal(dynamicRangeDb(-0.5, -9), 8.5);
  });

  it('не выдумывает число без измерения громкости', () => {
    assert.equal(dynamicRangeDb(-0.5, null), null);
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

  it('компенсирует снижение уровня, иначе режим только делает тише', () => {
    // A compressor alone only reduces level, which is the opposite of what a
    // night mode is for.
    assert.equal(nightMakeupDb(0), 0, 'без силы компенсации нет');
    const soft = nightMakeupDb(0.5);
    const hard = nightMakeupDb(1);
    assert.ok(soft > 0 && soft < 6, `компенсация ${soft} должна быть умеренной`);
    assert.ok(hard > soft, 'сильнее режим — больше компенсации');
    // Conservative on purpose: the limiter catches the rest.
    assert.ok(hard < 20, `компенсация ${hard} не должна перекрывать порог целиком`);
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
