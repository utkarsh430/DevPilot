// Regression suite for the builder Save data-loss bug.
//
// The bug: `saveAgentCanvasAction` writes `agents.config` as a WHOLE-OBJECT
// overwrite, and `compileCanvas` could not emit a `systemPrompt` because the
// canvas cannot represent one (`decompileConfig` never reads it in, and no UI
// surface populates `customRolePrompts`). So opening a JD-synthesized agent in
// the builder — the ONLY call-to-action on its card — and pressing Save
// destroyed `config.role_config`. `loadCustomRoleConfig` then returned null and
// the dispatcher threw `no RoleConfig for slug "<x>"`. Silent, total, and on
// the only button available.
//
// The fix is `CompileInput.existingRoleConfig`: the compiler carries a stored
// prompt forward when the canvas did not supply one. These tests are the guard
// against reintroducing the overwrite — if someone drops the merge, the
// preservation tests below go red.

import { describe, it, expect } from "vitest";
import { compileCanvas } from "@/lib/builder/compile";
import { decompileConfig } from "@/lib/builder/decompile";
import type { BuilderCanvas, BuilderCompiledConfig } from "@/lib/builder/types";

const SYNTH_PROMPT =
  "You are a Sourdough Logistics Coordinator. Track proofing schedules and escalate over-fermentation.";

/** A canvas as it comes back from `decompileConfig` for a JD-synth agent. */
function canvasFor(slug: string, displayName: string): BuilderCanvas {
  return {
    version: 1,
    entryNodeId: "n_entry",
    nodes: [
      {
        id: "n_entry",
        type: "role",
        position: { x: 160, y: 200 },
        data: {
          kind: "role",
          roleSlug: slug,
          displayName,
          modelTier: "default",
          runnerPolicy: "local-cc",
        },
      },
    ],
    edges: [],
  };
}

/** The `agents.config` a JD-synth agent is inserted with: a prompt, no canvas. */
function synthesizedConfig(): BuilderCompiledConfig {
  return {
    role_config: {
      displayName: "Sourdough Logistics Coordinator",
      systemPrompt: SYNTH_PROMPT,
      modelTier: "default",
      runnerPolicy: "local-cc",
      onSuccessStatus: "in_review",
    },
  };
}

describe("compileCanvas — stored role_config preservation", () => {
  it("PRESERVES an existing systemPrompt when the canvas supplies none", () => {
    // This is the whole point of the fix. If it fails, Save destroys agents.
    const res = compileCanvas({
      canvas: canvasFor("sourdough_logistics_coordinator", "Sourdough Logistics Coordinator"),
      existingRoleConfig: synthesizedConfig().role_config,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.role_config?.systemPrompt).toBe(SYNTH_PROMPT);
  });

  it("preserves the stored onSuccessStatus alongside the prompt", () => {
    // A verdict role stores `done`. The pre-fix branches path hardcoded
    // `in_review`, which would silently re-wire the role's FSM contract.
    const res = compileCanvas({
      canvas: canvasFor("custom_verifier", "Custom Verifier"),
      existingRoleConfig: {
        displayName: "Custom Verifier",
        systemPrompt: SYNTH_PROMPT,
        modelTier: "default",
        runnerPolicy: "local-cc",
        onSuccessStatus: "done",
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.role_config?.onSuccessStatus).toBe("done");
  });

  it("lets a GENUINE prompt edit still overwrite the stored one", () => {
    // The fix is "never lose what was there unintentionally", NOT "make
    // role_config immutable". An explicit edit must still land.
    const edited = "You are a Sourdough Logistics Coordinator. NEW INSTRUCTIONS.";
    const res = compileCanvas({
      canvas: canvasFor("sourdough_logistics_coordinator", "Sourdough Logistics Coordinator"),
      customRolePrompts: {
        sourdough_logistics_coordinator: {
          systemPrompt: edited,
          onSuccessStatus: "done",
        },
      },
      existingRoleConfig: synthesizedConfig().role_config,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.role_config?.systemPrompt).toBe(edited);
    expect(res.config.role_config?.onSuccessStatus).toBe("done");
  });

  it("does NOT invent a role_config for an agent that never had one", () => {
    // Built-in roles short-circuit to the ROLES map at dispatch. Inventing an
    // empty role_config here would be a second way to say "missing".
    const res = compileCanvas({ canvas: canvasFor("engineer", "Engineer") });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.role_config).toBeUndefined();
  });

  it("treats a stored EMPTY systemPrompt as absent, not as a value to keep", () => {
    // Pre-fix rows may carry `systemPrompt: ""`. It is not a prompt; carrying
    // it forward would launder a broken row into looking intentional.
    const res = compileCanvas({
      canvas: canvasFor("engineer", "Engineer"),
      existingRoleConfig: {
        displayName: "Engineer",
        systemPrompt: "",
        modelTier: "default",
        runnerPolicy: "local-cc",
        onSuccessStatus: "in_review",
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.role_config).toBeUndefined();
  });

  it("never writes an empty-string systemPrompt on the branches-only path", () => {
    // `""` reads like a valid value and behaves like a missing one — that
    // ambiguity is what made the original break silent. Omit the key instead.
    const canvas = canvasFor("engineer", "Engineer");
    canvas.nodes.push({
      id: "n_qa",
      type: "role",
      position: { x: 480, y: 200 },
      data: {
        kind: "role",
        roleSlug: "qa",
        displayName: "QA",
        modelTier: "default",
        runnerPolicy: "local-cc",
      },
    });
    canvas.edges.push({
      id: "e_branch",
      source: "n_entry",
      target: "n_qa",
      data: { kind: "conditional", branchKey: "approved" },
    });

    const res = compileCanvas({ canvas });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.role_config?.branches).toEqual({ approved: "qa" });
    expect(res.config.role_config?.systemPrompt).toBeUndefined();
    expect(Object.keys(res.config.role_config ?? {})).not.toContain("systemPrompt");
  });

  it("keeps the prompt AND the canvas branches when both are present", () => {
    const canvas = canvasFor("sourdough_logistics_coordinator", "Sourdough Logistics Coordinator");
    canvas.nodes.push({
      id: "n_qa",
      type: "role",
      position: { x: 480, y: 200 },
      data: {
        kind: "role",
        roleSlug: "qa",
        displayName: "QA",
        modelTier: "default",
        runnerPolicy: "local-cc",
      },
    });
    canvas.edges.push({
      id: "e_branch",
      source: "n_entry",
      target: "n_qa",
      data: { kind: "conditional", branchKey: "approved" },
    });

    const res = compileCanvas({ canvas, existingRoleConfig: synthesizedConfig().role_config });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.role_config?.systemPrompt).toBe(SYNTH_PROMPT);
    expect(res.config.role_config?.branches).toEqual({ approved: "qa" });
  });

  it("honours canvas edits to the identity fields while preserving the prompt", () => {
    // Preservation must not freeze the fields the canvas CAN represent.
    const canvas = canvasFor("sourdough_logistics_coordinator", "Renamed Coordinator");
    (canvas.nodes[0]!.data as { modelTier: string }).modelTier = "premium";

    const res = compileCanvas({ canvas, existingRoleConfig: synthesizedConfig().role_config });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.role_config?.displayName).toBe("Renamed Coordinator");
    expect(res.config.role_config?.modelTier).toBe("premium");
    expect(res.config.role_config?.systemPrompt).toBe(SYNTH_PROMPT);
  });
});

describe("builder round-trip — load, save unchanged, config is unchanged", () => {
  // The invariant a builder should always hold, and whose absence is why this
  // shipped: decompile → compile with NO edits must not lose anything the
  // dispatcher reads.

  it("round-trips a JD-synthesized agent with no canvas stored", () => {
    const stored = synthesizedConfig();

    // Load: exactly what `loadAgentCanvasAction` does.
    const decompiled = decompileConfig(stored, {
      fallbackRoleSlug: "sourdough_logistics_coordinator",
      fallbackDisplayName: "Sourdough Logistics Coordinator",
    });
    expect(decompiled.ok).toBe(true);
    if (!decompiled.ok) return;

    // Save, with no edits at all.
    const res = compileCanvas({
      canvas: decompiled.canvas,
      existingRoleConfig: stored.role_config,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.config.role_config).toMatchObject({
      displayName: "Sourdough Logistics Coordinator",
      systemPrompt: SYNTH_PROMPT,
      modelTier: "default",
      runnerPolicy: "local-cc",
      onSuccessStatus: "in_review",
    });
    expect(res.entryRoleSlug).toBe("sourdough_logistics_coordinator");
  });

  it("is idempotent — a second save changes nothing further", () => {
    const stored = synthesizedConfig();

    const first = decompileConfig(stored, {
      fallbackRoleSlug: "sourdough_logistics_coordinator",
      fallbackDisplayName: "Sourdough Logistics Coordinator",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const save1 = compileCanvas({
      canvas: first.canvas,
      existingRoleConfig: stored.role_config,
    });
    expect(save1.ok).toBe(true);
    if (!save1.ok) return;

    // Reopen the row we just wrote (it now embeds a canvas) and save again.
    const second = decompileConfig(save1.config, {
      fallbackRoleSlug: "sourdough_logistics_coordinator",
      fallbackDisplayName: "Sourdough Logistics Coordinator",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const save2 = compileCanvas({
      canvas: second.canvas,
      existingRoleConfig: save1.config.role_config,
    });
    expect(save2.ok).toBe(true);
    if (!save2.ok) return;

    expect(save2.config).toEqual(save1.config);
    expect(save2.config.role_config?.systemPrompt).toBe(SYNTH_PROMPT);
  });
});
