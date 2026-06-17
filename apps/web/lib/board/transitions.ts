// Side-effecting wrappers that perform a ticket transition + emit the
// dispatch event so the durable engine resumes work without a polling loop.

import { sendEventBounded } from "@/lib/engine/send-bounded";
import { supabaseService } from "@/lib/db/server";
import { assertTransition, type TicketStatus } from "@/lib/board/state";
import {
  BLOCKING_RELATION_TYPES,
  hasOpenBlockers,
  loadBlockerSummaryService,
} from "@/lib/board/dependencies";
import { humanMayOverride } from "@/lib/integration/landed";
import { enqueueForLanding } from "@/lib/integration/queue.server";
import { cancelPendingForTicket } from "@/lib/engine/dispatch-queue";
import { decideQaGate, isEngineerQaGateEnabled } from "@/lib/board/qa-gate";
import { loadRunVerification, loadRunRole } from "@/lib/board/qa-gate.server";
import { isCodeProducingRole } from "@/lib/roles/code-producing";
import {
  decideGateRetryCeiling,
  getQaGateMaxRetries,
  qaGateCeilingCommentBody,
} from "@/lib/board/gate-retry";
import { decideSafetyGate } from "@/lib/board/safety-gate";
import { decideReopenGate } from "@/lib/board/reopen-policy";
import { decidePlanHoldGate } from "@/lib/plan/scaffolder";
import { noticeUnpushedWorkOnDone } from "@/lib/workspace/unpushed-work.server";
import type { BoardTicket } from "@/components/board/types";

const TERMINAL_FOR_QUEUE: ReadonlySet<TicketStatus> = new Set(["done", "failed", "blocked"]);

/**
 * Who is driving this transition. This is the single L1 gate discriminator: the
 * QA hand-off gate fires only for `agent`/`system` moves into `in_review`, so a
 * `human` (board UI / operator) is always an override and never gated. Making it
 * REQUIRED means any FUTURE code path that reaches `transitionTicket` is a
 * COMPILE ERROR until it declares its actor — that is the correction for the
 * first attempt's fatal bug (it gated one route and silently missed the rest).
 *   • "human"  — operator via the board UI / server actions. NEVER gated.
 *   • "agent"  — a live agent run (MCP tool, engineer postprocess).
 *   • "system" — the engine acting on a run's behalf (reconciler, aggregator,
 *                scheduler, dependency promotion).
 */
export type TransitionActor = "human" | "agent" | "system";

/**
 * Surfaced to callers when a gate embedded in `transitionTicket` refuses a
 * move. The transition committed NOTHING; the caller decides recovery. Two
 * gates share this channel, distinguished by `code`:
 *   • `verification_failed`     — L1 QA gate: a producer's `→ in_review`
 *     hand-off carried a failing test/build. Recovery: park to blocked for
 *     dead engine runs; 422 in-session retry for the live MCP tool path (the
 *     agent can fix the failure and re-move).
 *   • `empty_delivery`          — B2: a CODE-PRODUCING role handed off a branch
 *     that adds no commits to the base branch. Same recovery as
 *     `verification_failed` (commit the work, then re-move), so both codes are
 *     handled identically by every caller.
 *   • `gate_retry_exhausted`    — B2: the two above have now been refused
 *     `DEVPILOT_QA_GATE_MAX_RETRIES` times for this ticket. Recovery is a PARK,
 *     never another 422 — the producer is not converging and each further lap
 *     costs a full run. Cleared by a human moving the ticket out of `blocked`.
 *   • `safety_approval_required` — SME safety gate: an agent/system tried to
 *     complete a `safety_critical` ticket to `done`. Recovery: park to blocked
 *     pending HUMAN approval — never a retry, because no non-human can ever
 *     approve it (see lib/board/safety-gate.ts).
 */
export type GateRefusal = {
  code:
    | "verification_failed"
    | "empty_delivery"
    | "gate_retry_exhausted"
    | "safety_approval_required";
  reason: string;
};
/** @deprecated alias kept for existing importers — use {@link GateRefusal}. */
export type QaGateRefusal = GateRefusal;

export type TransitionInput = {
  ticketId: string;
  tenantId: string;
  to: TicketStatus;
  /**
   * Who is driving the move — the L1 gate discriminator. Required (see
   * `TransitionActor`): a `human` move is never gated; `agent`/`system` moves
   * into `in_review` are.
   */
  actor: TransitionActor;
  /**
   * The run this transition is on behalf of. Lets the L1 gate read that run's
   * verification strictly `WHERE run_id = <this>` (never "any row on the
   * ticket"). Every agent/system `→ in_review` caller passes it; absent → the
   * gate finds no record and fails open (allows).
   */
  runId?: string;
  /** Optional: bump retry_count by this amount (used on QA reject). */
  retryDelta?: number;
  /** Optional: update description (used after PM refinement). */
  description?: string;
  acceptanceCriteria?: string;
  /** Optional: clear assignee */
  clearAssignee?: boolean;
  /** Phase 1 / M3: stamp the dispatcher-selected agent onto the ticket. */
  assigneeAgentId?: string | null;
  /** Phase 0: pass false to skip the dispatch event (terminal transitions). */
  emitDispatch?: boolean;
  /**
   * Optional compare-and-swap guard: only apply the UPDATE while the ticket
   * is still in this status (same `.eq("status", …).select("id")` pattern as
   * pause-resume). A concurrent move between the caller's read and our write
   * then yields `{ transitioned: false }` instead of clobbering the newer
   * state. Omitted = existing last-write-wins behavior for all callers.
   */
  expectedFrom?: TicketStatus;
};

/**
 * Thrown by `transitionTicket` when the caller asks to move a ticket into
 * `ready` while it still has open blockers. Carries the blocker list so the
 * server action can surface them to the client for a friendly toast / snap-back.
 */
export class BlockedByDependencyError extends Error {
  readonly blockers: BoardTicket[];
  constructor(blockers: BoardTicket[]) {
    super(`ticket has ${blockers.length} open blocker${blockers.length === 1 ? "" : "s"}`);
    this.name = "BlockedByDependencyError";
    this.blockers = blockers;
  }
}

/**
 * Thrown by `transitionTicket` when the caller asks to promote a scaffolder that
 * is still HELD for a pending plan commit. Carries an operator-readable reason:
 * a board drag surfaces it as a toast, and the drain logs it.
 */
export class PlanHoldError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PlanHoldError";
  }
}

export async function transitionTicket(
  input: TransitionInput,
): Promise<{ transitioned: boolean; gateRefusal?: GateRefusal }> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("tickets")
    // `tenant_id` is selected so the gates below can scope their own reads to
    // THIS ticket's tenant. The ticket row is the authority on that: everything
    // hanging off a ticket (its runs, their verification records) is in the same
    // tenant, so it is the correct scope to hand a service-role read.
    .select("status, retry_count, gate_retry_count, safety_critical, plan_hold, tenant_id")
    .eq("id", input.ticketId)
    .single();
  if (error || !data) throw new Error(`transitionTicket: ticket ${input.ticketId} not found`);

  // The tenant that every service-role read/write hanging off THIS ticket is
  // scoped to. Taken off the ticket row, deliberately not from `input.tenantId`.
  //
  // The reason is that this function never verifies `input.tenantId` against the
  // ticket — the lookup above is keyed on the primary key, and so is the UPDATE
  // below. That is safe in itself (a primary key is not attacker-aimable), but
  // it means `input.tenantId` is a CLAIM, and the gates below fail OPEN on an
  // empty result: no verification record → allow, no blockers found → allow. A
  // merely-wrong tenant id there would not wedge the ticket, it would silently
  // skip the gate. The row's `tenant_id` is DB truth and cannot be wrong.
  //
  // `input.tenantId` still populates the EVENTS emitted below, which is fine:
  // those consumers re-read the ticket under the tenant they are handed, so a
  // wrong claim fails closed there (no row → refuse) rather than acting.
  const rowTenantId = String((data as { tenant_id: unknown }).tenant_id);

  if (input.expectedFrom && (data.status as TicketStatus) !== input.expectedFrom) {
    return { transitioned: false };
  }

  // Reopen / reset gate — a RESET back to `backlog` from an operator-only source
  // state (a `done` "Restart from dev" reopen, or a non-done "Discard & restart")
  // is a HUMAN decision. Those `→ backlog` edges are legal in the FSM but must
  // never be reachable by an agent or an engine path. Every `→ backlog` flows
  // through here, so this is bypass-proof. We THROW (not a typed gateRefusal)
  // because no legitimate non-human path targets these edges — it is an illegal
  // move for that caller, exactly like `assertTransition` throwing on an edge the
  // FSM forbids. The MCP move route already maps such throws to 422.
  const reopen = decideReopenGate({
    from: data.status as TicketStatus,
    to: input.to,
    actor: input.actor,
  });
  if (!reopen.allow) {
    throw new Error(`transitionTicket: ${reopen.reason}`);
  }

  // Plan-hold gate — a scaffolder parked for a pending plan commit may be
  // promoted ONLY by its release path (`releaseScaffolder`), which does its own
  // guarded UPDATE and never comes through here.
  //
  // This seam is the enforcement point because the held row sits in Backlog,
  // visible, next to two things that know nothing about plans and both promote
  // through here: a board drag (`moveTicketAction`) and the backlog drain, which
  // force-promotes the backlog head when nothing else is eligible. Either one
  // would start a scaffolder that the plan commit is moments from starting with
  // its real context — two agents authoring the first commit of one empty repo.
  //
  // ACTOR-AGNOSTIC, unlike the reopen/safety gates: this is not "who decides",
  // it is "this row is spoken for". We THROW rather than returning a typed
  // refusal because no legitimate caller targets this edge — the same posture as
  // the reopen gate. The operator's paths out are commit, discard, or the TTL.
  const planHold = decidePlanHoldGate({
    to: input.to,
    planHold: (data as { plan_hold?: boolean }).plan_hold === true,
  });
  if (!planHold.allow) {
    throw new PlanHoldError(planHold.reason);
  }

  // L1 — QA hand-off gate. The single seam every `→ in_review` path flows
  // through. Only a non-human move into `in_review` under an enabled flag pays
  // for the verification read; everything else short-circuits and behaviour is
  // byte-for-byte unchanged. On refusal we mutate NOTHING (no status change, no
  // retry bump, no dispatch) and hand the caller a typed refusal to recover from
  // (park to blocked, or 422). Placed BEFORE assertTransition/update so a
  // refusal commits nothing at all.
  if (input.to === "in_review" && input.actor !== "human" && isEngineerQaGateEnabled()) {
    const [verification, runRole] = input.runId
      ? await Promise.all([
          loadRunVerification(input.runId, rowTenantId),
          loadRunRole(input.runId, rowTenantId),
        ])
      : [null, null];
    const decision = decideQaGate({
      enabled: true,
      from: data.status as TicketStatus,
      to: input.to,
      verification,
      // B2 — a PROPERTY OF THE ROLE, resolved from the static catalog, never
      // from run data. This is the whole thing that keeps the empty-delivery
      // refusal off the ~48 roles that legitimately never commit.
      codeProducing: isCodeProducingRole(runRole),
    });
    // OBSERVABILITY, not decoration. Every fail-open here is a hand-off the gate
    // could not judge, and the prod failure this feature exists to fix was 20 of
    // them in a row with nothing in the logs saying so. Coverage is only
    // measurable if each skip states its reason.
    if (decision.allow && decision.skipped) {
      console.warn(
        `[transitionTicket] qa-gate ALLOWED UNVERIFIED ticket=${input.ticketId} ` +
          `run=${input.runId ?? "?"} role=${runRole ?? "?"} actor=${input.actor} ` +
          `reason=${decision.skipped}`,
      );
    }
    if (!decision.allow) {
      console.warn(
        `[transitionTicket] qa-gate refused ticket=${input.ticketId} run=${input.runId ?? "?"} role=${runRole ?? "?"} actor=${input.actor} code=${decision.code}`,
      );
      // B2 — bound the refusal loop on its OWN counter. The live-agent path
      // hands back a 422 the agent retries in-session, and nothing counted
      // those laps. Bumped here, at the single seam every refusal flows
      // through, so no `→ in_review` path can spend an unbounded budget.
      //
      // This is the one mutation a refusal performs. It is deliberately not a
      // status change and not a `retry_count` bump (see lib/board/gate-retry.ts
      // for why that column must never carry this): a ticket refused by the
      // gate is still exactly where it was, still the producer's to finish.
      const gateRetryCount = ((data as { gate_retry_count?: number }).gate_retry_count ?? 0) + 1;
      const maxGateRetries = getQaGateMaxRetries();
      try {
        await supabase
          .from("tickets")
          .update({ gate_retry_count: gateRetryCount })
          .eq("id", input.ticketId);
      } catch (err) {
        // Best-effort: failing to count a refusal must not turn into failing to
        // REFUSE it. Worst case the ceiling arrives a lap late.
        console.error(`[transitionTicket] gate_retry_count bump failed:`, err);
      }
      const ceiling = decideGateRetryCeiling({ gateRetryCount, maxRetries: maxGateRetries });
      if (ceiling.exhausted) {
        console.warn(
          `[transitionTicket] qa-gate ceiling reached ticket=${input.ticketId} ${ceiling.reason}`,
        );
        // Retrying is now futile, so the refusal changes CODE: the live MCP path
        // parks instead of handing back another 422, exactly as it already does
        // for the safety gate. The reason carries the gate's own (already
        // fenced) message so the operator sees what actually failed.
        return {
          transitioned: false,
          gateRefusal: {
            code: "gate_retry_exhausted",
            reason: qaGateCeilingCommentBody(gateRetryCount, maxGateRetries, decision.reason),
          },
        };
      }
      return { transitioned: false, gateRefusal: { code: decision.code, reason: decision.reason } };
    }
  }

  // SME — safety-critical human-approval gate. The SECOND gate on this seam,
  // and — because EVERY `→ done` path routes through `transitionTicket` (the
  // MCP `devpilot_move_ticket` route, the board human move; the reconciler /
  // aggregator / scheduler never target `done`, and every other `status:"done"`
  // write in the codebase is on the `runs` table, not `tickets`) — the single
  // choke point that makes it bypass-proof. Unlike the L1 gate this has NO env
  // flag: the `safety_critical` flag on the ticket is the whole trigger, so the
  // gate cannot be silently disabled. On a non-human `→ done` for a
  // safety-critical ticket we mutate NOTHING and hand the caller a typed
  // refusal to recover from (park to blocked pending human approval — never a
  // retry). Placed BEFORE assertTransition/update so a refusal commits nothing.
  const safety = decideSafetyGate({
    to: input.to,
    actor: input.actor,
    safetyCritical: (data as { safety_critical?: boolean }).safety_critical === true,
  });
  if (!safety.allow) {
    console.warn(
      `[transitionTicket] safety-gate refused ticket=${input.ticketId} actor=${input.actor} code=${safety.code}`,
    );
    return { transitioned: false, gateRefusal: { code: safety.code, reason: safety.reason } };
  }

  // Dependency guard: refuse to move INTO `ready` while any blocker still holds
  // this ticket back. Other transitions are allowed so the engine can still pause
  // (input_required, blocked) or fail without contortion.
  //
  // WI-5 — the test is no longer `status !== "done"`. It is "the blocker's work
  // isn't on the integration branch yet, and a landing is still owed for it"
  // (lib/integration/landed.ts). `done` and `landed` are different facts, and the
  // gap between them is where a dependent would branch off a dev tip that lacks
  // its parent's commits.
  //
  // THE HUMAN OVERRIDE. Tightening an actor-agnostic guard would otherwise take
  // something away from operators: a done blocker has never blocked a human move,
  // and after WI-5 a done-but-unlanded one would. So a human may override
  // `awaiting_land` — a blocker that is finished and merely waiting on the land
  // worker — and only that. A blocker that is still being WORKED refuses for
  // humans exactly as it does today. (Same shape as the QA gate's human
  // short-circuit: a human is the override path; the gate exists to stop the
  // ENGINE acting unsafely on its own.)
  if (input.to === "ready") {
    const { blockers, summary } = await loadBlockerSummaryService(input.ticketId, rowTenantId);
    const overridable = input.actor === "human" && humanMayOverride(summary);
    if (summary.open > 0 && !overridable) {
      throw new BlockedByDependencyError(
        blockers.filter((b) =>
          b.landOpenness ? b.landOpenness !== "closed" : b.status !== "done",
        ),
      );
    }
  }

  assertTransition(data.status as TicketStatus, input.to);

  const patch: Record<string, unknown> = { status: input.to };
  if (input.retryDelta) patch.retry_count = (data.retry_count ?? 0) + input.retryDelta;
  // QA retry ceiling - the reset half (see lib/board/qa-retry.ts). A ticket whose
  // engineer↔QA reject loop exhausted its budget is parked to `blocked`; a HUMAN
  // moving it back out is the intervention the park was asking for, so the retry
  // budget starts over. Without this the park would be a permanent wedge - the
  // operator un-blocks, the dispatcher re-reads the still-exhausted counter and
  // parks it straight back. Human-only on purpose: no agent or engine path can
  // hand itself a fresh budget (they can't author a `human` actor), so the
  // ceiling can't be self-cleared. `retryDelta` is never set on this path (only
  // the QA-reject move sets it), but the guard makes that explicit.
  if (
    input.actor === "human" &&
    (data.status as TicketStatus) === "blocked" &&
    input.to !== "blocked" &&
    !input.retryDelta
  ) {
    patch.retry_count = 0;
    // B2 — the gate ceiling's reset half, on the SAME human-only trigger and for
    // the same reason: the park asks for an intervention, and the intervention
    // has now happened. Two separate columns, deliberately reset together —
    // sharing the trigger is not the same as sharing the counter, and only the
    // counter had to stay separate (see lib/board/gate-retry.ts).
    patch.gate_retry_count = 0;
  }
  if (input.description !== undefined) patch.description = input.description;
  if (input.acceptanceCriteria !== undefined) patch.acceptance_criteria = input.acceptanceCriteria;
  if (input.clearAssignee) patch.assignee_agent_id = null;
  else if (input.assigneeAgentId !== undefined) patch.assignee_agent_id = input.assigneeAgentId;
  // Clear the auto-promote flag whenever the ticket leaves Backlog so a manual
  // bump + later blocker-completion can't double-fire the promotion.
  if (data.status === "backlog" && input.to !== "backlog") {
    patch.auto_promote_when_unblocked = false;
  }

  let update = supabase.from("tickets").update(patch).eq("id", input.ticketId);
  if (input.expectedFrom) update = update.eq("status", input.expectedFrom);
  const { data: updated, error: upErr } = await update.select("id");
  if (upErr) throw new Error(`transitionTicket: ${upErr.message}`);
  if (input.expectedFrom && (!updated || updated.length === 0)) {
    return { transitioned: false };
  }

  // Phase 2 dispatch_queue hygiene: when a ticket lands in a terminal state,
  // cancel any pending queue entries so the drain doesn't re-dispatch a
  // ticket that has nowhere to go. Best-effort — drain re-checks status too.
  if (TERMINAL_FOR_QUEUE.has(input.to)) {
    try {
      await cancelPendingForTicket(input.ticketId, rowTenantId, `ticket-transitioned:${input.to}`);
    } catch (err) {
      console.warn(
        `[transitionTicket] cancelPendingForTicket failed for ${input.ticketId}: ${String(err)}`,
      );
    }
  }

  // Default to emitting the dispatch event so the engine picks up the next role.
  // Suppress for:
  //   • done/failed  — terminal, nothing more to dispatch.
  //   • input_required — paused waiting for human; resume is event-driven
  //                      (agent/run.human-reply), not dispatch.
  //   • paused       — operator-initiated soft-cancel; resume goes through
  //                    pause-resume.ts which decides replay vs dispatch.
  //                    Emitting here would spuriously fire a fresh run while
  //                    the ticket is meant to be on hold.
  const emit =
    input.emitDispatch ??
    !(
      input.to === "done" ||
      input.to === "failed" ||
      input.to === "input_required" ||
      input.to === "paused"
    );
  if (emit) {
    await sendEventBounded({
      name: "ticket/dispatch-needed",
      data: { ticketId: input.ticketId, tenantId: input.tenantId },
    });
  }

  if (input.to === "done") {
    // WI-4 — enqueue the ticket for landing, INLINE and BEFORE any dependent is
    // considered for promotion. The ordering is the whole point, not an
    // implementation detail:
    //
    // `promoteUnblockedDependents` below asks "does this dependent still have an
    // open blocker?", and under WI-5 the answer for a landable parent is "yes —
    // it is awaiting its landing". But that is only true once the queue row
    // EXISTS. Enqueue via an event instead and the two race: promotion reads "no
    // queue row ⇒ nothing owed ⇒ blocker closed", promotes the dependent, and the
    // dependent starts on a dev tip that does not contain its parent's work.
    // Inserting the row here closes the race by construction.
    //
    // For a ticket with nothing to land — no branch, auto-land off, a non-code
    // role — this is a cheap no-op, no row is written, and the promotion below
    // behaves exactly as it always has.
    try {
      await enqueueForLanding({ ticketId: input.ticketId, tenantId: input.tenantId });
    } catch (err) {
      console.warn(
        `[transitionTicket] enqueueForLanding failed for ${input.ticketId}: ${String(err)}`,
      );
    }

    // Bulk Move-to-Ready follow-up. A flagged dependent that has been waiting on
    // this ticket can now be promoted to Ready — unless the enqueue above just
    // recorded that a landing is owed, in which case every dependent correctly
    // reads as still-blocked here and is promoted later by the land-success
    // trigger in the land worker instead. Best-effort: a promotion failure must
    // not roll back the just-completed transition the caller depends on.
    try {
      await promoteUnblockedDependents({
        blockerTicketId: input.ticketId,
        tenantId: input.tenantId,
      });
    } catch (err) {
      console.warn(
        `[transitionTicket] promoteUnblockedDependents failed for ${input.ticketId}: ${String(err)}`,
      );
    }

    // A ticket must not reach `done` SILENTLY while its branch was never
    // pushed. The workspace reaper now holds that workspace back rather than
    // deleting the only copy of the commits (lib/workspace/unpushed-work.ts),
    // but held-on-disk is not delivered: nothing is on the remote and no PR
    // exists. Post a system comment so the gap is visible on the ticket itself.
    //
    // A notice, not a block: `→ done` still commits. Best-effort, exactly like
    // the promotion above - a comment failure must never roll back a transition
    // the caller already depends on.
    try {
      await noticeUnpushedWorkOnDone({ ticketId: input.ticketId, tenantId: input.tenantId });
    } catch (err) {
      console.warn(
        `[transitionTicket] unpushed-work notice failed for ${input.ticketId}: ${String(err)}`,
      );
    }
  }

  return { transitioned: true };
}

/**
 * Ready-side fan-out cap (WI-5.6). A wide `builds_on` tree can have dozens of
 * children waiting on one parent, and a single landing would otherwise ready all
 * of them at once — straight past the subscription concurrency boundary the whole
 * system is built around ("~1-3 steady concurrent agents", AGENTS.md). The
 * remainder is not lost: they stay in the backlog, and the land-success event
 * re-fires the drain, whose sliding window is the real throttle.
 */
const MAX_PROMOTIONS_PER_EVENT = 10;

/**
 * Scan direct dependents of a ticket and promote any that are waiting on
 * auto-promote and are now fully unblocked.
 *
 * WI-5 moved WHEN this fires. It used to run only on `* → done`, which is now too
 * early: at `done` the ticket's work is not yet on the integration branch, so
 * every dependent still reads as blocked, the promotion finds nothing, and
 * nothing ever re-fires it — the dependent is wedged in the backlog forever. The
 * landing is the fact that actually unblocks a dependent, so the land worker
 * calls this on land-success (and the reaper does too, when it reconciles a
 * landing forward).
 *
 * It is still ALSO called on `→ done`, and that is not a leftover: a ticket with
 * nothing to land (a PM ticket, a design ticket — the ~48 non-code roles) has no
 * landing to wait for, its blockers close at `done`, and `done` is the only
 * signal it will ever emit. The two call sites are disjoint by construction: the
 * `hasOpenBlockers` re-check below is what decides, and it is the same predicate
 * in both.
 *
 * Each promotion goes through `transitionTicket` itself so the dispatch event +
 * queue hygiene + audit trail land on the canonical path.
 */
export async function promoteUnblockedDependents(args: {
  blockerTicketId: string;
  tenantId: string;
}): Promise<{ promoted: string[] }> {
  const supabase = supabaseService();
  const { data: deps, error: depsErr } = await supabase
    .from("ticket_dependencies")
    .select("ticket_id")
    .eq("blocks_ticket_id", args.blockerTicketId)
    // Same filter as `fetchBlockerRows` - auto-promotion is the mirror image of
    // the readiness guard, so only a BLOCKING relation may promote a dependent.
    // A `related` row (auto-created by an @mention) never blocked anything, so
    // it must not unblock anything either.
    .in("relation_type", BLOCKING_RELATION_TYPES as unknown as string[]);
  if (depsErr || !deps || deps.length === 0) return { promoted: [] };

  const dependentIds = Array.from(new Set(deps.map((d) => d.ticket_id as string).filter(Boolean)));
  if (dependentIds.length === 0) return { promoted: [] };

  // Only tickets still in backlog with the flag set are promotion candidates.
  // Scoped to the same tenant defensively — RLS already covers this, but the
  // service-role client doesn't enforce it and we don't want a stray
  // cross-tenant dep row to leak a promotion.
  const { data: candidates, error: candErr } = await supabase
    .from("tickets")
    .select("id")
    .in("id", dependentIds)
    .eq("tenant_id", args.tenantId)
    .eq("status", "backlog")
    .eq("auto_promote_when_unblocked", true);
  if (candErr || !candidates || candidates.length === 0) return { promoted: [] };

  const promoted: string[] = [];
  for (const c of candidates) {
    if (promoted.length >= MAX_PROMOTIONS_PER_EVENT) {
      console.log(
        `[promoteUnblockedDependents] hit the ${MAX_PROMOTIONS_PER_EVENT}-promotion cap for ` +
          `blocker ${args.blockerTicketId}; the rest stay in backlog for the drain window`,
      );
      break;
    }
    const id = c.id as string;
    // Re-check the full blocker set: more than one upstream might still be
    // open even though THIS one just closed. This is ALSO what makes the
    // `→ done` and land-success call sites safe to both exist - a ticket with a
    // landing still owed reads as blocked here and is simply skipped.
    try {
      // `id` came from the candidate query above, which is already
      // `.eq("tenant_id", args.tenantId)` — so this ticket is proven to be in
      // that tenant and it is the right scope for its blocker read.
      if (await hasOpenBlockers(id, args.tenantId)) continue;
      await transitionTicket({
        ticketId: id,
        tenantId: args.tenantId,
        to: "ready",
        // Engine-initiated dependency promotion — never a `→ in_review`, so
        // ungated regardless, but the actor is required and it is the system.
        actor: "system",
      });
      promoted.push(id);
    } catch (err) {
      console.warn(`[promoteUnblockedDependents] promotion failed for ${id}: ${String(err)}`);
    }
  }
  return { promoted };
}

export async function addComment(args: {
  ticketId: string;
  tenantId: string;
  authorType: "agent" | "human" | "system";
  authorId: string;
  body: string;
  /** Slice A — optional structured payload for tool-driven comments.
   *  Today the UI looks for `metadata.kind === 'secret_request'` and renders
   *  a `<SecretRequestCard>` (masked-input form) instead of plain markdown.
   *  Schema is intentionally open-ended (jsonb) so other future tools can
   *  piggy-back without a migration. */
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  const supabase = supabaseService();
  const { error } = await supabase.from("comments").insert({
    ticket_id: args.ticketId,
    tenant_id: args.tenantId,
    author_type: args.authorType,
    author_id: args.authorId,
    body: args.body,
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
  });
  if (error) throw new Error(`addComment: ${error.message}`);
}
