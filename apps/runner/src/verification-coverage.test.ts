// B2 — the recording-coverage plumbing on the runner side.
//
// The prod failure: the engine enforced the QA gate while the runner recorded
// nothing, because each read its OWN host's flag and they are separate
// processes on separate hosts. `decideQaGate` fails open on an absent record,
// so the gate allowed every failing-build hand-off it existed to stop.
//
// The fix makes the ENGINE authoritative and ships the answer on the job. These
// tests pin the two runner-side halves of that: the env the MCP relay (hook (i))
// is spawned with, and the record body hook (ii) posts.
//
// Run: tsx src/verification-coverage.test.ts

import assert from "node:assert/strict";
import { buildSubscriptionEnvOverrides } from "./subscription-env.js";
import type { VerificationResultBody } from "./verification-hook.js";

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("verification coverage — engine-authoritative recording switch");

const base = {
  runId: "run-1",
  tenantId: "tenant-1",
  runnerConfig: {},
} as const;

test("the MCP relay is told to record when the engine says so", () => {
  const env = buildSubscriptionEnvOverrides({
    ...base,
    workspacePath: "/ws/ticket-1",
    qaVerifyEnabled: true,
  });
  assert.equal(env.ENGINEER_QA_VERIFY_ENABLED, "1");
});

test("the switch is written in BOTH directions, so the host env cannot override 'off'", () => {
  // Previously the key was OMITTED when false, and the spawn env is
  // `process.env` with these overrides layered on top — so a runner host with
  // its own ENGINEER_QA_VERIFY_ENABLED=1 silently ignored the engine's "off".
  // The engine must be authoritative for both answers, not just one.
  const env = buildSubscriptionEnvOverrides({ ...base, qaVerifyEnabled: false });
  assert.equal(env.ENGINEER_QA_VERIFY_ENABLED, "0");
});

test("the base branch reaches the relay, so hook (i) can measure delivery too", () => {
  // Without this the MCP relay — the hook that fires on the agent's OWN
  // `devpilot_move_ticket(in_review)`, i.e. the actual hand-off — would record a
  // row with no `commits_ahead` and the empty-delivery check would fail open on
  // exactly the path it most needs to bite.
  const env = buildSubscriptionEnvOverrides({
    ...base,
    qaVerifyEnabled: true,
    baseBranch: "dev",
  });
  assert.equal(env.DEVPILOT_BASE_BRANCH, "dev");
});

test("no base branch simply omits the var (never a bogus empty value)", () => {
  const env = buildSubscriptionEnvOverrides({ ...base, qaVerifyEnabled: true });
  assert.equal(env.DEVPILOT_BASE_BRANCH, undefined);
});

test("the recording switch is not smuggled past the credential blocklist", () => {
  // Sanity: the new key is an ordinary DEVPILOT_* value, not something the
  // sanitizer strips — a filtered var would silently reopen the coverage gap.
  const env = buildSubscriptionEnvOverrides({
    ...base,
    qaVerifyEnabled: true,
    baseBranch: "main",
    workspacePath: "/ws/x",
    baseSha: "c".repeat(40),
  });
  assert.equal(env.DEVPILOT_BASE_BRANCH, "main");
  assert.equal(env.DEVPILOT_WORKSPACE_PATH, "/ws/x");
  assert.equal(env.DEVPILOT_BASE_SHA, "c".repeat(40));
});

console.log("\nverification coverage — the record body");

test("commits_ahead is OPTIONAL on the body — a runner that cannot measure omits it", () => {
  // Typed assertion: omitting the field must remain valid, because a null must
  // reach the gate as "could not determine" (fail open) and never as a 0.
  const body: VerificationResultBody = {
    command: "pnpm test",
    exit_code: 0,
    head_sha: "d".repeat(40),
    pushed: true,
    output_tail: "",
  };
  assert.equal(body.commits_ahead, undefined);
});

test("commits_ahead 0 is representable — the positive 'empty delivery' assertion", () => {
  const body: VerificationResultBody = {
    command: "pnpm test",
    exit_code: 0,
    head_sha: "d".repeat(40),
    pushed: true,
    output_tail: "",
    commits_ahead: 0,
  };
  assert.equal(body.commits_ahead, 0);
});

if (failures > 0) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
