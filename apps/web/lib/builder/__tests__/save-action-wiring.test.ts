// Source-scan guard for the builder Save wiring.
//
// `saveAgentCanvasAction` lives in a `"use server"` file that pulls in
// `next/headers`, so it cannot load under Vitest at all — which is precisely
// the gap the data-loss bug lived in. The preservation LOGIC is unit-tested in
// compile-preserve-role-config.test.ts; this file guards the three lines of
// wiring that feed it, in the same spirit as
// lib/platform-secrets/__tests__/operator-gate-wiring.test.ts.
//
// Without the wiring the compiler's `existingRoleConfig` parameter is simply
// never populated and the bug is fully back, with every unit test still green.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ACTION_PATH = join(process.cwd(), "app/(app)/builder/[agentId]/actions.ts");
const source = readFileSync(ACTION_PATH, "utf8");

/** The update half of saveAgentCanvasAction — after the `new` sentinel block. */
function updatePathSource(): string {
  const start = source.indexOf("export async function saveAgentCanvasAction");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("export type FileTestTicketInput");
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("saveAgentCanvasAction wiring", () => {
  it("reads the stored config before compiling", () => {
    // The tenant-guard read must fetch `config`, not just `id` — otherwise
    // there is nothing to preserve from.
    const body = updatePathSource();
    expect(body).toMatch(/\.select\(\s*"id,\s*config"\s*\)/);
  });

  it("passes the stored role_config into compileCanvas", () => {
    const body = updatePathSource();
    expect(body).toContain("existingRoleConfig");
  });

  it("compiles AFTER the read on the update path, not before", () => {
    // If compile runs first there is no stored config in scope to pass, and
    // the natural "fix" is to drop the parameter again.
    const body = updatePathSource();
    const readIdx = body.indexOf('.select("id, config")');
    const updateCompileIdx = body.indexOf("existingRoleConfig");
    expect(readIdx).toBeGreaterThan(-1);
    expect(updateCompileIdx).toBeGreaterThan(readIdx);
  });

  it("still writes config as a whole object, so preservation is load-bearing", () => {
    // Documents WHY the merge is needed. If this ever stops matching because
    // the write became a real partial merge, revisit the compiler parameter —
    // do not simply delete this assertion.
    const body = updatePathSource();
    expect(body).toMatch(/config:\s*compiled\.config/);
  });
});
