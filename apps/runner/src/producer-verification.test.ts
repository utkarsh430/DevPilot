// L1 (ticket-speed audit) — regression coverage for producer-verification.ts.
//
// NOT a jest/vitest suite — the runner has no test runner wired up, so this
// follows the same bare-`main()` convention as connect-retry.test.ts /
// poll-backoff.test.ts / workspace.test.ts. Run it directly (no env needed —
// producer-verification.ts imports nothing from env.ts):
//
//   cd apps/runner
//   npx tsx src/producer-verification.test.ts

import assert from "node:assert/strict";
import {
  isProducerRole,
  parseCommandString,
  runVerificationCommands,
  type RunCommandFn,
} from "./producer-verification.js";

function testIsProducerRole(): void {
  for (const nonProducer of ["qa", "verifier", "release_engineer", "pm", "triage"]) {
    assert.equal(isProducerRole(nonProducer), false, `${nonProducer} should not be a producer`);
  }
  for (const producer of ["engineer", "backend_engineer", "designer", "cto", "some_custom_role"]) {
    assert.equal(isProducerRole(producer), true, `${producer} should be a producer`);
  }
  assert.equal(isProducerRole(null), false, "null role is never a producer");
  assert.equal(isProducerRole(undefined), false, "undefined role is never a producer");
  assert.equal(isProducerRole(""), false, "empty-string role is never a producer");
  console.log("✓ isProducerRole");
}

function testParseCommandString(): void {
  assert.deepEqual(parseCommandString("pnpm test"), { cmd: "pnpm", args: ["test"] });
  assert.deepEqual(parseCommandString("  pnpm   test  "), { cmd: "pnpm", args: ["test"] });
  assert.deepEqual(parseCommandString('pnpm test -- --grep "some name"'), {
    cmd: "pnpm",
    args: ["test", "--", "--grep", "some name"],
  });
  assert.deepEqual(parseCommandString("echo 'single quoted'"), {
    cmd: "echo",
    args: ["single quoted"],
  });
  assert.equal(parseCommandString(""), null);
  assert.equal(parseCommandString("   "), null);
  console.log("✓ parseCommandString");
}

async function testRunVerificationCommandsAllPass(): Promise<void> {
  const calls: string[] = [];
  const execFn: RunCommandFn = async (input) => {
    calls.push(`${input.cmd} ${input.args.join(" ")}`);
    return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
  };
  const outcome = await runVerificationCommands(
    "/tmp/whatever",
    [
      { label: "qa", command: "pnpm test" },
      { label: "build", command: "pnpm build" },
    ],
    execFn,
  );
  assert.deepEqual(calls, ["pnpm test", "pnpm build"], "both commands should run");
  assert.ok(outcome, "a command ran, so there must be a record");
  assert.equal(outcome.command, "pnpm build", "record reflects the last command run");
  assert.equal(outcome.label, "build", "record carries the label of the command it ran");
  assert.equal(outcome.exitCode, 0);
  console.log("✓ runVerificationCommands — all pass runs every command, records the last");
}

async function testRunVerificationCommandsFailFast(): Promise<void> {
  const calls: string[] = [];
  const execFn: RunCommandFn = async (input) => {
    calls.push(`${input.cmd} ${input.args.join(" ")}`);
    if (input.cmd === "pnpm" && input.args[0] === "test") {
      return { exitCode: 1, stdout: "1 failing\n", stderr: "", timedOut: false };
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  const outcome = await runVerificationCommands(
    "/tmp/whatever",
    [
      { label: "qa", command: "pnpm test" },
      { label: "build", command: "pnpm build" },
    ],
    execFn,
  );
  assert.deepEqual(calls, ["pnpm test"], "build must not run once qa fails (fail-fast)");
  assert.ok(outcome, "a command ran, so there must be a record");
  assert.equal(outcome.command, "pnpm test", "record is the failing command");
  assert.equal(outcome.label, "qa", "record names which command failed");
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.outputTail, /1 failing/);
  console.log("✓ runVerificationCommands — fail-fast on first non-zero, skips remaining");
}

async function testRunVerificationCommandsTimeout(): Promise<void> {
  const execFn: RunCommandFn = async () => ({
    exitCode: null,
    stdout: "hanging\n",
    stderr: "",
    timedOut: true,
  });
  const outcome = await runVerificationCommands(
    "/tmp/whatever",
    [{ label: "qa", command: "pnpm test" }],
    execFn,
  );
  assert.ok(outcome, "a timeout still produces a record");
  assert.equal(outcome.exitCode, -1, "a timeout is recorded as -1, not fabricated 0/1");
  assert.match(outcome.outputTail, /timed out/);
  console.log("✓ runVerificationCommands — timeout maps to exitCode -1");
}

/** A spawn failure (`pnpm` not on PATH) makes `runCommand` REJECT. That must
 *  become a recorded -1, not an escaped rejection that skips the POST and
 *  leaves the engine-side gate with no row at all. */
async function testRunVerificationCommandsSpawnFailure(): Promise<void> {
  const execFn: RunCommandFn = async () => {
    throw new Error("spawn pnpm ENOENT");
  };
  const outcome = await runVerificationCommands(
    "/tmp/whatever",
    [{ label: "qa", command: "pnpm test" }],
    execFn,
  );
  assert.ok(outcome, "a spawn failure must still produce a record");
  assert.equal(outcome.exitCode, -1, "spawn failure is 'couldn't determine' → -1");
  assert.equal(outcome.command, "pnpm test");
  assert.match(outcome.outputTail, /ENOENT/);
  console.log("✓ runVerificationCommands - spawn failure maps to exitCode -1, never escapes");
}

/** The second `build` command must not run after a spawn failure - same
 *  fail-fast semantics as a non-zero exit. */
async function testRunVerificationCommandsSpawnFailureIsFailFast(): Promise<void> {
  const calls: string[] = [];
  const execFn: RunCommandFn = async (input) => {
    calls.push(input.cmd);
    throw new Error("spawn ENOENT");
  };
  await runVerificationCommands(
    "/tmp/whatever",
    [
      { label: "qa", command: "pnpm test" },
      { label: "build", command: "pnpm build" },
    ],
    execFn,
  );
  assert.deepEqual(calls, ["pnpm"], "build must not run once qa fails to spawn");
  console.log("✓ runVerificationCommands - spawn failure is fail-fast");
}

/** Nothing ran → null, so the caller skips the POST entirely. Previously this
 *  fabricated `{command: "", exitCode: 0}`, which an enforcement gate would
 *  read as "verification passed" and admit an unverified change. */
async function testRunVerificationCommandsNothingRan(): Promise<void> {
  let called = false;
  const execFn: RunCommandFn = async () => {
    called = true;
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  for (const blank of ["", " ", "\t\n"]) {
    const outcome = await runVerificationCommands(
      "/tmp/whatever",
      [{ label: "qa", command: blank }],
      execFn,
    );
    assert.equal(outcome, null, `a blank command (${JSON.stringify(blank)}) must record nothing`);
  }
  assert.equal(called, false, "a blank command must never spawn anything");
  console.log("✓ runVerificationCommands - nothing ran returns null (never a fabricated pass)");
}

/** Configured but unrunnable (`''` parses to zero tokens) is a misconfiguration
 *  to surface as -1, not a silent skip - something WAS configured. */
async function testRunVerificationCommandsUnrunnableCommand(): Promise<void> {
  let called = false;
  const execFn: RunCommandFn = async () => {
    called = true;
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  const outcome = await runVerificationCommands(
    "/tmp/whatever",
    [{ label: "qa", command: "''" }],
    execFn,
  );
  assert.ok(outcome, "a non-blank but unrunnable command must produce a record");
  assert.equal(outcome.exitCode, -1, "unrunnable is 'couldn't determine' → -1, never 0");
  assert.equal(called, false, "nothing should have been spawned");
  console.log("✓ runVerificationCommands - non-blank unrunnable command records -1");
}

async function testRunVerificationCommandsOutputTailBounded(): Promise<void> {
  const bigOutput = "x".repeat(20_000);
  const execFn: RunCommandFn = async () => ({
    exitCode: 1,
    stdout: bigOutput,
    stderr: "",
    timedOut: false,
  });
  const outcome = await runVerificationCommands(
    "/tmp/whatever",
    [{ label: "qa", command: "pnpm test" }],
    execFn,
  );
  assert.ok(outcome, "a command ran, so there must be a record");
  assert.ok(outcome.outputTail.length <= 8_000, "output_tail must be bounded");
  console.log("✓ runVerificationCommands — output_tail is bounded");
}

async function testRunVerificationCommandsOutputTailBoundedOnTimeout(): Promise<void> {
  // The timeout marker must eat into the 8k budget, not be appended past it —
  // the timeout record is the one an operator most needs to read.
  const execFn: RunCommandFn = async () => ({
    exitCode: null,
    stdout: "x".repeat(20_000),
    stderr: "y".repeat(20_000),
    timedOut: true,
  });
  const outcome = await runVerificationCommands(
    "/tmp/whatever",
    [{ label: "qa", command: "pnpm test" }],
    execFn,
  );
  assert.ok(outcome, "a command ran, so there must be a record");
  assert.equal(outcome.exitCode, -1, "a timeout is 'couldn't determine' → -1");
  assert.ok(
    outcome.outputTail.length <= 8_000,
    `output_tail must stay bounded on the timeout path (was ${outcome.outputTail.length})`,
  );
  assert.match(outcome.outputTail, /command timed out after/, "the timeout marker must survive");
  console.log("✓ runVerificationCommands — output_tail is bounded INCLUDING the timeout marker");
}

async function testRunVerificationCommandsSynthesizedTailsBounded(): Promise<void> {
  // An even run of quotes is non-blank yet tokenizes to nothing → "unrunnable".
  const unrunnable = await runVerificationCommands(
    "/tmp/whatever",
    [{ label: "qa", command: "'".repeat(20_000) }],
    async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
  );
  assert.ok(unrunnable, "a non-blank command must produce a record");
  assert.equal(unrunnable.exitCode, -1);
  assert.ok(unrunnable.outputTail.length <= 8_000, "synthesized tails must be bounded too");

  const spawnFailed = await runVerificationCommands(
    "/tmp/whatever",
    [{ label: "qa", command: "pnpm test" }],
    async () => {
      throw new Error("z".repeat(20_000));
    },
  );
  assert.ok(spawnFailed, "a spawn failure must produce a record");
  assert.ok(spawnFailed.outputTail.length <= 8_000, "spawn-failure tails must be bounded too");
  console.log("✓ runVerificationCommands — synthesized output_tails are bounded");
}

async function main(): Promise<void> {
  testIsProducerRole();
  testParseCommandString();
  await testRunVerificationCommandsAllPass();
  await testRunVerificationCommandsFailFast();
  await testRunVerificationCommandsTimeout();
  await testRunVerificationCommandsSpawnFailure();
  await testRunVerificationCommandsSpawnFailureIsFailFast();
  await testRunVerificationCommandsNothingRan();
  await testRunVerificationCommandsUnrunnableCommand();
  await testRunVerificationCommandsOutputTailBounded();
  await testRunVerificationCommandsOutputTailBoundedOnTimeout();
  await testRunVerificationCommandsSynthesizedTailsBounded();
  console.log("\nAll producer-verification tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
