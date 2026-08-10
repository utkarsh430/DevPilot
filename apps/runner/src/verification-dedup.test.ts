// L1 (ticket-speed audit, §#5) — regression coverage for verification-dedup.ts.
//
// NOT a jest/vitest suite — the runner has no test runner wired up, so this
// follows the same bare-`main()` convention as connect-retry.test.ts /
// producer-verification.test.ts. Run it directly (no env needed):
//
//   cd apps/runner
//   npx tsx src/verification-dedup.test.ts
//
// The dedup guard is what turns "a run spans ~20 iterations reusing one working
// tree, and both hooks fire per commit" into "verify each HEAD exactly once".
// These assertions lock that: same head → skip after the first; a new commit →
// re-verify; a null head (unborn HEAD) → always verify (can't dedup).

import assert from "node:assert/strict";
import {
  shouldVerifyHead,
  markVerifiedHead,
  __resetVerificationDedup,
} from "./verification-dedup.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function testNIterationsUnchangedHeadVerifyOnce(): void {
  __resetVerificationDedup();
  const run = "run-1";
  let verifyCount = 0;
  // Simulate 20 iterations of one run, all at the same HEAD.
  for (let i = 0; i < 20; i++) {
    if (shouldVerifyHead(run, SHA_A)) {
      verifyCount++;
      markVerifiedHead(run, SHA_A);
    }
  }
  assert.equal(verifyCount, 1, "N iterations at an unchanged head must verify exactly once");
  console.log("✓ N iterations, unchanged head → exactly one verification (the dedup guard)");
}

function testNewCommitReVerifies(): void {
  __resetVerificationDedup();
  const run = "run-2";
  assert.equal(shouldVerifyHead(run, SHA_A), true, "first head is always verified");
  markVerifiedHead(run, SHA_A);
  assert.equal(shouldVerifyHead(run, SHA_A), false, "same head skips");
  // Agent commits — HEAD moves. This is what makes fix-and-retry work.
  assert.equal(shouldVerifyHead(run, SHA_B), true, "a new commit must re-verify");
  markVerifiedHead(run, SHA_B);
  assert.equal(shouldVerifyHead(run, SHA_B), false, "the new head then skips too");
  console.log("✓ a new commit (HEAD changes) re-verifies; fix-and-retry keeps working");
}

function testTwoHooksSameHeadOneVerify(): void {
  __resetVerificationDedup();
  const run = "run-3";
  // Hook (i) (MCP relay) fires first, then hook (ii) (step-result) — same head.
  let verifyCount = 0;
  for (const _hook of ["hook-i", "hook-ii"]) {
    if (shouldVerifyHead(run, SHA_A)) {
      verifyCount++;
      markVerifiedHead(run, SHA_A);
    }
  }
  assert.equal(verifyCount, 1, "both hooks at the same head must collapse to one verification");
  console.log("✓ both hooks at one head → one verification");
}

function testRunsAreIndependent(): void {
  __resetVerificationDedup();
  markVerifiedHead("run-A", SHA_A);
  // A different run at the same sha value is independently verified.
  assert.equal(shouldVerifyHead("run-B", SHA_A), true, "dedup is scoped per run, not global");
  console.log("✓ dedup is per-run: a different run at the same sha still verifies");
}

function testNullHeadAlwaysVerifies(): void {
  __resetVerificationDedup();
  const run = "run-4";
  // Unborn HEAD / git failure → head is null → cannot dedup → always verify.
  assert.equal(shouldVerifyHead(run, null), true, "a null head can't dedup — verify");
  markVerifiedHead(run, null); // no-op
  assert.equal(shouldVerifyHead(run, null), true, "still verifies; marking null is a no-op");
  console.log("✓ a null head (unborn/failed) always verifies and never poisons the guard");
}

function main(): void {
  testNIterationsUnchangedHeadVerifyOnce();
  testNewCommitReVerifies();
  testTwoHooksSameHeadOneVerify();
  testRunsAreIndependent();
  testNullHeadAlwaysVerifies();
  console.log("\nAll verification-dedup tests passed.");
}

main();
