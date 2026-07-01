// Learning auto-approve — the per-tenant choice of whether freshly extracted
// candidate lessons land as `active` (no review) or `candidate` (queued for the
// review queue).
//
// ── It is now a THRESHOLD, not a boolean ──
//
//   'off'             (DEFAULT) — every extracted lesson lands `status='candidate'`
//                                 and must be approved in the review queue before
//                                 PR 4 can feed it forward. The human-review gate
//                                 is fully on.
//   'high_only'                 — only lessons the grader marked `high` skip the
//                                 queue. Everything else (medium, low, and
//                                 anything UNGRADED) still queues.
//   'high_and_medium'           — `high` and `medium` skip the queue; `low` and
//                                 ungraded still queue.
//
// An UNGRADED lesson (confidence null — a downed runner, a timeout, a row from
// before grading shipped) NEVER auto-approves at any threshold. "We have not
// looked at this yet" is not "it is fine"; see `clearsAutoApproveThreshold`.
//
// ── Back-compat is load-bearing ──
// The stored value used to be a plain boolean. A legacy `true` reads as
// `'high_only'`, NOT as a blanket approve — i.e. an existing opted-in tenant gets
// STRICTLY SAFER behaviour after this migration than before it, with no operator
// action and no data migration. `false`, absent, malformed, or anything
// unrecognised reads as `'off'`, so a fresh install and a corrupt config both
// keep the review gate on.
//
// This module is PURE — no `server-only`, no DB, no `process.env` — mirroring
// `lib/llm/auth-mode.ts` so both the client toggle and the server resolver import
// the same normaliser. The DB-backed resolver lives in `auto-approve.server.ts`.

import type { LessonConfidence } from "@/lib/learning/confidence";

/** The `tenants.config` jsonb key this setting is stored under. Kept here so the
 *  reader, the writer (server action), and any doc reference the same literal.
 *  Unchanged across the boolean → threshold move: the same key now holds either
 *  shape, and `normalizeLearningAutoApproveThreshold` reads both. */
export const LEARNING_AUTO_APPROVE_CONFIG_KEY = "learning_auto_approve";

export const LEARNING_AUTO_APPROVE_THRESHOLDS = ["off", "high_only", "high_and_medium"] as const;
export type LearningAutoApproveThreshold = (typeof LEARNING_AUTO_APPROVE_THRESHOLDS)[number];

const THRESHOLD_SET: ReadonlySet<string> = new Set(LEARNING_AUTO_APPROVE_THRESHOLDS);

/** Absent / unset / malformed resolves here, so a fresh install — and a corrupt
 *  config — keeps the human-review gate fully ON with zero configuration. */
export const DEFAULT_LEARNING_AUTO_APPROVE_THRESHOLD: LearningAutoApproveThreshold = "off";

/** The literal author stamped on `approved_by` for an auto-approved lesson, so
 *  the queue / preferences surfaces can tell an operator approval from a machine
 *  one without a schema change. */
export const AUTO_APPROVE_APPROVER = "auto_approve";

/**
 * Coerce an arbitrary stored value (jsonb is `unknown` at the type level) into a
 * threshold.
 *
 *   - A recognised threshold string wins.
 *   - The LEGACY boolean `true` → `'high_only'`. This is the back-compat rule and
 *     it is deliberately the STRICTER reading: the old `true` meant "approve
 *     everything unreviewed", and silently keeping that after grading exists
 *     would waste the entire safety upgrade. An operator who genuinely wants the
 *     wider setting opts into `'high_and_medium'` explicitly.
 *   - EVERYTHING else — `false`, `null`, `undefined`, `0`, `""`, the string
 *     `"true"`, a typo, an object — → `'off'`. A malformed config can never
 *     silently disable the review gate.
 */
export function normalizeLearningAutoApproveThreshold(raw: unknown): LearningAutoApproveThreshold {
  if (typeof raw === "string" && THRESHOLD_SET.has(raw)) {
    return raw as LearningAutoApproveThreshold;
  }
  if (raw === true) return "high_only";
  return DEFAULT_LEARNING_AUTO_APPROVE_THRESHOLD;
}

/** Narrowing guard for the setter action / any form post. */
export function isLearningAutoApproveThreshold(raw: unknown): raw is LearningAutoApproveThreshold {
  return typeof raw === "string" && THRESHOLD_SET.has(raw);
}

/**
 * Does a candidate's grade clear the tenant's threshold — i.e. may it skip the
 * human review queue and land `active`?
 *
 * The `confidence === null` case is the load-bearing one: an UNGRADED lesson
 * never auto-approves, at any threshold. Grading is fail-open (a downed runner
 * leaves the row ungraded), and a fail-open grader that let its own failures
 * auto-approve would be a fail-OPEN safety gate — exactly backwards. Ungraded
 * means "no one, human or machine, has looked at this", so it queues.
 */
export function clearsAutoApproveThreshold(
  threshold: LearningAutoApproveThreshold,
  confidence: LessonConfidence | null | undefined,
): boolean {
  if (!confidence) return false;
  switch (threshold) {
    case "high_only":
      return confidence === "high";
    case "high_and_medium":
      return confidence === "high" || confidence === "medium";
    case "off":
    default:
      return false;
  }
}

/** Legacy boolean view of the setting, for surfaces that still render a simple
 *  on/off toggle. `'off'` ⇒ false; any grading threshold ⇒ true. Prefer the
 *  threshold directly in new code — this exists so the existing toggle keeps
 *  working while the richer control lands. */
export function isAutoApproveEnabled(threshold: LearningAutoApproveThreshold): boolean {
  return threshold !== "off";
}
