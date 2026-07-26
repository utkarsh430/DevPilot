import "server-only";

// Server wiring for the lesson confidence grader: the real service client + the
// LLM call.
//
// The DI'd orchestration (gradeLessonCandidate / gradeStoredLesson /
// backfillTenantConfidence) lives in `confidence-batch.ts` so it is unit-testable
// with a fake client + a stubbed model — the same split extract-batch.ts /
// extract.server.ts uses. This file is the `server-only` twin that builds
// `defaultConfidenceDeps` and re-exports the batch functions.
//
// The model call goes through `generateObjectForTenant` — the ONLY sanctioned way
// this repo talks to a model from feature code (AGENTS.md: `generateObject` /
// `models.*` directly crash with the raw env error in `claude_code` mode). It is
// auth-mode- and provider-aware, so grading honours the tenant's Settings → LLM
// auth choice for free. Same shape as `extract.server.ts`: `cheap` tier (one
// short classification), `temperature 0`, a sharp Zod schema, a bounded timeout,
// and — critically — a result with NO throw path: any LLM error / timeout /
// unparseable reply degrades to `null`, which `confidence-batch.ts` treats as
// "leave the row UNGRADED". An ungraded lesson never auto-approves, so a grading
// outage degrades to "everything queues for a human", the safe direction.

import { z } from "zod";
import { generateObjectForTenant } from "@/lib/llm/generate.server";
import { supabaseService } from "@/lib/db/server";
import {
  CONFIDENCE_REASON_MAX_CHARS,
  LESSON_CONFIDENCES,
  type RawConfidenceGrade,
} from "@/lib/learning/confidence";
import { type ConfidenceDeps } from "@/lib/learning/confidence-batch";

// The grade is grounded AGAIN by `normalizeConfidence` regardless of this enum —
// two independent layers, because an off-vocabulary value reaching storage as
// anything but `low` is the one failure the whole design is built to prevent.
const gradeSchema = z.object({
  confidence: z.enum(LESSON_CONFIDENCES),
  reason: z.string().max(CONFIDENCE_REASON_MAX_CHARS * 4), // re-bounded in normalizeGrade
});

/**
 * Production deps bound to one tenant (model routing is per-tenant). The
 * go-forward extractor and the backfill CLI both build these fresh per tenant.
 */
export function defaultConfidenceDeps(tenantId: string): ConfidenceDeps {
  return {
    db: supabaseService(),
    gradeLesson: async (input): Promise<RawConfidenceGrade | null> => {
      const res = await generateObjectForTenant({
        tenantId,
        featureName: "Lesson confidence grading",
        tier: "cheap", // Haiku — one short rubric classification
        schema: gradeSchema,
        schemaHint: input.schemaHint,
        system: input.system,
        prompt: input.prompt,
        maxTokens: 200,
        temperature: 0,
        // Bounded: a downed runner must not hang the harvest hook this runs under.
        timeoutMs: 60_000,
      });
      return res.ok ? res.object : null;
    },
  };
}

export {
  gradeLessonCandidate,
  gradeStoredLesson,
  backfillTenantConfidence,
  type ConfidenceDeps,
  type GradeStoredResult,
  type ConfidenceBackfillResult,
} from "@/lib/learning/confidence-batch";
