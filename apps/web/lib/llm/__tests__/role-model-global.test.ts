// The AGENT-WIDE model default (an `agent_project_models` row with a NULL
// `project_id`), and the two rules that make it safe.
//
// Every assertion here is a property, not a shape:
//   • PRECEDENCE — agent+project beats agent-global beats the project layer.
//     Getting this backwards means a per-project pin the operator deliberately
//     made stops applying the moment he sets a workspace-wide default.
//   • COMPATIBILITY — an agent-wide Claude model on a project that resolves to
//     `openai_compatible` is IGNORED, never forwarded. Forwarding it 404s that
//     endpoint mid-run, which is strictly worse than the no-op this whole family
//     of work exists to replace. The rule is `applyRoleModelOverride`'s, reused
//     unchanged — these tests exist to prove the GLOBAL goes through it too, not
//     to re-implement it.
//   • NON-DESTRUCTION — setting a global never invents "the per-project rows are
//     gone"; they are reported as overriding, which is what the UI must state.

import { describe, expect, it } from "vitest";
import {
  applyRoleModelOverride,
  indexRoleModels,
  lookupRoleModel,
  pickRoleModelOverride,
  type RoleModelRow,
} from "@/lib/llm/role-model";
import { describeRoleEffectiveModel, formatEffectiveModel } from "@/lib/llm/claude-model-ladder";
import { buildAgentGlobalTarget, buildAgentModelTargets } from "@/lib/metrics/agent-model-view";

const GLOBAL_OPUS: RoleModelRow = {
  projectId: null,
  roleSlug: "engineer",
  provider: "anthropic",
  model: "opus",
};
const P1_SONNET: RoleModelRow = {
  projectId: "p1",
  roleSlug: "engineer",
  provider: "anthropic",
  model: "sonnet",
};

describe("precedence: agent+project » agent-global » project", () => {
  const index = indexRoleModels([GLOBAL_OPUS, P1_SONNET]);

  it("a per-project row beats the agent-wide default", () => {
    const hit = lookupRoleModel(index, "p1", "engineer");
    expect(hit.scope).toBe("project");
    expect(hit.override?.model).toBe("sonnet");
  });

  it("a project with no row of its own falls back to the agent-wide default", () => {
    const hit = lookupRoleModel(index, "p2", "engineer");
    expect(hit.scope).toBe("global");
    expect(hit.override?.model).toBe("opus");
  });

  it("the agent-wide default beats the PROJECT-level model", () => {
    // The project resolved to haiku through project » tenant » default; the
    // agent-wide default outranks it.
    const { model } = applyRoleModelOverride({
      provider: "anthropic",
      projectModel: "haiku",
      override: lookupRoleModel(index, "p2", "engineer").override,
    });
    expect(model).toBe("opus");
  });

  it("neither rung set ⇒ the project layer answers, byte for byte as before", () => {
    const hit = lookupRoleModel(index, "p2", "qa");
    expect(hit).toEqual({ override: null, scope: "none" });
    const { model, outcome } = applyRoleModelOverride({
      provider: "anthropic",
      projectModel: "haiku",
      override: hit.override,
    });
    expect(model).toBe("haiku");
    expect(outcome.kind).toBe("none");
  });

  it("a ticket-less run (no project) still gets the agent-wide default", () => {
    // "Set it once for this agent" would not be true if it silently excluded
    // headless /v1 calls and supervisor children.
    const hit = lookupRoleModel(index, null, "engineer");
    expect(hit.scope).toBe("global");
    expect(hit.override?.model).toBe("opus");
  });

  it("pickRoleModelOverride — the engine's per-run read — applies the same rule", () => {
    expect(
      pickRoleModelOverride({ projectOverride: P1_SONNET, globalOverride: GLOBAL_OPUS }),
    ).toEqual({ override: P1_SONNET, scope: "project" });
    expect(pickRoleModelOverride({ projectOverride: null, globalOverride: GLOBAL_OPUS })).toEqual({
      override: GLOBAL_OPUS,
      scope: "global",
    });
    expect(pickRoleModelOverride({ projectOverride: null, globalOverride: null })).toEqual({
      override: null,
      scope: "none",
    });
  });
});

describe("compatibility: an agent-wide Claude model is never forwarded to a custom endpoint", () => {
  const index = indexRoleModels([GLOBAL_OPUS]);
  const override = lookupRoleModel(index, "p9", "engineer").override;

  it("is IGNORED on an openai_compatible project — the project's own model runs", () => {
    const { model, outcome } = applyRoleModelOverride({
      provider: "openai_compatible",
      projectModel: "llama3.1:70b",
      override,
    });
    // The value the endpoint would 404 on must not appear.
    expect(model).toBe("llama3.1:70b");
    expect(model).not.toBe("opus");
    expect(outcome.kind).toBe("shadowed");
  });

  it("is never forwarded even when the custom endpoint has no model of its own", () => {
    const { model } = applyRoleModelOverride({
      provider: "openai_compatible",
      projectModel: null,
      override,
    });
    expect(model).toBeNull();
  });

  it("renders as NOT IN EFFECT rather than as the agent's model", () => {
    const effective = describeRoleEffectiveModel({
      provider: "openai_compatible",
      projectModel: "llama3.1:70b",
      override,
    });
    expect(effective.kind).toBe("shadowed");
    // Names what IS running, and flags the inert global.
    expect(formatEffectiveModel(effective)).toContain("opus not in effect");
  });
});

describe("truthfulness: the label reflects the global when no per-project row exists", () => {
  it("a project inheriting the global is labelled with the GLOBAL's model", () => {
    const index = indexRoleModels([GLOBAL_OPUS, P1_SONNET]);
    const label = (projectId: string) =>
      formatEffectiveModel(
        describeRoleEffectiveModel({
          provider: "anthropic",
          projectModel: null,
          override: lookupRoleModel(index, projectId, "engineer").override,
        }),
      );
    expect(label("p2")).toBe("Opus");
    // …and the project that pinned its own model is unaffected by the global.
    expect(label("p1")).toBe("Sonnet");
  });
});

describe("the per-project rows are surfaced, never silently cleared", () => {
  const targets = buildAgentModelTargets(
    ["p1", "p2"],
    [
      {
        projectId: "p1",
        projectName: "cert-radar",
        effective: { kind: "pinned", model: "sonnet", rung: { label: "Sonnet" } },
        currentValue: "sonnet",
        hasOwnRow: true,
      },
      {
        projectId: "p2",
        projectName: "Todo App",
        effective: { kind: "pinned", model: "opus", rung: { label: "Opus" } },
        currentValue: "",
        hasOwnRow: false,
      },
    ],
  );

  it("names exactly the projects that override the agent-wide default", () => {
    const global = buildAgentGlobalTarget("opus", targets);
    expect(global.currentValue).toBe("opus");
    expect(global.overriding).toEqual([{ projectId: "p1", projectName: "cert-radar" }]);
  });

  it("claims no conflict when there is no agent-wide default to override", () => {
    // A per-project row overrides nothing when nothing is pinned agent-wide;
    // saying otherwise would invent a conflict and offer to clear a real choice.
    expect(buildAgentGlobalTarget("", targets).overriding).toEqual([]);
  });
});
