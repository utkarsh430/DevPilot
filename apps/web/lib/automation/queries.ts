// Server-side reads for the automation pause UI.
// Used by:
//   • the top-nav AutomationToggle (workspace switch)
//   • the project-page AutomationToggle (project switch)
//   • the MissedSchedulesBanner (post-resume)
//
// Not a server action — these are plain server fns called from RSC layouts /
// pages. Mutations live in lib/automation/actions.ts.

import { supabaseServer, supabaseService } from "@/lib/db/server";

export type AutomationLayerState = {
  state: "running" | "paused";
  pausedAt: string | null;
  resumedAt: string | null;
  pausedByUserId: string | null;
};

export type AutomationOverview = {
  tenantId: string;
  tenant: AutomationLayerState;
  /** Latest fetched at — caller can stamp into a key for revalidation. */
  fetchedAt: string;
};

/**
 * Read the workspace-level pause state for a tenant. Server fn (not action).
 * The caller passes the already-resolved tenant id (every RSC caller has it in
 * hand) so this costs exactly one query — no duplicate `tenant_members`
 * lookup per call. Returns null for a null tenant (unauth, etc.).
 */
/** Raw `tenants` automation columns as returned by PostgREST or the
 *  `shell_bootstrap` RPC's jsonb `tenant` object. */
export type TenantAutomationRow = {
  id: string;
  automation_state?: string | null;
  automation_paused_at?: string | null;
  automation_resumed_at?: string | null;
  automation_paused_by_user_id?: string | null;
};

/** Map a raw tenant automation row to the `AutomationOverview` shape. Exported
 *  so the shell-bootstrap loader seeds the topbar switch through the SAME logic
 *  as `loadTenantAutomationState`. */
export function mapAutomationOverview(row: TenantAutomationRow): AutomationOverview {
  return {
    tenantId: row.id,
    tenant: {
      state: (row.automation_state as "running" | "paused") ?? "running",
      pausedAt: row.automation_paused_at ?? null,
      resumedAt: row.automation_resumed_at ?? null,
      pausedByUserId: row.automation_paused_by_user_id ?? null,
    },
    fetchedAt: new Date().toISOString(),
  };
}

export async function loadTenantAutomationState(
  tenantId: string | null,
): Promise<AutomationOverview | null> {
  if (!tenantId) return null;
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("tenants")
    .select(
      "id, automation_state, automation_paused_at, automation_resumed_at, automation_paused_by_user_id",
    )
    .eq("id", tenantId)
    .maybeSingle();
  if (error || !data) return null;
  return mapAutomationOverview(data as TenantAutomationRow);
}

/**
 * Per-project state read. The caller already has projectId from the route
 * params; we only need the state columns.
 */
export async function loadProjectAutomationState(
  projectId: string,
): Promise<AutomationLayerState | null> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("projects")
    .select(
      "automation_state, automation_paused_at, automation_resumed_at, automation_paused_by_user_id",
    )
    .eq("id", projectId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    state: (data.automation_state as "running" | "paused") ?? "running",
    pausedAt: (data.automation_paused_at as string | null) ?? null,
    resumedAt: (data.automation_resumed_at as string | null) ?? null,
    pausedByUserId: (data.automation_paused_by_user_id as string | null) ?? null,
  };
}

export type MissedSchedule = {
  scheduleId: string;
  projectId: string;
  timeOfDay: string;
  expectedAt: string;
  daysOfWeek: number[];
};

export type RunnerDisconnectedTickets = {
  count: number;
  /** First few ticket titles for the banner's hover tooltip. */
  sampleTitles: string[];
  /** First few ticket ids — used to deep-link to the board filter. */
  sampleIds: string[];
  /** Wallclock of the most-recent pause in the set; banner displays "Xh ago". */
  mostRecentPausedAt: string | null;
};

/**
 * Tickets in the caller's tenant that were auto-paused by the runner-watchdog
 * (heartbeat went silent for >60s and the watchdog flipped them to `paused`
 * with `paused_reason='runner-disconnected'`). Surfaces in the layout banner
 * so the operator can batch-resume them on a single click after the runner
 * comes back online.
 *
 * Returns {count:0, ...} for a null tenant — the banner just doesn't render
 * in that case. Takes the caller's already-resolved tenant id (same reasoning
 * as `loadTenantAutomationState`).
 */
/** Raw runner-disconnected `tickets` row (PostgREST or the `shell_bootstrap`
 *  RPC's jsonb). */
export type DisconnectedTicketRow = {
  id: string;
  title: string | null;
  paused_at: string | null;
};

/** Shape a (count, first-5-rows) pair into the banner payload. Exported so the
 *  shell-bootstrap loader builds the banner through the SAME logic as
 *  `loadRunnerDisconnectedTickets` (the "(untitled)" fallback and the sample
 *  slices stay identical). */
export function mapRunnerDisconnected(
  count: number,
  rows: DisconnectedTicketRow[],
): RunnerDisconnectedTickets {
  return {
    count: count ?? rows.length,
    sampleTitles: rows.map((r) => r.title ?? "(untitled)"),
    sampleIds: rows.map((r) => r.id),
    mostRecentPausedAt: rows[0]?.paused_at ?? null,
  };
}

export async function loadRunnerDisconnectedTickets(
  tenantId: string | null,
): Promise<RunnerDisconnectedTickets> {
  if (!tenantId) {
    return { count: 0, sampleTitles: [], sampleIds: [], mostRecentPausedAt: null };
  }
  const supabase = await supabaseServer();
  const { data, count, error } = await supabase
    .from("tickets")
    .select("id, title, paused_at", { count: "exact" })
    .eq("status", "paused")
    .eq("paused_reason", "runner-disconnected")
    .order("paused_at", { ascending: false })
    .limit(5);
  if (error) {
    return { count: 0, sampleTitles: [], sampleIds: [], mostRecentPausedAt: null };
  }
  return mapRunnerDisconnected(
    count ?? (data ?? []).length,
    (data ?? []) as DisconnectedTicketRow[],
  );
}

/**
 * Compute schedules that would have fired during the pause window but didn't
 * because the scheduler cron's automation-gate skipped them.
 *
 * Algorithm
 * ─────────
 *   1. Read active recurring schedules in scope.
 *   2. For each, walk forward from pausedAt at HH:MM-of-day, looking for
 *      the FIRST firing in [pausedAt, resumedAt] that is later than
 *      last_fired_at AND on a matching weekday.
 *   3. Return one row per schedule. We don't enumerate multiple missed firings
 *      per schedule — one "Fire now" click triggers one drain; multi-day pause
 *      → user sees one offer, not N.
 *
 * The window is exclusive of resumedAt to avoid surfacing "right now" firings
 * that the cron's next tick will pick up naturally.
 */
export async function computeMissedSchedules(args: {
  tenantId: string;
  scope: "tenant" | "project";
  scopeId: string;
  pausedAt: string;
  resumedAt: string;
}): Promise<MissedSchedule[]> {
  const supabase = supabaseService();
  let q = supabase
    .from("ticket_schedules")
    .select("id, tenant_id, project_id, mode, days_of_week, time_of_day, last_fired_at, status")
    .eq("status", "active");
  if (args.scope === "project") q = q.eq("project_id", args.scopeId);
  else q = q.eq("tenant_id", args.tenantId);
  const { data, error } = await q;
  if (error || !data) return [];

  const pausedDate = new Date(args.pausedAt);
  const resumedDate = new Date(args.resumedAt);
  const out: MissedSchedule[] = [];

  for (const row of data) {
    if ((row.mode as string) !== "recurring") continue;
    const tod = (row.time_of_day as string | null) ?? null;
    if (!tod) continue;
    const days = (row.days_of_week as number[] | null) ?? [];
    const lastFired = row.last_fired_at ? new Date(row.last_fired_at as string) : null;

    const [hhStr, mmStr] = tod.split(":");
    const hh = Number(hhStr);
    const mm = Number(mmStr);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) continue;

    // Walk day-by-day from pausedAt, stopping at resumedAt. Bound to 31 days
    // so a stuck pause-window doesn't spin the loop forever.
    const cursor = new Date(pausedDate);
    cursor.setUTCHours(hh, mm, 0, 0);
    if (cursor <= pausedDate) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(hh, mm, 0, 0);
    }
    let firstMissed: Date | null = null;
    for (let i = 0; i < 31 && cursor < resumedDate; i++) {
      const wd = cursor.getUTCDay();
      const dayMatch = days.length === 0 || days.includes(wd);
      if (dayMatch && (!lastFired || cursor > lastFired)) {
        firstMissed = new Date(cursor);
        break;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(hh, mm, 0, 0);
    }

    if (firstMissed) {
      out.push({
        scheduleId: row.id as string,
        projectId: row.project_id as string,
        timeOfDay: tod,
        expectedAt: firstMissed.toISOString(),
        daysOfWeek: days,
      });
    }
  }

  return out;
}
