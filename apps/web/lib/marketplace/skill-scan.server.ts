import "server-only";

// Wiring twin for `skill-scan.ts`. IO only — every decision lives in the
// marker-free module so it stays Vitest-loadable and no test needs a network.
//
// The model call goes through `generateObjectForTenant`, NEVER a vendor SDK and
// never `generateObject` directly: AGENTS.md is explicit that a direct call
// crashes with the raw env error in `claude_code` auth mode, which is this
// instance's default.
//
// Tier `default` (Sonnet) rather than `cheap`. This pass is asked to judge
// INTENT in adversarial prose — the one job the static half cannot do — and it
// runs once, on a deliberate button press, over at most 8,000 characters. The
// pattern checks are what make the scan cheap; the point of the second pass is
// that it is better, and downgrading it would leave the scan with two passes
// that both only catch the obvious.
//
// Temperature 0: this is a reading task with a fixed output shape, not a
// brainstorm, and an operator re-running a scan on the same body should not get
// a different answer.
//
// `fence` is injected rather than imported at the call site so that
// `__tests__/skill-scan.test.ts` can assert the body actually reaches the model
// wrapped — an unfenced body would put attacker-controlled text into the
// reviewer's prompt with nothing marking it as data.

import { fenceUntrustedOutput } from "@/lib/board/qa-gate";
import { generateObjectForTenant } from "@/lib/llm/generate.server";
import { type SkillReviewReply, type SkillScanDeps } from "@/lib/marketplace/skill-scan";

export function defaultSkillScanDeps(tenantId: string): SkillScanDeps {
  return {
    fence: fenceUntrustedOutput,
    review: async (args) => {
      const res = await generateObjectForTenant<SkillReviewReply>({
        tenantId,
        featureName: "Skill scan",
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

/**
 * The static-only deps — no reviewer.
 *
 * Exported so a caller that must not spend (or must not wait) can still run the
 * pattern half and have the report say plainly that the review did not run,
 * rather than the reviewer being silently dropped.
 */
export function staticOnlyScanDeps(): SkillScanDeps {
  return { fence: fenceUntrustedOutput };
}
