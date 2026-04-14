// Provider-aware cost (security criterion 5): the budget gate must not be
// silently corrupted by a model id or a provider we don't have a price for.

import { describe, expect, it } from "vitest";
import { costCents, stepCost, tierFromModelId } from "@/lib/llm/cost";
import { MODEL_IDS } from "@/lib/llm/models";

const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000 };

describe("stepCost", () => {
  it("prices a known Anthropic model id from the id", () => {
    const cost = stepCost({
      provider: "anthropic",
      requestedTier: "cheap",
      modelId: MODEL_IDS.heavy,
      usage,
    });
    expect(cost).toEqual({ cents: costCents("heavy", usage), priced: true, basis: "model_id" });
  });

  it("prices an UNRECOGNISED Anthropic id at the requested tier — not silently at zero", () => {
    // This is the live bug: the local-cc runner reports whatever `claude` actually
    // ran (a dated variant, a --model override), `tierFromModelId` returns null for
    // it, and the old `?? 0` charged nothing — so `assertCanProceed` gated on a
    // number that never grew.
    expect(tierFromModelId("claude-sonnet-4-5-20250929")).toBeNull();
    const cost = stepCost({
      provider: "anthropic",
      requestedTier: "default",
      modelId: "claude-sonnet-4-5-20250929",
      usage,
    });
    expect(cost.cents).toBe(costCents("default", usage));
    expect(cost.cents).toBeGreaterThan(0);
    expect(cost).toMatchObject({ priced: true, basis: "requested_tier" });
  });

  it("returns an EXPLICIT, labelled zero for a self-hosted / OpenAI-compatible endpoint", () => {
    const cost = stepCost({
      provider: "openai_compatible",
      requestedTier: "heavy",
      modelId: "llama3.1:70b",
      usage,
    });
    // Zero because we have no price table — and `priced: false` is what makes that
    // legible as "unpriced" rather than "free".
    expect(cost).toEqual({ cents: 0, priced: false, basis: "unpriced_provider" });
  });

  it("distinguishes 'no usage reported' from 'unpriced provider'", () => {
    const cost = stepCost({ provider: "anthropic", requestedTier: "default", usage: null });
    expect(cost).toEqual({ cents: 0, priced: false, basis: "no_usage" });
  });
});
