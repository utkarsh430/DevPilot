// Phase 1 / M14 — sliding-window rate limit for the public platform surface.
//
// Keyed on apiKeyId (NOT tenantId — tenant-level limits live in the
// cost-velocity circuit breaker in `lib/engine/budget.ts`). Default 60
// requests / minute / key; tunable via DEVPILOT_API_RATELIMIT_PER_MIN env var.
//
// Implementation: Upstash sorted-set-as-sliding-window.
//   - ZADD <key> <now_ms> <unique_member>
//   - ZREMRANGEBYSCORE <key> 0 <now_ms - window_ms>   (drop stale entries)
//   - ZCARD <key>                                      (in-window count)
//   - EXPIRE <key> <window_seconds>                    (best-effort GC)
//
// We pipeline the four commands so the latency stays a single round-trip to
// Upstash. The count returned by ZCARD INCLUDES the just-added entry, so the
// limit comparison is `count > N`. On bust we return a Retry-After hint
// computed from the oldest in-window entry — the moment it ages out of the
// window is the moment the caller can succeed again.

import { redis } from "@/lib/cache/redis";

const WINDOW_MS = 60_000;
const KEY_PREFIX = "devpilot:ratelimit:apikey:";

export type RateLimitResult =
  | { allowed: true; remaining: number; limit: number }
  | { allowed: false; retryAfterSeconds: number; limit: number };

function limit(): number {
  const raw = process.env.DEVPILOT_API_RATELIMIT_PER_MIN;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
}

/**
 * Enforce a sliding 60s window on the given api key id. Returns
 * { allowed: true } on success and { allowed: false, retryAfterSeconds }
 * once the caller has busted the limit.
 *
 * Failure mode: any Upstash/transport error → fail-OPEN (allowed). The same
 * policy as `assertCanProceed` — rate limit is a quality knob, not a security
 * boundary, and we don't want a Redis blip to take the whole API offline.
 */
export async function checkRateLimit(apiKeyId: string): Promise<RateLimitResult> {
  const max = limit();
  const key = `${KEY_PREFIX}${apiKeyId}`;
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  // Unique member so two requests in the same millisecond don't collide.
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;

  try {
    const r = redis();
    const pipe = r.pipeline();
    pipe.zadd(key, { score: now, member });
    pipe.zremrangebyscore(key, 0, cutoff);
    pipe.zcard(key);
    pipe.expire(key, Math.ceil(WINDOW_MS / 1000) + 5);
    const results = (await pipe.exec()) as [unknown, unknown, number, unknown];
    const count = typeof results[2] === "number" ? results[2] : 0;

    if (count > max) {
      // Best-effort: find the oldest in-window entry to compute Retry-After.
      // ZRANGE WITHSCORES <key> 0 0 — cheap call.
      let retryAfterSeconds = Math.ceil(WINDOW_MS / 1000);
      try {
        const oldest = (await r.zrange(key, 0, 0, { withScores: true })) as unknown as Array<
          string | number
        >;
        if (oldest && oldest.length >= 2) {
          const oldestScore = Number(oldest[1]);
          if (Number.isFinite(oldestScore)) {
            const ageOutAt = oldestScore + WINDOW_MS;
            retryAfterSeconds = Math.max(1, Math.ceil((ageOutAt - now) / 1000));
          }
        }
      } catch {
        // ignore — fall back to the default window
      }
      return { allowed: false, retryAfterSeconds, limit: max };
    }

    return { allowed: true, remaining: Math.max(0, max - count), limit: max };
  } catch {
    // Fail open — same policy as the cost-velocity guard.
    return { allowed: true, remaining: max, limit: max };
  }
}
