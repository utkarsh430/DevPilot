"use server";

// Server actions for the learning review queue (`(app)/learnings`) and the Agent
// preferences page (`/settings/agent-preferences`). Both surfaces mount onto this
// one action set, per the plan — the queue reviews candidates, Preferences CRUDs
// user-scope lessons, and both share the same status-flip / edit path.
//
// ── "use server" async-only-export rule (respected) ──
// EVERY exported symbol in this file is a browser-callable endpoint, so every one
// is an async server action that derives `tenantId` from the SESSION
// (`requireTenantId()`), never a helper taking a raw tenantId. The raw-tenantId DB
// logic lives in the plain `lib/learning/write.ts` module (imported, not
// re-exported), which is why THIS file exposes no tenant-taking function an
// attacker could call with someone else's id.
//
// ── Security ──
// Writes go through `supabaseService()` because `agent_learnings` denies all JWT
// writes by design (the human-review gate is the whole safety story — see the
// migration header). The service client bypasses RLS, so `write.ts` carries the
// `.eq("tenant_id", tenantId)` that is the entire write-side tenant boundary.
// Operator-gated with plain `requireUser()` + `requireTenantId()` — NOT
// `isInstanceOperator`, which checks the install's FIRST tenant, not the caller's.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import {
  isLearningAutoApproveThreshold,
  LEARNING_AUTO_APPROVE_CONFIG_KEY,
} from "@/lib/learning/auto-approve";
import { BULK_MAX_IDS, bulkTransitionLearnings } from "@/lib/learning/bulk";
import {
  createUserLesson,
  editLearningBody,
  setTenantConfigKey,
  transitionLearningStatus,
} from "@/lib/learning/write";

export type LearningActionResult = { ok: true } | { ok: false; error: string };
export type CreateLessonActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; duplicateBody?: string };

const IdInput = z.object({ id: z.string().uuid() });
const EditInput = z.object({
  id: z.string().uuid(),
  body: z.string().min(1).max(4000),
  category: z.string().max(64).optional(),
});
const CreateInput = z.object({
  body: z.string().min(1).max(4000),
  category: z.string().max(64).optional(),
});

/** Refresh both surfaces the value feeds after any write. */
function revalidateLearningSurfaces() {
  revalidatePath("/learnings");
  revalidatePath("/settings/agent-preferences");
}

/** Approve a candidate → `active`, stamping the operator as the approver. */
export async function approveLearningAction(input: { id: string }): Promise<LearningActionResult> {
  const parsed = IdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid id" };
  const user = await requireUser();
  const tenantId = await requireTenantId();
  const res = await transitionLearningStatus(supabaseService(), {
    id: parsed.data.id,
    tenantId,
    status: "active",
    approvedBy: user.email ?? user.id,
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidateLearningSurfaces();
  return { ok: true };
}

/**
 * Reject a candidate → `rejected`.
 *
 * Distinct from `archived`, and the distinction is now load-bearing: a `rejected`
 * body DOES feed the extractor's dedupe, so the same lesson is not put back in the
 * queue — but on a deliberately STRICTER basis than an active lesson, matching
 * only a near-exact restatement (`isRejectedRestatement`, `lib/learning/extract.ts`).
 * A materially different formulation of the same subject is still allowed through,
 * because rejecting one phrasing must not blacklist the underlying idea forever.
 *
 * Two things it does NOT do, both on purpose: rejected lessons are never handed to
 * the semantic LLM judge (whose premise — "an agent following this already does
 * what the candidate asks" — is false of a lesson in force nowhere), and they do
 * not block the operator hand-authoring a preference via `createUserLessonAction`
 * (he is the one who rejected it; typing it now is a deliberate reversal, not an
 * accidental re-offer, and that path's dedupe exists to stop double-inserting an
 * ACTIVE preference).
 */
export async function rejectLearningAction(input: { id: string }): Promise<LearningActionResult> {
  const parsed = IdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid id" };
  await requireUser();
  const tenantId = await requireTenantId();
  const res = await transitionLearningStatus(supabaseService(), {
    id: parsed.data.id,
    tenantId,
    status: "rejected",
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidateLearningSurfaces();
  return { ok: true };
}

/** Edit a lesson's body (+ optional category). Provenance/status untouched. */
export async function editLearningAction(input: {
  id: string;
  body: string;
  category?: string;
}): Promise<LearningActionResult> {
  const parsed = EditInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  await requireUser();
  const tenantId = await requireTenantId();
  const res = await editLearningBody(supabaseService(), {
    id: parsed.data.id,
    tenantId,
    body: parsed.data.body,
    category: parsed.data.category,
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidateLearningSurfaces();
  return { ok: true };
}

/** Archive a lesson → `archived` (terminal; used by the Preferences page). */
export async function archiveLearningAction(input: { id: string }): Promise<LearningActionResult> {
  const parsed = IdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid id" };
  await requireUser();
  const tenantId = await requireTenantId();
  const res = await transitionLearningStatus(supabaseService(), {
    id: parsed.data.id,
    tenantId,
    status: "archived",
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidateLearningSurfaces();
  return { ok: true };
}

/** Create a hand-authored user-scope preference (active, dedupe-checked). */
export async function createUserLessonAction(input: {
  body: string;
  category?: string;
}): Promise<CreateLessonActionResult> {
  const parsed = CreateInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  const user = await requireUser();
  const tenantId = await requireTenantId();
  const res = await createUserLesson(supabaseService(), {
    tenantId,
    body: parsed.data.body,
    category: parsed.data.category,
    createdBy: user.id,
  });
  if (!res.ok) {
    return {
      ok: false,
      error: res.error,
      ...(res.existingBody ? { duplicateBody: res.existingBody } : {}),
    };
  }
  revalidateLearningSurfaces();
  return { ok: true, id: res.id };
}

/**
 * Toggle the per-tenant learning auto-approve flag (tenants.config jsonb).
 *
 * Now that the setting is a THRESHOLD, this simple on/off toggle writes the
 * SAFEST enabled value, `'high_only'` — matching how a legacy stored `true` is
 * read (`normalizeLearningAutoApproveThreshold`), so the toggle and the legacy
 * data mean the same thing. An operator who wants the wider `'high_and_medium'`
 * picks it explicitly via `setLearningAutoApproveThresholdAction`.
 */
export async function setLearningAutoApproveAction(input: {
  enabled: boolean;
}): Promise<LearningActionResult> {
  if (typeof input?.enabled !== "boolean") return { ok: false, error: "invalid" };
  await requireUser();
  const tenantId = await requireTenantId();
  const res = await setTenantConfigKey(supabaseService(), {
    tenantId,
    key: LEARNING_AUTO_APPROVE_CONFIG_KEY,
    value: input.enabled ? "high_only" : "off",
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidateLearningSurfaces();
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lesson confidence grading — auto-approve threshold
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set the per-tenant learning auto-approve THRESHOLD.
 *
 *   'off'             — every candidate queues for human review (default).
 *   'high_only'       — only `high`-graded candidates skip the queue.
 *   'high_and_medium' — `high` and `medium` skip the queue.
 *
 * An UNGRADED candidate never auto-approves at any threshold — the enforcement
 * lives at the single extractor insert seam (`clearsAutoApproveThreshold` in
 * `extract-batch.ts`), not here; this action only records the operator's choice.
 * A legacy stored boolean `true` reads as `'high_only'` (strictly safer than the
 * blanket approve it used to mean), so no data migration is needed.
 */
export async function setLearningAutoApproveThresholdAction(input: {
  threshold: string;
}): Promise<LearningActionResult> {
  if (!isLearningAutoApproveThreshold(input?.threshold)) {
    return { ok: false, error: "invalid threshold" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const res = await setTenantConfigKey(supabaseService(), {
    tenantId,
    key: LEARNING_AUTO_APPROVE_CONFIG_KEY,
    value: input.threshold,
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidateLearningSurfaces();
  return { ok: true };
}

/* ══════════════════════════════════════════════════════════════════════════
 * BULK ACTIONS (lessons table view)
 * ══════════════════════════════════════════════════════════════════════════
 * Multi-row Accept / Reject for the table view, so an operator with dozens of
 * candidates hand-decides only the ones that genuinely need it.
 *
 * They follow `approveLearningAction` / `rejectLearningAction` EXACTLY — Zod on
 * the input, `requireUser()` + `requireTenantId()`, a `supabaseService()` write
 * whose co-located `.eq("tenant_id", tenantId)` (in `lib/learning/bulk.ts`) is
 * the entire tenant boundary. The tenantId comes from the SESSION and is never
 * accepted from the client; the id list IS client-supplied and therefore
 * attacker-controllable, which is exactly why the tenant predicate rides
 * alongside it.
 *
 * WHICH rows a confidence-based button targets is decided CLIENT-side by the
 * pure `confidenceBulkTargets` (`lib/learning/table-view.ts`), which structurally
 * excludes ungraded (`confidence IS NULL`) rows. This layer stays a dumb,
 * id-scoped flip on purpose: it must not grow a second, drifting copy of the
 * selection policy.
 */

const BulkIdsInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(BULK_MAX_IDS),
});

export type BulkApproveActionResult = { ok: true; approved: number } | { ok: false; error: string };
export type BulkRejectActionResult = { ok: true; rejected: number } | { ok: false; error: string };

/** Approve many candidates → `active` in one statement. `approved` is the count
 *  that ACTUALLY changed, not the count requested. */
export async function bulkApproveLearningsAction(input: {
  ids: string[];
}): Promise<BulkApproveActionResult> {
  const parsed = BulkIdsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid selection" };
  const user = await requireUser();
  const tenantId = await requireTenantId();
  const res = await bulkTransitionLearnings(supabaseService(), {
    ids: parsed.data.ids,
    tenantId,
    status: "active",
    approvedBy: user.email ?? user.id,
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidateLearningSurfaces();
  return { ok: true, approved: res.updated };
}

/** Reject many lessons → `rejected` in one statement. */
export async function bulkRejectLearningsAction(input: {
  ids: string[];
}): Promise<BulkRejectActionResult> {
  const parsed = BulkIdsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid selection" };
  await requireUser();
  const tenantId = await requireTenantId();
  const res = await bulkTransitionLearnings(supabaseService(), {
    ids: parsed.data.ids,
    tenantId,
    status: "rejected",
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidateLearningSurfaces();
  return { ok: true, rejected: res.updated };
}
