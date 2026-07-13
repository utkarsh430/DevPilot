// Schedule activity log — append-only writes from the cron + drain, paired
// with a tenant-RLS-bound read for the ScheduleDialog Activity panel.
//
// Why a thin helper module instead of inline supabase calls in the engine:
// the activity write is best-effort (every emit point writes; a transient
// DB failure shouldn't stall the cron's loop). Centralising the warn-on-fail
// pattern keeps the engine files focused on their actual logic.

import { supabaseService, supabaseServer } from "@/lib/db/server";

export type ScheduleActivityKind = "fired" | "skipped" | "ticket-advanced" | "completed" | "error";

export type ScheduleActivityRow = {
  id: number;
  tenantId: string;
  scheduleId: string;
  projectId: string | null;
  drainRunId: string | null;
  kind: ScheduleActivityKind;
  reason: string | null;
  ticketId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type RecordActivityArgs = {
  tenantId: string;
  scheduleId: string;
  projectId?: string | null;
  drainRunId?: string | null;
  kind: ScheduleActivityKind;
  reason?: string | null;
  ticketId?: string | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Append one activity row. Best-effort — warns on failure but never throws
 * (callers don't want activity-log writes blocking their primary path).
 * Uses service-role since callers are engine fns that already validated
 * tenant identity at their boundary.
 */
export async function recordScheduleActivity(args: RecordActivityArgs): Promise<void> {
  try {
    const supabase = supabaseService();
    const { error } = await supabase.from("schedule_activity").insert({
      tenant_id: args.tenantId,
      schedule_id: args.scheduleId,
      project_id: args.projectId ?? null,
      drain_run_id: args.drainRunId ?? null,
      kind: args.kind,
      reason: args.reason ?? null,
      ticket_id: args.ticketId ?? null,
      metadata: args.metadata ?? null,
    });
    if (error) {
      console.warn(
        `[schedule-activity] insert failed (kind=${args.kind} schedule=${args.scheduleId.slice(0, 8)}): ${error.message}`,
      );
    }
  } catch (err) {
    console.warn(
      `[schedule-activity] insert threw (kind=${args.kind}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read the N most-recent activity rows for one schedule.
 *
 * RLS-bound, and ALSO explicitly tenant-scoped. Both, for two different
 * reasons. RLS is the real control here and `tenantId` adds nothing to it —
 * but this module binds the identifier `supabase` from `supabaseService()` in
 * one function and `supabaseServer()` in this one, so nothing local proves
 * which client reaches this read. The detector treats that ambiguity as
 * service-role (it only ever guesses toward more work), and it is right to: the
 * next edit that swaps a client here would silently turn this into a real
 * unscoped read. The predicate makes the read correct under EITHER binding, so
 * the question stops mattering.
 */
export async function loadRecentActivity(
  scheduleId: string,
  tenantId: string,
  limit = 20,
): Promise<ScheduleActivityRow[]> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("schedule_activity")
    .select(
      "id, tenant_id, schedule_id, project_id, drain_run_id, kind, reason, ticket_id, metadata, created_at",
    )
    .eq("schedule_id", scheduleId)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id as number,
    tenantId: r.tenant_id as string,
    scheduleId: r.schedule_id as string,
    projectId: (r.project_id as string | null) ?? null,
    drainRunId: (r.drain_run_id as string | null) ?? null,
    kind: r.kind as ScheduleActivityKind,
    reason: (r.reason as string | null) ?? null,
    ticketId: (r.ticket_id as string | null) ?? null,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    createdAt: r.created_at as string,
  }));
}
