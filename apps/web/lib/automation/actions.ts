"use server";

import { revalidatePath } from "next/cache";
import { requireUser, requireTenantId } from "@/lib/auth";
import { supabaseServer, supabaseService } from "@/lib/db/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { resumeTicket } from "@/lib/engine/pause-resume";
import { resolveDrainParallelism } from "@/lib/engine/drain-window";
import { RESUME_DISPATCHABLE_STATUSES } from "@/lib/engine/cancel-check-policy";
import { computeMissedSchedules, type MissedSchedule } from "@/lib/automation/queries";

export type AutomationScope = "tenant" | "project";
export type AutomationStateValue = "running" | "paused";

export type SetAutomationStateArgs = {
  scope: AutomationScope;
  /** tenant id (for scope='tenant') or project id (for scope='project') */
  id: string;
  state: AutomationStateValue;
};

export type SetAutomationStateResult =
  | {
      ok: true;
      newState: AutomationStateValue;
      /** Populated on resume — non-empty if scheduled drains were missed. */
      missedSchedules?: MissedSchedule[];
    }
  | { ok: false; error: string };

/**
 * Pause or resume the automation engine at the workspace (tenant) or project
 * level. Pausing: stamp paused_at + paused_by; clear resumed_at. Resuming:
 * preserve paused_at (so the missed-schedules banner can read the window),
 * stamp resumed_at, and kick a dispatch-needed for every still-dispatchable
 * ticket so the dispatcher (now unpaused) picks up the queue.
 *
 * Idempotency: both paths use a conditional UPDATE with the inverse state in
 * the WHERE — a double-click matches zero rows on the second call and is a
 * no-op success (we return ok=true with the already-applied state).
 */
export async function setAutomationStateAction(
  args: SetAutomationStateArgs,
): Promise<SetAutomationStateResult> {
  const user = await requireUser();
  const tenantId = await requireTenantId();

  if (args.scope === "tenant" && args.id !== tenantId) {
    return { ok: false, error: "tenant id does not match caller" };
  }
  if (args.scope === "project") {
    // Defense in depth — RLS already gates this, but a stray cross-tenant
    // project id should fail loudly.
    const supabase = await supabaseServer();
    const { data: proj } = await supabase
      .from("projects")
      .select("tenant_id")
      .eq("id", args.id)
      .maybeSingle();
    if (!proj || (proj.tenant_id as string) !== tenantId) {
      return { ok: false, error: "project not found in tenant" };
    }
  }

  const table = args.scope === "tenant" ? "tenants" : "projects";
  const nowIso = new Date().toISOString();
  const supabase = await supabaseServer();

  if (args.state === "paused") {
    const { error } = await supabase
      .from(table)
      .update({
        automation_state: "paused",
        automation_paused_at: nowIso,
        automation_resumed_at: null,
        automation_paused_by_user_id: user.id,
      })
      .eq("id", args.id)
      .eq("automation_state", "running");
    if (error) return { ok: false, error: error.message };

    revalidatePath("/", "layout");
    return { ok: true, newState: "paused" };
  }

  // ── Resume ───────────────────────────────────────────────────────────
  // Read pausedAt BEFORE the UPDATE so we can compute the missed-schedules
  // window. The UPDATE preserves automation_paused_at deliberately (we keep
  // it across the resume so the banner can read it; a subsequent pause
  // overwrites it).
  const { data: cur } = await supabase
    .from(table)
    .select("automation_paused_at, automation_state")
    .eq("id", args.id)
    .maybeSingle();
  const pausedAt = (cur?.automation_paused_at as string | null) ?? null;

  const { error: upErr } = await supabase
    .from(table)
    .update({
      automation_state: "running",
      automation_resumed_at: nowIso,
    })
    .eq("id", args.id)
    .eq("automation_state", "paused");
  if (upErr) return { ok: false, error: upErr.message };

  // Kick the dispatcher for every dispatch-eligible ticket in scope. The
  // dispatcher's automation-gate is now passing; it will route to the right
  // role. Tickets in blocked/input_required/paused stay where they are.
  await emitResumeDispatches({
    tenantId,
    scope: args.scope,
    scopeId: args.id,
  });

  // Compute missed scheduled drains for the banner.
  let missed: MissedSchedule[] = [];
  if (pausedAt) {
    try {
      missed = await computeMissedSchedules({
        tenantId,
        scope: args.scope,
        scopeId: args.id,
        pausedAt,
        resumedAt: nowIso,
      });
    } catch (err) {
      console.warn(
        `[setAutomationStateAction] computeMissedSchedules failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  revalidatePath("/", "layout");
  return {
    ok: true,
    newState: "running",
    missedSchedules: missed,
  };
}

export type ResumeAllRunnerDisconnectedResult =
  | {
      ok: true;
      attempted: number;
      resumed: number;
      refused: number;
      /** First few refusal reasons so the toast can surface a hint. */
      refusedReasons: Array<{ ticketId: string; error: string }>;
    }
  | { ok: false; error: string };

/**
 * Batch-resume every ticket in the caller's tenant that the runner-watchdog
 * auto-paused. Sequential — `resumeTicket` is idempotent on conditional
 * UPDATEs so a double-fire is safe, but serialising keeps the dispatch event
 * fan-out predictable.
 *
 * A ticket whose project is paused (or whose workspace is paused) will be
 * refused by `resumeTicket`'s own automation-gate; we surface the count of
 * refusals so the banner toast can hint at the cause without enumerating
 * every reason.
 */
export async function resumeAllRunnerDisconnectedAction(): Promise<ResumeAllRunnerDisconnectedResult> {
  const tenantId = await requireTenantId();
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("tickets")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "paused")
    .eq("paused_reason", "runner-disconnected");
  if (error) return { ok: false, error: error.message };

  const tickets = (data ?? []) as Array<{ id: string }>;
  if (tickets.length === 0) {
    return {
      ok: true,
      attempted: 0,
      resumed: 0,
      refused: 0,
      refusedReasons: [],
    };
  }

  // Hard cap so a runaway disconnect (e.g. a misconfigured watchdog) can't
  // blast hundreds of Inngest events from one click.
  const CAP = 200;
  const batch = tickets.slice(0, CAP);

  let resumed = 0;
  let refused = 0;
  const refusedReasons: Array<{ ticketId: string; error: string }> = [];

  for (const ticket of batch) {
    const res = await resumeTicket({
      ticketId: ticket.id,
      tenantId,
    });
    if (res.ok) {
      if ("alreadyAtState" in res) {
        // Someone else (or a prior click) already resumed it. Count as
        // success — the ticket is in the desired state.
        resumed++;
      } else {
        resumed++;
      }
    } else {
      refused++;
      if (refusedReasons.length < 3) {
        refusedReasons.push({
          ticketId: ticket.id,
          error: res.error,
        });
      }
    }
  }

  revalidatePath("/", "layout");
  return {
    ok: true,
    attempted: batch.length,
    resumed,
    refused,
    refusedReasons,
  };
}

/**
 * Trigger a single missed schedule's drain on demand. Used by the banner's
 * per-row "Fire now" button.
 */
export async function fireMissedScheduleAction(
  scheduleId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tenantId = await requireTenantId();
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("ticket_schedules")
    .select("id, tenant_id, project_id, drain_parallelism, status")
    .eq("id", scheduleId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data) return { ok: false, error: "schedule not found" };
  if ((data.status as string) !== "active") {
    return { ok: false, error: `schedule is ${data.status}, not active` };
  }
  await sendEventBounded({
    name: "ticket-drain/requested",
    data: {
      tenantId: data.tenant_id as string,
      projectId: data.project_id as string,
      scheduleId: data.id as string,
      drainParallelism: resolveDrainParallelism(data.drain_parallelism as number | null),
    },
  });
  return { ok: true };
}

/**
 * On resume, kick `ticket/dispatch-needed` for every ticket in scope whose
 * status implies it should be working (ready, in_review, in_progress). The
 * dispatcher's role decision + pause gate (both checked again per-ticket)
 * filter further. Tickets in blocked / input_required / paused / terminal
 * states are deliberately left alone.
 *
 * Uses service-role to bypass RLS — the caller already validated tenant
 * ownership at the action boundary.
 */
async function emitResumeDispatches(args: {
  tenantId: string;
  scope: AutomationScope;
  scopeId: string;
}): Promise<void> {
  const supabase = supabaseService();
  let q = supabase
    .from("tickets")
    .select("id")
    // `in_progress` is load-bearing here: a run halted by a board pause (the
    // run loop's check-cancel now honors effective pause) leaves its ticket in
    // `in_progress`, so resume MUST re-dispatch that status for the halted run
    // to come back. Shared with the run loop's halt policy so the two can't
    // drift. See lib/engine/cancel-check-policy.ts.
    .in("status", RESUME_DISPATCHABLE_STATUSES as unknown as string[])
    .eq("tenant_id", args.tenantId);
  if (args.scope === "project") q = q.eq("project_id", args.scopeId);
  const { data, error } = await q;
  if (error || !data || data.length === 0) return;

  // Cap the resume-kick batch so a stale workspace with thousands of in-
  // flight tickets doesn't blast the queue. The dispatcher idempotency on
  // dispatch_queue means later tickets get picked up by completion drains.
  const CAP = 200;
  const batch = data.slice(0, CAP);
  await Promise.all(
    batch.map((t) =>
      sendEventBounded({
        name: "ticket/dispatch-needed",
        data: { ticketId: t.id as string, tenantId: args.tenantId },
      }),
    ),
  );
}
