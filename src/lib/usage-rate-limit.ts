import { createRateLimiter } from "./rate-limit.js";

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export type UsageRateLimitResult =
  | { ok: true; retryAfterSec: 0 }
  | { ok: false; retryAfterSec: number; window: "minute" | "day" };

/** Per api_key_id sliding windows; limits read from api_keys on each deduct. */
export function createUsageRateLimiter() {
  const perMinute = createRateLimiter(MS_PER_MINUTE, Number.MAX_SAFE_INTEGER);
  const perDay = createRateLimiter(MS_PER_DAY, Number.MAX_SAFE_INTEGER);

  return function check(keyId: string, rpm: number, rpd: number): UsageRateLimitResult {
    const minute = perMinute(`${keyId}:rpm`, rpm);
    if (!minute.ok) {
      return { ok: false, retryAfterSec: minute.retryAfterSec, window: "minute" };
    }
    const day = perDay(`${keyId}:rpd`, rpd);
    if (!day.ok) {
      return { ok: false, retryAfterSec: day.retryAfterSec, window: "day" };
    }
    return { ok: true, retryAfterSec: 0 };
  };
}
