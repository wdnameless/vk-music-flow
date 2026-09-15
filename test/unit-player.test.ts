import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { EQ_BANDS, clampDb, flatEq } from '../src/offscreen/player.js';

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
