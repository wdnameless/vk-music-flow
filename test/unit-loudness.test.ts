import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { dbToGain, gainToDb, nightMakeupDb, nightSettings } from '../src/offscreen/audio-graph.js';
import {
  addBlock,
  albumLufs,
  modeGain,
  replayGainDb,
  replayGainPeak,
  REPLAYGAIN_REFERENCE_LUFS,
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

describe('звук: режим по альбому', () => {
  it('усредняет энергию треков, а не их уровни', () => {
    // The energy mean of -10 and -20 is -12.6, not -15: a quiet interlude must
    // not pull the album level up the way an arithmetic mean would.
    const album = albumLufs([-10, -20]);
    assert.ok(album !== null && Math.abs(album - -12.596) < 0.01, `получено ${album}`);
    assert.notEqual(album, -15, 'арифметическое среднее здесь было бы неверным');
  });

  it('на одном треке даёт ровно его уровень', () => {
    assert.equal(albumLufs([-16.5]), -16.5);
  });

  it('не выдумывает альбом без измерений', () => {
    assert.equal(albumLufs([]), null);
    assert.equal(albumLufs([-90, -85]), null);
  });

  it('по треку выравнивает каждый трек к цели', () => {
    // +6 by loudness, but the peak at -6 leaves room for only +5, so the peak
    // limit is what applies.
    assert.equal(modeGain(-20, -6, { lufs: -16, peakDb: -6 }, -14, 'track'), 5);
    // The album figure is ignored in this mode.
    assert.equal(modeGain(-20, -12, { lufs: -8, peakDb: -2 }, -14, 'track'), 6);
  });

  it('по альбому даёт один и тот же гейн всем трекам', () => {
    // Album gain is a single value for the release, limited by the album's
    // loudest peak. If it varied per track the mode would flatten the album's
    // dynamics — the exact thing it exists to preserve.
    // Album at -16 with its loudest peak at -3: +2 by loudness, but only +2 fits
    // before the -1 ceiling, so that is the album gain.
    const album = { lufs: -16, peakDb: -3 };
    const quiet = modeGain(-24, -14, album, -14, 'album');
    const loud = modeGain(-12, -4, album, -14, 'album');
    assert.equal(quiet, loud, 'все треки альбома получают одинаковый гейн');
    assert.equal(quiet, 2, 'гейн считается от громкости и пика альбома');
    // And the 12 dB between the two tracks is untouched.
    assert.equal(-12 - -24, 12);
  });

  it('по треку выравнивает каждый трек, ломая динамику альбома', () => {
    // The contrast: per-track mode gives the quiet one +8 and the loud one -2.
    const quiet = modeGain(-24, -14, null, -14, 'track');
    const loud = modeGain(-12, -4, null, -14, 'track');
    assert.equal(quiet, 10, 'тихий поднимается на 10 дБ');
    assert.equal(loud, -2, 'громкий опускается на 2 дБ');
    assert.notEqual(quiet, loud, 'именно этого режим «по альбому» и не делает');
  });

  it('по альбому без известного альбома ведёт себя как по треку', () => {
    assert.equal(modeGain(-20, -12, null, -14, 'album'), 6);
  });

  it('в выключенном режиме ничего не меняет', () => {
    assert.equal(modeGain(-24, -6, { lufs: -16, peakDb: -6 }, -14, 'off'), 0);
  });

  it('потолок по пикам действует в любом режиме', () => {
    // Not clipping is not a level-matching question.
    for (const mode of ['track', 'album'] as const) {
      const g = modeGain(-30, -0.2, { lufs: -20, peakDb: -0.2 }, -14, mode);
      assert.ok(-0.2 + g <= PEAK_CEILING_DB + 1e-9, `${mode}: пик вышел за потолок`);
    }
  });
});

describe('звук: ReplayGain', () => {
  it('считает относительно эталона ReplayGain, а не стримингов', () => {
    // Writing -14 figures into the tags would make every file play 4 dB louder
    // in another player than it does here.
    assert.equal(REPLAYGAIN_REFERENCE_LUFS, -18);
    assert.equal(replayGainDb(-18), 0);
    assert.equal(replayGainDb(-24), 6, 'тихий файл усиливается');
    assert.equal(replayGainDb(-10), -8, 'громкий ослабляется');
  });

  it('пик пишет в линейной амплитуде, как требует формат', () => {
    assert.ok(Math.abs(replayGainPeak(0) - 1) < 1e-9);
    assert.ok(Math.abs(replayGainPeak(-6) - 0.5012) < 0.001);
  });

  it('на полной шкале не даёт NaN', () => {
    assert.ok(Number.isFinite(replayGainPeak(0)));
    assert.equal(replayGainDb(-14) - replayGainDb(-18), -4);
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
