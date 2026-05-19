// Idle-poll backoff for the runner's Redis REST pull loops.
//
// The runner drains several control queues (local-cc jobs, cancels, dev-server
// control, takeover control) by RPOP-polling Upstash Redis over its REST API.
// Upstash bills every request, and a flat 1s cadence across the ~4 always-on
// loops is ~350k requests/day per runner — which alone approaches the free
// tier's request cap and blows straight past it once a host ends up running
// more than one runner (a stacked-runner incident exhausted the 500k cap and
// silently killed the dev-server hand-off: every lpush/rpop started failing).
//
// When a queue is idle there is nothing to gain from polling every second, so
// each loop backs off exponentially while it keeps coming up empty and snaps
// back to the fast base cadence the instant a message arrives. Steady-state
// cost drops ~5x without adding latency during active periods: after the first
// message the loop is hot (base cadence) again. On a pop error (the quota-
// exhaustion case above) we throttle straight to the cap so a Redis outage
// can't be made worse by hammering it.

export const POLL_BASE_MS = 1_000;
export const POLL_IDLE_CAP_MS = 5_000;

/**
 * Next idle delay: double the current delay, capped at `capMs` and floored at
 * `baseMs`. Loops advance this after each empty poll and reset to `baseMs` on
 * any message; on a pop error they jump straight to `capMs`. Pure + clamped so
 * it is trivially unit-testable and never returns below `baseMs`.
 */
export function nextIdleDelayMs(
  currentMs: number,
  baseMs: number = POLL_BASE_MS,
  capMs: number = POLL_IDLE_CAP_MS,
): number {
  const doubled = Math.max(currentMs, baseMs) * 2;
  return Math.min(doubled, capMs);
}
