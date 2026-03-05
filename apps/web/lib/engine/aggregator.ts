// Phase 1 / M6 — fan-in aggregator.
//
// What this does
// ──────────────
// On every `agent/run.completed`, check whether the completing run belongs to
// a fan-out cohort (carries a `fan_out_group`). If so, look at every sibling
// run for that cohort, and — when the ticket's acceptance strategy is
// satisfied — transition the ticket and re-emit ONE `ticket/dispatch-needed`
// event so the next phase (QA in the canonical demo) picks up.
//
// Idempotency contract (the runaway-shape guard)
// ──────────────────────────────────────────────
// The 2026-06-02 runaway (SESSION_HANDOFF.md §8b) was a broadcast re-fan on
// every completion event that re-emitted dispatch even when the ticket had
// already moved. M6 must NOT reintroduce this.
//
// The aggregator's anti-runaway invariants:
//
//   1. Decision claim. Before re-emitting any event, the aggregator INSERTs a
//      row into `fan_in_decisions` with PK `(fan_out_group, phase)`. The DB
//      unique-violation (Postgres 23505) is the ONLY signal that an earlier
//      invocation already decided — on a unique violation we abort silently.
//      Inngest replays and racing completion events therefore never produce
//      two transitions for the same cohort.
//
//   2. Terminal-ticket guard. If the ticket is already in {done, failed,
//      blocked}, we INSERT a `cancelled` decision row to record the decision
//      was abandoned, then exit. No event is emitted. Re-emitting a dispatch
//      against a terminal ticket is the exact runaway shape we're guarding
//      against.
//
//   3. No re-entrance. The aggregator only reacts to `agent/run.completed`.
//      It never listens for `ticket/dispatch-needed`, so even if the
//      re-emitted dispatch event somehow racing-replayed (it shouldn't —
//      Inngest events are durable), the aggregator wouldn't loop on itself.
//
// Strategy semantics
// ──────────────────
// • single   — the dispatcher never emits a cohort for this strategy, but if
//              we ever see one we treat completion-count >= 1 as satisfied.
// • all      — every sibling in the cohort must have status in {done, failed}.
//              Failure is treated as "this sibling spoke" — the QA stage can
//              decide what to do with a security-review FAIL marker. We do not
//              gate the transition on every sibling being `done`; that's a
//              Phase 2 decision once we add a "rejected" strategy.
// • quorum(N)— first N completed siblings (any status) satisfy the cohort.

import { NonRetriableError } from "inngest";
import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { transitionTicket, addComment } from "@/lib/board/transitions";
import { isEngineerQaGateEnabled } from "@/lib/board/qa-gate";
import { loadCohortGateRefusal } from "@/lib/board/qa-gate.server";
import type { TicketStatus } from "@/lib/board/state";
import {
  DEFAULT_FAN_OUT_PHASE,
  parseAcceptanceStrategy,
  parseCohortPlan,
  strategySatisfied,
  type CohortPlanEntry,
} from "@/lib/engine/fan-out";

const TERMINAL_TICKET_STATES: ReadonlySet<string> = new Set(["done", "failed", "blocked"]);

/**
 * The aggregator is keyed by (tenantId, fanOutGroup) so two siblings of the
 * same cohort completing simultaneously serialise through one invocation.
 * Different cohorts run in parallel. A `concurrency.limit: 1` per cohort key
 * is enough — Postgres unique_violation backs us up if the limit is ever
 * misconfigured.
 */
export const fanInAggregator = inngest.createFunction(
  {
    id: "fan-in-aggregator",
    retries: 1,
    concurrency: {
      limit: 1,
      key: 'event.data.tenantId + ":" + (event.data.fanOutGroup || "no-group")',
    },
  },
  { event: "agent/run.completed" },
  async ({ event, step }) => {
    const {
      tenantId,
      fanOutGroup: rawFanOutGroup,
      fanOutPhase: rawFanOutPhase,
      cohortKey: rawCohortKey,
      runId,
    } = event.data;

    // Fast-skip: events without a cohort are Phase 0 single-emit runs — the
    // aggregator's not interested. Use the event payload as the hint, then
    // fall back to a one-row DB read for legacy completion events that don't
    // carry the fields.
    let fanOutGroup = rawFanOutGroup ?? null;
    let fanOutPhase = rawFanOutPhase ?? DEFAULT_FAN_OUT_PHASE;
    let runCohortKey: string | null = rawCohortKey ?? null;
    if (!fanOutGroup) {
      const fromRow = await step.run("read-run-cohort", async () => readRunCohort(runId));
      if (!fromRow) {
        return { runId, skipped: "no-fan-out-group" };
      }
      fanOutGroup = fromRow.fanOutGroup;
      fanOutPhase = fromRow.fanOutPhase ?? DEFAULT_FAN_OUT_PHASE;
      runCohortKey = fromRow.cohortKey ?? null;
    }

    // Re-read cohort state from the DB rather than trusting in-memory state.
    // This is the "world state, not event state" invariant from CLAUDE.md.
    const cohort = await step.run("load-cohort", async () => loadCohort(tenantId, fanOutGroup!));
    if (!cohort) {
      // No ticket / no siblings — nothing to aggregate. Belt-and-braces:
      // shouldn't happen because the cohort was stamped by the dispatcher,
      // but a hand-deleted ticket would land here.
      return { runId, fanOutGroup, skipped: "cohort-empty" };
    }

    // Phase 2.5 / M6 — phase resolution. When the cohort came from a
    // `cohort_plan` (cohortEntry !== null) the phase IS the cohort_key —
    // each cohort instance gets its own `fan_in_decisions` row. The event
    // payload's fanOutPhase ("review" default) only applies on the legacy
    // single-cohort path.
    if (cohort.cohortEntry) {
      fanOutPhase = cohort.cohortEntry.cohort_key;
    } else if (runCohortKey) {
      // Defensive: run row has a cohort_key but the plan no longer parses
      // (e.g. plan was rewritten between fan-out and fan-in). Use the run's
      // cohort_key as the phase to keep the idempotency ledger keyed
      // consistently with seed time.
      fanOutPhase = runCohortKey;
    }

    // Decision time. Does the strategy permit the join now?
    const strategy = parseAcceptanceStrategy(cohort.acceptanceStrategy);
    const completedCount = cohort.siblingRuns.filter(
      (r) => r.status === "done" || r.status === "failed",
    ).length;
    const satisfied = strategySatisfied(strategy, completedCount, cohort.siblingRuns.length);
    if (!satisfied) {
      return {
        runId,
        fanOutGroup,
        skipped: "strategy-not-satisfied",
        strategy: cohort.acceptanceStrategy,
        completed: completedCount,
        total: cohort.siblingRuns.length,
      };
    }

    // Pre-transition runaway guard #2: if the ticket has already moved to a
    // terminal state for any reason (manual close, sibling cohort moved it),
    // we MUST NOT re-emit a dispatch. Record cancelled decision and exit.
    if (TERMINAL_TICKET_STATES.has(cohort.ticketStatus)) {
      await step.run("decision-cancelled-terminal", async () =>
        insertDecision({
          tenantId,
          ticketId: cohort.ticketId,
          fanOutGroup: fanOutGroup!,
          phase: fanOutPhase,
          strategy: cohort.acceptanceStrategy,
          outcome: "cancelled",
          siblingRuns: cohort.siblingRuns.map((r) => r.id),
          decidedByRun: runId,
          notes: `ticket already in terminal state: ${cohort.ticketStatus}`,
        }),
      );
      return {
        runId,
        fanOutGroup,
        skipped: "ticket-terminal",
        status: cohort.ticketStatus,
      };
    }

    // The atomic claim. INSERT into fan_in_decisions; on 23505 (unique
    // violation) another invocation already decided this cohort and we abort.
    // This is the ONLY place we authorise a fan-in transition.
    const claim = await step.run("claim-decision", async () =>
      insertDecision({
        tenantId,
        ticketId: cohort.ticketId,
        fanOutGroup: fanOutGroup!,
        phase: fanOutPhase,
        strategy: cohort.acceptanceStrategy,
        outcome: "accepted",
        siblingRuns: cohort.siblingRuns.map((r) => r.id),
        decidedByRun: runId,
        notes: `strategy=${cohort.acceptanceStrategy} completed=${completedCount}/${cohort.siblingRuns.length}`,
      }),
    );
    if (!claim.inserted) {
      return {
        runId,
        fanOutGroup,
        skipped: "decision-already-recorded",
        existingDecisionId: claim.existingId,
      };
    }

    // Compose the fan-in comment and transition. The destination state for
    // the canonical demo is `in_review` — when each sibling already moved the
    // ticket to in_review via its own `devpilot_move_ticket` MCP call, the
    // transition below is a no-op (ticket already there) and we just emit
    // the dispatch. For the acceptance-script's synthetic flow where the
    // siblings don't actually call MCP tools, we drive the transition here.
    await step.run("fan-in-comment", async () =>
      addComment({
        ticketId: cohort.ticketId,
        tenantId,
        authorType: "system",
        authorId: "aggregator",
        body:
          `Fan-in: cohort ${fanOutGroup!.slice(0, 8)} satisfied ` +
          `(strategy=${cohort.acceptanceStrategy}, ` +
          `${completedCount}/${cohort.siblingRuns.length} siblings completed). ` +
          `Cohort roles: [${cohort.siblingRuns.map((r) => r.fanOutRole ?? "?").join(", ")}].`,
      }),
    );

    // Transition the ticket only if it isn't already in the target state.
    // The canonical demo target is `in_review` (so QA picks up next). If a
    // sibling's MCP tool call already moved it there, we skip; otherwise we
    // drive the transition. Either way, we emit a single dispatch.
    const target: TicketStatus = "in_review";
    await step.run("fan-in-transition", async () => {
      if (cohort.ticketStatus === target) {
        // Already there — emit a single dispatch event manually so QA picks up.
        await inngest.send({
          name: "ticket/dispatch-needed",
          data: { ticketId: cohort.ticketId, tenantId },
        });
        return;
      }
      // transitionTicket will fire its own dispatch event when moving into a
      // non-terminal state, so we don't need to send one separately.
      //
      // L1 / B2 — gate the WHOLE cohort before the transition, not just the
      // deciding sibling.
      //
      // `transitionTicket`'s gate is run-scoped (deliberately — it is what stops
      // a stale record re-parking an unblocked ticket), so it can only ever see
      // the ONE run whose completion won the fan-in claim. Under `strategy=all`
      // that made N-1 siblings' failing builds invisible, and when the deciding
      // sibling was a non-producer role (or cancelled, or api-policy) it had no
      // record at all and the whole cohort handed off ungated. A cohort is only
      // as shippable as its worst member — they all wrote to the same branch.
      const cohortRefusal = isEngineerQaGateEnabled()
        ? await loadCohortGateRefusal(
            cohort.siblingRuns,
            tenantId,
            cohort.ticketStatus as TicketStatus,
          )
        : null;
      if (cohortRefusal) {
        await addComment({
          ticketId: cohort.ticketId,
          tenantId,
          authorType: "system",
          authorId: "aggregator",
          body:
            `Fan-in cohort ${fanOutGroup!.slice(0, 8)} completed but a sibling's work failed the ` +
            `QA verification gate; parking to blocked instead of handing off to QA. ` +
            `${cohortRefusal.reason}`,
        });
        await transitionTicket({
          ticketId: cohort.ticketId,
          tenantId,
          to: "blocked",
          actor: "system",
          emitDispatch: false,
        });
        return;
      }
      // L1 — the fan-in `→ in_review` is gated too (actor:"system" + the
      // deciding run's id). Kept as defence in depth behind the cohort-wide
      // check above. On refusal the cohort run is already done, so we park to
      // `blocked` (like the engineer/reconciler dead-run paths) with a fenced
      // explanation under the aggregator's author.
      const result = await transitionTicket({
        ticketId: cohort.ticketId,
        tenantId,
        to: target,
        actor: "system",
        runId,
        clearAssignee: true,
      });
      if (result.gateRefusal) {
        await addComment({
          ticketId: cohort.ticketId,
          tenantId,
          authorType: "system",
          authorId: "aggregator",
          body:
            `Fan-in cohort ${fanOutGroup!.slice(0, 8)} completed but its work failed the QA ` +
            `verification gate; parking to blocked instead of handing off to QA. ` +
            `${result.gateRefusal.reason}`,
        });
        await transitionTicket({
          ticketId: cohort.ticketId,
          tenantId,
          to: "blocked",
          actor: "system",
          emitDispatch: false,
        });
      }
    });

    return {
      runId,
      fanOutGroup,
      decided: true,
      completed: completedCount,
      total: cohort.siblingRuns.length,
      target,
    };
  },
);

// ---------------------------------------------------------------------------
// Helpers — kept module-private; the aggregator is the only caller.

type CohortSnapshot = {
  ticketId: string;
  ticketStatus: string;
  acceptanceStrategy: string;
  /** Phase 2.5 / M6 — the cohort plan entry, when this cohort was seeded
   *  from `tickets.cohort_plan`. null on the legacy single-cohort path. */
  cohortEntry: CohortPlanEntry | null;
  /** Whether any other cohort in the plan cites this cohort_key as its
   *  parent_cohort_key — used by the aggregator to skip the transition for
   *  cohorts whose children still need to fire. */
  hasChildCohort: boolean;
  /** Cohort plan as-parsed from the ticket row (or null if absent /
   *  malformed). The aggregator uses this to discover child cohorts. */
  cohortPlanEntries: CohortPlanEntry[] | null;
  siblingRuns: Array<{
    id: string;
    status: string;
    fanOutRole: string | null;
  }>;
};

async function readRunCohort(runId: string): Promise<{
  fanOutGroup: string;
  fanOutPhase: string | null;
  cohortKey: string | null;
} | null> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("runs")
    .select("fan_out_group, cohort_key")
    .eq("id", runId)
    .maybeSingle();
  if (error || !data) return null;
  const fanOutGroup = (data.fan_out_group as string | null) ?? null;
  if (!fanOutGroup) return null;
  return {
    fanOutGroup,
    fanOutPhase: null,
    cohortKey: (data.cohort_key as string | null) ?? null,
  };
}

async function loadCohort(tenantId: string, fanOutGroup: string): Promise<CohortSnapshot | null> {
  const supabase = supabaseService();
  // Pull the ticket via the cohort uuid. For the legacy single-cohort path
  // there is exactly one ticket per fan_out_group (uuid stamped on row).
  // For the cohort-plan path, fan_out_group identifies one cohort instance
  // and the same ticket may carry multiple cohorts in sequence — the
  // ticket-level fan_out_group column matches the FIRST cohort only.
  //
  // To find the ticket reliably regardless of which cohort fired, we look
  // up the run row first (any sibling will do) and read its ticket_id.
  const { data: anyRun } = await supabase
    .from("runs")
    .select("ticket_id, cohort_key")
    .eq("tenant_id", tenantId)
    .eq("fan_out_group", fanOutGroup)
    .limit(1)
    .maybeSingle();
  if (!anyRun) return null;
  const ticketId = anyRun.ticket_id as string | null;
  if (!ticketId) return null;
  const runCohortKey = (anyRun.cohort_key as string | null) ?? null;

  const { data: ticket } = await supabase
    .from("tickets")
    .select("id, status, acceptance_strategy, cohort_plan")
    .eq("tenant_id", tenantId)
    .eq("id", ticketId)
    .maybeSingle();
  if (!ticket) return null;

  const { data: runs, error } = await supabase
    .from("runs")
    .select("id, status, fan_out_role")
    .eq("tenant_id", tenantId)
    .eq("fan_out_group", fanOutGroup);
  if (error || !runs) return null;

  // Phase 2.5 / M6 — try to resolve the cohort plan entry. If the run row
  // carries a cohort_key, look it up in tickets.cohort_plan. If not, this
  // is a legacy fan-out and we use tickets.acceptance_strategy (scalar).
  const plan = parseCohortPlan(ticket.cohort_plan);
  const cohortPlanEntries = plan ? plan.cohorts : null;
  let cohortEntry: CohortPlanEntry | null = null;
  let hasChildCohort = false;
  if (runCohortKey && plan) {
    cohortEntry = plan.cohorts.find((c) => c.cohort_key === runCohortKey) ?? null;
    hasChildCohort = plan.cohorts.some((c) => c.parent_cohort_key === runCohortKey);
  }

  return {
    ticketId,
    ticketStatus: ticket.status as string,
    // Source of truth for the strategy: cohort entry when present (each
    // entry can have its own strategy in the multi-stage plan), else the
    // ticket's scalar column (back-compat).
    acceptanceStrategy:
      cohortEntry?.acceptance_strategy ?? (ticket.acceptance_strategy as string | null) ?? "single",
    cohortEntry,
    hasChildCohort,
    cohortPlanEntries,
    siblingRuns: runs.map((r) => ({
      id: r.id as string,
      status: r.status as string,
      fanOutRole: (r.fan_out_role as string | null) ?? null,
    })),
  };
}

type InsertDecisionInput = {
  tenantId: string;
  ticketId: string;
  fanOutGroup: string;
  phase: string;
  strategy: string;
  outcome: "accepted" | "rejected" | "cancelled";
  siblingRuns: string[];
  decidedByRun?: string;
  notes?: string;
};

async function insertDecision(
  input: InsertDecisionInput,
): Promise<{ inserted: true; id: string } | { inserted: false; existingId: string | null }> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("fan_in_decisions")
    .insert({
      tenant_id: input.tenantId,
      ticket_id: input.ticketId,
      fan_out_group: input.fanOutGroup,
      phase: input.phase,
      strategy: input.strategy,
      outcome: input.outcome,
      sibling_runs: input.siblingRuns,
      decided_by_run: input.decidedByRun ?? null,
      notes: input.notes ?? null,
    })
    .select("id")
    .single();
  if (error) {
    // 23505 unique_violation on (fan_out_group, phase) — another invocation
    // already decided this cohort. This is the idempotency guard.
    if ((error as { code?: string }).code === "23505") {
      // Look up the existing row id for telemetry. Best-effort.
      const { data: existing } = await supabase
        .from("fan_in_decisions")
        .select("id")
        .eq("fan_out_group", input.fanOutGroup)
        .eq("phase", input.phase)
        .maybeSingle();
      return { inserted: false, existingId: (existing?.id as string | null) ?? null };
    }
    throw new NonRetriableError(`insertDecision: ${error.message}`);
  }
  return { inserted: true, id: data.id as string };
}
