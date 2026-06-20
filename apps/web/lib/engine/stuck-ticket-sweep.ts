// Stuck-ticket sweeper — engine-side cron that repairs tickets stranded in a
// working state after their run already completed.
//
// Why this exists
// ───────────────
// The event-time fix for the stuck-in_progress bug lives in runAgent's
// `reconcile-ticket` step (see lib/engine/reconcile-policy.ts for the whole
// story). That step only fires for runs completing FROM NOW ON; tickets
// already stranded in production (e.g. 865345ef: latest run qa 'done',
// ticket still in_progress for hours) need a periodic repair pass. The
// sweeper is also the backstop when the event-time step itself is skipped
// or lost (deploy race, Inngest hiccup).
//
// Detection criteria (ALL must hold)
// ──────────────────────────────────
//   • ticket status ∈ {assigned, in_progress, in_review} and untouched for
//     ≥ threshold (default 10 min);
//   • the ticket's LATEST run is status='done' and finished ≥ threshold ago
//     (failed/cancelled latest runs belong to supervision / pause-resume,
//     not to us — see the note below, which corrects that attribution);
//   • that run is not part of a fan-out cohort (the aggregator owns those);
//   • no run on the ticket is running / awaiting_human;
//   • no pending dispatch_queue row (the WIP drain will handle it);
//   • tenant/project automation is not paused.
// The "reconciler already acted for this run" idempotency check (a
// 'ticket-reconciler' comment newer than the run) now lives inside
// reconcileTicketAfterRun (sweeper-mode gated), so a terminal `block` decision
// can bypass it and surface a ticket already frozen at the re-dispatch cap;
// non-block decisions still skip there with `skipped:already-reconciled`.
//
// WHO OWNS A FAILED/CANCELLED LATEST RUN (checked 2026-08-03, do not widen)
// ────────────────────────────────────────────────────────────────────────────
// The exclusion above once delegated to "supervision / pause-resume", and that
// attribution was wrong: `applySupervisionStrategy` touches the ticket only
// under `escalate_to_human`, and under the default `let_it_crash` nobody did.
// The real owner is `orphanTicketReaper` (lib/engine/orphan-ticket-reaper.ts),
// built for exactly this gap and NON-OVERLAPPING with this sweep by
// construction: it stands down with `latest-run-done`, which is precisely the
// set we take. The two 5-minute crons can therefore never both act on one
// ticket.
//
// That reaper was confirmed working during the 2026-08-03 deadlock — it fired
// and recovered stranded `in_progress` tickets whose latest runs had ended
// `failed`/`cancelled`. So this sweep is deliberately NOT widened. Widening it
// would put two crons with two different policies on one ticket, and the
// verdict-less-review park (reconcile-policy's `block`) exists precisely
// because re-running a review that rendered no verdict is non-deterministic and
// could flip "changes requested" into a spurious approve.
//
// What DID fail in that incident was upstream of both crons: the Inngest dev
// server wedged, so no cron ran at all for hours (see the inngest-cli pin in
// apps/web/package.json), and separately a stalled `dispatch_queue` row disarmed
// the orphan reaper's pending-dispatch guard — now bounded by
// `dispatchRescueReaper` (lib/engine/dispatch-rescue.ts).
//
// Action: the shared `reconcileTicketAfterRun` routine — same FSM-legal
// decision the event-time step applies, same audit trail.
//
// Tunables
// ────────
//   DEVPILOT_STUCK_TICKET_SWEEP=0                    — disable the cron.
//   DEVPILOT_STUCK_TICKET_SWEEP_THRESHOLD_SECONDS=600 — staleness window.
//   DEVPILOT_STUCK_TICKET_SWEEP_BATCH=25             — per-tick cap on tickets
//     the sweep ACTS on (transition/dispatch/error; also the scan page size).
//
// The scan pages through candidates (oldest updated_at first, lossless
// (updated_at, id) keyset cursor) until BATCH_LIMIT rows have been acted on
// or MAX_SCAN_PAGES pages are exhausted. Rows that fail the cheap pre-checks
// (latest run not done, active run, paused tenant, already reconciled, …) or
// that the policy refuses read-only (action 'none', e.g. already at the
// role's success state) never move their updated_at, so if they consumed
// batch slots they would occupy the whole batch on every tick and starve
// genuinely stuck tickets ranked younger — only real actions count.

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { getEffectivePauseForTicket } from "@/lib/engine/automation-state";
import { reconcileTicketAfterRun } from "@/lib/engine/ticket-reconciler";

const SWEEP_ENABLED = (process.env.DEVPILOT_STUCK_TICKET_SWEEP ?? "1") !== "0";
const STALE_THRESHOLD_SECONDS = Number(
  process.env.DEVPILOT_STUCK_TICKET_SWEEP_THRESHOLD_SECONDS ?? "600",
);
const BATCH_LIMIT = Number(process.env.DEVPILOT_STUCK_TICKET_SWEEP_BATCH ?? "25");
// Backstop on scan work per tick: at most this many pages of BATCH_LIMIT rows
// are read looking for evaluable candidates.
const MAX_SCAN_PAGES = 10;

const SWEEPABLE_TICKET_STATUSES = ["assigned", "in_progress", "in_review"] as const;
const ACTIVE_RUN_STATUSES = ["running", "awaiting_human"] as const;

type CandidateTicket = {
  id: string;
  tenant_id: string;
  status: string;
  updated_at: string;
};

type SweepOutcome = {
  outcome: string;
  /** True when the sweep acted on the ticket (transition/dispatch applied, or
   *  errored mid-attempt) — only these consume BATCH_LIMIT slots. Read-only
   *  results (pre-check skips, policy 'none', lost CAS races) don't, so
   *  tickets that legitimately sit still can never starve the batch;
   *  MAX_SCAN_PAGES still bounds total scan work per tick. */
  actioned: boolean;
};

export const stuckTicketSweeper = inngest.createFunction(
  { id: "stuck-ticket-sweeper", retries: 1 },
  // Every 5 minutes; with the 10-minute threshold a stuck ticket is repaired
  // within 10–15 minutes of its run completing. The manual event trigger
  // mirrors runner-watchdog's, for ops/acceptance scripts.
  [{ cron: "*/5 * * * *" }, { event: "internal/stuck-ticket-sweep" }],
  async ({ step }) => {
    if (!SWEEP_ENABLED) {
      return { skipped: "DEVPILOT_STUCK_TICKET_SWEEP=0" };
    }

    const cutoffIso = await step.run("compute-cutoff", async () =>
      new Date(Date.now() - STALE_THRESHOLD_SECONDS * 1000).toISOString(),
    );

    let scanned = 0;
    let actioned = 0;
    let reconciled = 0;
    let cursor: { updatedAtIso: string; id: string } | null = null;
    const actions: Array<{ ticketId: string; outcome: string }> = [];

    for (let page = 0; page < MAX_SCAN_PAGES && actioned < BATCH_LIMIT; page++) {
      const candidates = await step.run(`scan-candidates-${page}`, async () => {
        const supabase = supabaseService();
        let query = supabase
          .from("tickets")
          .select("id, tenant_id, status, updated_at")
          .in("status", SWEEPABLE_TICKET_STATUSES as unknown as string[])
          .lt("updated_at", cutoffIso)
          .order("updated_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(BATCH_LIMIT);
        if (cursor) {
          // (updated_at, id) keyset: strictly-after in the scan order, so rows
          // sharing the page-boundary timestamp are never skipped.
          query = query.or(
            `updated_at.gt."${cursor.updatedAtIso}",and(updated_at.eq."${cursor.updatedAtIso}",id.gt."${cursor.id}")`,
          );
        }
        const { data, error } = await query;
        if (error) throw new Error(`scan-candidates: ${error.message}`);
        return (data ?? []) as CandidateTicket[];
      });
      if (candidates.length === 0) break;
      scanned += candidates.length;
      const lastRow = candidates[candidates.length - 1];
      if (lastRow) cursor = { updatedAtIso: lastRow.updated_at, id: lastRow.id };

      for (const ticket of candidates) {
        if (actioned >= BATCH_LIMIT) break;
        const result = await step.run(`reconcile-${ticket.id}`, async (): Promise<SweepOutcome> => {
          try {
            return await sweepOne(ticket, cutoffIso);
          } catch (err) {
            // Per-ticket isolation: one bad row must not stall the sweep.
            console.warn(
              `[stuck-ticket-sweep] reconcile failed for ticket ${ticket.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            return { outcome: "error", actioned: true };
          }
        });
        actions.push({ ticketId: ticket.id, outcome: result.outcome });
        if (result.actioned) actioned += 1;
        if (result.outcome.startsWith("applied")) reconciled += 1;
      }
    }

    return { cutoffIso, scanned, actioned, reconciled, actions };
  },
);

async function sweepOne(ticket: CandidateTicket, cutoffIso: string): Promise<SweepOutcome> {
  const skip = (outcome: string): SweepOutcome => ({ outcome, actioned: false });
  const supabase = supabaseService();

  // Latest run decides whether this ticket is "completed but stranded".
  //
  // Every read in this function is scoped to `ticket.tenant_id` — the tenant on
  // the candidate row the sweep selected, which is this ticket's own. The three
  // reads below are all DISARM signals ("a run is live", "a dispatch is queued",
  // "the latest run isn't done"), so each is a way for a planted row to make the
  // sweeper stand down and strand our ticket for good.
  const { data: latestRows, error: latestErr } = await supabase
    .from("runs")
    .select("id, status, agent_id, fan_out_group, fan_out_role, created_at, last_event_at")
    .eq("ticket_id", ticket.id)
    .eq("tenant_id", ticket.tenant_id)
    .order("created_at", { ascending: false })
    .limit(1);
  if (latestErr) throw new Error(`latest run lookup: ${latestErr.message}`);
  const latest = latestRows?.[0];
  if (!latest) return skip("skip:no-runs");
  if ((latest.status as string) !== "done") return skip(`skip:latest-${latest.status}`);
  if (latest.fan_out_group) return skip("skip:fan-out-cohort");
  const finishedAt = (latest.last_event_at as string | null) ?? (latest.created_at as string);
  if (finishedAt > cutoffIso) return skip("skip:recently-finished");

  const { data: activeRuns } = await supabase
    .from("runs")
    .select("id")
    .eq("ticket_id", ticket.id)
    .eq("tenant_id", ticket.tenant_id)
    .in("status", ACTIVE_RUN_STATUSES as unknown as string[])
    .limit(1);
  if ((activeRuns ?? []).length > 0) return skip("skip:active-run");

  const { data: pendingQueue } = await supabase
    .from("dispatch_queue")
    .select("id")
    .eq("ticket_id", ticket.id)
    .eq("tenant_id", ticket.tenant_id)
    .eq("status", "pending")
    .limit(1);
  if ((pendingQueue ?? []).length > 0) return skip("skip:pending-dispatch-queue");

  // Operator's off switch wins — a paused workspace/project must stay quiet.
  // (reconcileTicketAfterRun re-checks this before acting; gating here spares
  // paused tenants the reconciler's heavier evidence queries.)
  const pauseGate = await getEffectivePauseForTicket(ticket.tenant_id, ticket.id);
  if (pauseGate.paused) return skip("skip:automation-paused");

  // The "already handled for this run?" idempotency check (a RECONCILER_COMMENT_
  // AUTHOR comment newer than the run) used to live HERE as a hard pre-skip. It
  // now lives inside reconcileTicketAfterRun (gated to sweeper mode), so a
  // verdict-role ticket that already exhausted its re-dispatch attempts is still
  // re-evaluated and can be parked to `blocked` via the policy's terminal
  // `block` decision — the pre-skip would otherwise freeze it here for good.
  // Non-block decisions still short-circuit there with `skipped:already-reconciled`.
  const result = await reconcileTicketAfterRun({
    runId: latest.id as string,
    tenantId: ticket.tenant_id,
    ticketId: ticket.id,
    role: (latest.fan_out_role as string | null) ?? null,
    agentId: (latest.agent_id as string | null) ?? null,
    // No run-start snapshot exists here; staleness + latest-run-done + no
    // active runs establish "stranded" instead, and the policy refuses when
    // the ticket already sits at the role's onSuccessStatus (the run
    // demonstrably advanced it — a declined follow-up dispatch is the
    // dispatcher's deliberate decision, not a stranded ticket).
    statusAtRunStart: null,
    postNext: null,
    runStartedAtIso: latest.created_at as string,
  });

  if ("skipped" in result) return { outcome: `skip:${result.skipped}`, actioned: false };
  // L1 — the reconciler's fallback `→ in_review` was refused by the QA gate and
  // it parked the ticket to blocked. That IS an action (and a terminal-for-this-
  // loop one: blocked is outside SWEEPABLE_TICKET_STATUSES, so no re-sweep).
  if ("gateBlocked" in result) {
    return { outcome: "applied:qa-gate-blocked", actioned: true };
  }
  if (!result.applied) {
    return { outcome: `skip:policy-${result.decision.reason}`, actioned: false };
  }
  return {
    outcome: `applied:${result.decision.action}${
      result.decision.action === "transition" ? `:${result.decision.to}` : ""
    }`,
    actioned: true,
  };
}
