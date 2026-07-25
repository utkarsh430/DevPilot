// Pure derivation behind the per-agent model pickers on `/agents` and
// `/scoreboard`.
//
// PURE: no `server-only`, no DB, no React. Both screens derive their rows here,
// which is the point — before this, `/agents` rendered the static catalog
// `role_config.modelTier` while `/scoreboard` rendered the resolved model, so the
// two screens disagreed about the same agent and one of them was always wrong.
//
// ── Two invariants live here, and both are the reason this is a module ──────
//
// (1) A ROLE IS TENANT-WIDE; A MODEL IS PER PROJECT. A scoreboard row spans
//     `projectIds[]`, so "set this agent's model" has no single target. The
//     control therefore EXPANDS into exactly that role's projects — never picks
//     one silently, never widens to every project in the workspace.
//
// (2) A MODEL THAT IS NOT IN EFFECT MUST NOT RENDER AS IF IT WERE. That is the
//     whole reason this feature exists: `role_config.modelTier` was rendered as a
//     per-agent model badge while being a documented no-op on the local-cc path.
//     `viewEffectiveModel` is deliberately written against `kind` as a STRING with
//     a conservative default, not an exhaustive switch, so a variant added later
//     (e.g. "a role model is set but shadowed by an incompatible provider")
//     degrades to NOT-IN-EFFECT rather than silently rendering as live.

/**
 * Structurally what `EffectiveModel` (lib/llm/claude-model-ladder.ts) provides,
 * kept loose on purpose — see invariant (2). A new variant is readable here
 * without this module having to know it exists.
 */
export type EffectiveModelLike = {
  kind: string;
  model?: string | null;
  stored?: string;
  rung?: { label: string } | null;
  /** For `shadowed`: what IS running while the stored override is inert. */
  running?: EffectiveModelLike;
};

export type ModelEffectState =
  /** An allowlisted Claude model is configured and IS what runs. */
  | "pinned"
  /** Nothing pinned; runs use whatever the Claude account defaults to. */
  | "account_default"
  /** Something IS stored but does not take effect. Never render as live. */
  | "not_in_effect"
  /** Not a Claude project at all — the ladder does not apply. */
  | "custom_endpoint";

export type ModelEffectView = {
  state: ModelEffectState;
  /** Short label for a table cell. */
  label: string;
  /** Present only when something is stored that does not apply. */
  note: string | null;
};

const NOT_IN_EFFECT_FALLBACK =
  "A model is configured here but does not take effect, so runs use the account default.";

export function viewEffectiveModel(effective: EffectiveModelLike | null): ModelEffectView {
  if (!effective) return { state: "account_default", label: "Account default", note: null };

  switch (effective.kind) {
    case "pinned":
      return {
        state: "pinned",
        label: effective.rung?.label ?? effective.model ?? "Pinned",
        note: null,
      };
    case "account_default":
      return { state: "account_default", label: "Account default", note: null };
    case "custom_endpoint":
      return {
        state: "custom_endpoint",
        label: effective.model ? `Custom endpoint · ${effective.model}` : "Custom endpoint",
        note: null,
      };
    case "ignored":
      return {
        state: "not_in_effect",
        label: "Account default",
        note: `“${effective.stored ?? "the stored value"}” is not a model DevPilot recognises, so it is ignored and runs use the account default.`,
      };
    // An override IS stored for this (role, project) but names a provider the
    // project does not resolve to, so the compatibility rule ignores it
    // (lib/llm/role-model.ts). Label what is ACTUALLY running — saying "Account
    // default" here would be a second, smaller lie on top of the first.
    case "shadowed":
      return {
        state: "not_in_effect",
        label: effective.running ? viewEffectiveModel(effective.running).label : "Account default",
        note: `“${effective.stored ?? "the stored model"}” is set for this agent but this project does not run that provider, so it is ignored.`,
      };
    // Any variant added after this was written. Conservative by construction: an
    // unknown state is reported as NOT in effect, because the failure mode this
    // whole feature exists to kill is a control that looks applied and is not.
    default:
      return {
        state: "not_in_effect",
        label: "Account default",
        note: effective.stored
          ? `“${effective.stored}” is configured here but is not in effect on this project, so runs use the account default.`
          : NOT_IN_EFFECT_FALLBACK,
      };
  }
}

/** Is this a state where offering a Claude model from the ladder makes sense? */
export function isLadderApplicable(state: ModelEffectState): boolean {
  return state !== "custom_endpoint";
}

export const CUSTOM_ENDPOINT_REASON =
  "This project runs on a custom OpenAI-compatible endpoint, not Claude, so the Claude model ladder does not apply. Change its provider in project settings first.";

/** One project's resolved facts for one role. */
export type ProjectModelFacts = {
  projectId: string;
  projectName: string;
  /** How the model resolves for THIS role on THIS project. */
  effective: EffectiveModelLike;
  /**
   * The ladder value stored for this (role, project) pair specifically, "" when
   * this project has no row of its own. This is the picker's current selection —
   * distinct from `effective`, which is what actually runs after the agent-wide
   * default and the project/tenant layers are folded in. It is deliberately NOT
   * pre-filled from the agent-wide default: pre-selecting an inherited value
   * would let a plain "Apply" mint a per-project override nobody asked for, and
   * that override would then keep winning after the global changed.
   */
  currentValue: string;
  /** True when this project has a row of its OWN. Whether that constitutes an
   *  OVERRIDE depends on whether an agent-wide default exists — that judgement
   *  lives in `buildAgentGlobalTarget`, not in this fact. */
  hasOwnRow: boolean;
};

/** One row of the per-agent picker: a project this agent actually worked in. */
export type AgentModelTarget = {
  projectId: string;
  projectName: string;
  currentValue: string;
  effect: ModelEffectView;
  /** False ⇒ the control is inert and no Claude model may be offered. */
  offerable: boolean;
  disabledReason: string | null;
  /** This project has its own row, so it wins over any agent-wide default. */
  hasOwnRow: boolean;
};

/**
 * Expand a role into EXACTLY the projects it ran in.
 *
 * `projectIds` is the role's own `RoleScoreRow.projectIds`. Ids with no matching
 * project fact are dropped (a project deleted since the run), and projects the
 * role never touched are never added — widening the target set would move agents
 * on projects the operator was not looking at.
 */
export function buildAgentModelTargets(
  projectIds: readonly string[],
  facts: readonly ProjectModelFacts[],
): AgentModelTarget[] {
  const byId = new Map(facts.map((f) => [f.projectId, f]));
  const out: AgentModelTarget[] = [];
  const seen = new Set<string>();
  for (const id of projectIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const fact = byId.get(id);
    if (!fact) continue;
    const effect = viewEffectiveModel(fact.effective);
    const offerable = isLadderApplicable(effect.state);
    out.push({
      projectId: fact.projectId,
      projectName: fact.projectName,
      // An inert row must not carry a Claude selection into the control, or the
      // select would render a model this project can never serve.
      currentValue: offerable ? fact.currentValue : "",
      effect,
      offerable,
      disabledReason: offerable ? null : CUSTOM_ENDPOINT_REASON,
      hasOwnRow: fact.hasOwnRow,
    });
  }
  return out;
}

/**
 * The single label for a role's model across every project it ran in — or the
 * honest admission that there is more than one answer.
 *
 * `projectIds` is carried so the control can expand into the per-project list;
 * the previous `mixed` variant deliberately carried no project id at all, which
 * was correct when the model was only settable per project and is exactly what
 * blocks a per-agent control now.
 */
export type AgentModelSummary =
  | { kind: "single"; label: string; state: ModelEffectState; projectIds: string[] }
  | { kind: "mixed"; labels: string[]; projectIds: string[] };

export function summarizeAgentModel(targets: readonly AgentModelTarget[]): AgentModelSummary {
  const projectIds = targets.map((t) => t.projectId);
  const labels = [...new Set(targets.map((t) => t.effect.label))].sort();
  if (labels.length <= 1) {
    return {
      kind: "single",
      label: labels[0] ?? "Account default",
      state: targets[0]?.effect.state ?? "account_default",
      projectIds,
    };
  }
  return { kind: "mixed", labels, projectIds };
}

/**
 * The "All projects" row of the per-agent picker — the agent-wide default.
 *
 * ── Why `overriding` is part of the type, not a UI afterthought ────────────
 * The trap this feature has to defuse: the operator sets the agent-wide model to
 * Opus, one project still has its own Sonnet row, and that project keeps running
 * Sonnet — which reads as "the global didn't work". The honest answer is to say
 * so, in the same popover, with a way to clear those rows in one action. It is
 * NEVER to delete his per-project choices as a side effect of setting a global.
 *
 * `overriding` lists only projects the control is actually targeting, so a count
 * shown next to a "Clear N project overrides" button always matches what the
 * button will clear.
 */
export type AgentGlobalTarget = {
  /** The ladder value stored as the agent-wide default; "" = nothing pinned. */
  currentValue: string;
  /** Projects (of the targeted set) with their own row, which therefore win. */
  overriding: { projectId: string; projectName: string }[];
};

export function buildAgentGlobalTarget(
  globalValue: string,
  targets: readonly AgentModelTarget[],
): AgentGlobalTarget {
  return {
    currentValue: globalValue,
    // Gated on a global EXISTING: with nothing pinned agent-wide, a project row
    // overrides nothing and claiming otherwise would invent a conflict.
    overriding:
      globalValue === ""
        ? []
        : targets
            .filter((t) => t.hasOwnRow)
            .map((t) => ({ projectId: t.projectId, projectName: t.projectName })),
  };
}
