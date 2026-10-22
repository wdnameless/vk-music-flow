import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  advancePos,
  buildOrder,
  insertIntoOrder,
  moveInOrder,
  removeFromOrder,
} from '../src/offscreen/queue-order.js';

// The queue keeps the user's list and the play order apart, so a bug here
// silently plays the wrong track or drops one. These are the parts that are
// hard to see by clicking around: index remapping after a removal or a move.

/** Deterministic stand-in for Math.random, so shuffle is reproducible. */
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const isPermutation = (order: number[], length: number): boolean =>
  order.length === length && [...order].sort((a, b) => a - b).every((v, i) => v === i);

describe('queue: порядок воспроизведения', () => {
  it('без шафла порядок совпадает со списком', () => {
    assert.deepEqual(buildOrder(4, false, 0), [0, 1, 2, 3]);
  });

  it('шафл даёт перестановку, а не потерю или дубликат элементов', () => {
    const order = buildOrder(20, true, -1, seeded(7));
    assert.ok(isPermutation(order, 20), 'порядок должен быть перестановкой 0..19');
    assert.notDeepEqual(order, Array.from({ length: 20 }, (_, i) => i));
  });

  it('шафл не уносит играющий трек в конец — он остаётся первым', () => {
    // Otherwise enabling shuffle would restart the song being listened to.
    for (let seed = 1; seed <= 5; seed++) {
      const order = buildOrder(10, true, 6, seeded(seed));
      assert.equal(order[0], 6, `seed ${seed}: текущий трек должен остаться первым`);
    }
  });

  it('вставка «следующим» идёт сразу за курсором, а не в конец', () => {
    assert.deepEqual(insertIntoOrder([0, 1, 2], 3, 2, 0, true), [0, 3, 4, 1, 2]);
  });

  it('вставка в конец добавляет после всех', () => {
    assert.deepEqual(insertIntoOrder([0, 1, 2], 3, 2, 1, false), [0, 1, 2, 3, 4]);
  });

  it('вставка в пустую очередь становится самой очередью', () => {
    assert.deepEqual(insertIntoOrder([], 0, 3, -1, false), [0, 1, 2]);
  });

  it('удаление сдвигает все последующие индексы на единицу', () => {
    // Removing a middle entry must not leave a gap that points at the wrong track.
    assert.deepEqual(removeFromOrder([0, 1, 2, 3], 1), [0, 1, 2]);
    assert.deepEqual(removeFromOrder([3, 2, 1, 0], 1), [2, 1, 0]);
  });

  it('удаление последнего элемента не трогает предыдущие', () => {
    assert.deepEqual(removeFromOrder([0, 1, 2], 2), [0, 1]);
  });

  it('удаление нетекущего элемента до текущего сдвигает индекс текущего в очереди, сохраняя порядок', () => {
    const order = [2, 0, 1];
    const removedQi = 0;
    const newOrder = removeFromOrder(order, removedQi);
    assert.deepEqual(newOrder, [1, 0]);
    const targetQi = 1 > removedQi ? 1 - 1 : 1;
    assert.equal(targetQi, 0);
    assert.equal(newOrder.indexOf(targetQi), 1);
  });

  it('перенос вверх ставит трек на новое место, сдвигая промежуточные', () => {
    // Dragging a row rearranges the play sequence itself.
    assert.deepEqual(moveInOrder([0, 1, 2, 3], 0, 2), [1, 2, 0, 3]);
  });

  it('перенос вниз ставит трек на новое место, сдвигая промежуточные', () => {
    assert.deepEqual(moveInOrder([0, 1, 2, 3], 3, 1), [0, 3, 1, 2]);
  });

  it('перенос на себя и за пределами не меняет порядок', () => {
    assert.deepEqual(moveInOrder([0, 1, 2], 1, 1), [0, 1, 2]);
    assert.deepEqual(moveInOrder([0, 1, 2], -1, 1), [0, 1, 2]);
    assert.deepEqual(moveInOrder([0, 1, 2], 0, 9), [0, 1, 2]);
  });

  it('перенос остаётся перестановкой при любой паре позиций', () => {
    for (let from = 0; from < 5; from++) {
      for (let to = 0; to < 5; to++) {
        assert.ok(isPermutation(moveInOrder([0, 1, 2, 3, 4], from, to), 5), `move ${from}->${to}`);
      }
    }
  });

  it('курсор идёт по порядку и не выходит за края', () => {
    assert.equal(advancePos(0, 3, 1, false), 1);
    assert.equal(advancePos(2, 3, 1, false), null, 'в конце без повтора — стоп');
    assert.equal(advancePos(0, 3, -1, false), null, 'в начале назад — стоп');
  });

  it('повтор всей очереди заворачивает в обе стороны', () => {
    assert.equal(advancePos(2, 3, 1, true), 0);
    assert.equal(advancePos(0, 3, -1, true), 2);
  });

  it('пустая очередь не двигает курсор', () => {
    assert.equal(advancePos(0, 0, 1, true), null);
  });
});
