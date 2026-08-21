// Structural guarantees about the skill-authoring write path.
//
// These are SOURCE SCANS, not runtime tests, and that is deliberate: they
// assert properties a runtime test cannot reach.
//
//   • `lib/skills/authoring-actions.ts` is a `"use server"` file, so it cannot
//     load under Vitest at all — a runtime test of the actions is not
//     available, and the write-scope gap in `overlay-assist` lived in exactly
//     that blind spot;
//   • "no path writes a public row" is a claim about EVERY path, and a runtime
//     test can only ever show that the paths it happens to call did not.
//
// Two things are checked, and both are the kind that get broken by a
// well-intentioned later edit rather than by malice.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const STORE = read("lib/skills/authoring-store.ts");
const ACTIONS = read("lib/skills/authoring-actions.ts");

/** Strip comments so prose about a rule is never mistaken for the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("no path can write a PUBLIC (tenant_id null) skill", () => {
  it("the store never writes a null / undefined tenant_id", () => {
    const src = code(STORE);
    expect(src).not.toMatch(/tenant_id\s*:\s*null/);
    expect(src).not.toMatch(/tenant_id\s*:\s*undefined/);
  });

  it("the store's only tenant_id write is the caller-supplied one", () => {
    // Every `tenant_id:` in an insert payload must be `args.tenantId` — the
    // value the action derives from the session. A literal, a field off the
    // draft, or anything else would be a way to nominate whose row this is.
    const src = code(STORE);
    const writes = [...src.matchAll(/tenant_id\s*:\s*([^,\n}]+)/g)].map((m) => (m[1] ?? "").trim());
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w).toBe("args.tenantId");
  });

  it("the actions never accept a tenant id from the caller", () => {
    // The Zod input schema is the whole browser-facing contract. If it grew a
    // `tenantId` field, a forged POST could write into another workspace
    // regardless of how carefully the store behaves.
    const src = code(ACTIONS);
    expect(src).not.toMatch(/tenantId\s*:\s*z\./);
    expect(src).not.toMatch(/tenant_id\s*:\s*z\./);
  });

  it("every action derives the tenant from the session", () => {
    const src = code(ACTIONS);
    const actions = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    expect(actions).toEqual(
      expect.arrayContaining(["createSkillAction", "updateSkillAction", "deleteSkillAction"]),
    );
    // One `requireTenantId()` per exported action, and a `requireUser()` in
    // front of it. A new action added without them fails this count.
    const tenantCalls = [...src.matchAll(/requireTenantId\(\)/g)].length;
    expect(tenantCalls).toBe(actions.length);
    const userCalls = [...src.matchAll(/requireUser\(\)/g)].length;
    expect(userCalls).toBe(actions.length);
  });
});

describe("every write is tenant-scoped in SQL", () => {
  it('each .update() and .delete() chain carries .eq("tenant_id", …)', () => {
    // This is the third guard on the update path — the one that holds even if
    // the row changed hands between the load and the write, and the one no
    // single-neuter runtime control can isolate while the in-app row check
    // stands in front of it.
    const src = code(STORE);
    const chains = [...src.matchAll(/\.(update|delete)\(([\s\S]*?)\.select\(/g)];
    expect(chains.length).toBeGreaterThanOrEqual(2);
    for (const [chain] of chains) {
      expect(chain).toContain('.eq("tenant_id"');
    }
  });

  it("each read is scoped by tenant_id, or explicitly by tenant_id IS NULL", () => {
    // `findPublicNameClash` is the one deliberate exception: it reads the
    // PUBLIC catalogue, which is cross-tenant by definition and carries no
    // private data. It must still be pinned to null rather than unfiltered.
    const src = code(STORE);
    const selects = [
      ...src.matchAll(/\.from\(TABLE\)\s*\.select\(([\s\S]*?)(?:maybeSingle|order|single|;)/g),
    ];
    expect(selects.length).toBeGreaterThanOrEqual(3);
    for (const [chain] of selects) {
      const scoped = chain.includes('.eq("tenant_id"') || chain.includes('.is("tenant_id", null)');
      expect(scoped, chain.slice(0, 120)).toBe(true);
    }
  });
});

describe("no agent-facing surface", () => {
  it("authoring is reachable only from a human session", () => {
    // Authoring a skill is a human action: there is no MCP tool, nothing in
    // `DEVPILOT_BOARD_TOOLS`, and no runner-key path here. A runner-auth import
    // appearing in either file would mean one had been added.
    for (const src of [code(STORE), code(ACTIONS)]) {
      expect(src).not.toMatch(/checkRunnerAuth|runners\/auth|DEVPILOT_KEY/);
    }
  });
});
