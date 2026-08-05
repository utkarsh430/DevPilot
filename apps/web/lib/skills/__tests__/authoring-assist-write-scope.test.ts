// "The assist writes nothing, and reads nothing."
//
// That is the load-bearing claim of this feature, and it is the one an ordinary
// unit test cannot make: a test that exercises the assist and observes no write
// proves only that THAT path did not write, not that no path can. So this file
// SOURCE-SCANS the assist modules and the action file they live beside, the way
// `authoring-write-scope.test.ts` and `overlay-assist-write-scope.test.ts` do —
// and for the same reason, since `authoring-actions.ts` is `"use server"` and
// cannot load under Vitest at all, which is precisely the gap a bug would live
// in.
//
// It also pins the properties of the assist action that can silently regress:
// the tenant id comes from the SESSION, and the model call goes through the
// tenant-aware adapter rather than a vendor SDK.

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

const ASSIST = "lib/skills/authoring-assist.ts";
const ASSIST_SERVER = "lib/skills/authoring-assist.server.ts";
const ACTIONS = "lib/skills/authoring-actions.ts";
const FORM = "app/(app)/marketplace/skill-form.tsx";

describe("the assist touches no table", () => {
  it.each([ASSIST, ASSIST_SERVER])("%s performs no database access at all", (rel) => {
    const src = code(rel);
    // No Supabase query builder of any kind — not even a read. Stronger than a
    // correctly-scoped read: there is no query here for a tenant filter to be
    // missing from.
    expect(src).not.toMatch(/\.from\s*\(/);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
    expect(src).not.toContain("supabaseService");
    expect(src).not.toContain("supabaseServer");
  });

  it("the assist action reaches no store writer", () => {
    const src = code(ACTIONS);
    const assist = src.slice(
      src.indexOf("export async function draftSkillAction"),
      src.indexOf("export async function deleteSkillAction"),
    );
    expect(assist.length).toBeGreaterThan(0);
    for (const writer of [
      "createOwnedSkill",
      "updateOwnedSkill",
      "deleteOwnedSkill",
      "supabaseService",
    ]) {
      expect(assist).not.toContain(writer);
    }
  });

  it("the action file still routes every write through the owned-skill store", () => {
    const src = code(ACTIONS);
    // Unchanged from before this feature: the actions never build a query
    // themselves, and no path writes a PUBLIC (tenant_id null) row.
    expect(src).not.toMatch(/\.from\s*\(/);
    expect(src).not.toMatch(/tenant_id\s*:\s*null/);
  });
});

describe("the assist action's inputs", () => {
  const src = code(ACTIONS);

  it("derives the tenant from the session, never from the caller", () => {
    expect(src).toMatch(/export async function draftSkillAction/);
    const assist = src.slice(
      src.indexOf("const DraftAssistInput"),
      src.indexOf("export async function deleteSkillAction"),
    );
    expect(assist).toContain("await requireTenantId()");
    expect(assist).toContain("await requireUser()");

    // The input schema names exactly the two client-supplied fields; a tenantId
    // among them would be the bug.
    const schema = assist.slice(0, assist.indexOf("export async function draftSkillAction"));
    expect(schema).toContain("request");
    expect(schema).toContain("currentBody");
    expect(schema).not.toContain("tenantId");
    expect(schema).not.toContain("targets");
  });

  it("passes the session tenant to the model adapter", () => {
    expect(src).toMatch(/defaultSkillAssistDeps\(\s*tenantId\s*\)/);
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

describe("suggested roles are never applied without the operator", () => {
  const src = code(FORM);

  it("the draft is held in state and only a deliberate press fills the form", () => {
    // `useDraft` is the ONLY thing that moves a suggestion into the form fields,
    // and it is wired to a button rather than to the response handler.
    expect(src).toMatch(/function useDraft\(\)/);
    expect(src).toMatch(/onClick=\{useDraft\}/);

    // The response handler stores the proposal and nothing else — in particular
    // it never calls a setter for a form field.
    const handler = src.slice(
      src.indexOf("function onDraft()"),
      src.indexOf("function useDraft()"),
    );
    for (const setter of [
      "setTargets(",
      "setBody(",
      "setName(",
      "setSummary(",
      "setTriggersText(",
    ]) {
      expect(handler).not.toContain(setter);
    }
  });

  it("no save happens as part of drafting", () => {
    const handler = src.slice(
      src.indexOf("function onDraft()"),
      src.indexOf("function useDraft()"),
    );
    expect(handler).not.toContain("createSkillAction");
    expect(handler).not.toContain("updateSkillAction");
    // …and using the draft only fills the form; it does not submit it either.
    const use = src.slice(src.indexOf("function useDraft()"), src.indexOf("function submit()"));
    expect(use.length).toBeGreaterThan(0);
    expect(use).not.toContain("submit()");
    expect(use).not.toContain("createSkillAction");
    expect(use).not.toContain("updateSkillAction");
  });

  it("assist-chosen roles are attributed in the picker until he touches them", () => {
    expect(src).toContain("setAssistTargets");
    // Toggling any role clears that role's attribution — he has reviewed it.
    const toggle = src.slice(src.indexOf("function toggleTarget"), src.indexOf("function onDraft"));
    expect(toggle).toContain("setAssistTargets");
  });
});
