// The ordered set of Claude models an operator may pick from the scoreboard's
// "raise the model" control, plus the pure rendering of what a project is
// CURRENTLY running on.
//
// PURE: no `server-only`, no DB, no env. Imported by both the server action that
// writes the choice and the client component that renders the picker.
//
// ── Why aliases, not pinned ids ────────────────────────────────────────────
// `claude -p --model opus` asks the CLI to resolve the best Opus THIS
// subscription can run, at run time. A pinned id (`claude-opus-4-7`) goes stale
// the moment the vendor ships a successor, and is the value most likely to be
// unavailable on the operator's actual plan. Both forms are in
// `ALLOWED_CLAUDE_MODELS`, so both are accepted if already stored — we just do
// not OFFER the pinned ones, because "higher" is only meaningful along the
// haiku → sonnet → opus ladder and mixing tiers with dated ids makes the order
// unreadable.
//
// ── The allowlist is the gate, this ladder is only the menu ────────────────
// Nothing here is a security boundary. The server action validates the submitted
// value against `ALLOWED_CLAUDE_MODELS` (lib/llm/provider.ts) — the same
// allowlist `resolveClaudeModelArg` uses before the value reaches a `claude -p`
// argv — and additionally against this ladder, so a value that is merely
// allowlisted but not offered cannot be smuggled in through the form either.

import { ALLOWED_CLAUDE_MODELS, resolveClaudeModelArg, type LlmProvider } from "@/lib/llm/provider";
import { applyRoleModelOverride, type RoleModelOverride } from "@/lib/llm/role-model";

export type ClaudeModelRung = {
  /** The value stored in `projects.llm_model` and handed to `--model`. */
  value: string;
  label: string;
  hint: string;
  /** Ascending capability. Higher = "raise the agent to a better model". */
  rank: number;
};

/** Lowest → highest. The picker renders in this order so "higher" is literal. */
export const CLAUDE_MODEL_LADDER: readonly ClaudeModelRung[] = [
  {
    value: "haiku",
    label: "Haiku",
    hint: "Fastest and cheapest. Good for mechanical, well-specified work.",
    rank: 1,
  },
  {
    value: "sonnet",
    label: "Sonnet",
    hint: "Balanced capability and speed. The usual choice for engineering work.",
    rank: 2,
  },
  {
    value: "opus",
    label: "Opus",
    hint: "Most capable, slowest, most expensive. For work that keeps going wrong.",
    rank: 3,
  },
];

/** The sentinel the form submits for "don't pin a model" — stored as NULL. */
export const ACCOUNT_DEFAULT_VALUE = "";

/** Is this a value the picker offers AND the CLI allowlist accepts? */
export function isOfferedClaudeModel(value: string): boolean {
  return (
    CLAUDE_MODEL_LADDER.some((r) => r.value === value) && ALLOWED_CLAUDE_MODELS.includes(value)
  );
}

export function ladderRung(value: string | null): ClaudeModelRung | null {
  if (!value) return null;
  return CLAUDE_MODEL_LADDER.find((r) => r.value === value) ?? null;
}

/**
 * What a project is running on RIGHT NOW, said honestly.
 *
 * The four outcomes exist because a wrong label here would drive a bad upgrade
 * decision — the operator would "raise" a model that was never in effect:
 *
 *   account_default — nothing pinned, so `--model` is not emitted at all and the
 *                     run uses whatever the Claude account defaults to. We cannot
 *                     know that id from here and deliberately do not guess one.
 *   pinned          — an allowlisted Claude model is configured and IS used.
 *   ignored         — a value is stored that `resolveClaudeModelArg` refuses, so
 *                     the run silently falls back to the account default. Showing
 *                     the stored string as if it were live would be a lie.
 *   custom_endpoint — an OpenAI-compatible project. Not Claude, so the ladder
 *                     does not apply and the control must not offer to raise it.
 *   shadowed        — a per-agent × per-project model override EXISTS but names
 *                     a provider this project does not resolve to, so the
 *                     compatibility rule ignores it (lib/llm/role-model.ts) and
 *                     the project's own model runs instead. This is the fifth
 *                     outcome, and it is the price of shipping the override at
 *                     all: `role_config.modelTier` was a per-agent control that
 *                     silently did nothing for its whole life, and the ONE
 *                     unacceptable outcome here is a second one. A settable
 *                     value must take effect or be shown as not in effect.
 */
export type EffectiveModel =
  | { kind: "account_default" }
  | { kind: "pinned"; model: string; rung: ClaudeModelRung | null }
  | { kind: "ignored"; stored: string }
  | { kind: "custom_endpoint"; model: string | null }
  | {
      kind: "shadowed";
      /** The override that is NOT running. */
      stored: string;
      /** The provider it was stored for. */
      storedProvider: LlmProvider;
      /** The provider that actually won, and why the override is inert. */
      provider: LlmProvider;
      /** What IS running instead — the project/tenant answer. */
      running: EffectiveModelWithoutShadow;
    };

/** The four non-shadow outcomes. `shadowed` nests one of these as "what is
 *  actually running", so the type cannot recurse. */
export type EffectiveModelWithoutShadow = Exclude<EffectiveModel, { kind: "shadowed" }>;

export function describeEffectiveModel(
  provider: LlmProvider,
  model: string | null,
): EffectiveModelWithoutShadow {
  if (provider === "openai_compatible") return { kind: "custom_endpoint", model };
  const decision = resolveClaudeModelArg(model);
  if (decision.kind === "explicit") {
    return { kind: "pinned", model: decision.model, rung: ladderRung(decision.model) };
  }
  if (decision.reason === "unrecognised_model")
    return { kind: "ignored", stored: decision.rejected };
  return { kind: "account_default" };
}

/**
 * Describe what a ROLE is running on for one project, given the project's own
 * resolution and the override row (if any).
 *
 * The compatibility decision itself is NOT re-implemented here — it is
 * `applyRoleModelOverride` in lib/llm/role-model.ts, the same pure function the
 * engine's resolver calls, so the label and the run cannot disagree. This only
 * turns its outcome into the display type.
 */
export function describeRoleEffectiveModel(args: {
  provider: LlmProvider;
  /** The project » tenant » default model, before any override. */
  projectModel: string | null;
  override: RoleModelOverride | null | undefined;
}): EffectiveModel {
  const { model, outcome } = applyRoleModelOverride({
    provider: args.provider,
    projectModel: args.projectModel,
    override: args.override,
  });
  if (outcome.kind === "shadowed") {
    return {
      kind: "shadowed",
      stored: outcome.stored,
      storedProvider: outcome.storedProvider,
      provider: outcome.provider,
      running: describeEffectiveModel(args.provider, model),
    };
  }
  return describeEffectiveModel(args.provider, model);
}

/** One short human string for a resolved model, for table cells and summaries. */
export function formatEffectiveModel(effective: EffectiveModel): string {
  switch (effective.kind) {
    case "account_default":
      return "Account default";
    case "pinned":
      return effective.rung ? effective.rung.label : effective.model;
    case "ignored":
      return "Account default";
    case "custom_endpoint":
      return effective.model ? `Custom endpoint · ${effective.model}` : "Custom endpoint";
    case "shadowed":
      // Names what IS running, and flags the inert override rather than hiding
      // it — an operator who set `opus` here needs to know it is not in effect.
      return `${formatEffectiveModel(effective.running)} (${effective.stored} not in effect)`;
  }
}
