// Token-usage → cost in cents. List-price snapshot for Claude 4.x; update here
// when pricing moves. Used by the budget guard (M3) and the trace cost field.

import { MODEL_IDS, type ModelTier } from "@/lib/llm/models";
import type { LlmProvider } from "@/lib/llm/provider";

// Dollars per million tokens.
const PRICING_USD_PER_MTOK: Record<ModelTier, { input: number; output: number }> = {
  heavy: { input: 15, output: 75 }, // Opus 4.7
  default: { input: 3, output: 15 }, // Sonnet 4.6
  cheap: { input: 0.8, output: 4 }, // Haiku 4.5
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
};

export function costCents(tier: ModelTier, usage: TokenUsage): number {
  const p = PRICING_USD_PER_MTOK[tier];
  const usd =
    (usage.promptTokens / 1_000_000) * p.input + (usage.completionTokens / 1_000_000) * p.output;
  return Math.ceil(usd * 100);
}

const ID_TO_TIER: Record<string, ModelTier> = {
  [MODEL_IDS.default]: "default",
  [MODEL_IDS.heavy]: "heavy",
  [MODEL_IDS.cheap]: "cheap",
};

export function tierFromModelId(modelId: string): ModelTier | null {
  return ID_TO_TIER[modelId] ?? null;
}

// ─── provider-aware step cost ───────────────────────────────────────────────
//
// `tierFromModelId` only knows the three ids in MODEL_IDS, and the ONLY caller
// (run-agent's persist step) used to do:
//
//     const tier = tierFromModelId(modelId);
//     const cents = usage && tier ? costCents(tier, usage) : 0;
//
// …which quietly charges ZERO for every model id it doesn't recognise. That was
// already wrong — the local-cc runner reports whatever id `claude` actually ran
// (a dated variant, a `--model` override, next quarter's Sonnet), so real
// Anthropic spend has been landing in the budget guard as 0 cents and
// `assertCanProceed` has been gating on a number that undercounts. Two providers
// makes it worse, not better: a non-Anthropic id would hit the same silent zero.
//
// So the zero is now EXPLICIT and attributed, and the unrecognised-Anthropic case
// falls back to the tier the run actually requested (the price we'd have charged
// had the model come back with the id we asked for) instead of vanishing.

export type CostBasis =
  | "model_id" // priced from the returned model id
  | "requested_tier" // Anthropic, unrecognised id → priced at the requested tier
  | "no_usage" // the runner reported no token usage → nothing to price
  | "unpriced_provider"; // self-hosted / OpenAI-compatible → we don't know the price

export type StepCost = {
  cents: number;
  /** False = the number above is a floor, not a bill. Persisted on the step +
   *  the trace so a zero is legible as "we can't price this" rather than free. */
  priced: boolean;
  basis: CostBasis;
};

/**
 * Cost for one completed step.
 *
 * `openai_compatible` is deliberately NOT priced: the endpoint may be a local
 * Ollama (genuinely free), a self-hosted vLLM (cost is the operator's GPU bill,
 * not per-token), or a gateway to a model whose price we have no table for.
 * Inventing a number would corrupt the budget gate in the other direction — an
 * agent throttled against a bill nobody is paying. We return an explicit, labelled
 * zero and let the operator's own per-run ceiling still bound iteration count.
 */
export function stepCost(args: {
  provider: LlmProvider;
  /** The tier the run REQUESTED — the fallback basis when the id is unknown. */
  requestedTier: ModelTier;
  /** The model id the runner actually reported, when it reported one. */
  modelId?: string | null;
  usage?: TokenUsage | null;
}): StepCost {
  if (!args.usage) return { cents: 0, priced: false, basis: "no_usage" };
  if (args.provider === "openai_compatible") {
    return { cents: 0, priced: false, basis: "unpriced_provider" };
  }
  const tier = args.modelId ? tierFromModelId(args.modelId) : null;
  if (tier) return { cents: costCents(tier, args.usage), priced: true, basis: "model_id" };
  return {
    cents: costCents(args.requestedTier, args.usage),
    priced: true,
    basis: "requested_tier",
  };
}
