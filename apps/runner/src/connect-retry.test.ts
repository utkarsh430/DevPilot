// Regression coverage for the boot-race fix (connect-retry.ts).
//
// NOT a jest/vitest suite — the runner has no test runner wired up, so this
// follows the same bare-`main()` convention as workspace.test.ts. Run it
// directly (no env needed — connect-retry.ts imports nothing from env.ts):
//
//   cd apps/runner
//   npx tsx src/connect-retry.test.ts
//
// It asserts the boot-race behaviour without real timers or sockets by
// injecting a fake clock + no-op sleep:
//   1. A transient ECONNREFUSED-style failure RETRIES then succeeds (the bug:
//      the runner used to fatal-exit here instead).
//   2. A real HTTP-response error (register failed: 401 …) is NOT retried and
//      surfaces immediately — genuine failures aren't masked.
//   3. Persistent transient failure past the overall ceiling rethrows (fails
//      loudly) rather than looping forever.
//   4. isTransientConnectError classifies wrapped/aggregate causes correctly.

import assert from "node:assert/strict";
import { isTransientConnectError, retryOnTransientConnect } from "./connect-retry.js";

/** Build a value shaped like node's `fetch` ECONNREFUSED rejection. */
function fetchFailed(code = "ECONNREFUSED"): TypeError {
  const err = new TypeError("fetch failed");
  // node nests the real connect error under `.cause`, often as an AggregateError.
  (err as { cause?: unknown }).cause = new AggregateError(
    [Object.assign(new Error("connect " + code), { code })],
    code,
  );
  return err;
}

async function testRetriesTransientThenSucceeds(): Promise<void> {
  let calls = 0;
  const waits: number[] = [];
  const result = await retryOnTransientConnect(
    async () => {
      calls++;
      if (calls < 3) throw fetchFailed();
      return { runnerId: "runner-123" };
    },
    {
      sleep: async (ms) => {
        waits.push(ms);
      },
      now: () => 0, // frozen clock: never hits the overall ceiling
    },
  );
  assert.equal(result.runnerId, "runner-123");
  assert.equal(calls, 3, "should retry until the engine is reachable");
  assert.deepEqual(waits, [500, 1000], "capped exponential backoff between attempts");
  console.log("[ok] transient ECONNREFUSED retries then succeeds");
}

async function testHttpResponseErrorSurfacesImmediately(): Promise<void> {
  let calls = 0;
  // Mirrors engine-client.registerRunner()'s throw when res.ok is false: a real
  // response was received, so this must NOT be retried.
  const httpErr = new Error("register failed: 401 unauthorized");
  await assert.rejects(
    () =>
      retryOnTransientConnect(
        async () => {
          calls++;
          throw httpErr;
        },
        { sleep: async () => {}, now: () => 0 },
      ),
    /register failed: 401/,
  );
  assert.equal(calls, 1, "a genuine HTTP-response error is not retried");
  console.log("[ok] post-connection HTTP error surfaces immediately (no retry)");
}

async function testGivesUpAfterOverallCeiling(): Promise<void> {
  let calls = 0;
  let clock = 0;
  await assert.rejects(
    () =>
      retryOnTransientConnect(
        async () => {
          calls++;
          throw fetchFailed();
        },
        {
          overallTimeoutMs: 10_000,
          sleep: async (ms) => {
            clock += ms; // advance the injected clock by each backoff wait
          },
          now: () => clock,
        },
      ),
    (err: unknown) => isTransientConnectError(err),
  );
  assert.ok(calls > 1, "should have retried at least once before giving up");
  console.log(`[ok] persistent transient failure rethrows after ceiling (${calls} attempts)`);
}

function testClassifier(): void {
  assert.equal(isTransientConnectError(fetchFailed()), true);
  assert.equal(isTransientConnectError(fetchFailed("ECONNRESET")), true);
  assert.equal(
    isTransientConnectError(Object.assign(new Error("boom"), { code: "ETIMEDOUT" })),
    true,
  );
  assert.equal(isTransientConnectError(new Error("register failed: 403 forbidden")), false);
  assert.equal(isTransientConnectError(new SyntaxError("Unexpected token < in JSON")), false);
  assert.equal(isTransientConnectError(null), false);
  console.log("[ok] isTransientConnectError classifies connect vs response errors");
}

async function main(): Promise<void> {
  testClassifier();
  await testRetriesTransientThenSucceeds();
  await testHttpResponseErrorSurfacesImmediately();
  await testGivesUpAfterOverallCeiling();
  console.log("\n[connect-retry.test] all assertions passed");
}

main().catch((err) => {
  console.error("[connect-retry.test] FAILED:", err);
  process.exit(1);
});
