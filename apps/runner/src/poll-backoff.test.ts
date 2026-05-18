// Regression coverage for the Redis idle-poll backoff (poll-backoff.ts).
//
// NOT a jest/vitest suite — the runner has no test runner wired up, so this
// follows the same bare-`main()` convention as connect-retry.test.ts /
// workspace.test.ts. Run it directly (no env needed — poll-backoff.ts imports
// nothing from env.ts):
//
//   cd apps/runner
//   npx tsx src/poll-backoff.test.ts
//
// Guards the fix for the stacked-runner Upstash quota-exhaustion incident: an
// idle loop must ramp its empty-poll cadence 1s→5s (not sit at 1s forever), cap
// at 5s, and — critically — snap back to the 1s base cadence the instant work
// arrives so responsiveness during active periods is unchanged.

import assert from "node:assert/strict";
import { nextIdleDelayMs, POLL_BASE_MS, POLL_IDLE_CAP_MS } from "./poll-backoff.js";

function testRampSequence(): void {
  // From the base cadence, doubling each empty poll, capped at 5s.
  assert.equal(nextIdleDelayMs(POLL_BASE_MS), 2_000, "1s → 2s");
  assert.equal(nextIdleDelayMs(2_000), 4_000, "2s → 4s");
  assert.equal(nextIdleDelayMs(4_000), 5_000, "4s → 5s (capped, not 8s)");
  assert.equal(nextIdleDelayMs(5_000), 5_000, "5s → 5s (stays at cap)");
}

function testFloorAndCapGuards(): void {
  // Never returns below the base, even if handed a nonsensical sub-base value.
  assert.equal(nextIdleDelayMs(0), 2_000, "0 floored to base then doubled");
  assert.equal(nextIdleDelayMs(-1_000), 2_000, "negative floored to base then doubled");
  // Respects custom base/cap so callers with a different cadence stay correct.
  assert.equal(nextIdleDelayMs(1_000, 1_000, 3_000), 2_000, "custom cap: 1s → 2s");
  assert.equal(nextIdleDelayMs(2_000, 1_000, 3_000), 3_000, "custom cap: 2s → 3s (capped)");
}

// Simulate the loop's use of the helper: empty polls ramp, a message resets,
// and a pop error throttles straight to the cap. This is the exact state
// machine every pull loop now runs, so it documents the contract end to end.
function testLoopStateMachine(): void {
  let idleMs = POLL_BASE_MS;
  const onEmpty = () => {
    const slept = idleMs;
    idleMs = nextIdleDelayMs(idleMs);
    return slept;
  };
  const onMessage = () => {
    idleMs = POLL_BASE_MS;
  };
  const onError = () => {
    idleMs = POLL_IDLE_CAP_MS;
    return idleMs;
  };

  // A run of empty polls ramps 1 → 2 → 4 → 5 → 5 …
  assert.deepEqual(
    [onEmpty(), onEmpty(), onEmpty(), onEmpty(), onEmpty()],
    [1_000, 2_000, 4_000, 5_000, 5_000],
    "empty polls ramp to the cap",
  );

  // Work arrives — the next empty poll is back at the fast base cadence.
  onMessage();
  assert.equal(onEmpty(), 1_000, "a message resets the cadence to 1s (no added latency)");

  // A pop error (the quota-exhaustion failure mode) throttles straight to 5s.
  assert.equal(onError(), 5_000, "pop error jumps straight to the cap");
  assert.equal(onEmpty(), 5_000, "next empty poll after an error is still at the cap");
}

function main(): void {
  testRampSequence();
  testFloorAndCapGuards();
  testLoopStateMachine();
  console.log("poll-backoff.test.ts: all assertions passed");
}

main();
