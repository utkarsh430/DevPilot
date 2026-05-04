// The ONLY place in the codebase that imports a vendor SDK directly.
// All other code uses `models` / `pickModel` from here, or goes through
// the Runner interface in lib/runners/.

import { createAnthropic } from "@ai-sdk/anthropic";
import { env } from "@/lib/env";

export const MODEL_IDS = {
  default: "claude-sonnet-4-6",
  heavy: "claude-opus-4-7",
  cheap: "claude-haiku-4-5-20251001",
} as const;

export type ModelTier = keyof typeof MODEL_IDS;

let _anthropic: ReturnType<typeof createAnthropic> | null = null;
function anthropic() {
  _anthropic ??= createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// Lazy getters — the Anthropic client (and its API-key read) only fires on
// first access, so importing this file in code-paths that never call an LLM
// (e.g. type-only imports) doesn't crash if the key isn't present.
export const models = {
  get default() {
    return anthropic()(MODEL_IDS.default);
  },
  get heavy() {
    return anthropic()(MODEL_IDS.heavy);
  },
  get cheap() {
    return anthropic()(MODEL_IDS.cheap);
  },
} as const;

export function pickModel(tier: ModelTier) {
  return models[tier];
}
