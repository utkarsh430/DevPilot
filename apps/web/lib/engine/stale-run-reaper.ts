// Stale-run reaper — engine-side cron that fails runs idle past a threshold
// and drains `dispatch_queue` by emitting a synthetic `agent/run.completed`.
//
// Closes the 2026-06-03 WIP-zombification class: when a runner crashes or a
// `claude -p` call hangs, the owning run sits in `status='running'` forever.
// The dispatcher's per-agent WIP gate refuses to release queued tickets until
// the in-flight run completes — but no completion event ever arrives. Tickets
// pile up in `dispatch_queue` with nothing to drain them.
//
// Behaviour:
//   • Cron */5 * * * * (every 5 minutes) AND an internal trigger event so the
//     acceptance script can invoke without waiting for the cron.
//   • Scans `runs` where status='running' AND last_event_at <= now() - threshold.
//     Default threshold 15 min; override via DEVPILOT_STALE_RUN_THRESHOLD_MINUTES.
//     Note: 'awaiting_human' is excluded — it's a legitimate paused state
//     (waiting on an input_required ticket comment, possibly for days).
//   • Per stale run, in a single step.run() so the I/O is checkpointed:
//       (a) UPDATE runs SET status='failed' WHERE id=:id AND status='running'.
//           The conditional clause makes the next cron tick idempotent — once
//           a row is failed, the second pass sees zero rows and skips.
//       (b) INSERT a system step at idx=99_996 documenting the reap. The idx
//           sits below cascade-kill's 99_998 and above runAgentFailed's 9999,
//           giving us a distinct, greppable audit signature.
//   • Per reaped run, emit `agent/run.completed` with status='failed'. The
//     dispatcher's concurrency key (tenantId:agentId) consumes this and
//     drains the next dispatch_queue entry for that pair, restoring forward
//     progress. The synthetic event includes fanOutGroup so the aggregator
//     can decrement quorum/all-style cohorts cleanly.
//   • DEVPILOT_STALE_RUN_REAPER=0 disables the cron entirely (matches the
//     workspace-reaper opt-out idiom).
//
// Out of scope:
//   • Ticket state changes. The ticket whose run got reaped stays where it
//     was (likely 'in_progress'). The dispatcher will re-fan on the next
//     ticket/dispatch-needed for that ticket, or the operator can manually
//     move it. Closing the WIP zombification class is the narrow goal.

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";

const REAPER_ENABLED = (process.env.DEVPILOT_STALE_RUN_REAPER ?? "1") !== "0";
const STALE_THRESHOLD_MINUTES = Number(process.env.DEVPILOT_STALE_RUN_THRESHOLD_MINUTES ?? "15");
const BATCH_LIMIT = Number(process.env.DEVPILOT_STALE_RUN_REAPER_BATCH ?? "100");

type StaleRunRow = {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  ticket_id: string | null;
  fan_out_group: string | null;
  fan_out_role: string | null;
  last_event_at: string;
};

export const staleRunReaper = inngest.createFunction(
  { id: "stale-run-reaper", retries: 1 },
  // Two triggers: the regular cron tick AND an internal event the acceptance
  // script (and any future operator-tooling) can use to invoke synchronously.
  [{ cron: "*/5 * * * *" }, { event: "internal/reap-stale-runs" }],
  async ({ step }) => {
    if (!REAPER_ENABLED) {
      return { skipped: "DEVPILOT_STALE_RUN_REAPER=0" };
    }

    const cutoffIso = await step.run("compute-cutoff", async () => {
      const d = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60_000);
      return d.toISOString();
    });

    const staleRuns = await step.run("scan-stale", async () => {
      const supabase = supabaseService();
      const { data, error } = await supabase
        .from("runs")
        .select("id, tenant_id, agent_id, ticket_id, fan_out_group, fan_out_role, last_event_at")
        .eq("status", "running")
        .lte("last_event_at", cutoffIso)
        .limit(BATCH_LIMIT);
      if (error) throw new Error(`scan failed: ${error.message}`);
      return (data ?? []) as StaleRunRow[];
    });

    if (staleRuns.length === 0) {
      return { cutoffIso, candidates: 0, reaped: 0 };
    }

    let reaped = 0;
    for (const run of staleRuns) {
      const claimed = await step.run(`reap-${run.id}`, async () => {
        const supabase = supabaseService();
        // Conditional update: if another reaper tick (or runAgentFailed) beat
        // us to this row, the UPDATE matches zero rows and we no-op.
        //
        // `stale-<N>min` is the convention `20260609000000_pause_resume_schema`
        // documented for this reaper when `status_reason` was added
        // ('stale-15min') but this write never actually stamped it — a run
        // reaped here carried no reason at all until the class of silent
        // `failed` rows this closes.
        const { data, error } = await supabase
          .from("runs")
          .update({
            status: "failed",
            status_reason: `stale-${STALE_THRESHOLD_MINUTES}min`,
            last_event_at: new Date().toISOString(),
          })
          .eq("id", run.id)
          .eq("status", "running")
          .select("id");
        if (error) throw new Error(`update failed for ${run.id}: ${error.message}`);
        if (!data || data.length === 0) return false;

        const { error: stepErr } = await supabase.from("run_steps").insert({
          run_id: run.id,
          idx: 99_996,
          kind: "system",
          payload: {
            kind: "stale-run-reaped",
            thresholdMinutes: STALE_THRESHOLD_MINUTES,
            last_event_at: run.last_event_at,
          },
        });
        if (stepErr) {
          // Audit-step write failure is non-fatal — the run is already
          // marked failed and the event will still drain the queue. Surface
          // it so ops can investigate (e.g., idx collision on a replay run).
          console.warn(
            `stale-run-reaper: audit step write failed for ${run.id}: ${stepErr.message}`,
          );
        }
        return true;
      });
      if (!claimed) continue;

      await step.sendEvent(`emit-${run.id}`, {
        name: "agent/run.completed",
        data: {
          runId: run.id,
          tenantId: run.tenant_id,
          ticketId: run.ticket_id ?? undefined,
          agentId: run.agent_id ?? undefined,
          // fan-out siblings carry fan_out_role; non-fanout single-emit runs
          // don't have a role on the row (the dispatcher routes by the ticket's
          // requested_role, which lives on the tickets table — not duplicated
          // here). undefined is fine; dispatchOnRunComplete's concurrency key
          // already handles the missing-role case.
          role: run.fan_out_role ?? undefined,
          status: "failed" as const,
          fanOutGroup: run.fan_out_group ?? undefined,
          // fanOutPhase intentionally omitted — not persisted on runs;
          // aggregator defaults it to DEFAULT_FAN_OUT_PHASE on receipt.
        },
      });
      reaped += 1;
    }

    return { cutoffIso, candidates: staleRuns.length, reaped };
  },
);
