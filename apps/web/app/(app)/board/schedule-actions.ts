"use server";

// Phase 2.5++ / Scheduler — server actions for the Schedule dialog.
//
//   • createTicketScheduleAction — write a recurring or one-time schedule
//                                  row. Cron picks it up on the next tick.
//   • runScheduleNowAction       — fire-and-forget drain on the active
//                                  project; no schedule row is written.
//   • toggleScheduleStatusAction — pause / resume.
//   • deleteScheduleAction       — hard-delete a schedule.
//
// All actions are RLS-bound; service-role writes are used only where we
// need the consistent "write + read" round-trip to confirm a tenant-
// scoped insert/update landed.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { DEFAULT_DRAIN_PARALLELISM, MAX_DRAIN_PARALLELISM } from "@/lib/engine/drain-window";

const DAYS_SCHEMA = z.array(z.number().int().min(0).max(6)).max(7).default([]);
// How many tickets the drain keeps in flight. Full 1..10 range, matching the
// `ticket_schedules.drain_parallelism` CHECK - the drain is a WIP window, not a
// runner spawn cap (over-window work simply queues at the runner), so there is
// no reason for the action to narrow it below what the DB allows. The dialog
// steers operators on subscription-backed runners toward ≤ 3.
const PARALLELISM_SCHEMA = z
  .number()
  .int()
  .min(1)
  .max(MAX_DRAIN_PARALLELISM)
  .default(DEFAULT_DRAIN_PARALLELISM);
const TIME_OF_DAY = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be "HH:MM" 24h UTC');

const CreateTicketScheduleInput = z
  .object({
    projectId: z.string().uuid(),
    mode: z.enum(["once", "recurring"]),
    // recurring fields
    daysOfWeek: DAYS_SCHEMA,
    timeOfDay: TIME_OF_DAY.optional(),
    // once fields (ISO timestamp, UTC)
    runAt: z.string().datetime().optional(),
    drainParallelism: PARALLELISM_SCHEMA,
  })
  .refine((i) => (i.mode === "once" ? !!i.runAt : !!i.timeOfDay), {
    message: "mode=once requires runAt; mode=recurring requires timeOfDay",
  });

const RunScheduleNowInput = z.object({
  projectId: z.string().uuid(),
  drainParallelism: PARALLELISM_SCHEMA,
});

const ToggleScheduleStatusInput = z.object({
  scheduleId: z.string().uuid(),
  status: z.enum(["active", "paused"]),
});

const DeleteScheduleInput = z.object({
  scheduleId: z.string().uuid(),
});

export type ScheduleActionResult<T = void> =
  | (T extends void ? { ok: true } : { ok: true; value: T })
  | { ok: false; error: string };

export async function createTicketScheduleAction(
  input: z.infer<typeof CreateTicketScheduleInput>,
): Promise<ScheduleActionResult<{ scheduleId: string }>> {
  const parsed = CreateTicketScheduleInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const user = await requireUser();
  const tenantId = await requireTenantId();

  const svc = supabaseService();
  // Defensive: confirm project ownership.
  const { data: project, error: projErr } = await svc
    .from("projects")
    .select("id, tenant_id")
    .eq("id", parsed.data.projectId)
    .maybeSingle();
  if (projErr) return { ok: false, error: projErr.message };
  if (!project || project.tenant_id !== tenantId) {
    return { ok: false, error: "project not found in your tenant" };
  }

  const { data: row, error: insErr } = await svc
    .from("ticket_schedules")
    .insert({
      tenant_id: tenantId,
      project_id: parsed.data.projectId,
      created_by: user.id,
      mode: parsed.data.mode,
      days_of_week: parsed.data.daysOfWeek,
      time_of_day: parsed.data.timeOfDay ?? null,
      run_at: parsed.data.runAt ?? null,
      drain_parallelism: parsed.data.drainParallelism,
      status: "active",
    })
    .select("id")
    .single();
  if (insErr || !row) {
    return { ok: false, error: insErr?.message ?? "insert failed" };
  }

  revalidatePath("/board");
  return { ok: true, value: { scheduleId: row.id as string } };
}

export async function runScheduleNowAction(
  input: z.infer<typeof RunScheduleNowInput>,
): Promise<ScheduleActionResult> {
  const parsed = RunScheduleNowInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  await requireUser();
  const tenantId = await requireTenantId();

  // Tenant ownership check for the project (cheap).
  const svc = supabaseService();
  const { data: project, error: projErr } = await svc
    .from("projects")
    .select("id, tenant_id")
    .eq("id", parsed.data.projectId)
    .maybeSingle();
  if (projErr) return { ok: false, error: projErr.message };
  if (!project || project.tenant_id !== tenantId) {
    return { ok: false, error: "project not found in your tenant" };
  }

  try {
    await sendEventBounded({
      name: "ticket-drain/requested",
      data: {
        tenantId,
        projectId: parsed.data.projectId,
        drainParallelism: parsed.data.drainParallelism,
        // No scheduleId — this is an ad-hoc drain.
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: `dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true };
}

export async function toggleScheduleStatusAction(
  input: z.infer<typeof ToggleScheduleStatusInput>,
): Promise<ScheduleActionResult> {
  const parsed = ToggleScheduleStatusInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  await requireUser();
  const tenantId = await requireTenantId();

  const svc = supabaseService();
  const { data, error } = await svc
    .from("ticket_schedules")
    .update({ status: parsed.data.status })
    .eq("id", parsed.data.scheduleId)
    .eq("tenant_id", tenantId)
    // Don't reactivate something that's already completed/cancelled —
    // operator can delete + recreate if they really want that.
    .in("status", ["active", "paused"])
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "schedule not found or in terminal state" };
  }
  revalidatePath("/board");
  return { ok: true };
}

export async function deleteScheduleAction(
  input: z.infer<typeof DeleteScheduleInput>,
): Promise<ScheduleActionResult> {
  const parsed = DeleteScheduleInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  await requireUser();
  const tenantId = await requireTenantId();

  const svc = supabaseService();
  const { data, error } = await svc
    .from("ticket_schedules")
    .delete()
    .eq("id", parsed.data.scheduleId)
    .eq("tenant_id", tenantId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "schedule not found" };
  }
  revalidatePath("/board");
  return { ok: true };
}
