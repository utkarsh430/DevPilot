// `--model` plumb-through: default-OFF, plus the plan-availability safe fallback.
//
// Run: tsx src/model-args.test.ts

import assert from "node:assert/strict";
import { isModelUnavailableError, modelArgs } from "./model-args.js";

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

console.log("model-args — --model plumb-through");

test("DEFAULT-OFF: no model → no flag at all (today's exact argv)", () => {
  assert.deepEqual(modelArgs(null), []);
  assert.deepEqual(modelArgs(undefined), []);
  assert.deepEqual(modelArgs(""), []);
  assert.deepEqual(modelArgs("   "), []);
});

test("an explicit model produces exactly one --model pair", () => {
  assert.deepEqual(modelArgs("sonnet"), ["--model", "sonnet"]);
  assert.deepEqual(modelArgs("claude-opus-4-7"), ["--model", "claude-opus-4-7"]);
});

test("an implausible model value is DROPPED, not passed into argv", () => {
  // The value arrives in the Redis job payload, so it's only as trustworthy as
  // write access to the queue. Dropping it runs on the account default — the same
  // safe fallback as everywhere else on this path.
  for (const bad of [
    "--verbose",
    "-p",
    "sonnet extra",
    "sonnet\nopus",
    "$(whoami)",
    "a".repeat(200),
  ]) {
    assert.deepEqual(modelArgs(bad), [], `should drop: ${JSON.stringify(bad)}`);
  }
});

console.log("model-args — safe fallback detection");

test("recognises plan/model availability failures", () => {
  for (const msg of [
    "Model not available on your plan",
    "The model claude-opus-4-7 is unavailable",
    "Unknown model: gpt-9",
    "Invalid model specified",
    "Your account does not have access to the model claude-opus-4-7",
    "Upgrade your plan to use Opus",
  ]) {
    assert.ok(isModelUnavailableError(msg), `should match: ${msg}`);
  }
});

test("does NOT swallow unrelated failures into a retry", () => {
  // A false positive here costs a wasted retry; treating EVERY error as a model
  // problem would double the cost of every genuinely broken run.
  for (const msg of [
    "claude exited with code 1",
    "ENOENT: no such file or directory",
    "Credit balance is too low",
    "network timeout after 30s",
    "",
  ]) {
    assert.equal(isModelUnavailableError(msg), false, `should not match: ${msg}`);
  }
});

test("ignores a huge blob that merely contains the word 'model'", () => {
  const haystack = "model ".repeat(500) + "not available";
  assert.equal(isModelUnavailableError(haystack), false);
});

if (failures > 0) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
