// The three properties the per-agent model picker must not lose. Each of these
// maps to a way the OLD UI lied: a control that targeted the wrong project, a
// control offered on a project that cannot serve Claude, and a stored model
// rendered as if it were live when it was a no-op.

import { describe, expect, it } from "vitest";
import {
  buildAgentModelTargets,
  summarizeAgentModel,
  viewEffectiveModel,
  type ProjectModelFacts,
} from "@/lib/metrics/agent-model-view";

function fact(over: Partial<ProjectModelFacts> & { projectId: string }): ProjectModelFacts {
  return {
    projectName: `Project ${over.projectId}`,
    effective: { kind: "account_default" },
    currentValue: "",
    hasOwnRow: false,
    ...over,
  };
}

describe("buildAgentModelTargets — a role expands to exactly its own projects", () => {
  const facts = [fact({ projectId: "p1" }), fact({ projectId: "p2" }), fact({ projectId: "p3" })];

  it("expands a mixed-project role to exactly its projectIds, in order", () => {
    const targets = buildAgentModelTargets(["p1", "p3"], facts);
    expect(targets.map((t) => t.projectId)).toEqual(["p1", "p3"]);
  });

  it("never widens to a project the role did not work in", () => {
    const targets = buildAgentModelTargets(["p2"], facts);
    expect(targets.map((t) => t.projectId)).toEqual(["p2"]);
    expect(targets.some((t) => t.projectId === "p1")).toBe(false);
  });

  it("drops an id with no matching project rather than rendering a blank row", () => {
    expect(buildAgentModelTargets(["p1", "deleted"], facts).map((t) => t.projectId)).toEqual([
      "p1",
    ]);
  });

  it("de-duplicates a repeated id", () => {
    expect(buildAgentModelTargets(["p1", "p1"], facts)).toHaveLength(1);
  });

  it("returns nothing for a role that ran in no project", () => {
    expect(buildAgentModelTargets([], facts)).toEqual([]);
  });
});

describe("an incompatible project is never offered a Claude model", () => {
  it("marks a custom-endpoint project inert, with a reason", () => {
    const [target] = buildAgentModelTargets(
      ["p1"],
      [fact({ projectId: "p1", effective: { kind: "custom_endpoint", model: "llama-3" } })],
    );
    expect(target!.offerable).toBe(false);
    expect(target!.disabledReason).toMatch(/OpenAI-compatible/i);
  });

  it("clears any stored ladder value on an inert row, so no Claude model is shown", () => {
    const [target] = buildAgentModelTargets(
      ["p1"],
      [
        fact({
          projectId: "p1",
          effective: { kind: "custom_endpoint", model: "llama-3" },
          // A row left over from before the project switched providers.
          currentValue: "opus",
        }),
      ],
    );
    expect(target!.currentValue).toBe("");
  });

  it("leaves a Claude project offerable", () => {
    const [target] = buildAgentModelTargets(
      ["p1"],
      [
        fact({
          projectId: "p1",
          effective: { kind: "pinned", model: "opus", rung: { label: "Opus" } },
          currentValue: "opus",
        }),
      ],
    );
    expect(target!.offerable).toBe(true);
    expect(target!.currentValue).toBe("opus");
  });
});

describe("viewEffectiveModel — a model that is not in effect never renders as live", () => {
  it("reports a pinned model as pinned, by its rung label", () => {
    const view = viewEffectiveModel({ kind: "pinned", model: "opus", rung: { label: "Opus" } });
    expect(view.state).toBe("pinned");
    expect(view.label).toBe("Opus");
    expect(view.note).toBeNull();
  });

  it("reports an unrecognised stored model as NOT in effect and explains it", () => {
    const view = viewEffectiveModel({ kind: "ignored", stored: "claude-9-ultra" });
    expect(view.state).toBe("not_in_effect");
    expect(view.label).toBe("Account default");
    expect(view.note).toContain("claude-9-ultra");
  });

  it("reports a SHADOWED model as NOT in effect, labelled with what DOES run", () => {
    // lib/llm's fifth outcome: an override exists but names a provider this
    // project does not resolve to, so it is ignored. The label must name the
    // model that is actually running — claiming "Account default" here would be
    // a second, smaller lie on top of the inert override.
    const view = viewEffectiveModel({
      kind: "shadowed",
      stored: "opus",
      running: { kind: "pinned", model: "sonnet", rung: { label: "Sonnet" } },
    });
    expect(view.state).toBe("not_in_effect");
    expect(view.label).toBe("Sonnet");
    expect(view.note).toContain("opus");
  });

  it("falls back to the account default when a shadowed outcome names no running model", () => {
    const view = viewEffectiveModel({ kind: "shadowed", stored: "opus" });
    expect(view.state).toBe("not_in_effect");
    expect(view.label).toBe("Account default");
    expect(view.note).toContain("opus");
  });

  it("degrades an entirely unknown variant to NOT in effect rather than to pinned", () => {
    const view = viewEffectiveModel({ kind: "some_future_state" });
    expect(view.state).toBe("not_in_effect");
    expect(view.label).toBe("Account default");
    expect(view.note).not.toBeNull();
  });

  it("treats a missing resolution as the account default, not as an error", () => {
    expect(viewEffectiveModel(null).state).toBe("account_default");
  });
});

describe("summarizeAgentModel — a role spanning disagreeing projects is never collapsed", () => {
  it("carries projectIds so the control can expand, instead of picking one", () => {
    const targets = buildAgentModelTargets(
      ["p1", "p2"],
      [
        fact({
          projectId: "p1",
          effective: { kind: "pinned", model: "opus", rung: { label: "Opus" } },
        }),
        fact({ projectId: "p2", effective: { kind: "account_default" } }),
      ],
    );
    const summary = summarizeAgentModel(targets);
    expect(summary.kind).toBe("mixed");
    expect(summary.projectIds).toEqual(["p1", "p2"]);
    if (summary.kind === "mixed") {
      expect(summary.labels).toEqual(["Account default", "Opus"]);
    }
  });

  it("reports one label when every project agrees", () => {
    const targets = buildAgentModelTargets(
      ["p1", "p2"],
      [
        fact({
          projectId: "p1",
          effective: { kind: "pinned", model: "sonnet", rung: { label: "Sonnet" } },
        }),
        fact({
          projectId: "p2",
          effective: { kind: "pinned", model: "sonnet", rung: { label: "Sonnet" } },
        }),
      ],
    );
    const summary = summarizeAgentModel(targets);
    expect(summary.kind).toBe("single");
    expect(summary.projectIds).toEqual(["p1", "p2"]);
    if (summary.kind === "single") expect(summary.label).toBe("Sonnet");
  });
});
