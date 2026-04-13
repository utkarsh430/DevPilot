// "Nothing but the overlay is ever written."
//
// That is the load-bearing claim of the whole prompt-editing feature, and it is
// the one an ordinary unit test cannot make: a test that exercises the assist and
// observes no write proves only that THIS path did not write, not that no path
// can. So this file SOURCE-SCANS the three assist modules and the action file
// they live beside, the way `operator-gate-wiring.test.ts` and
// `scaffolder-single-creator.test.ts` do — and for the same reason, since
// `overlay-actions.ts` is `"use server"` and cannot load under Vitest at all,
// which is precisely the gap a bug would live in.
//
// It also pins the two properties of the action that can silently regress: the
// tenant id comes from the SESSION, and the base prompt is read SERVER-SIDE.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB_ROOT = join(__dirname, "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(WEB_ROOT, rel), "utf8");
}

/** Strip comments so a table name inside prose is not read as a query. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const ASSIST = "lib/roles/overlay-assist.ts";
const ASSIST_SERVER = "lib/roles/overlay-assist.server.ts";
const ACTIONS = "lib/roles/overlay-actions.ts";
const STORE = "lib/roles/overlay-store.ts";

describe("the assist writes nothing", () => {
  it.each([ASSIST, ASSIST_SERVER])("%s touches no table at all", (rel) => {
    const src = code(rel);
    // No Supabase query builder of any kind — not even a read.
    expect(src).not.toMatch(/\.from\s*\(/);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
    expect(src).not.toContain("supabaseService");
  });

  it("the action file's only writes go through the overlay store", () => {
    const src = code(ACTIONS);
    expect(src).not.toMatch(/\.from\s*\(/);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
    // The two store functions are the whole write surface, and both target
    // `agent_prompt_overlays` (asserted below, against the store itself).
    const writers = src.match(/\b(upsertRoleOverlay|clearRoleOverlay)\b/g) ?? [];
    expect(writers.length).toBeGreaterThan(0);
  });

  it("the store writes to `agent_prompt_overlays` and nothing else", () => {
    const src = code(STORE);
    const tables = [...src.matchAll(/\.from\s*\(\s*([A-Za-z_][\w]*|"[^"]+")\s*\)/g)].map(
      (m) => m[1],
    );
    expect(tables.length).toBeGreaterThan(0);
    // The module addresses its table through one constant.
    expect(new Set(tables)).toEqual(new Set(["TABLE"]));
    expect(src).toMatch(/const TABLE = "agent_prompt_overlays"/);
  });

  // A base prompt cannot be written because there is nowhere to write it. Stated
  // against the migration rather than the code, since that is what makes it
  // structural: no column, no write path, no drift problem, and "Clear" is a
  // complete reset forever.
  it("the overlay table has no column that could hold a base prompt", () => {
    const migration = readFileSync(
      join(
        WEB_ROOT,
        "..",
        "..",
        "supabase",
        "migrations",
        "20260743000000_agent_prompt_overlays.sql",
      ),
      "utf8",
    );
    for (const forbidden of ["base_prompt", "base_hash", "system_prompt", "role_prompt"]) {
      expect(migration).not.toContain(forbidden);
    }
  });
});

describe("the assist action's inputs", () => {
  const src = code(ACTIONS);

  it("derives the tenant from the session, never from the caller", () => {
    expect(src).toMatch(/export async function improveAgentOverlayAction/);
    expect(src).toContain("await requireTenantId()");
    expect(src).toContain("await requireUser()");
    // The input schema names exactly three client-supplied fields; a tenantId or
    // a basePrompt among them would be the bug.
    const schema = src.slice(
      src.indexOf("const ImproveInput"),
      src.indexOf("export async function improveAgentOverlayAction"),
    );
    expect(schema).toContain("roleSlug");
    expect(schema).toContain("request");
    expect(schema).toContain("currentOverlay");
    expect(schema).not.toContain("tenantId");
    expect(schema).not.toContain("basePrompt");
  });

  it("reads the base prompt server-side, tenant-scoped", () => {
    expect(src).toMatch(/loadRoleConfig\(\s*tenantId\s*,/);
    expect(src).toMatch(/defaultAssistDeps\(\s*tenantId\s*\)/);
  });

  it("routes the model call through `generateObjectForTenant`, never a vendor SDK", () => {
    const server = code(ASSIST_SERVER);
    expect(server).toContain("generateObjectForTenant");
    // A direct `generateObject` call crashes in `claude_code` auth mode, which is
    // the default; a vendor SDK breaks the adapter boundary outright.
    expect(server).not.toMatch(/from "ai"/);
    expect(server).not.toMatch(/@ai-sdk\//);
    expect(server).not.toMatch(/@anthropic-ai\//);
  });
});
