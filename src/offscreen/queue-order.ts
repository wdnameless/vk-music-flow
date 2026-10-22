/**
 * Order arithmetic for the play queue.
 *
 * The list and the play order are separate values:
 *  - `queue` is what the user sees and arranged;
 *  - `order` is a permutation of indices into `queue`, i.e. what will play.
 *
 * Shuffling permutes `order` and never `queue`, so turning shuffle off restores
 * the user's own arrangement, and dragging a row stays meaningful while
 * shuffled. Everything here is pure so the tricky parts (index remapping after
 * a removal or a move) can be tested without an audio context.
 */

/** A permutation of `0..length-1`, shuffled in place, current track first. */
export function buildOrder(
  length: number,
  shuffle: boolean,
  current: number,
  random: () => number = Math.random,
): number[] {
  const idx = Array.from({ length }, (_, i) => i);
  if (!shuffle) return idx;
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  // The playing track must not be shuffled away, or it would restart the song
  // the user is listening to.
  if (current >= 0 && current < length) {
    const at = idx.indexOf(current);
    if (at > 0) [idx[0], idx[at]] = [idx[at]!, idx[0]!];
  }
  return idx;
}

/** Append indices for `count` new items, optionally right after `pos`. */
export function insertIntoOrder(
  order: number[],
  base: number,
  count: number,
  pos: number,
  next: boolean,
): number[] {
  const fresh = Array.from({ length: count }, (_, i) => base + i);
  if (!order.length) return fresh;
  if (!next) return [...order, ...fresh];
  const at = Math.min(Math.max(pos + 1, 0), order.length);
  return [...order.slice(0, at), ...fresh, ...order.slice(at)];
}

/**
 * Drop one entry and shift every later index down.
 *
 * `removed` is a queue index; entries after it move by one, so the order has to
 * be rewritten rather than filtered.
 */
export function removeFromOrder(order: number[], removed: number): number[] {
  return order.filter((qi) => qi !== removed).map((qi) => (qi > removed ? qi - 1 : qi));
}

/**
 * Move one entry within the play order, i.e. drag a row in the queue panel.
 *
 * `from` and `to` are slots in the play order, not positions in the list: the
 * queue panel shows the play sequence, so dragging rearranges what will play.
 * Reordering the hidden list would need every value remapped and would play the
 * wrong track when shuffle is on — a drag is a statement about the order.
 */
export function moveInOrder(order: number[], from: number, to: number): number[] {
  const next = order.slice();
  if (from === to || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  if (item === undefined) return order.slice();
  next.splice(to, 0, item);
  return next;
}

/**
 * The next cursor position along `order`.
 *
 * `all` wraps; `off` reports `null` at the edge so the caller can stop without
 * clearing the current track, which would blank the player.
 */
export function advancePos(
  pos: number,
  length: number,
  delta: number,
  repeatAll: boolean,
): number | null {
  if (length <= 0) return null;
  const next = pos + delta;
  if (next >= 0 && next < length) return next;
  if (repeatAll) return delta > 0 ? 0 : length - 1;
  return null;
}
