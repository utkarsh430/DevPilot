// The per-agent × per-project model rung: precedence and the COMPATIBILITY RULE.
//
// These two properties are the whole feature. `role_config.modelTier` shipped as
// a per-agent control that silently did nothing on the local-cc path — every
// normal ticket run — so the precedence test is "does a set value actually
// win?", and the compatibility test is "does an INCOMPATIBLE value get ignored
// rather than forwarded?". Forwarding is not a smaller bug than the no-op: an
// `openai_compatible` endpoint handed `opus` 404s mid-run and costs a ticket,
// where the no-op cost nothing.

import { describe, expect, it } from "vitest";
import { applyRoleModelOverride, indexRoleModels, roleModelKey } from "@/lib/llm/role-model";
import {
  describeEffectiveModel,
  describeRoleEffectiveModel,
  formatEffectiveModel,
} from "@/lib/llm/claude-model-ladder";

describe("applyRoleModelOverride — precedence", () => {
  it("agent+project beats project", () => {
    const { model, outcome } = applyRoleModelOverride({
      provider: "anthropic",
      projectModel: "sonnet",
      override: { roleSlug: "engineer", provider: "anthropic", model: "opus" },
    });
    expect(model).toBe("opus");
    expect(outcome).toEqual({ kind: "applied", model: "opus" });
  });

  it("falls through to the project model when there is no override", () => {
    const { model, outcome } = applyRoleModelOverride({
      provider: "anthropic",
      projectModel: "sonnet",
      override: null,
    });
    expect(model).toBe("sonnet");
    expect(outcome.kind).toBe("none");
  });

  it("preserves today's exact behaviour when nothing is configured anywhere", () => {
    // The default-OFF path every existing project takes: null model in, null
    // model out, so no `--model` flag is ever emitted.
    const { model, outcome } = applyRoleModelOverride({
      provider: "anthropic",
      projectModel: null,
      override: null,
    });
    expect(model).toBeNull();
    expect(outcome.kind).toBe("none");
  });

  it("an override wins even when the project pinned nothing", () => {
    const { model } = applyRoleModelOverride({
      provider: "anthropic",
      projectModel: null,
      override: { roleSlug: "qa", provider: "anthropic", model: "haiku" },
    });
    expect(model).toBe("haiku");
  });
});

describe("applyRoleModelOverride — the compatibility rule", () => {
  it("IGNORES a Claude model on an openai_compatible project and NEVER forwards it", () => {
    const { model, outcome } = applyRoleModelOverride({
      provider: "openai_compatible",
      projectModel: "llama3.1:70b",
      override: { roleSlug: "engineer", provider: "anthropic", model: "opus" },
    });
    // The project's OWN model runs. The Claude value must not appear at all —
    // this is what stops it reaching `resolveApiModelId`, which for
    // openai_compatible returns any non-empty string with NO allowlist check.
    expect(model).toBe("llama3.1:70b");
    expect(model).not.toBe("opus");
    expect(outcome).toEqual({
      kind: "shadowed",
      stored: "opus",
      storedProvider: "anthropic",
      provider: "openai_compatible",
    });
  });

  it("shadows in the other direction too — an openai model on an Anthropic project", () => {
    const { model, outcome } = applyRoleModelOverride({
      provider: "anthropic",
      projectModel: "sonnet",
      override: { roleSlug: "engineer", provider: "openai_compatible", model: "llama3.1:70b" },
    });
    expect(model).toBe("sonnet");
    expect(outcome.kind).toBe("shadowed");
  });

  it("never changes the model when shadowing, even with no project model", () => {
    // The dangerous variant: if the rule leaked, this would hand `opus` to an
    // endpoint that has no Claude at all.
    const { model } = applyRoleModelOverride({
      provider: "openai_compatible",
      projectModel: null,
      override: { roleSlug: "engineer", provider: "anthropic", model: "opus" },
    });
    expect(model).toBeNull();
  });
});

describe("indexRoleModels", () => {
  it("keys on (project, role) so two roles on one project do not collide", () => {
    const idx = indexRoleModels([
      { projectId: "p1", roleSlug: "engineer", provider: "anthropic", model: "opus" },
      { projectId: "p1", roleSlug: "qa", provider: "anthropic", model: "haiku" },
      { projectId: "p2", roleSlug: "engineer", provider: "anthropic", model: "sonnet" },
    ]);
    expect(idx.byProject.get(roleModelKey("p1", "engineer"))?.model).toBe("opus");
    expect(idx.byProject.get(roleModelKey("p1", "qa"))?.model).toBe("haiku");
    expect(idx.byProject.get(roleModelKey("p2", "engineer"))?.model).toBe("sonnet");
    expect(idx.byProject.get(roleModelKey("p2", "qa"))).toBeUndefined();
  });

  it("routes a NULL-project row to the agent-wide partition, not the project one", () => {
    const idx = indexRoleModels([
      { projectId: null, roleSlug: "engineer", provider: "anthropic", model: "opus" },
      { projectId: "p1", roleSlug: "engineer", provider: "anthropic", model: "sonnet" },
    ]);
    expect(idx.byRole.get("engineer")?.model).toBe("opus");
    expect(idx.byProject.get(roleModelKey("p1", "engineer"))?.model).toBe("sonnet");
    // The agent-wide row must not leak into the project namespace under any key.
    expect([...idx.byProject.values()].map((r) => r.model)).toEqual(["sonnet"]);
  });
});

describe("describeEffectiveModel — the shadowed variant", () => {
  it("reports a shadowed override, and names what is ACTUALLY running", () => {
    const effective = describeRoleEffectiveModel({
      provider: "openai_compatible",
      projectModel: "llama3.1:70b",
      override: { roleSlug: "engineer", provider: "anthropic", model: "opus" },
    });
    expect(effective.kind).toBe("shadowed");
    if (effective.kind !== "shadowed") throw new Error("unreachable");
    expect(effective.stored).toBe("opus");
    expect(effective.storedProvider).toBe("anthropic");
    expect(effective.provider).toBe("openai_compatible");
    // The running model is the project's, described by the SAME four-outcome
    // function — not re-derived.
    expect(effective.running).toEqual(describeEffectiveModel("openai_compatible", "llama3.1:70b"));
  });

  it("says out loud that the stored value is not in effect", () => {
    // The label is the anti-no-op guarantee: a UI rendering this cannot assert a
    // model that never takes effect.
    const label = formatEffectiveModel(
      describeRoleEffectiveModel({
        provider: "openai_compatible",
        projectModel: "llama3.1:70b",
        override: { roleSlug: "engineer", provider: "anthropic", model: "opus" },
      }),
    );
    expect(label).toContain("not in effect");
    expect(label).toContain("opus");
  });

  it("an APPLIED override renders as a plain pinned model, not as shadowed", () => {
    const effective = describeRoleEffectiveModel({
      provider: "anthropic",
      projectModel: "sonnet",
      override: { roleSlug: "engineer", provider: "anthropic", model: "opus" },
    });
    expect(effective.kind).toBe("pinned");
    expect(formatEffectiveModel(effective)).toBe("Opus");
    expect(formatEffectiveModel(effective)).not.toContain("not in effect");
  });

  it("no override at all is byte-for-byte the pre-existing four-outcome answer", () => {
    for (const model of [null, "sonnet", "not-a-real-model"]) {
      expect(
        describeRoleEffectiveModel({ provider: "anthropic", projectModel: model, override: null }),
      ).toEqual(describeEffectiveModel("anthropic", model));
    }
  });
});
