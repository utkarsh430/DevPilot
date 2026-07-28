import "server-only";

// Server wiring for the lesson extractor: the real service client + the LLM call.
//
// The DI'd orchestration (extractMistakeLesson / extractTicketLessons /
// backfillTenantLessons) lives in `extract-batch.ts` so it is unit-testable with
// a fake client + a stubbed model — the same split harvest-batch.ts /
// harvest.server.ts uses. This file is the `server-only` twin that builds
// `defaultExtractDeps` and re-exports the batch functions.
//
// The model call goes through `generateObjectForTenant` — the ONLY sanctioned
// way this repo talks to a model from feature code (AGENTS.md: `generateObject`/
// `models.*` directly crash with the raw env error in `claude_code` mode). It is
// auth-mode-aware, so extraction honours the tenant's Settings → LLM auth choice
// for free. Copies `lib/stack/infer-capabilities.server.ts`'s shape: Haiku,
// temperature 0, a sharp Zod schema, a bounded timeout, and — critically — a
// result with NO throw path: any LLM error/timeout/unparseable reply degrades to
// `null` (no candidate this round), so a downed runner never fails the harvest
// hook it runs under. The backfill just records fewer lessons and can re-run.

import { z } from "zod";
import { generateObjectForTenant } from "@/lib/llm/generate.server";
import { supabaseService } from "@/lib/db/server";
import {
  LESSON_BODY_MAX_CHARS,
  LESSON_CATEGORIES,
  LESSON_SCOPES,
  type RawDedupVerdict,
  type RawLessonCandidate,
} from "@/lib/learning/extract";
import { getLearningAutoApproveThreshold } from "@/lib/learning/auto-approve.server";
import { defaultConfidenceDeps } from "@/lib/learning/confidence.server";
import { gradeLessonCandidate } from "@/lib/learning/confidence-batch";
import { type ExtractDeps } from "@/lib/learning/extract-batch";

const candidateSchema = z.object({
  body: z
    .string()
    .min(1)
    .max(LESSON_BODY_MAX_CHARS * 2), // grounded again in normalizeCandidate
  scope: z.enum(LESSON_SCOPES),
  category: z.enum(LESSON_CATEGORIES),
});

// Semantic-dedup verdict schema. The index is grounded again (in-range check)
// by `normalizeDedupVerdict`, so this only needs to accept "an int or null".
const dedupVerdictSchema = z.object({
  duplicateIndex: z.number().int().nullable(),
});

/**
 * Production deps bound to one tenant (the model routing is per-tenant). The go-
 * forward hook and the backfill both build these fresh per tenant. `db` is the
 * service client; `generateCandidate` is the auth-mode-aware Haiku call that
 * returns `null` on any failure so extraction is best-effort end to end.
 */
export function defaultExtractDeps(tenantId: string): ExtractDeps {
  return {
    db: supabaseService(),
    generateCandidate: async (input): Promise<RawLessonCandidate | null> => {
      const res = await generateObjectForTenant({
        tenantId,
        featureName: "Lesson extraction",
        tier: "cheap", // Haiku — a short single-lesson summarisation
        schema: candidateSchema,
        schemaHint: input.schemaHint,
        system: input.system,
        prompt: input.prompt,
        maxTokens: 400,
        temperature: 0,
        // Bounded: a downed runner must not hang the harvest hook this runs under.
        timeoutMs: 60_000,
      });
      return res.ok ? res.object : null;
    },
    // Semantic-dedup judge (stage 2). Same seam, tier, and fail-open contract as
    // generateCandidate — any error/timeout/unparseable reply degrades to `null`
    // (insert), so dedup falls back to Jaccard-only rather than blocking.
    checkSemanticDuplicate: async (input): Promise<RawDedupVerdict | null> => {
      const res = await generateObjectForTenant({
        tenantId,
        featureName: "Lesson duplicate check",
        tier: "cheap",
        schema: dedupVerdictSchema,
        schemaHint: input.schemaHint,
        system: input.system,
        prompt: input.prompt,
        maxTokens: 60,
        temperature: 0,
        timeoutMs: 60_000,
      });
      return res.ok ? res.object : null;
    },
    // Auto-approve THRESHOLD lookup at the insert seam (tenants.config, fresh read).
    resolveAutoApprove: (t: string) => getLearningAutoApproveThreshold(t),
    // Confidence grading, wired to the same tenant. Fail-open all the way down:
    // `gradeLessonCandidate` returns `null` on any model/DB failure, which leaves
    // the row ungraded — and an ungraded row never clears an auto-approve
    // threshold, so a grading outage degrades to "a human reviews it".
    gradeCandidate: (lesson) =>
      gradeLessonCandidate(defaultConfidenceDeps(tenantId), { tenantId, lesson }),
  };
}

export {
  extractMistakeLesson,
  extractTicketLessons,
  backfillTenantLessons,
  type ExtractDeps,
  type ExtractResult,
  type TicketExtractResult,
  type LessonBackfillResult,
} from "@/lib/learning/extract-batch";
