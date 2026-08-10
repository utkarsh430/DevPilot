// Mistake derivation. PURE — no IO, no DB. The server wrapper
// (`harvest.server.ts`) loads the rows and calls `deriveMistakes`; this module
// turns those rows into `agent_mistakes` records deterministically, so both the
// go-forward hook and the one-time backfill produce byte-identical results (and
// therefore identical `dedupeKey`s) from the same stored data.
//
// The five signals (all confirmed present in the schema today):
//   • run_failed        ← runs.status = 'failed'
//   • verification_fail ← run_verifications.exit_code > 0
//   • qa_reject         ← the in_review → in_progress reject loop (tickets.retry_count)
//   • gate_refusal      ← a devpilot_qa_gate / devpilot_qa_retry_ceiling /
//                          devpilot_safety_gate park comment
//   • human_correction  ← a human corrective reply that resumed the ticket
//
// Attribution is ALWAYS to the PRODUCER whose work failed/was rejected — never
// the reviewer that caught it — resolved COALESCE(fan_out_role, agents.role) by
// the loader and passed in as `role`. Comment-derived signals have no run FK, so
// they are correlated to their producing run by phase/timestamp (the same
// approach lib/engine/ticket-reconciler.ts uses).

import { redactEvidence } from "@/lib/learning/redact";

export const MISTAKE_TYPES = [
  "verification_fail",
  "qa_reject",
  "run_failed",
  "gate_refusal",
  "human_correction",
] as const;
export type MistakeType = (typeof MISTAKE_TYPES)[number];

/** Only these count toward an agent's future score. human_correction never does
 *  (a redirect is a preference signal, not a mark against the agent). */
export const SCORE_COUNTING_TYPES: ReadonlySet<MistakeType> = new Set([
  "verification_fail",
  "qa_reject",
  "run_failed",
  "gate_refusal",
]);

/** System comment authors that mark an engine gate/ceiling park. */
export const GATE_COMMENT_AUTHORS = [
  "devpilot_qa_gate",
  "devpilot_qa_retry_ceiling",
  "devpilot_safety_gate",
] as const;

/** The system author whose comments record an agent's explicit verdict. */
export const MOVE_COMMENT_AUTHOR = "devpilot_move_ticket";

// ── Inputs (already loaded + role-resolved by the server layer) ─────────────

export type HarvestRun = {
  runId: string;
  agentId: string | null;
  /** COALESCE(fan_out_role, agents.role); null only when neither is known. */
  role: string | null;
  /** The role's onSuccessStatus — 'in_review' = producer, 'done' = reviewer. */
  onSuccessStatus: string | null;
  status: string;
  createdAt: string;
  lastEventAt: string | null;
  /** Optional failure narrative (last run_steps text) for run_failed evidence. */
  failureText?: string | null;
};

export type HarvestVerification = {
  runId: string;
  command: string;
  exitCode: number;
  outputTail: string;
  ranAt: string;
};

export type HarvestComment = {
  id: string;
  authorType: string;
  authorId: string;
  body: string;
  createdAt: string;
};

export type HarvestTicket = {
  ticketId: string;
  tenantId: string;
  retryCount: number;
  status: string;
};

export type HarvestInput = {
  ticket: HarvestTicket;
  runs: HarvestRun[];
  verifications: HarvestVerification[];
  comments: HarvestComment[];
};

/** A derived mistake, ready to upsert into `agent_mistakes`. */
export type DerivedMistake = {
  dedupeKey: string;
  type: MistakeType;
  agentId: string | null;
  role: string;
  runId: string | null;
  countsAgainstScore: boolean;
  severity: number;
  evidence: Record<string, unknown>;
  correctedBy: Record<string, unknown> | null;
};

const isProducer = (r: HarvestRun): boolean => r.onSuccessStatus === "in_review";

/** Fallback attribution role when a run's role could not be resolved. */
const UNATTRIBUTED_ROLE = "unassigned";

function ts(iso: string | null | undefined): number {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(n) ? 0 : n;
}

/**
 * The run active at `iso`, for correlating a comment (which has no run FK) to its
 * producing run. Prefer a run whose [createdAt, lastEventAt] window contains the
 * timestamp; otherwise the most recent run that had started by then. Null when no
 * run had started yet.
 */
export function correlateToRun(iso: string, runs: readonly HarvestRun[]): HarvestRun | null {
  const t = ts(iso);
  const containing = runs
    .filter((r) => ts(r.createdAt) <= t && t <= ts(r.lastEventAt ?? r.createdAt))
    .sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
  if (containing[0]) return containing[0];
  const before = runs
    .filter((r) => ts(r.createdAt) <= t)
    .sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
  return before[0] ?? null;
}

/** The earliest run that started strictly after `iso` — the "how it was fixed"
 *  seed (the run that followed the failure/reject on the same ticket). */
function nextRunAfter(iso: string, runs: readonly HarvestRun[]): HarvestRun | null {
  const t = ts(iso);
  return (
    runs.filter((r) => ts(r.createdAt) > t).sort((a, b) => ts(a.createdAt) - ts(b.createdAt))[0] ??
    null
  );
}

/** Did any verification for this ticket pass (exit 0) after `iso`? */
function reVerificationLanded(iso: string, verifications: readonly HarvestVerification[]): boolean {
  const t = ts(iso);
  return verifications.some((v) => ts(v.ranAt) > t && v.exitCode === 0);
}

/**
 * Derive every mistake for one ticket. Deterministic in its inputs, so re-running
 * over the same stored rows produces the same set with the same dedupeKeys.
 */
export function deriveMistakes(input: HarvestInput): DerivedMistake[] {
  const { ticket, runs, verifications, comments } = input;
  const out: DerivedMistake[] = [];
  const runById = new Map(runs.map((r) => [r.runId, r] as const));

  // ── run_failed ────────────────────────────────────────────────────────────
  for (const r of runs) {
    if (r.status !== "failed") continue;
    out.push({
      dedupeKey: `run_failed:${r.runId}`,
      type: "run_failed",
      agentId: r.agentId,
      role: r.role ?? UNATTRIBUTED_ROLE,
      runId: r.runId,
      countsAgainstScore: true,
      severity: 3,
      evidence: {
        status: "failed",
        ...(r.failureText ? { finalText: redactEvidence(r.failureText) } : {}),
      },
      correctedBy: correctedByRun(nextRunAfter(r.createdAt, runs)),
    });
  }

  // ── verification_fail ───────────────────────────────────────────────────
  for (const v of verifications) {
    if (v.exitCode <= 0) continue; // <0 = indeterminate, 0 = pass
    const r = runById.get(v.runId) ?? null;
    out.push({
      dedupeKey: `verification_fail:${v.runId}`,
      type: "verification_fail",
      agentId: r?.agentId ?? null,
      role: r?.role ?? UNATTRIBUTED_ROLE,
      runId: v.runId,
      countsAgainstScore: true,
      severity: 2,
      evidence: {
        command: redactEvidence(v.command),
        exitCode: v.exitCode,
        outputTail: redactEvidence(v.outputTail),
      },
      correctedBy: {
        ...(correctedByRun(nextRunAfter(r?.createdAt ?? v.ranAt, runs)) ?? {}),
        reVerificationClean: reVerificationLanded(v.ranAt, verifications),
      },
    });
  }

  // ── gate_refusal ──────────────────────────────────────────────────────────
  const gateAuthors = new Set<string>(GATE_COMMENT_AUTHORS);
  for (const c of comments) {
    if (c.authorType !== "system" || !gateAuthors.has(c.authorId)) continue;
    const producer = correlateToRun(c.createdAt, runs);
    out.push({
      dedupeKey: `gate_refusal:${c.id}`,
      type: "gate_refusal",
      agentId: producer?.agentId ?? null,
      role: producer?.role ?? UNATTRIBUTED_ROLE,
      runId: producer?.runId ?? null,
      countsAgainstScore: true,
      severity: c.authorId === "devpilot_safety_gate" ? 3 : 2,
      evidence: { gate: c.authorId, reason: redactEvidence(c.body) },
      correctedBy: correctedByRun(nextRunAfter(c.createdAt, runs)),
    });
  }

  // ── qa_reject ───────────────────────────────────────────────────────────
  // tickets.retry_count is the authoritative COUNT of QA rejects (the move route
  // is its only writer, bumping only on in_review → in_progress). We attribute
  // each to a producer run that handed off and was then superseded by a later
  // run, capped at retry_count so the score total can never exceed the true
  // reject count. Anchoring on the producer run gives a stable dedupeKey and
  // attributes the reject to the producer, not the reviewer.
  const moveComments = comments
    .filter((c) => c.authorType === "system" && c.authorId === MOVE_COMMENT_AUTHOR)
    .sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
  const rejectedProducers = runs
    .filter((r) => isProducer(r) && nextRunAfter(r.createdAt, runs) !== null)
    .sort((a, b) => ts(a.createdAt) - ts(b.createdAt))
    .slice(0, Math.max(0, ticket.retryCount));
  for (const r of rejectedProducers) {
    const rejectComment = moveComments.find(
      (c) => ts(c.createdAt) > ts(r.lastEventAt ?? r.createdAt),
    );
    out.push({
      dedupeKey: `qa_reject:${r.runId}`,
      type: "qa_reject",
      agentId: r.agentId,
      role: r.role ?? UNATTRIBUTED_ROLE,
      runId: r.runId,
      countsAgainstScore: true,
      severity: 2,
      evidence: {
        retryCount: ticket.retryCount,
        ...(rejectComment ? { reason: redactEvidence(rejectComment.body) } : {}),
      },
      correctedBy: correctedByRun(nextRunAfter(r.createdAt, runs)),
    });
  }

  // ── human_correction (counts_against_score = FALSE) ─────────────────────────
  // A human corrective reply that RESUMED the ticket: a human comment that a
  // later run follows (the fresh dispatch board/actions.ts fires on an
  // input_required reply). Requires an agent to have been working (a correlated
  // run), so a stray "looks good" on a done ticket is not harvested. Attributed
  // to the agent that was working when the human stepped in.
  for (const c of comments) {
    if (c.authorType !== "human") continue;
    const producer = correlateToRun(c.createdAt, runs);
    const resumed = nextRunAfter(c.createdAt, runs);
    if (!producer || !resumed) continue;
    out.push({
      dedupeKey: `human_correction:${c.id}`,
      type: "human_correction",
      agentId: producer.agentId,
      role: producer.role ?? UNATTRIBUTED_ROLE,
      runId: producer.runId,
      countsAgainstScore: false,
      severity: 1,
      evidence: { comment: redactEvidence(c.body) },
      correctedBy: correctedByRun(resumed),
    });
  }

  return out;
}

function correctedByRun(run: HarvestRun | null): Record<string, unknown> | null {
  return run ? { nextRunId: run.runId } : null;
}
