// The DI'd confidence-grading orchestration: load the tenant's active lessons
// through an injected client, call the (injected) model to grade one candidate,
// ground the answer, and — for stored rows — write the grade back.
//
// ── Why this file has no `server-only` (and why it's split from confidence.server.ts) ──
// Every IO dependency arrives as an argument (`ConfidenceDeps.db`,
// `ConfidenceDeps.gradeLesson`), so this module is unit-testable with a fake
// client and a stubbed model — the same DI split extract-batch.ts /
// extract.server.ts uses. `confidence.server.ts` is the `server-only` twin that
// wires the real service client + the LLM. Tests import from HERE.
//
// ── FAIL-OPEN IS A CONTRACT, NOT AN IMPLEMENTATION DETAIL ──
// `gradeLessonCandidate` returns `null` on ANY failure — a downed runner, a
// timeout, an unparseable reply, a DB error loading peers, an unexpected throw.
// `null` means LEAVE THE ROW UNGRADED. It must never:
//   • throw (grading runs inside the extractor, which runs inside the harvest
//     hook on `agent/run.completed` — a grading failure must not fail extraction,
//     and extraction must not fail the run), or
//   • degrade to a grade (a fail-open grader that invented `high` on failure
//     would be a fail-OPEN safety gate; one that invented `low` would silently
//     erase the "nobody has looked at this" state the UI needs to show).
// The safety half is at the CONSUMER: `clearsAutoApproveThreshold` never
// auto-approves an ungraded lesson, so a grading outage degrades to "everything
// queues for a human" — the safe direction.
//
// Security (load-bearing) — mirrors extract-batch.ts
// ──────────────────────────────────────────────────
// Reads and writes run on the SERVICE client (RLS off — `agent_learnings` denies
// all JWT writes by design), so tenant isolation is carried entirely by the
// `.eq("tenant_id", tenantId)` written into each statement. A grade written to
// another tenant's row, or a peer set contaminated by another tenant's lessons,
// would be invisible in the output — the grade would simply be wrong — so every
// query here is co-located with its tenant predicate and the scope test drives a
// fake client that ACTUALLY applies `.eq`.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildConfidenceInput,
  CONFIDENCE_PEER_CAP,
  normalizeGrade,
  type ConfidenceInput,
  type GradedConfidence,
  type LessonForGrading,
  type RawConfidenceGrade,
} from "@/lib/learning/confidence";

export type ConfidenceDeps = {
  db: SupabaseClient;
  /**
   * The model call. Returns the raw (post-Zod, pre-grounding) grade, or `null` on
   * ANY failure/timeout/unparseable reply. Injected so the pipeline runs in tests
   * without a live model, and so a downed runner degrades to "ungraded this
   * round" rather than throwing.
   */
  gradeLesson: (input: ConfidenceInput) => Promise<RawConfidenceGrade | null>;
};

/**
 * Grade one candidate lesson. Returns the grounded grade, or `null` to mean
 * LEAVE IT UNGRADED (see the fail-open contract above). Never throws.
 *
 * Peers: the tenant's currently-`active` lessons, so "conflicts with an existing
 * active lesson" is detectable. Deliberately NOT scope-filtered — a `global`
 * lesson can absolutely contradict a `role` one, and that contradiction is
 * exactly what should pull a grade down. A peer-load error is not fatal: we grade
 * WITHOUT the conflict signal rather than skipping the grade, and the missing
 * signal can only push a grade up, which the prompt's grade-downward bias and the
 * human review of anything non-`high` still cover.
 */
export async function gradeLessonCandidate(
  deps: ConfidenceDeps,
  args: { tenantId: string; lesson: LessonForGrading },
): Promise<GradedConfidence | null> {
  try {
    const activeBodies = await loadActiveBodies(deps.db, args.tenantId);
    const raw = await deps.gradeLesson(buildConfidenceInput(args.lesson, activeBodies));
    if (!raw) return null;
    return normalizeGrade(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[lesson-confidence] grading failed, leaving ungraded: ${msg.slice(0, 200)}`);
    return null;
  }
}

/** The tenant's active lesson bodies, capped. Tenant-scoped: this set is spliced
 *  into a model prompt, so a foreign row here would put another tenant's text in
 *  front of our model. */
async function loadActiveBodies(db: SupabaseClient, tenantId: string): Promise<string[]> {
  const { data, error } = await db
    .from("agent_learnings")
    .select("body")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .limit(CONFIDENCE_PEER_CAP);
  if (error) {
    console.warn(`[lesson-confidence] active-peer load failed: ${error.message}`);
    return [];
  }
  return (data ?? [])
    .map((r) => (r as { body: string }).body)
    .filter((b) => typeof b === "string" && b.length > 0)
    .slice(0, CONFIDENCE_PEER_CAP);
}

// ── Stored-row grading (the backfill path) ──────────────────────────────────

export type GradeStoredResult =
  | { ok: true; status: "graded"; grade: GradedConfidence }
  | { ok: true; status: "skipped"; reason: "already-graded" | "not-graded" }
  | { ok: false; reason: string };

type LearningRow = {
  id: string;
  body: string;
  scope: string;
  role_slug: string | null;
  category: string;
  confidence: string | null;
  source_mistake_id: string | null;
};

/**
 * Grade one ALREADY-STORED lesson and write the grade back. Idempotent: a row
 * that already carries a confidence is skipped unless `regrade` is set.
 *
 * Used by the backfill over the existing queue. The go-forward path does NOT use
 * this — it grades BEFORE insert (see extract-batch.ts) because the auto-approve
 * threshold decision needs the grade at the insert seam.
 */
export async function gradeStoredLesson(
  deps: ConfidenceDeps,
  args: { tenantId: string; learningId: string; regrade?: boolean; dryRun?: boolean },
): Promise<GradeStoredResult> {
  const { tenantId, learningId } = args;
  try {
    const { data: row, error } = await deps.db
      .from("agent_learnings")
      .select("id, body, scope, role_slug, category, confidence, source_mistake_id")
      .eq("id", learningId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) return { ok: false, reason: `lesson-load:${error.message}` };
    if (!row) return { ok: false, reason: "lesson-not-found" };
    const lesson = row as LearningRow;

    if (lesson.confidence && !args.regrade) {
      return { ok: true, status: "skipped", reason: "already-graded" };
    }

    const source = await loadSourceMistake(deps.db, tenantId, lesson.source_mistake_id);
    const grade = await gradeLessonCandidate(deps, {
      tenantId,
      lesson: {
        body: lesson.body,
        scope: lesson.scope,
        roleSlug: lesson.role_slug,
        category: lesson.category,
        evidence: source.evidence,
        mistakeType: source.type,
      },
    });
    // Fail-open: no grade ⇒ leave the row exactly as it was (ungraded, or its
    // prior grade under --regrade). Never write a placeholder.
    if (!grade) return { ok: true, status: "skipped", reason: "not-graded" };

    if (args.dryRun) return { ok: true, status: "graded", grade };

    const { error: upErr } = await deps.db
      .from("agent_learnings")
      .update({ confidence: grade.confidence, confidence_reason: grade.reason })
      .eq("id", learningId)
      .eq("tenant_id", tenantId);
    if (upErr) return { ok: false, reason: `update:${upErr.message}` };

    return { ok: true, status: "graded", grade };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

/** The source mistake's evidence/type, when the lesson has one. Tenant-scoped;
 *  a miss (deleted mistake, hand-authored preference) is not an error — the
 *  grader is told there is no evidence, which is itself a grading signal. */
async function loadSourceMistake(
  db: SupabaseClient,
  tenantId: string,
  sourceMistakeId: string | null,
): Promise<{ evidence: Record<string, unknown> | null; type: string | null }> {
  if (!sourceMistakeId) return { evidence: null, type: null };
  try {
    const { data, error } = await db
      .from("agent_mistakes")
      .select("type, evidence")
      .eq("id", sourceMistakeId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error || !data) return { evidence: null, type: null };
    const row = data as { type: string | null; evidence: Record<string, unknown> | null };
    return { evidence: row.evidence ?? null, type: row.type ?? null };
  } catch {
    return { evidence: null, type: null };
  }
}

export type ConfidenceBackfillResult = {
  tenantId: string;
  scanned: number;
  graded: number;
  skipped: number;
  failures: number;
};

/**
 * Backfill: grade every candidate lesson in a tenant. Idempotent — an
 * already-graded row is skipped unless `regrade` is set, so a re-run (or a run
 * overlapping the go-forward path) re-grades nothing and costs no tokens.
 *
 * Scoped to `status='candidate'` on purpose: grading exists to triage the REVIEW
 * QUEUE. An already-active lesson has been through a human (or a threshold), and
 * retro-grading it would imply the grade gates something it does not.
 *
 * Service-role with the tenant PRE-VALIDATED by the caller (the CLI derives it
 * from a --tenant arg; there is no session there).
 */
export async function backfillTenantConfidence(
  deps: ConfidenceDeps,
  args: {
    tenantId: string;
    dryRun?: boolean;
    regrade?: boolean;
    onProgress?: (scanned: number, total: number, grade: GradeStoredResult) => void;
  },
): Promise<ConfidenceBackfillResult> {
  const { tenantId } = args;
  let query = deps.db
    .from("agent_learnings")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "candidate");
  // Without --regrade, skip already-graded rows in SQL so the scan does not even
  // load them (the per-row check below is still the authority).
  if (!args.regrade) query = query.is("confidence", null);
  const { data: rows, error } = await query;
  if (error) throw new Error(`backfill lessons-load: ${error.message}`);
  const ids = (rows ?? []).map((r) => (r as { id: string }).id);

  const result: ConfidenceBackfillResult = {
    tenantId,
    scanned: 0,
    graded: 0,
    skipped: 0,
    failures: 0,
  };
  for (const learningId of ids) {
    const r = await gradeStoredLesson(deps, {
      tenantId,
      learningId,
      regrade: args.regrade,
      dryRun: args.dryRun,
    });
    result.scanned += 1;
    if (!r.ok) result.failures += 1;
    else if (r.status === "graded") result.graded += 1;
    else result.skipped += 1;
    args.onProgress?.(result.scanned, ids.length, r);
  }
  return result;
}
