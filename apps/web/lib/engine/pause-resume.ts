// Pause / Resume engine — operator-initiated soft-cancel + checkpoint resume.
//
// The contract
// ────────────
// pauseTicket():
//   1. Conditionally UPDATE tickets.status='paused' (only from a pausable
//      state). Zero rows ⇒ already paused/terminal/etc., return alreadyAtState.
//   2. For every in-flight run on the ticket (running | awaiting_human),
//      conditionally UPDATE runs.status='cancelled', write an audit step at
//      idx=99_993, and emit agent/run.completed (status='failed') so the
//      WIP-drain dispatcher releases the slot. The runAgent loop notices
//      the status flip at the next iteration's check-cancel step (PR1) and
//      exits cleanly — the in-flight step.run still lands, which is exactly
//      what we want (that step becomes the resume point).
//
// resumeTicket():
//   1. Conditionally UPDATE tickets.status='paused' → 'in_progress'. Zero
//      rows ⇒ someone else already resumed, return alreadyAtState.
//   2. Look up the latest run on the ticket.
//      • status='done'     → emit ticket/dispatch-needed (let the dispatcher
//                            pick the next role; same as a fresh transition).
//      • cancelled/failed  → compute lastGoodStepIdx from run_steps (productive
//                            kinds only), then emit agent/run.replay-requested
//                            with replayReason='resume'. The existing replay
//                            primitive (lib/engine/replay.ts) clones the run,
//                            copies steps 0..N-1 forward, and re-enters
//                            runAgent at startIterationIdx=N. Resume replays
//                            do NOT count against MAX_REPLAYS_PER_RUN — see
//                            replay.ts cap-split.
//      • no runs yet       → emit ticket/dispatch-needed (first-time path).
//      • still running     → refuse with code='run-still-active' (shouldn't
//                            happen if pauseTicket ran first, but defensive).
//
// Why no advisory lock
// ────────────────────
// Both paths use conditional UPDATEs (status='paused' on the way in, =='paused'
// on the way out). A double-click within milliseconds races on the SQL, and
// only the first UPDATE matches; the second sees zero rows and returns
// alreadyAtState. That gives us idempotency without a session-level lock or
// an RPC migration. The same pattern is already load-bearing in cascade-kill,
// stale-run-reaper, and the PR1 runAgent finish/failed paths.

import { NonRetriableError } from "inngest";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { supabaseService } from "@/lib/db/server";
import { planReplay, ReplayRefused } from "@/lib/engine/replay";
import { getEffectivePauseForTicket, pauseRefusalMessage } from "@/lib/engine/automation-state";

// Statuses a ticket can pause OUT of (mirrors ALLOWED_TRANSITIONS into
// 'paused' from lib/board/state.ts). Replicated here as a SQL filter so the
// conditional UPDATE matches whatever the FSM allows.
const PAUSABLE_FROM = [
  "in_progress",
  "input_required",
  "blocked",
  "in_review",
  "assigned",
] as const;

// Statuses on `runs` where an in-flight cancel makes sense. Mirrors the
// cascade-kill set so we don't accidentally try to "cancel" a done/failed row.
const ACTIVE_RUN_STATUSES = ["running", "awaiting_human"] as const;

// Why this pause was fired. Persisted on tickets.paused_reason and stamped
// into run_steps audit payloads + runs.status_reason for the cancelled runs.
// `takeover` — an operator clicked "Take the wheel": the headless run is paused
// so an interactive Claude session can drive the same workspace. The UI reads
// runs.status_reason='paused:takeover' to show "you have the wheel" instead of
// a generic pause, and Release routes through resumeTicket like any other pause.
export type PauseReason = "user" | "runner-disconnected" | "stale-15min" | "takeover";

export type PauseTicketResult =
  | { ok: true; cancelledRunIds: string[] }
  | { ok: true; alreadyAtState: true }
  | { ok: false; error: string; code?: "ticket-not-found" | "ticket-terminal" };

export type ResumeTicketResult =
  | {
      ok: true;
      mode: "replay";
      latestRunId: string;
      fromStepIdx: number;
    }
  | { ok: true; mode: "dispatch"; latestRunId: string | null }
  | { ok: true; alreadyAtState: true }
  | {
      ok: false;
      error: string;
      code?:
        | "ticket-not-found"
        | "ticket-not-paused"
        | "run-still-active"
        | "replay-refused"
        | "automation-paused";
    };

/**
 * Idx range reserved for system-audit steps. The drawer's "Resume from step
 * N" label and our resumeTicket's lastGoodStepIdx computation both exclude
 * this range so the resume point lands on a real productive checkpoint
 * (think/tool_call/tool_result) rather than a marker we wrote ourselves.
 *
 * Known markers and their owners:
 *   9999   — runAgentFailed exception trace
 *   99_992 — run-agent board/workspace automation-pause halt (run-agent.ts)
 *   99_993 — pauseTicket user-pause / cancel audit (this file)
 *   99_994 — ticket-reconciler action audit (ticket-reconciler.ts)
 *   99_995 — runner-watchdog auto-pause audit (PR3)
 *   99_996 — stale-run-reaper audit
 *   99_997 — supervision strategy outcome
 *   99_998 — cascade-kill audit
 */
const AUDIT_STEP_FLOOR = 9999;
const PAUSE_AUDIT_STEP_IDX = 99_993;

export async function pauseTicket(args: {
  ticketId: string;
  tenantId: string;
  reason: PauseReason;
  /** Optional auth user id stamped into the audit payload. */
  byUserId?: string;
}): Promise<PauseTicketResult> {
  const supabase = supabaseService();

  // ── 1. Conditional ticket transition ──────────────────────────────────
  // The IN-clause is the only gate: any non-pausable state (paused, done,
  // failed, ready, backlog) matches zero rows and we return alreadyAtState.
  // We also re-verify tenant ownership in the WHERE so a service-role call
  // can't cross tenants from a malformed input.
  const { data: updated, error: updErr } = await supabase
    .from("tickets")
    .update({
      status: "paused",
      paused_at: new Date().toISOString(),
      paused_reason: args.reason,
    })
    .eq("id", args.ticketId)
    .eq("tenant_id", args.tenantId)
    .in("status", PAUSABLE_FROM as unknown as string[])
    .select("id");
  if (updErr) {
    return { ok: false, error: `pause UPDATE: ${updErr.message}` };
  }
  if (!updated || updated.length === 0) {
    // Either already paused, in a terminal state, or pre-active (backlog/ready).
    // Caller treats this as a no-op success — there's nothing to do.
    return { ok: true, alreadyAtState: true };
  }

  // ── 2. Cancel every in-flight run on the ticket ───────────────────────
  // Tenant-scoped, and here that is not merely a read guard: every row this
  // returns is then CANCELLED. Unscoped, a hostile tenant could plant
  // `{tenant_id: them, ticket_id: <our ticket>, status: "running"}` and have our
  // pause kill THEIR run — a cross-tenant write, reachable by writing a row.
  // The ticket UPDATE above is already `.eq("tenant_id", args.tenantId)`, so
  // reaching this line proves the ticket is in that tenant.
  const { data: activeRuns, error: runsErr } = await supabase
    .from("runs")
    .select("id, tenant_id, agent_id, ticket_id, fan_out_group, fan_out_role")
    .eq("ticket_id", args.ticketId)
    .eq("tenant_id", args.tenantId)
    .in("status", ACTIVE_RUN_STATUSES as unknown as string[]);
  if (runsErr) {
    // Ticket is already paused; surface the error but don't try to roll back.
    // A follow-up Resume will still work (it picks the latest run regardless).
    return {
      ok: false,
      error: `list active runs failed: ${runsErr.message}`,
    };
  }
  const runs = activeRuns ?? [];
  const cancelledRunIds: string[] = [];

  for (const run of runs) {
    const runId = run.id as string;
    // Conditional UPDATE — if cascade-kill or stale-reaper beat us to this
    // row, we skip cleanly.
    const { data: cancelRows, error: cancelErr } = await supabase
      .from("runs")
      .update({
        status: "cancelled",
        status_reason: `paused:${args.reason}`,
        last_event_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .in("status", ACTIVE_RUN_STATUSES as unknown as string[])
      .select("id");
    if (cancelErr) {
      console.warn(`[pauseTicket] cancel UPDATE failed for run ${runId}: ${cancelErr.message}`);
      continue;
    }
    if (!cancelRows || cancelRows.length === 0) continue;

    cancelledRunIds.push(runId);

    // Audit step. Failure is non-fatal — the run is already cancelled.
    const { error: stepErr } = await supabase.from("run_steps").insert({
      run_id: runId,
      idx: PAUSE_AUDIT_STEP_IDX,
      kind: "system",
      payload: {
        kind: "user-paused",
        reason: args.reason,
        ticket_id: args.ticketId,
        ...(args.byUserId ? { by_user_id: args.byUserId } : {}),
      },
    });
    if (stepErr) {
      console.warn(`[pauseTicket] audit step write failed for run ${runId}: ${stepErr.message}`);
    }

    // Drain dispatch_queue: agent/run.completed (status='failed' since the
    // event schema doesn't include 'cancelled'; the drain treats anything
    // non-'done' the same). Matches stale-run-reaper's emission shape.
    await sendEventBounded({
      name: "agent/run.completed",
      data: {
        runId,
        tenantId: run.tenant_id as string,
        ticketId: (run.ticket_id as string | null) ?? undefined,
        agentId: (run.agent_id as string | null) ?? undefined,
        role: (run.fan_out_role as string | null) ?? undefined,
        status: "failed" as const,
        fanOutGroup: (run.fan_out_group as string | null) ?? undefined,
      },
    });
  }

  return { ok: true, cancelledRunIds };
}

export async function resumeTicket(args: {
  ticketId: string;
  tenantId: string;
}): Promise<ResumeTicketResult> {
  const supabase = supabaseService();

  // ── 1. Pre-flight: confirm ticket exists in this tenant ───────────────
  // Read before the conditional UPDATE so we can return a precise error if
  // the ticket isn't visible at all (vs the "already resumed" case where the
  // UPDATE would silently match zero rows).
  const { data: ticket, error: tErr } = await supabase
    .from("tickets")
    .select("id, status, tenant_id")
    .eq("id", args.ticketId)
    .maybeSingle();
  if (tErr) {
    return { ok: false, error: `ticket lookup: ${tErr.message}` };
  }
  if (!ticket || (ticket.tenant_id as string) !== args.tenantId) {
    return { ok: false, error: "ticket not found", code: "ticket-not-found" };
  }

  // ── 1b. Automation pause gate ────────────────────────────────────────
  // Refuse if the workspace/project is paused — un-pausing the ticket would
  // just trip the dispatcher's automation gate immediately and confuse the
  // operator ("I clicked Resume but nothing happened"). The drawer's toast
  // surfaces this clearly so the operator un-pauses automation first.
  const automationGate = await getEffectivePauseForTicket(args.tenantId, args.ticketId);
  if (automationGate.paused) {
    return {
      ok: false,
      error: pauseRefusalMessage(automationGate),
      code: "automation-paused",
    };
  }

  // ── 2. Conditional transition paused → in_progress ────────────────────
  const { data: updated, error: updErr } = await supabase
    .from("tickets")
    .update({
      status: "in_progress",
      paused_at: null,
      paused_reason: null,
    })
    .eq("id", args.ticketId)
    .eq("tenant_id", args.tenantId)
    .eq("status", "paused")
    .select("id");
  if (updErr) {
    return { ok: false, error: `resume UPDATE: ${updErr.message}` };
  }
  if (!updated || updated.length === 0) {
    // Concurrent resume already won, or the ticket wasn't paused.
    //
    // BUT — a real-world stuck case (cb860274) hit this branch when the
    // user took the wheel, the ticket got flipped back to in_progress by a
    // mid-session board interaction (drag-out-of-paused / drawer Resume),
    // and then release-takeover called us with the ticket already at
    // in_progress. Latest run was `cancelled` (the takeover-paused one) and
    // nobody had emitted a dispatch event. So we returned success here,
    // looked done, and the ticket sat with zero in-flight work forever.
    //
    // Defensive nudge: when alreadyAtState lands on a working-status
    // ticket and no run is currently active, fire ticket/dispatch-needed
    // so the engine recovers. Safe under concurrent resume too: the
    // dispatcher is concurrency-keyed per ticket, so a duplicate event is
    // a no-op once a live run exists.
    const { data: state } = await supabase
      .from("tickets")
      .select("status")
      .eq("id", args.ticketId)
      .maybeSingle();
    const workingStatus = state?.status as string | undefined;
    const isWorking =
      workingStatus === "in_progress" ||
      workingStatus === "in_review" ||
      workingStatus === "assigned";
    if (isWorking) {
      // Tenant-scoped: a planted "running" row would read as work already in
      // flight, suppress the dispatch, and leave the ticket unresumable.
      const { data: liveRuns } = await supabase
        .from("runs")
        .select("id")
        .eq("ticket_id", args.ticketId)
        .eq("tenant_id", args.tenantId)
        .in("status", ACTIVE_RUN_STATUSES as unknown as string[])
        .limit(1);
      if (!liveRuns || liveRuns.length === 0) {
        await sendEventBounded({
          name: "ticket/dispatch-needed",
          data: { ticketId: args.ticketId, tenantId: args.tenantId },
        });
      }
    }
    return { ok: true, alreadyAtState: true };
  }

  // ── 3. Pick the latest run and decide replay-vs-dispatch ──────────────
  // Tenant-scoped: this row's id is what the resume then REPLAYS. A planted
  // `{tenant_id: them, ticket_id: <our ticket>}` row would win the
  // `created_at DESC` race and steer our resume at a foreign run id. (Replay
  // re-checks the tenant and would refuse, but "the next layer happens to catch
  // it" is not the property we want here — the resume would still be wedged.)
  // `args.tenantId` is proven against the ticket row at the top of this function.
  const { data: latestRows, error: latestErr } = await supabase
    .from("runs")
    .select("id, status")
    .eq("ticket_id", args.ticketId)
    .eq("tenant_id", args.tenantId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (latestErr) {
    return {
      ok: false,
      error: `latest run lookup: ${latestErr.message}`,
    };
  }
  const latest = latestRows && latestRows.length > 0 ? latestRows[0] : null;
  const latestStatus = (latest?.status as string | null) ?? null;

  // No runs yet → first-time dispatch.
  if (!latest) {
    await sendEventBounded({
      name: "ticket/dispatch-needed",
      data: { ticketId: args.ticketId, tenantId: args.tenantId },
    });
    return { ok: true, mode: "dispatch", latestRunId: null };
  }

  // The pause path should have flipped any in-flight run to 'cancelled' before
  // the ticket UPDATE. If we still see 'running' or 'awaiting_human' here,
  // either pauseTicket was never run, or a fresh run was kicked between
  // pause and resume — refuse so we don't fork the trace.
  if (latestStatus === "running" || latestStatus === "awaiting_human") {
    return {
      ok: false,
      error: `latest run ${latest.id as string} is still ${latestStatus}; cannot resume`,
      code: "run-still-active",
    };
  }

  // Done → dispatcher picks next role; no replay needed.
  if (latestStatus === "done") {
    await sendEventBounded({
      name: "ticket/dispatch-needed",
      data: { ticketId: args.ticketId, tenantId: args.tenantId },
    });
    return { ok: true, mode: "dispatch", latestRunId: latest.id as string };
  }

  // Cancelled / failed → resume via replay from the last productive step.
  const latestRunId = latest.id as string;
  const fromStepIdx = await computeLastGoodStepIdx(latestRunId);

  // Inline plan-check so cap-exceeded surfaces as a structured error rather
  // than burning an Inngest invocation that throws ReplayRefused. The
  // belt-and-suspenders 50-cap is enforced inside planReplay via
  // MAX_NON_OPERATOR_REPLAYS_PER_RUN.
  try {
    await planReplay({
      originalRunId: latestRunId,
      tenantId: args.tenantId,
      fromStepIdx,
      replayReason: "resume",
    });
  } catch (err) {
    if (err instanceof ReplayRefused) {
      return {
        ok: false,
        error: err.message,
        code: "replay-refused",
      };
    }
    throw err;
  }

  await sendEventBounded({
    name: "agent/run.replay-requested",
    data: {
      originalRunId: latestRunId,
      tenantId: args.tenantId,
      fromStepIdx,
      replayReason: "resume",
    },
  });
  return { ok: true, mode: "replay", latestRunId, fromStepIdx };
}

/**
 * Highest run_steps.idx for the run where kind is a productive step
 * (think | tool_call | tool_result). Excludes system audit markers in the
 * 9999 / 99_99x range so the resume point lands on real work. Returns 0 if
 * the run produced nothing useful (e.g. cancelled before its first
 * iteration) — replaying from idx=0 is the right behaviour there: re-enter
 * the loop from the top with the original prompt.
 *
 * Intentionally does NOT throw on missing run_steps rows; callers must
 * tolerate fromStepIdx=0 as a clean restart.
 */
async function computeLastGoodStepIdx(runId: string): Promise<number> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("run_steps")
    .select("idx")
    .eq("run_id", runId)
    .in("kind", ["think", "tool_call", "tool_result"])
    .lt("idx", AUDIT_STEP_FLOOR)
    .order("idx", { ascending: false })
    .limit(1);
  if (error) {
    // Soft failure — better to replay from idx=0 than refuse the resume.
    console.warn(`[resumeTicket] computeLastGoodStepIdx for run ${runId}: ${error.message}`);
    return 0;
  }
  const top = data?.[0];
  const lastIdx = typeof top?.idx === "number" ? top.idx : -1;
  // +1 because the replay primitive treats fromStepIdx as "resume AT this
  // index" — copying [0, fromStepIdx) forward and re-entering the loop with
  // startIterationIdx=fromStepIdx. To resume PAST the last good step (not
  // replay it), we hand it the next idx. This matches the Run Inspector
  // "Replay from here" semantics. lastIdx=-1 (no productive steps) → 0,
  // a clean restart from the original prompt.
  return lastIdx + 1;
}

// Surface NonRetriableError from this module if a caller wants to consume
// the engine functions directly (no re-export of the inngest function — that
// stays in lib/engine/replay.ts). Avoids "imported but unused" lint noise.
export { NonRetriableError };
