/**
 * Pure retry/rate-limit math for the Phase 1 queue engine.
 * Kept side-effect-free so bounds are unit-testable without chrome/DOM.
 */

/**
 * Exponential backoff with additive jitter:
 *   delay = min(maxMs, baseMs * 2^attempt) + rand() * jitterMs
 * `attempt` is the number of failures so far (>= 1 on first retry).
 * `rand` is injectable for deterministic tests; it must return [0, 1).
 */
export function computeBackoff(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitterMs: number,
  rand: () => number = Math.random,
): number {
  const a = Math.max(0, Math.min(Math.floor(attempt), 30));
  const exp = Math.max(0, baseMs) * 2 ** a;
  const capped = Math.min(exp, Math.max(0, maxMs));
  const jitter = Math.max(0, jitterMs) * Math.min(Math.max(rand(), 0), 0.9999999);
  return Math.round(capped + jitter);
}

/**
 * Pre-start rate limiter: seconds to wait before launching the next download
 * given when the previous one started, plus random anti-ban jitter.
 * Returns milliseconds; `now`/`rand` are injectable.
 */
export function computeStartDelay(
  lastStartAt: number,
  minIntervalMs: number,
  jitterMs: number,
  now: number = Date.now(),
  rand: () => number = Math.random,
): number {
  const since = Math.max(0, now - lastStartAt);
  const base = Math.max(0, Math.max(0, minIntervalMs) - since);
  const jitter = Math.max(0, jitterMs) * Math.min(Math.max(rand(), 0), 0.9999999);
  return Math.round(base + jitter);
}
