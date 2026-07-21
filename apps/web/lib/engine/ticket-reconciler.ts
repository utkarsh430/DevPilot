// Service layer around the pure reconcile policy (reconcile-policy.ts):
// gather the evidence, decide, and apply — advancing a ticket whose run
// completed 'done' without moving it, per the role's FSM contract.
//
// Two consumers share this exact routine:
//   • runAgent's `reconcile-ticket` step (event-time, right after a run
//     finishes), and
//   • the stuck-ticket sweeper cron (lib/engine/stuck-ticket-sweep.ts),
//     which repairs tickets already stranded in production.
//
// Both are best-effort: callers catch, and every applied decision leaves an
// audit trail (run_steps idx=99_994 + a system comment on the ticket) so the
// operator can see WHY a ticket moved without an agent's tool call.

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { addComment, transitionTicket } from "@/lib/board/transitions";
import { getEffectivePauseForTicket } from "@/lib/engine/automation-state";
import { getBuiltinRoleConfig, loadCustomRoleConfig } from "@/lib/roles/load";
import { fenceUntrustedOutput } from "@/lib/board/qa-gate";
import type { TicketStatus } from "@/lib/board/state";
import { decideTicketReconciliation, type ReconcileDecision } from "@/lib/engine/reconcile-policy";

// Audit-step idx for reconciler actions. Registry (see pause-resume.ts):
// 9999 runAgentFailed · 99_991 THIS (verdictless park marker) · 99_992
// automation-pause · 99_993 pauseTicket · 99_994 THIS · 99_995 watchdog ·
// 99_996 stale-reaper · 99_997 supervision · 99_998 cascade-kill.
export const RECONCILE_AUDIT_STEP_IDX = 99_994;

/**
 * "This run has already driven a verdictless-review park." A DEDICATED idx, not
 * a reuse of RECONCILE_AUDIT_STEP_IDX, and the distinction is the whole fix.
 *
 * THE WEDGE THIS CLOSES (observed live, ticket de18a05f / run bb1cc5ee, 2026-08-01)
 * ────────────────────────────────────────────────────────────────────────────────
 * A qa run completed with no verdict (its board calls were failing on an
 * unrelated `401 bad registration key`), so the reconciler parked the ticket to
 * `blocked` with a comment ending "unblock it once resolved". The operator fixed
 * the environment and did exactly that. Twelve minutes later the sweeper parked
 * it again, with a BYTE-IDENTICAL comment naming the SAME run — and no new run
 * had been created in between. Every unblock was undone; the instruction the
 * park itself gives was impossible to follow.
 *
 * The mechanism is the `block` branch's deliberate bypass of the sweeper-mode
 * "already-reconciled" check below. That bypass is CORRECT and must stay (see
 * its comment: a ticket frozen at the re-dispatch cap must still be able to
 * reach `blocked`), but it left the park with NO idempotency of its own, so the
 * decision — a pure function of the ticket's status and the latest run, both
 * unchanged by a human unblock — re-fired on every 5-minute tick forever.
 *
 * The principle: A RUN MAY DRIVE AT MOST ONE PARK. A human moving the ticket out
 * of `blocked` is the intervention the park asked for; the reconciler must not
 * then re-litigate the same, already-finished run. Genuine protection is
 * untouched — a NEW verdictless run carries a new run id and parks normally.
 *
 * WHY A DEDICATED idx rather than reading RECONCILE_AUDIT_STEP_IDX's payload:
 * `run_steps` is `unique (run_id, idx)`, so this row's EXISTENCE means exactly
 * "this run parked", unambiguously and at most once, enforced by the database
 * rather than by argument. The generic 99_994 row is written for `transition`
 * and `dispatch` decisions too, so a run reconciled once as a dispatch would
 * occupy it and silently swallow the later park marker — restoring the wedge in
 * the one case (a ticket hand-moved between passes) where the decision really
 * can change for a fixed run. `hasRunAlreadyParked` still ACCEPTS a 99_994 row
 * whose decision was `block`, so tickets parked before this shipped are healed
 * with no backfill.
 */
export const RECONCILE_PARK_AUDIT_STEP_IDX = 99_991;

/** System comment author for reconciler actions (also the sweeper's
 *  already-handled marker — see stuck-ticket-sweep.ts). */
export const RECONCILER_COMMENT_AUTHOR = "ticket-reconciler";

// Hard ceiling (CLAUDE.md non-negotiable #3): reconciler interventions per
// ticket PHASE, counted via the RECONCILER_COMMENT_AUTHOR comment trail. An
// agent that NEVER advances its ticket (e.g. a broken MCP tool surface)
// would otherwise be re-dispatched by the reconciler on every completion —
// an unbounded review loop burning LLM spend. After the cap the ticket stays
// put and the operator investigates via the comment trail.
//
// Per PHASE, not per lifetime: the count used to span the ticket's whole life,
// so a legitimately long-lived ticket that stranded once during refinement, once
// during implementation and once during review was FROZEN on its fourth strand -
// three unrelated hiccups spread over days, treated as one runaway loop, and the
// freeze was announced only to `console.warn` (see `loadPhaseStartIso` for what a
// phase is, and the freeze notice below for the surfacing).
export const MAX_RECONCILES_PER_TICKET = Number(
  process.env.DEVPILOT_TICKET_RECONCILE_MAX_ATTEMPTS ?? "3",
);

/** System comment author for the "frozen by the reconcile cap" notice. Distinct
 *  from RECONCILER_COMMENT_AUTHOR on purpose: a freeze notice must not itself
 *  count as a reconcile attempt, and it must not disarm the sweeper's
 *  already-handled check. */
export const RECONCILE_CAP_COMMENT_AUTHOR = "ticket-reconcile-cap";

const ACTIVE_RUN_STATUSES = ["running", "awaiting_human"] as const;

export type ReconcileRunArgs = {
  runId: string;
  tenantId: string;
  ticketId: string;
  /** Role slug from the run/event; null lets us fall back to agents.role. */
  role: string | null;
  agentId: string | null;
  /** Ticket status snapshotted at run start; null when unknown (sweeper). */
  statusAtRunStart: TicketStatus | null;
  /** applyRolePostProcess outcome; null when postprocess didn't run. */
  postNext: "dispatch" | "done" | "failed" | null;
  /** Run start time — devpilot_move_ticket comments after this mean the role
   *  rendered its verdict. */
  runStartedAtIso: string | null;
};

export type ReconcileRunResult =
  | { skipped: string }
  | { gateBlocked: true; role: string | null }
  | { decision: ReconcileDecision; role: string | null; applied: boolean };

export async function reconcileTicketAfterRun(args: ReconcileRunArgs): Promise<ReconcileRunResult> {
  const supabase = supabaseService();

  const { data: ticket, error: ticketErr } = await supabase
    .from("tickets")
    .select("id, tenant_id, status")
    .eq("id", args.ticketId)
    .maybeSingle();
  if (ticketErr || !ticket) return { skipped: "ticket-not-found" };
  if ((ticket.tenant_id as string) !== args.tenantId) {
    return { skipped: "tenant-mismatch" };
  }
  const statusNow = ticket.status as TicketStatus;

  // Resolve the role — event value first, then the run's agent row. A
  // resume-replay of a run that persisted no steps used to lose the role
  // entirely; agents.role recovers it (the replay clone keeps agent_id).
  let role = args.role;
  if (!role && args.agentId) {
    const { data: agentRow } = await supabase
      .from("agents")
      .select("role")
      .eq("id", args.agentId)
      .maybeSingle();
    role = (agentRow?.role as string | null) ?? null;
  }
  const roleConfig = role
    ? (getBuiltinRoleConfig(role) ?? (await loadCustomRoleConfig(args.tenantId, role)))
    : null;

  // Tenant-scoped (as is every service-role read below): `args.tenantId` is
  // proven against the ticket row above, and `runs`' member write policy pins
  // only the row's own `tenant_id`, never the `ticket_id` it names. Unscoped,
  // a hostile tenant could plant `{tenant_id: them, ticket_id: <our ticket>,
  // status: "running"}` and this read would see a phantom active run — the
  // reconciler would stand down and the ticket would strand for good.
  const { data: activeRuns } = await supabase
    .from("runs")
    .select("id")
    .eq("ticket_id", args.ticketId)
    .eq("tenant_id", args.tenantId)
    .in("status", ACTIVE_RUN_STATUSES as unknown as string[])
    .neq("id", args.runId)
    .limit(1);
  const hasOtherActiveRuns = (activeRuns ?? []).length > 0;

  // Did a devpilot_move_ticket call land during the run? The move route stamps a
  // system comment with author_id='devpilot_move_ticket' (both real transitions
  // and same-state no-op verdicts). Status changes are caught separately via
  // the statusAtRunStart comparison inside the policy.
  let moveTicketToolUsed = false;
  if (args.runStartedAtIso) {
    // Tenant-scoped: without it a planted `{tenant_id: them, ticket_id: <our
    // ticket>, author_id: "devpilot_move_ticket"}` comment would forge the
    // "a verdict was rendered" signal and disarm the reconciler.
    const { data: moveComments } = await supabase
      .from("comments")
      .select("id")
      .eq("ticket_id", args.ticketId)
      .eq("tenant_id", args.tenantId)
      .eq("author_type", "system")
      .eq("author_id", "devpilot_move_ticket")
      .gt("created_at", args.runStartedAtIso)
      .limit(1);
    moveTicketToolUsed = (moveComments ?? []).length > 0;
  }

  const decision = decideTicketReconciliation({
    role,
    onSuccessStatus: roleConfig?.onSuccessStatus ?? null,
    statusAtRunStart: args.statusAtRunStart,
    statusNow,
    hasOtherActiveRuns,
    postNext: args.postNext,
    moveTicketToolUsed,
  });

  if (decision.action === "none") {
    return { decision, role, applied: false };
  }

  // Operator's off switch wins on BOTH consumers (the sweeper checks it too):
  // a paused workspace/project must not have its board mutated by the engine.
  const pauseGate = await getEffectivePauseForTicket(args.tenantId, args.ticketId);
  if (pauseGate.paused) {
    return { skipped: "automation-paused" };
  }

  // Verdict/reviewer run recorded NO verdict (reconcile-policy's verdictless-
  // review branch): park to `blocked` and surface the agent's summary to a
  // human. Handled BEFORE the reconcile cap on purpose — this is a loop-EXIT,
  // not a re-touch, so a ticket that already burned its re-dispatch budget must
  // still be able to reach the terminal-for-the-loops `blocked` state instead
  // of freezing. blocked is outside RECONCILABLE_STATUSES and the sweeper scan,
  // so it never re-fires (see qa-gate-recovery-nonloop.test.ts) — but ONLY while
  // the ticket stays blocked. The moment a human unblocks it (the very thing the
  // park asks for) it is sweepable again, and this branch's bypass of the
  // already-reconciled check below meant the SAME finished run parked it right
  // back, forever. The park now carries its own run-scoped idempotency; see
  // RECONCILE_PARK_AUDIT_STEP_IDX and verdictless-park-idempotency.test.ts.
  if (decision.action === "block") {
    return await parkVerdictlessReviewToBlocked(args, statusNow, role, decision);
  }

  // Sweeper-mode idempotency (moved here out of stuck-ticket-sweep.ts so the
  // `block` decision above can BYPASS it): in a sweep pass (no run-start
  // snapshot) a RECONCILER_COMMENT_AUTHOR comment already newer than the run we
  // are reconciling means a prior pass (or the event-time step) already tried
  // this ticket — don't re-fire a dispatch/transition every 5-min tick when the
  // dispatcher just keeps declining. `block` is deliberately EXEMPT (it returned
  // above): it's a one-time terminal park that must still surface a stranded
  // verdict ticket even after earlier re-dispatch attempts exhausted the cap —
  // the sweeper's own pre-check used to skip such tickets as "already handled"
  // and freeze them for good. Event-time reconciles carry a run-start snapshot,
  // so `statusAtRunStart === null` scopes this strictly to the sweeper; their
  // behaviour is unchanged.
  if (args.statusAtRunStart === null && args.runStartedAtIso) {
    const { data: priorMarker } = await supabase
      .from("comments")
      .select("id")
      .eq("ticket_id", args.ticketId)
      .eq("tenant_id", args.tenantId)
      .eq("author_type", "system")
      .eq("author_id", RECONCILER_COMMENT_AUTHOR)
      .gt("created_at", args.runStartedAtIso)
      .limit(1);
    if ((priorMarker ?? []).length > 0) {
      return { skipped: "already-reconciled" };
    }
  }

  // Circuit breaker BEFORE acting: bounded interventions per ticket PHASE.
  // Counting only the reconciles since the ticket last made real forward
  // progress means a ticket that strands once per phase across a long life never
  // freezes, while a genuine runaway (an agent that keeps completing without
  // advancing anything) still trips the cap after MAX_RECONCILES_PER_TICKET laps
  // - it makes no forward progress by definition, so its phase never rolls over.
  const phaseStartIso = await loadPhaseStartIso(args.ticketId, args.tenantId);
  let priorQuery = supabase
    .from("comments")
    .select("id", { count: "exact", head: true })
    .eq("ticket_id", args.ticketId)
    .eq("tenant_id", args.tenantId)
    .eq("author_type", "system")
    .eq("author_id", RECONCILER_COMMENT_AUTHOR);
  if (phaseStartIso) priorQuery = priorQuery.gt("created_at", phaseStartIso);
  const { count: priorReconciles } = await priorQuery;
  if ((priorReconciles ?? 0) >= MAX_RECONCILES_PER_TICKET) {
    console.warn(
      `[ticket-reconciler] ticket ${args.ticketId} hit MAX_RECONCILES_PER_TICKET=${MAX_RECONCILES_PER_TICKET} in this phase - leaving for the operator`,
    );
    // Surface the freeze on the ticket itself. Until now the ONLY trace was this
    // console.warn: the ticket simply stopped moving, with no board-visible
    // reason. Once per phase (the sweeper re-evaluates every 5 min - an
    // unconditional comment here would be a comment-spam firehose).
    await noticeReconcileCapFrozen(args, statusNow, phaseStartIso, priorReconciles ?? 0);
    return { skipped: "reconcile-cap-exceeded" };
  }

  if (decision.action === "transition") {
    // transitionTicket re-checks the FSM and emits ticket/dispatch-needed
    // itself for non-terminal targets. `expectedFrom` makes the UPDATE a
    // compare-and-swap on the status this decision was based on; zero rows
    // means someone moved the ticket between our read and the write — it's
    // already handled, so no comment and no reconcile-cap slot consumed.
    //
    // L1 — the reconciler is gated uniformly (O1): a fallback `→ in_review` for
    // this run passes actor:"system" + runId, so a failing verification refuses
    // here too. On refusal we park to `blocked`, which is OUTSIDE both
    // RECONCILABLE_STATUSES and the sweeper's scan — the moment a reconcile
    // attempt is refused, the ticket leaves both loops for good (no hot-loop, no
    // strand). The park + its explanation go under the reconciler's OWN audit
    // author so the sweeper stays disarmed (never `devpilot_qa_gate` here).
    const result = await transitionTicket({
      ticketId: args.ticketId,
      tenantId: args.tenantId,
      to: decision.to,
      actor: "system",
      runId: args.runId,
      expectedFrom: statusNow,
    });
    if (result.gateRefusal) {
      const body =
        `Run ${args.runId.slice(0, 8)}${role ? ` (${role})` : ""} completed but its ` +
        `work failed the QA verification gate; the engine parked this ticket to blocked instead ` +
        `of handing it to QA. Unblock it after the failure is fixed. ${result.gateRefusal.reason}`;
      await parkToBlockedFromReconciler(args, statusNow, body);
      return { gateBlocked: true, role };
    }
    if (!result.transitioned) {
      return { skipped: "lost-transition-race" };
    }
  } else {
    await inngest.send({
      name: "ticket/dispatch-needed",
      data: { ticketId: args.ticketId, tenantId: args.tenantId },
    });
  }

  await writeAuditTrail(args, role, statusNow, decision);
  return { decision, role, applied: true };
}

/**
 * When did the ticket's CURRENT phase begin?
 *
 * A phase boundary is the last time an AGENT actually rendered a verdict on the
 * ticket - i.e. the newest `devpilot_move_ticket` system comment, which the move route
 * stamps on every real transition AND on a same-state no-op verdict. That is the
 * durable "the ticket moved forward under its own power" signal, and it is
 * exactly what the reconcile cap should reset on: past that line, the ticket is
 * doing something new, and the reconciles that preceded it belong to work that is
 * already finished.
 *
 * Deliberately NOT reset by the reconciler's own transitions: those are engine
 * repair, not agent progress. That is what keeps the cap honest - an agent that
 * never advances its ticket produces no `devpilot_move_ticket` comment, so its phase
 * never rolls over and it still trips the cap after MAX_RECONCILES_PER_TICKET.
 *
 * null = no verdict has ever been rendered on this ticket (its first phase), so
 * the caller counts the whole trail.
 */
async function loadPhaseStartIso(ticketId: string, tenantId: string): Promise<string | null> {
  const supabase = supabaseService();
  const { data } = await supabase
    .from("comments")
    .select("created_at")
    .eq("ticket_id", ticketId)
    // Tenant-scoped, and load-bearing: this read IS the phase boundary that
    // resets the reconcile cap. A planted `devpilot_move_ticket` comment on our
    // ticket would move the boundary forward on every poll, rolling the phase
    // over forever and turning the cap — the circuit breaker on engine repair —
    // into a no-op.
    .eq("tenant_id", tenantId)
    .eq("author_type", "system")
    .eq("author_id", "devpilot_move_ticket")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const iso = (data as { created_at?: unknown } | null)?.created_at;
  return typeof iso === "string" ? iso : null;
}

/**
 * Tell the operator the ticket is frozen by the reconcile cap. Best-effort, and
 * posted at most ONCE per phase: the sweeper re-reaches this branch every 5
 * minutes for as long as the ticket sits stranded, so an unconditional comment
 * would bury the ticket in duplicates. The notice carries its OWN author
 * (RECONCILE_CAP_COMMENT_AUTHOR) so it neither consumes a reconcile slot nor
 * disarms the sweeper's already-handled check.
 */
async function noticeReconcileCapFrozen(
  args: ReconcileRunArgs,
  statusNow: TicketStatus,
  phaseStartIso: string | null,
  reconciles: number,
): Promise<void> {
  const supabase = supabaseService();
  try {
    let existing = supabase
      .from("comments")
      .select("id")
      .eq("ticket_id", args.ticketId)
      .eq("tenant_id", args.tenantId)
      .eq("author_type", "system")
      .eq("author_id", RECONCILE_CAP_COMMENT_AUTHOR)
      .limit(1);
    if (phaseStartIso) existing = existing.gt("created_at", phaseStartIso);
    const { data: already } = await existing;
    if ((already ?? []).length > 0) return;

    await addComment({
      ticketId: args.ticketId,
      tenantId: args.tenantId,
      authorType: "system",
      authorId: RECONCILE_CAP_COMMENT_AUTHOR,
      body:
        `The engine has already repaired this ticket ${reconciles} time${reconciles === 1 ? "" : "s"} ` +
        `without it making progress under its own power, reaching the reconcile cap ` +
        `(DEVPILOT_TICKET_RECONCILE_MAX_ATTEMPTS=${MAX_RECONCILES_PER_TICKET}). It will NOT be repaired or ` +
        `re-dispatched again, so it will sit in \`${statusNow}\` until a human looks at it.\n\n` +
        `Runs keep completing without advancing the ticket - read the \`${RECONCILER_COMMENT_AUTHOR}\` ` +
        `comments above for what the engine tried. Typical causes: the role never calls ` +
        `\`devpilot_move_ticket\`, or its work is genuinely stuck. The cap disables the engine's ` +
        `self-healing for this ticket, not the board: move the ticket yourself (or fix the role) and it ` +
        `runs again. The repair budget refills as soon as an agent moves the ticket under its own power ` +
        `(the next \`devpilot_move_ticket\` verdict), which starts a new phase.`,
    });
  } catch (err) {
    // Never let a notice failure break the reconciler's skip path.
    console.warn(
      `[ticket-reconciler] cap notice failed for ticket ${args.ticketId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Park a ticket to `blocked` under the reconciler's own audit author and record
 * WHY (`commentBody`). Shared by BOTH reconciler park paths — the L1
 * gate-refusal recovery and the verdictless-review park below. Using
 * RECONCILER_COMMENT_AUTHOR (not `devpilot_qa_gate`) is deliberate: the stuck-ticket
 * sweeper treats a reconciler comment newer than the latest run as "already
 * handled" and stays disarmed, so this park cannot be re-swept. `blocked` is
 * itself outside the sweeper's scan and RECONCILABLE_STATUSES, so this fully
 * exits both loops. Best-effort — a comment/park failure is logged, never thrown
 * (the sweeper/reconciler must not crash on a follow-up write). CAS-guarded on
 * `statusBefore`, so a concurrent move between the read and the park is a clean
 * no-op; the comment is posted ONLY when the park actually committed, so we
 * never claim to have blocked a ticket we didn't. Returns whether it committed.
 */
async function parkToBlockedFromReconciler(
  args: ReconcileRunArgs,
  statusBefore: TicketStatus,
  commentBody: string,
): Promise<boolean> {
  let transitioned = false;
  try {
    const result = await transitionTicket({
      ticketId: args.ticketId,
      tenantId: args.tenantId,
      to: "blocked",
      actor: "system",
      expectedFrom: statusBefore,
      emitDispatch: false,
    });
    transitioned = result.transitioned;
  } catch (err) {
    console.warn(
      `[ticket-reconciler] park-to-blocked failed for ticket ${args.ticketId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!transitioned) return false;
  try {
    await addComment({
      ticketId: args.ticketId,
      tenantId: args.tenantId,
      authorType: "system",
      authorId: RECONCILER_COMMENT_AUTHOR,
      body: commentBody,
    });
  } catch (err) {
    console.warn(
      `[ticket-reconciler] park comment failed for ticket ${args.ticketId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return true;
}

/**
 * Verdictless-review recovery (reconcile-policy's `block` decision): a
 * verdict/reviewer run completed 'done' without recording a verdict. Park the
 * ticket to `blocked` and surface the review's OWN summary text to a human so
 * they see what it concluded — we never re-run the review (non-deterministic;
 * could flip a "changes requested" into a spurious approve). The summary is
 * fenced as untrusted (model output landing in an operator-visible comment). A
 * lost CAS race (someone moved the ticket first) is a clean skip. Writes only
 * the run_steps audit marker — the park already posts the detailed comment, so
 * the generic writeAuditTrail comment would be a redundant second one.
 */
async function parkVerdictlessReviewToBlocked(
  args: ReconcileRunArgs,
  statusBefore: TicketStatus,
  role: string | null,
  decision: Extract<ReconcileDecision, { action: "block" }>,
): Promise<ReconcileRunResult> {
  // At most ONE park per run (see RECONCILE_PARK_AUDIT_STEP_IDX). Checked here
  // rather than beside the sweeper's already-reconciled check because the whole
  // point of the `block` branch is that it bypasses that one; this guard is
  // run-scoped, so it cannot re-freeze a cap-exhausted ticket the way reusing
  // the ticket-scoped comment check would.
  if (await hasRunAlreadyParked(args.runId)) {
    return { skipped: "run-already-parked" };
  }

  const verdictText = await loadRunFinalText(args.runId);
  const body =
    `Run ${args.runId.slice(0, 8)}${role ? ` (${role})` : ""} completed but recorded NO verdict — ` +
    `the reviewer did not call devpilot_move_ticket to approve (→ done) or request changes ` +
    `(→ in_progress). The engine parked this ticket to blocked instead of leaving it stranded or ` +
    `blindly re-running the review (a fresh run is non-deterministic and could flip the verdict). ` +
    `(${decision.reason})\n\n` +
    // Honesty about what happens next. The old text said only "unblock it once
    // resolved" — an instruction the engine then undid every 5 minutes. It no
    // longer does, but "unblock" alone still under-specifies: `blocked` exits
    // only to in_progress/paused/backlog/done/failed (ALLOWED_TRANSITIONS in
    // lib/board/state.ts), so the obvious operator move — dragging the card
    // straight back to In Review — is not a legal edge at all. And any exit
    // fires a dispatch the dispatcher may legitimately DECLINE, leaving the
    // ticket sitting there with no new run. Name what actually works; every
    // status below is checked against the FSM.
    `**This run will not park this ticket again** — the engine has said its piece and now ` +
    `stands down for run ${args.runId.slice(0, 8)}. Moving the ticket out of \`blocked\` sticks.\n\n` +
    `What moves it forward:\n` +
    `• **Send it back for changes, and get a fresh review** — move it to \`in_progress\`. That ` +
    `fires a dispatch; when the producer hands off to \`in_review\` a NEW review run is dispatched ` +
    `(and parked again if it too records no verdict). Note \`blocked → in_review\` is not a legal ` +
    `move — a re-review is reached through \`in_progress\`.\n` +
    `• **Accept it yourself** — move it to \`done\`. You are the only actor allowed to; the engine ` +
    `must never force a verdict on a review that did not render one.\n` +
    `• **Start over** — "Discard & restart from dev" in the ticket drawer discards this ticket's ` +
    `branch work and resets it to \`backlog\`.\n` +
    `• If the dispatcher declines the fresh dispatch because it judges the work already finished, ` +
    `the ticket simply sits where you put it with nothing queued — that is not a second wedge, ` +
    `but it does mean the next move is yours.` +
    (verdictText
      ? `\n\nWhat the review run concluded before it ended:${fenceUntrustedOutput("review summary", verdictText)}`
      : "");
  const transitioned = await parkToBlockedFromReconciler(args, statusBefore, body);
  if (!transitioned) {
    // Lost the CAS race — someone moved the ticket first, so no park happened
    // and the marker is deliberately NOT written: a future genuine park for
    // this run must still be possible. This is also why the marker is written
    // AFTER the park rather than claimed before it; concurrent sweeps can't
    // double-park anyway, because `parkToBlockedFromReconciler` transitions
    // with `expectedFrom: statusBefore` and the loser matches zero rows.
    return { skipped: "lost-transition-race" };
  }
  await writeReconcileAuditStep(args, role, statusBefore, decision);
  await writeParkMarker(args, role, statusBefore, decision);
  return { decision, role, applied: true };
}

/**
 * Has this run already driven a verdictless-review park?
 *
 * One read, two accepted witnesses:
 *   • RECONCILE_PARK_AUDIT_STEP_IDX — the dedicated marker written below.
 *   • RECONCILE_AUDIT_STEP_IDX carrying a `block` decision — what a park wrote
 *     BEFORE the dedicated marker existed. Reading it heals tickets already
 *     wedged in production with no backfill and no migration.
 *
 * Fails OPEN (returns false) on a read error: the alternative is suppressing a
 * genuine first park, which strands the ticket. A duplicate park is a bad
 * comment; a missing one is a ticket nobody is told about.
 */
async function hasRunAlreadyParked(runId: string): Promise<boolean> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("run_steps")
    .select("idx, payload")
    .eq("run_id", runId)
    .in("idx", [RECONCILE_PARK_AUDIT_STEP_IDX, RECONCILE_AUDIT_STEP_IDX]);
  if (error) {
    console.warn(
      `[ticket-reconciler] park-marker lookup failed for run ${runId}: ${error.message}`,
    );
    return false;
  }
  return (data ?? []).some((row) => {
    if ((row as { idx?: unknown }).idx === RECONCILE_PARK_AUDIT_STEP_IDX) return true;
    const action = (
      (row as { payload?: { decision?: { action?: unknown } } }).payload?.decision ?? {}
    ).action;
    return action === "block";
  });
}

/** The durable "this run parked" record. Best-effort like every other audit
 *  write here — a failure means at worst one duplicate park on the next sweep,
 *  never a failed reconcile. */
async function writeParkMarker(
  args: ReconcileRunArgs,
  role: string | null,
  statusBefore: TicketStatus,
  decision: Extract<ReconcileDecision, { action: "block" }>,
): Promise<void> {
  const supabase = supabaseService();
  const { error } = await supabase.from("run_steps").insert({
    run_id: args.runId,
    idx: RECONCILE_PARK_AUDIT_STEP_IDX,
    kind: "system",
    payload: {
      kind: "ticket-verdictless-park",
      ticket_id: args.ticketId,
      role,
      status_before: statusBefore,
      decision,
    },
  });
  if (error) {
    console.warn(
      `[ticket-reconciler] park marker write failed for run ${args.runId}: ${error.message}`,
    );
  }
}

/** The last `think` step's text for a run — the reviewer's final summary — used
 *  to surface what a verdictless review concluded. Best-effort: null when the
 *  run persisted no think step or the text is empty. */
async function loadRunFinalText(runId: string): Promise<string | null> {
  const supabase = supabaseService();
  const { data } = await supabase
    .from("run_steps")
    .select("payload")
    .eq("run_id", runId)
    .eq("kind", "think")
    .order("idx", { ascending: false })
    .limit(1)
    .maybeSingle();
  const text = (data?.payload as { text?: unknown } | null)?.text;
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
}

/** run_steps audit marker for a reconciler action. Best-effort. Extracted so the
 *  verdictless-review park can record the marker WITHOUT the generic advancement
 *  comment (it posts its own richer one). */
async function writeReconcileAuditStep(
  args: ReconcileRunArgs,
  role: string | null,
  statusBefore: TicketStatus,
  decision: Exclude<ReconcileDecision, { action: "none" }>,
): Promise<void> {
  const supabase = supabaseService();
  const { error: stepErr } = await supabase.from("run_steps").insert({
    run_id: args.runId,
    idx: RECONCILE_AUDIT_STEP_IDX,
    kind: "system",
    payload: {
      kind: "ticket-reconciled",
      ticket_id: args.ticketId,
      role,
      status_before: statusBefore,
      decision,
    },
  });
  if (stepErr) {
    console.warn(
      `[ticket-reconciler] audit step write failed for run ${args.runId}: ${stepErr.message}`,
    );
  }
}

/** run_steps audit marker + operator-visible system comment. Best-effort —
 *  the transition/dispatch has already committed. */
async function writeAuditTrail(
  args: ReconcileRunArgs,
  role: string | null,
  statusBefore: TicketStatus,
  decision: Exclude<ReconcileDecision, { action: "none" }>,
): Promise<void> {
  await writeReconcileAuditStep(args, role, statusBefore, decision);
  try {
    const detail =
      decision.action === "transition"
        ? `moved the ticket ${statusBefore} → ${decision.to}`
        : "re-dispatched the ticket";
    await addComment({
      ticketId: args.ticketId,
      tenantId: args.tenantId,
      authorType: "system",
      authorId: RECONCILER_COMMENT_AUTHOR,
      body:
        `Run ${args.runId.slice(0, 8)}${role ? ` (${role})` : ""} completed without advancing ` +
        `this ticket; the engine ${detail}. (${decision.reason})`,
    });
  } catch (err) {
    console.warn(
      `[ticket-reconciler] comment write failed for ticket ${args.ticketId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
