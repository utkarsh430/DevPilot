import "server-only";

// Wiring twin for `overlay-assist.ts`. IO only — every decision lives in the
// marker-free module so it stays Vitest-loadable and no test needs a network.
//
// The model call goes through `generateObjectForTenant`, NEVER a vendor SDK and
// never `generateObject` directly: AGENTS.md is explicit that a direct call
// crashes with the raw env error in `claude_code` auth mode, which is the
// default for this instance. Tier `default` (Sonnet) and temperature 0 for the
// same reasons `synthesizeRoleAction` picks them — this is a writing task with
// hard constraints, not a brainstorm.

import { generateObjectForTenant } from "@/lib/llm/generate.server";
import { type AssistDeps, type AssistProposal } from "@/lib/roles/overlay-assist";

export function defaultAssistDeps(tenantId: string): AssistDeps {
  return {
    generate: async (args) => {
      const res = await generateObjectForTenant<AssistProposal>({
        tenantId,
        featureName: "Prompt assist",
        tier: "default",
        temperature: 0,
        system: args.system,
        prompt: args.prompt,
        schema: args.schema,
        schemaHint: args.schemaHint,
        timeoutMs: args.timeoutMs,
      });
      return res.ok ? { ok: true, object: res.object } : { ok: false, error: res.error };
    },
  };
}
