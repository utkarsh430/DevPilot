// Structural proof that the platform-secrets WRITE ACTIONS actually enforce the
// gate.
//
// WHY A SOURCE SCAN. `operator-gate.test.ts` proves the decision refuses a
// non-operator; it cannot prove the actions ask. And the actions cannot be
// imported here at all — `secret-actions.ts` is `"use server"` and pulls in
// `@/lib/auth` → `next/headers`, which does not load under Vitest. That gap is
// exactly where the original bug lived: the tenant path simply never performed
// a role check, and no test noticed because no test could reach it.
//
// So this asserts, over the real source text, that every write action in that
// file calls the gate BEFORE it calls the store. It is a coarse instrument, but
// it fails on the change that matters: someone adding a third write path, or
// deleting the check from an existing one.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ACTIONS = path.join(
  webRoot,
  "app",
  "(app)",
  "settings",
  "platform-secrets",
  "secret-actions.ts",
);

const source = readFileSync(ACTIONS, "utf8");

/** Body of one exported action, from its signature to the next top-level
 *  `export`/`function` at column 0. */
function actionBody(name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found in secret-actions.ts`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const next = rest.search(/\nexport (async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Every action in this file that performs a WRITE, and which gate each one is
 *  required to pass. The instance-scope pair predates this PR and gates on
 *  `isInstanceOperator` directly, which is the same role requirement — so an
 *  operatorOnly key is covered there by construction. */
const TENANT_WRITE_ACTIONS = ["setPlatformSecretAction", "deletePlatformSecretAction"];
const INSTANCE_WRITE_ACTIONS = ["setInstanceSecretAction", "deleteInstanceSecretAction"];

describe("secret-actions enforce the operatorOnly gate", () => {
  it.each(TENANT_WRITE_ACTIONS)("%s calls the gate", (name) => {
    expect(actionBody(name)).toContain("assertOperatorAllowed");
  });

  it.each(TENANT_WRITE_ACTIONS)("%s gates BEFORE it writes", (name) => {
    const body = actionBody(name);
    const gate = body.indexOf("assertOperatorAllowed");
    // The store call this action performs.
    const write = Math.max(
      body.indexOf("await setPlatformSecret("),
      body.indexOf("await deletePlatformSecret("),
    );
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThanOrEqual(0);
    expect(gate, `${name} must check the gate before writing`).toBeLessThan(write);
  });

  it.each(TENANT_WRITE_ACTIONS)("%s returns on refusal rather than continuing", (name) => {
    // The refusal must short-circuit. A computed-but-ignored message is the
    // shape of a gate that looks present in review and enforces nothing.
    expect(actionBody(name)).toMatch(/if \(opErr\) return \{ ok: false/);
  });

  it.each(INSTANCE_WRITE_ACTIONS)("%s still gates on isInstanceOperator", (name) => {
    expect(actionBody(name)).toContain("isInstanceOperator");
  });

  it("the gate is the shared lib function, not a local re-implementation", () => {
    expect(source).toContain('from "@/lib/platform-secrets/operator-gate"');
    expect(source).toContain("operatorOnlyRefusal");
  });

  it("finds exactly the write actions it claims to cover", () => {
    // Non-vacuity: if a new write action appears, this list is stale and the
    // suite above is no longer covering the file.
    const found = [...source.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
    const writers = found.filter(
      (n): n is string => typeof n === "string" && /^(set|delete)/.test(n),
    );
    expect(writers.sort()).toEqual([...TENANT_WRITE_ACTIONS, ...INSTANCE_WRITE_ACTIONS].sort());
  });
});
