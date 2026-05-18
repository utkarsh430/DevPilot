// Agent prompt inspector — the properties that make the page safe to believe.
//
// Two groups:
//
//  1. TRUTHFULNESS. The page's whole value is that the operator can trust it.
//     The tests below pin that the composed prompt is byte-identical to what
//     `composeRoleSystemPrompt` produces for a ticket-bound dispatch, and that
//     no skill body is ever spliced into it (the one over-claim available here,
//     since skill selection is ticket-dependent and this page has no ticket).
//
//  2. TENANT SCOPE. `loadAgentRowForRole` is the one NEW read this feature
//     adds and it runs on the SERVICE client, so its co-located
//     `.eq("tenant_id", …)` is the entire boundary. The fake below ACTUALLY
//     APPLIES `.eq`; the control at the bottom neuters it and asserts the
//     foreign row IS returned there, so deleting the predicate from
//     `prompt-inspection.ts` turns the earlier test red instead of leaving it
//     vacuously green.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoleConfig } from "@/lib/roles/index";
import type { SelectedSkill } from "@/lib/skills/select";
import { composeRoleSystemPrompt } from "@/lib/roles/compose-prompt";
import {
  REVIEWER_AWARENESS_FENCE_HEADER,
  REVIEWER_AWARENESS_NOTE,
} from "@/lib/roles/reviewer-awareness";
import { SKILL_FENCE_HEADER } from "@/lib/skills/merge";
import { LEARNINGS_CHAR_BUDGET, MAX_LEARNINGS, type LearningEntry } from "@/lib/learning/select";
import {
  LESSON_CAPS,
  LESSON_DISCLOSURE,
  SKILL_DISCLOSURE,
  composeInspectedPrompt,
  describeLessonScope,
  describePromptLayers,
  loadAgentRowForRole,
  reviewerAwarenessApplies,
  toEligibleLessons,
  toEligibleSkills,
} from "@/lib/roles/prompt-inspection";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

function roleConfig(over: Partial<RoleConfig> = {}): RoleConfig {
  return {
    role: "engineer" as RoleConfig["role"],
    displayName: "Engineer",
    systemPrompt: "You are an engineer. Do the work.",
    modelTier: "default",
    runnerPolicy: "local-cc",
    onSuccessStatus: "in_review",
    ...over,
  };
}

function skill(over: Partial<SelectedSkill> = {}): SelectedSkill {
  return {
    id: "sk-1",
    name: "House style",
    version: "1.0.0",
    body: "SECRET_SKILL_BODY — never render me inside the prompt.",
    score: 3,
    ...over,
  };
}

describe("composed prompt matches dispatch", () => {
  it("is byte-identical to the dispatch seam for a ticket-bound run", () => {
    const config = roleConfig();
    // This is the exact expression `dispatcher.ts` evaluates (merge-skills step)
    // once skill selection has returned. With no skills selected — the state the
    // inspector renders — the two must not merely look alike.
    expect(composeInspectedPrompt(config, null)).toBe(
      composeRoleSystemPrompt(config, [], true, null),
    );
  });

  it("appends the reviewer-awareness note for an in_review role", () => {
    const composed = composeInspectedPrompt(roleConfig({ onSuccessStatus: "in_review" }), null);
    expect(composed).toContain(REVIEWER_AWARENESS_FENCE_HEADER);
    expect(composed).toContain(REVIEWER_AWARENESS_NOTE);
  });

  it("omits it for a role that self-drives to done (qa/verifier shape)", () => {
    const composed = composeInspectedPrompt(roleConfig({ onSuccessStatus: "done" }), null);
    expect(composed).not.toContain(REVIEWER_AWARENESS_FENCE_HEADER);
    expect(composed).toBe("You are an engineer. Do the work.");
    expect(reviewerAwarenessApplies(roleConfig({ onSuccessStatus: "done" }))).toBe(false);
  });

  it("never splices a skill body or the skill fence into the displayed prompt", () => {
    // The over-claim this page must not make: skill selection is ticket-driven,
    // so any specific skill shown as part of "the prompt" is a claim about a run
    // that has not happened.
    const composed = composeInspectedPrompt(roleConfig(), null);
    expect(composed).not.toContain(SKILL_FENCE_HEADER);
    expect(composed).not.toContain("SECRET_SKILL_BODY");
  });

  it("carries name and version out of a selected skill, never the body", () => {
    const eligible = toEligibleSkills([skill()]);
    expect(eligible).toEqual([{ id: "sk-1", name: "House style", version: "1.0.0" }]);
    expect(JSON.stringify(eligible)).not.toContain("SECRET_SKILL_BODY");
  });

  it("says out loud that skill selection is per-ticket", () => {
    // That sentence is the only reason showing an eligibility list is honest.
    expect(SKILL_DISCLOSURE).toMatch(/per ticket|varies per ticket/i);
  });
});

describe("lessons are surfaced as a distinct, non-fixed layer", () => {
  function entry(over: Partial<LearningEntry> = {}): LearningEntry {
    return {
      id: "l-1",
      scope: "global",
      roleSlug: null,
      category: "process",
      body: "Check the staging URL loads before reporting success.",
      status: "active",
      createdAt: "2026-07-01T00:00:00Z",
      ...over,
    };
  }

  it("carries the body through — a named-but-hidden lesson answers nothing", () => {
    const [mapped] = toEligibleLessons([entry()]);
    expect(mapped?.body).toBe("Check the staging URL loads before reporting success.");
    expect(mapped?.scope).toBe("global");
  });

  it("states that lessons are a different channel from the system prompt", () => {
    // The page must not let the operator read a lesson as part of the prompt:
    // it lands in the per-ticket brief, fenced, and the role prompt outranks it.
    expect(LESSON_DISCLOSURE).toMatch(/ticket/i);
    expect(LESSON_DISCLOSURE).toMatch(/fenced|recalled/i);
    expect(LESSON_DISCLOSURE).toMatch(/role prompt always wins/i);
  });

  it("states that the per-run set is selected and capped, not fixed", () => {
    // Without this the eligibility list reads as "what every run sees".
    expect(LESSON_DISCLOSURE).toMatch(/capped/i);
    expect(LESSON_DISCLOSURE).toContain(String(LESSON_CAPS.maxPerRun));
    expect(LESSON_DISCLOSURE).toMatch(/not all of them/i);
  });

  it("reports the real engine caps, not hand-typed numbers", () => {
    expect(LESSON_CAPS.maxPerRun).toBe(MAX_LEARNINGS);
    expect(LESSON_CAPS.charBudget).toBe(LEARNINGS_CHAR_BUDGET);
  });

  it("labels each scope in the operator's language, naming role-bound ones", () => {
    expect(describeLessonScope(toEligibleLessons([entry({ scope: "global" })])[0]!)).toBe(
      "all agents",
    );
    expect(describeLessonScope(toEligibleLessons([entry({ scope: "user" })])[0]!)).toBe(
      "your preference",
    );
    expect(
      describeLessonScope(toEligibleLessons([entry({ scope: "role", roleSlug: "engineer" })])[0]!),
    ).toBe("this role");
  });
});

describe("layer breakdown", () => {
  it("describes one layer for a role with no reviewer note", () => {
    const layers = describePromptLayers(roleConfig({ onSuccessStatus: "done" }), "builtin", null);
    expect(layers.map((l) => l.kind)).toEqual(["base"]);
  });

  it("describes both layers, in composition order, for a reviewed role", () => {
    const layers = describePromptLayers(roleConfig(), "builtin", null);
    expect(layers.map((l) => l.kind)).toEqual(["base", "reviewer_awareness"]);
  });

  it("reports the base layer's real character count", () => {
    const config = roleConfig({ systemPrompt: "x".repeat(8192) });
    const layers = describePromptLayers(config, "custom", null);
    expect(layers[0]?.chars).toBe(8192);
  });

  it("names where a built-in base lives versus a custom one", () => {
    expect(describePromptLayers(roleConfig(), "builtin", null)[0]?.origin).toMatch(/code/i);
    expect(describePromptLayers(roleConfig(), "custom", null)[0]?.origin).toMatch(
      /agents\.config/i,
    );
  });
});

// ── Tenant scope ───────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** PostgREST-ish fake that ACTUALLY applies `.eq`. `honourEq` exists only for
 *  the non-vacuity control at the bottom. */
function fakeClient(rows: Row[], opts: { honourEq?: boolean } = {}) {
  const honourEq = opts.honourEq ?? true;
  const seen: string[] = [];

  function builder() {
    const filters: Array<(r: Row) => boolean> = [];
    const self: Record<string, unknown> = {};
    self.select = () => self;
    self.order = () => self;
    self.limit = () => self;
    self.eq = (c: string, v: unknown) => {
      seen.push(c);
      if (honourEq) filters.push((r) => r[c] === v);
      return self;
    };
    self.maybeSingle = () =>
      Promise.resolve({
        data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null,
        error: null,
      });
    return self;
  }

  return { client: { from: () => builder() } as unknown as SupabaseClient, seen };
}

const OURS: Row = {
  name: "Our Engineer",
  role: "engineer",
  tenant_id: T1,
  config: { source: "builtin" },
};
const THEIRS: Row = {
  name: "Their Engineer",
  role: "engineer",
  tenant_id: T2,
  config: { source: "jd-synth" },
};

describe("loadAgentRowForRole is tenant-scoped", () => {
  it("returns our own row", async () => {
    const { client } = fakeClient([OURS, THEIRS]);
    await expect(loadAgentRowForRole(client, T1, "engineer")).resolves.toEqual({
      name: "Our Engineer",
      source: "builtin",
    });
  });

  it("never returns a foreign tenant's row for the same slug", async () => {
    // THEIRS sorts first, so a missing tenant predicate would hand this page
    // another workspace's agent name and source badge.
    const { client } = fakeClient([THEIRS, OURS]);
    await expect(loadAgentRowForRole(client, T1, "engineer")).resolves.toEqual({
      name: "Our Engineer",
      source: "builtin",
    });
  });

  it("returns null when this tenant has no row for the slug", async () => {
    const { client } = fakeClient([THEIRS]);
    await expect(loadAgentRowForRole(client, T1, "engineer")).resolves.toBeNull();
  });

  it("filters on tenant_id AND role", async () => {
    const { client, seen } = fakeClient([OURS]);
    await loadAgentRowForRole(client, T1, "engineer");
    expect(seen).toContain("tenant_id");
    expect(seen).toContain("role");
  });

  it("CONTROL: without the tenant predicate the foreign row IS returned", async () => {
    // Non-vacuity. If this ever fails, the fake stopped modelling the real
    // client and every assertion above is meaningless.
    const { client } = fakeClient([THEIRS, OURS], { honourEq: false });
    await expect(loadAgentRowForRole(client, T1, "engineer")).resolves.toEqual({
      name: "Their Engineer",
      source: "jd-synth",
    });
  });
});
