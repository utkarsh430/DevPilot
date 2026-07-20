// The DI'd extraction orchestration: read an `agent_mistakes` row through an
// injected client, call the (injected) model to draft a candidate lesson,
// ground + dedupe it, and insert it into `agent_learnings` as `status='candidate'`.
//
// ── Why this file has no `server-only` (and why it's split from extract.server.ts) ──
// Every IO dependency arrives as an argument (`ExtractDeps.db`,
// `ExtractDeps.generateCandidate`), so this module is unit-testable with a fake
// client and a stubbed model — the same DI split harvest-batch.ts /
// harvest.server.ts uses. `extract.server.ts` is the `server-only` twin that
// wires the real service client + the LLM (`generateObjectForTenant`). Tests
// import from HERE.
//
// Idempotency (two layers)
// ────────────────────────
//   1. Per-mistake: before drafting, we check `agent_learnings` for an existing
//      row with this `source_mistake_id`. One candidate per mistake — a re-fire
//      of the go-forward hook or a backfill overlap re-drafts nothing.
//   2. Body dedupe: a fresh candidate is compared (Jaccard) against existing
//      lessons for the SAME (tenant, scope, role); a near-duplicate is skipped so
//      the review queue never fills with restatements of one lesson. TWO peer
//      sets, matched on DIFFERENT bases and never pooled:
//        • active + candidate — lessons IN FORCE. Broad matching (Jaccard 0.5 +
//          the semantic LLM judge): a paraphrase adds nothing an agent isn't
//          already told, so suppressing it costs nothing.
//        • rejected — the operator's own declined lessons. STRICT matching
//          (Jaccard 0.8, no semantic judge), so a rejection suppresses re-offering
//          the SAME lesson without blacklisting the underlying subject forever.
//          Full reasoning on `isRejectedRestatement` in extract.ts.
//        • archived is in NEITHER set — a retired lesson may legitimately become
//          relevant again.
//
// Security (load-bearing) — mirrors harvest-batch.ts
// ──────────────────────────────────────────────────
// Reads run on the SERVICE client (RLS off), so tenant isolation is carried by
// the `.eq("tenant_id", tenantId)` written into each query. `tenantId` is proved
// against the mistake row first, then threaded into every subsequent read AND the
// insert. The `agent_learnings` assert_tenant_matches_parent trigger is the
// second line of defence at write time. Evidence fed to the model is UNTRUSTED
// and is fenced + redacted by the pure `buildExtractionPrompt` / `redactEvidence`
// before it ever reaches the LLM.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildDedupCheckInput,
  buildExtractionInput,
  DEDUPE_PEER_CAP,
  isDuplicateBody,
  isRejectedRestatement,
  normalizeCandidate,
  normalizeDedupVerdict,
  type DedupCheckInput,
  type ExtractionInput,
  type LessonCandidate,
  type MistakeForExtraction,
  type RawDedupVerdict,
  type RawLessonCandidate,
} from "@/lib/learning/extract";
import {
  AUTO_APPROVE_APPROVER,
  clearsAutoApproveThreshold,
  type LearningAutoApproveThreshold,
} from "@/lib/learning/auto-approve";
import type { GradedConfidence, LessonForGrading } from "@/lib/learning/confidence";
import type { MistakeType } from "@/lib/learning/harvest";

export type ExtractDeps = {
  db: SupabaseClient;
  /**
   * The model call. Returns the raw (post-Zod, pre-grounding) candidate, or
   * `null` on ANY failure/timeout/unparseable reply. Injected so the whole
   * pipeline runs in tests without a live model, and so a downed runner degrades
   * to "no candidate this round" rather than throwing.
   */
  generateCandidate: (input: ExtractionInput) => Promise<RawLessonCandidate | null>;
  /**
   * Semantic-dedup judge (stage 2). Given the candidate body + the numbered peer
   * bodies, returns the raw verdict, or `null` on ANY failure/timeout — same
   * fail-open contract as `generateCandidate`, so a downed runner degrades dedup
   * to Jaccard-only rather than throwing or blocking the insert. Optional: when
   * absent, only the stage-1 Jaccard pass runs (used by callers that don't wire
   * the LLM, and by the dry-run/tests that stub it explicitly).
   */
  checkSemanticDuplicate?: (input: DedupCheckInput) => Promise<RawDedupVerdict | null>;
  /**
   * Resolve the tenant's learning auto-approve THRESHOLD. A fresh candidate is
   * inserted as `status='active'`/`approved_by='auto_approve'` only when its
   * GRADE clears that threshold (`clearsAutoApproveThreshold`); everything else —
   * including every UNGRADED candidate — lands `status='candidate'`. Optional:
   * absent ⇒ `'off'` (always candidate), today's byte-for-byte behaviour.
   * Injected so `extract-batch.ts` stays free of `server-only`.
   */
  resolveAutoApprove?: (tenantId: string) => Promise<LearningAutoApproveThreshold>;
  /**
   * Grade the drafted candidate's confidence (high | medium | low), or `null` to
   * leave it UNGRADED. Fail-open by contract: any model failure/timeout/DB error
   * returns `null` and extraction proceeds — a grading outage must never fail or
   * block extraction, and an ungraded candidate simply never auto-approves.
   * Optional: absent ⇒ ungraded (callers that don't wire the LLM, and tests).
   */
  gradeCandidate?: (lesson: LessonForGrading) => Promise<GradedConfidence | null>;
};

export type ExtractResult =
  | { ok: true; status: "inserted"; candidate: LessonCandidate; grade: GradedConfidence | null }
  | {
      ok: true;
      status: "skipped";
      reason: "already-extracted" | "duplicate" | "rejected-restatement" | "no-candidate";
    }
  | { ok: false; reason: string };

type MistakeRow = {
  id: string;
  type: MistakeType;
  role: string;
  severity: number;
  evidence: Record<string, unknown> | null;
  corrected_by: Record<string, unknown> | null;
};

function toMistake(row: MistakeRow): MistakeForExtraction {
  return {
    id: row.id,
    type: row.type,
    role: row.role,
    severity: row.severity ?? 1,
    evidence: row.evidence ?? null,
    correctedBy: row.corrected_by ?? null,
  };
}

/**
 * Extract one candidate lesson for one mistake. Never throws — extraction is
 * best-effort and must not fail the run/hook that triggered it.
 */
export async function extractMistakeLesson(
  deps: ExtractDeps,
  args: { tenantId: string; mistakeId: string; dryRun?: boolean },
): Promise<ExtractResult> {
  const { tenantId, mistakeId } = args;
  try {
    const { db } = deps;

    // The mistake — proves the tenant and supplies the extraction input.
    const { data: mistakeRow, error: mErr } = await db
      .from("agent_mistakes")
      .select("id, type, role, severity, evidence, corrected_by")
      .eq("id", mistakeId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (mErr) return { ok: false, reason: `mistake-load:${mErr.message}` };
    if (!mistakeRow) return { ok: false, reason: "mistake-not-found" };
    const mistake = toMistake(mistakeRow as MistakeRow);

    // Idempotency 1: one candidate per source mistake.
    const { data: existingForMistake, error: exErr } = await db
      .from("agent_learnings")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("source_mistake_id", mistakeId)
      .limit(1);
    if (exErr) return { ok: false, reason: `existing-load:${exErr.message}` };
    if ((existingForMistake ?? []).length > 0) {
      return { ok: true, status: "skipped", reason: "already-extracted" };
    }

    // Draft (the only network hop; DI'd so tests skip it).
    const raw = await deps.generateCandidate(buildExtractionInput(mistake));
    if (!raw) return { ok: true, status: "skipped", reason: "no-candidate" };

    const candidate = normalizeCandidate(raw, mistake);
    if (!candidate) return { ok: true, status: "skipped", reason: "no-candidate" };

    // Idempotency 2: body dedupe against existing lessons in the SAME
    // (tenant, scope, role). role_slug is null for global/user, so the `.is`/`.eq`
    // below scopes the comparison set exactly as the DB CHECK does.
    //
    // THREE statuses are loaded, but they are NOT one pool — `rejected` peers are
    // partitioned out below and matched on a different, much stricter basis (see
    // `isRejectedRestatement`). `archived` is deliberately absent: see the note on
    // the partition below.
    let dupQuery = db
      .from("agent_learnings")
      .select("body, status")
      .eq("tenant_id", tenantId)
      .eq("scope", candidate.scope)
      .in("status", ["active", "candidate", "rejected"]);
    dupQuery =
      candidate.roleSlug === null
        ? dupQuery.is("role_slug", null)
        : dupQuery.eq("role_slug", candidate.roleSlug);
    const { data: peers, error: peersErr } = await dupQuery;
    if (peersErr) return { ok: false, reason: `dedupe-load:${peersErr.message}` };

    // Partition, and cap EACH side at DEDUPE_PEER_CAP independently — a bucket
    // with many rejections must not crowd the in-force lessons out of the
    // comparison (or out of the semantic judge's prompt, which sees only these).
    //
    // `archived` is excluded from BOTH sets, preserving today's behaviour exactly.
    // It is a distinct fact from `rejected` and the code has always kept them
    // apart: archived means a lesson WAS in force and has been retired, usually
    // because circumstances moved on (the practice got automated, the stack
    // changed). That is not a judgement that the lesson was wrong, and a mistake
    // recurring after retirement is real signal that it is relevant again — so
    // re-surfacing it for a fresh decision is the correct outcome, not noise.
    const peerRows = (peers ?? []) as { body: string; status: string }[];
    const existingBodies = peerRows
      .filter((p) => p.status !== "rejected")
      .map((p) => p.body)
      .slice(0, DEDUPE_PEER_CAP);
    const rejectedBodies = peerRows
      .filter((p) => p.status === "rejected")
      .map((p) => p.body)
      .slice(0, DEDUPE_PEER_CAP);

    // Stage 1: free, instant lexical dedupe against lessons that are IN FORCE.
    if (isDuplicateBody(candidate.body, existingBodies)) {
      return { ok: true, status: "skipped", reason: "duplicate" };
    }

    // Stage 1b: the operator's own rejections. Strict threshold — this suppresses
    // re-offering the SAME lesson he already declined, never the same subject.
    // Logged, because unlike a dup of an active lesson this drops a candidate that
    // exists nowhere in the system, and that should be auditable.
    if (isRejectedRestatement(candidate.body, rejectedBodies)) {
      console.warn(
        `[learning-extract] mistake=${mistakeId} suppressed as a restatement of a ` +
          `REJECTED lesson: ${candidate.body.slice(0, 120)}`,
      );
      return { ok: true, status: "skipped", reason: "rejected-restatement" };
    }

    // Stage 2: semantic dedupe (LLM judge), only when stage 1 did NOT flag a dup
    // AND there are peers to compare against AND the judge is wired. Fail-open:
    // a `null` verdict (downed runner / timeout / malformed reply) inserts, so
    // dedup degrades to Jaccard-only under load rather than blocking.
    if (deps.checkSemanticDuplicate && existingBodies.length > 0) {
      const raw = await deps.checkSemanticDuplicate(
        buildDedupCheckInput(candidate.body, existingBodies),
      );
      const dupIndex = normalizeDedupVerdict(raw, existingBodies.length);
      if (dupIndex !== null) {
        // Auditable: the counters can't distinguish a lexical from a semantic
        // suppression, and a semantic false-positive silently drops a candidate
        // before any human sees it, so log which mistake was dropped as a dup of
        // which existing body.
        console.warn(
          `[learning-extract] mistake=${mistakeId} semantically de-duplicated ` +
            `against existing lesson: ${existingBodies[dupIndex]?.slice(0, 120)}`,
        );
        return { ok: true, status: "skipped", reason: "duplicate" };
      }
    }

    // Grade the candidate. This happens BEFORE the insert, not after, precisely
    // because the auto-approve decision below needs the grade: the threshold gate
    // and the insert must be ONE statement, or a candidate would briefly exist
    // ungraded-and-active and a crash between the two would strand it there.
    // Fail-open — `null` (no grader wired, downed runner, timeout, bad reply)
    // means the row lands UNGRADED, which never auto-approves.
    // The local try/catch is deliberate and is NOT redundant with the function's
    // outer one: the outer catch would turn a throwing grader into a FAILED
    // extraction (no lesson recorded at all), which is exactly what the fail-open
    // contract forbids. `gradeLessonCandidate` already returns null rather than
    // throwing; this covers any other injected implementation.
    let grade: GradedConfidence | null = null;
    if (deps.gradeCandidate) {
      try {
        grade = await deps.gradeCandidate({
          body: candidate.body,
          scope: candidate.scope,
          roleSlug: candidate.roleSlug,
          category: candidate.category,
          evidence: mistake.evidence,
          mistakeType: mistake.type,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[learning-extract] mistake=${mistakeId} grading threw, leaving ungraded: ${msg.slice(0, 200)}`,
        );
        grade = null;
      }
    }

    if (args.dryRun) return { ok: true, status: "inserted", candidate, grade };

    // Auto-approve: resolve the tenant THRESHOLD at the single insert seam. The
    // candidate skips the review queue as `active` (machine approver) only if its
    // grade clears that threshold; `'off'`, an unwired resolver, a sub-threshold
    // grade, or NO grade at all ⇒ `candidate`, i.e. a human still reviews it.
    const threshold = deps.resolveAutoApprove
      ? await deps.resolveAutoApprove(tenantId)
      : ("off" as const);
    const autoApprove = clearsAutoApproveThreshold(threshold, grade?.confidence ?? null);
    const { error: insErr } = await db
      .from("agent_learnings")
      .insert(toRow(candidate, tenantId, autoApprove, grade));
    if (insErr) return { ok: false, reason: `insert:${insErr.message}` };

    return { ok: true, status: "inserted", candidate, grade };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[learning-extract] mistake=${mistakeId} failed: ${msg.slice(0, 200)}`);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

function toRow(
  c: LessonCandidate,
  tenantId: string,
  autoApprove: boolean,
  grade: GradedConfidence | null,
) {
  return {
    // NULL confidence means NOT YET GRADED and is never defaulted — the review UI
    // must be able to show "ungraded", and an ungraded row never auto-approves.
    confidence: grade?.confidence ?? null,
    confidence_reason: grade?.reason ?? null,
    tenant_id: tenantId,
    scope: c.scope,
    role_slug: c.roleSlug,
    category: c.category,
    body: c.body,
    // Auto-approve lands the lesson `active` with a machine approver so it skips
    // the review queue; otherwise it queues as a `candidate` for a human.
    status: autoApprove ? ("active" as const) : ("candidate" as const),
    source_mistake_id: c.sourceMistakeId,
    created_by: "lesson_extractor",
    approved_by: autoApprove ? AUTO_APPROVE_APPROVER : null,
  };
}

export type TicketExtractResult = {
  mistakesConsidered: number;
  inserted: number;
  skipped: number;
  failures: number;
};

/**
 * Extract candidate lessons for every mistake recorded on one ticket. Called
 * go-forward as a step AFTER harvest on `agent/run.completed` (so the mistakes
 * exist), and reusable by the backfill per ticket. Best-effort: a failure on one
 * mistake never blocks the others or the run.
 */
export async function extractTicketLessons(
  deps: ExtractDeps,
  args: { tenantId: string; ticketId: string; dryRun?: boolean },
): Promise<TicketExtractResult> {
  const { tenantId, ticketId } = args;
  const out: TicketExtractResult = {
    mistakesConsidered: 0,
    inserted: 0,
    skipped: 0,
    failures: 0,
  };
  const { data: rows, error } = await deps.db
    .from("agent_mistakes")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("ticket_id", ticketId);
  if (error) {
    console.warn(`[learning-extract] ticket=${ticketId} mistakes-load: ${error.message}`);
    return out;
  }
  for (const row of rows ?? []) {
    out.mistakesConsidered += 1;
    const r = await extractMistakeLesson(deps, {
      tenantId,
      mistakeId: (row as { id: string }).id,
      dryRun: args.dryRun,
    });
    if (!r.ok) out.failures += 1;
    else if (r.status === "inserted") out.inserted += 1;
    else out.skipped += 1;
  }
  return out;
}

export type LessonBackfillResult = {
  tenantId: string;
  mistakesScanned: number;
  lessonsInserted: number;
  skipped: number;
  failures: number;
};

/**
 * One-time (re-runnable) backfill: extract a candidate lesson from every mistake
 * in a tenant. Idempotent via the per-mistake source check + body dedupe, so a
 * second run — or a run after the go-forward path already drafted some — inserts
 * nothing new. Scoped per tenant, service-role with the tenant PRE-VALIDATED by
 * the caller (the CLI derives it from a --tenant arg; there is no session here).
 */
export async function backfillTenantLessons(
  deps: ExtractDeps,
  args: {
    tenantId: string;
    dryRun?: boolean;
    onProgress?: (scanned: number, total: number) => void;
  },
): Promise<LessonBackfillResult> {
  const { tenantId } = args;
  const { data: rows, error } = await deps.db
    .from("agent_mistakes")
    .select("id")
    .eq("tenant_id", tenantId);
  if (error) throw new Error(`backfill mistakes-load: ${error.message}`);
  const ids = (rows ?? []).map((r) => (r as { id: string }).id);

  const result: LessonBackfillResult = {
    tenantId,
    mistakesScanned: 0,
    lessonsInserted: 0,
    skipped: 0,
    failures: 0,
  };
  for (const mistakeId of ids) {
    const r = await extractMistakeLesson(deps, { tenantId, mistakeId, dryRun: args.dryRun });
    result.mistakesScanned += 1;
    if (!r.ok) result.failures += 1;
    else if (r.status === "inserted") result.lessonsInserted += 1;
    else result.skipped += 1;
    args.onProgress?.(result.mistakesScanned, ids.length);
  }
  return result;
}
