/** Sliding window: max `max` events in `windowMs`. Returns seconds until retry or 0 if allowed. */
export function createRateLimiter(windowMs: number, max: number) {
  const buckets = new Map<string, number[]>();

  return function allow(key: string, maxOverride?: number): { ok: boolean; retryAfterSec: number } {
    const limit = maxOverride ?? max;
    const now = Date.now();
    const cutoff = now - windowMs;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    const filtered = arr.filter((t) => t > cutoff);
    buckets.set(key, filtered);
    if (filtered.length >= limit) {
      const oldest = filtered[0]!;
      const retryAt = oldest + windowMs;
      return { ok: false, retryAfterSec: Math.ceil((retryAt - now) / 1000) };
    }
    filtered.push(now);
    return { ok: true, retryAfterSec: 0 };
  };
}
