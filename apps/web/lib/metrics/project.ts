// Phase 2 / M5f — Per-project aggregations driven by `runs` joined through
// `tickets` (project_id) and `agents` (for role display name). All metrics
// are derived; no new schema.
//
// ── Every entry point takes a REQUIRED `tenantId`. This is a boundary. ──────
// These are SERVICE-ROLE reads, so RLS is off and nothing filters by tenant
// except the predicates written here. That used to be left to the caller
// ("callers are server components that have already validated tenant
// membership"), and membership was indeed validated — but validating that the
// CALLER may see project P is a different fact from ensuring the ROWS SCANNED
// belong to P's tenant, and only the first was being done.
//
// The gap is `project_id`: `tickets_member_write` (core.sql) constrains a row's
// own `tenant_id` and nothing else, so tenant B can write a ticket carrying
// tenant A's `project_id` and the policy passes. A `tickets WHERE project_id = P`
// scan on the service client then swept B's ticket — and its runs — into A's
// totals. No secret crosses (only counts and cents aggregate), but the numbers
// an auditor reads off a PDF, and an operator reads off the project page, were
// silently wrong.
//
// So `tenantId` is a required FIRST parameter on every export here rather than an
// optional extra: an optional one is a thing a caller forgets, and forgetting is
// exactly how this happened. The app-side filter is the real control — migration
// `20260730000000` also constrains `project_id` at write time, but a policy
// cannot unmake rows already written.

import { supabaseService } from "@/lib/db/server";

export type ProjectStats = {
  totalSpendCents: number;
  totalRuns: number;
  totalTickets: number;
  ticketsDone: number;
  ticketsFailed: number;
  ticketsInFlight: number; // backlog + ready + assigned + in_progress + in_review + input_required + blocked
  totalRetries: number; // sum of tickets.retry_count
  totalRunTimeMs: number; // sum across runs of (last_event_at - created_at)
  avgTicketConvergenceMs: number; // mean for done tickets only
  lastActivityAt: string | null; // most recent runs.last_event_at
};

export type DailySpendPoint = {
  date: string; // YYYY-MM-DD (UTC)
  cents: number;
  runs: number;
};

export type RoleUsageRow = {
  role: string; // slug
  displayName: string; // human-friendly (or the slug if no agent row matches)
  runs: number;
  doneRuns: number;
  failedRuns: number;
  totalCents: number;
  totalDurationMs: number;
  /** Convenience: totalDurationMs / runs (ms). */
  avgDurationMs: number;
};

const IN_FLIGHT_STATUSES = new Set([
  "backlog",
  "ready",
  "assigned",
  "in_progress",
  "in_review",
  "input_required",
  "blocked",
]);

/**
 * The project's ticket ids, scoped to its tenant.
 *
 * This is the seed for almost every rollup below (runs are then read by
 * `.in("ticket_id", …)`), so the tenant filter here is what keeps a foreign
 * ticket's RUNS out of the spend and role numbers too — not just the ticket
 * counts.
 */
async function loadProjectTicketIds(tenantId: string, projectId: string): Promise<string[]> {
  const supabase = supabaseService();
  const { data } = await supabase
    .from("tickets")
    .select("id")
    .eq("project_id", projectId)
    // See the module header: `project_id` is attacker-settable across tenants.
    .eq("tenant_id", tenantId);
  return (data ?? []).map((r) => r.id as string);
}

export async function loadProjectStats(tenantId: string, projectId: string): Promise<ProjectStats> {
  const supabase = supabaseService();

  const [{ data: tickets }, ticketIds] = await Promise.all([
    supabase
      .from("tickets")
      .select("id, status, retry_count, created_at, updated_at")
      .eq("project_id", projectId)
      .eq("tenant_id", tenantId),
    loadProjectTicketIds(tenantId, projectId),
  ]);

  if (ticketIds.length === 0) {
    return {
      totalSpendCents: 0,
      totalRuns: 0,
      totalTickets: tickets?.length ?? 0,
      ticketsDone: 0,
      ticketsFailed: 0,
      ticketsInFlight: 0,
      totalRetries: 0,
      totalRunTimeMs: 0,
      avgTicketConvergenceMs: 0,
      lastActivityAt: null,
    };
  }

  const { data: runs } = await supabase
    .from("runs")
    .select("id, status, spent_cents, created_at, last_event_at")
    .in("ticket_id", ticketIds)
    // A tenant-clean ticket id does NOT make the RUN clean: `runs.ticket_id`
    // is a nullable FK to ANY ticket and `runs_member_write` constrains only
    // the run's own tenant_id, so tenant B can attach a run to OUR ticket.
    .eq("tenant_id", tenantId);

  const r = runs ?? [];
  const t = tickets ?? [];

  const totalSpendCents = r.reduce((sum, x) => sum + ((x.spent_cents as number) ?? 0), 0);
  const totalRunTimeMs = r.reduce((sum, x) => {
    const start = new Date(x.created_at as string).getTime();
    const end = new Date(x.last_event_at as string).getTime();
    return sum + Math.max(0, end - start);
  }, 0);

  const lastActivityAt =
    r
      .map((x) => x.last_event_at as string)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;

  const doneTickets = t.filter((x) => x.status === "done");
  const failedTickets = t.filter((x) => x.status === "failed");
  const inFlight = t.filter((x) => IN_FLIGHT_STATUSES.has(x.status as string));

  const convergenceMs = doneTickets.map((x) => {
    const a = new Date(x.created_at as string).getTime();
    const b = new Date((x.updated_at as string) ?? (x.created_at as string)).getTime();
    return Math.max(0, b - a);
  });
  const avgTicketConvergenceMs = convergenceMs.length
    ? Math.round(convergenceMs.reduce((s, n) => s + n, 0) / convergenceMs.length)
    : 0;

  const totalRetries = t.reduce((sum, x) => sum + ((x.retry_count as number) ?? 0), 0);

  return {
    totalSpendCents,
    totalRuns: r.length,
    totalTickets: t.length,
    ticketsDone: doneTickets.length,
    ticketsFailed: failedTickets.length,
    ticketsInFlight: inFlight.length,
    totalRetries,
    totalRunTimeMs,
    avgTicketConvergenceMs,
    lastActivityAt,
  };
}

export async function loadDailySpend(
  tenantId: string,
  projectId: string,
  days: number = 14,
): Promise<DailySpendPoint[]> {
  const supabase = supabaseService();
  const ticketIds = await loadProjectTicketIds(tenantId, projectId);
  if (ticketIds.length === 0) return makeEmptyDailySeries(days);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { data } = await supabase
    .from("runs")
    .select("spent_cents, created_at")
    .in("ticket_id", ticketIds)
    // A tenant-clean ticket id does NOT make the RUN clean: `runs.ticket_id`
    // is a nullable FK to ANY ticket and `runs_member_write` constrains only
    // the run's own tenant_id, so tenant B can attach a run to OUR ticket.
    .eq("tenant_id", tenantId)
    .gte("created_at", since.toISOString());

  const bucket = new Map<string, { cents: number; runs: number }>();
  for (const row of data ?? []) {
    const day = String(row.created_at).slice(0, 10); // YYYY-MM-DD
    const acc = bucket.get(day) ?? { cents: 0, runs: 0 };
    acc.cents += (row.spent_cents as number) ?? 0;
    acc.runs += 1;
    bucket.set(day, acc);
  }

  // Fill every day in the window so the chart shows zeros for idle days.
  const out: DailySpendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const acc = bucket.get(key) ?? { cents: 0, runs: 0 };
    out.push({ date: key, cents: acc.cents, runs: acc.runs });
  }
  return out;
}

function makeEmptyDailySeries(days: number): DailySpendPoint[] {
  const out: DailySpendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    out.push({ date: d.toISOString().slice(0, 10), cents: 0, runs: 0 });
  }
  return out;
}

export async function loadRoleUsage(tenantId: string, projectId: string): Promise<RoleUsageRow[]> {
  const supabase = supabaseService();
  const ticketIds = await loadProjectTicketIds(tenantId, projectId);
  if (ticketIds.length === 0) return [];

  // Runs carry agent_id (for role agents) and fan_out_role (for sibling runs).
  // We resolve to a role slug by COALESCE(fan_out_role, agents.role).
  const [{ data: runs }, { data: agents }] = await Promise.all([
    supabase
      .from("runs")
      .select("id, agent_id, fan_out_role, status, spent_cents, created_at, last_event_at")
      .in("ticket_id", ticketIds)
      // See loadProjectStats: a clean ticket id does not imply a clean run.
      .eq("tenant_id", tenantId),
    supabase.from("agents").select("id, name, role"),
  ]);

  const agentMap = new Map<string, { name: string; role: string }>(
    (agents ?? []).map((a) => [a.id as string, { name: a.name as string, role: a.role as string }]),
  );

  const bucket = new Map<string, RoleUsageRow>();
  for (const row of runs ?? []) {
    const fan = (row.fan_out_role as string | null) ?? null;
    const agentEntry = row.agent_id ? agentMap.get(row.agent_id as string) : null;
    const slug = fan ?? agentEntry?.role ?? "unassigned";
    const display = agentEntry?.name ?? slug;
    const acc =
      bucket.get(slug) ??
      ({
        role: slug,
        displayName: display,
        runs: 0,
        doneRuns: 0,
        failedRuns: 0,
        totalCents: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
      } satisfies RoleUsageRow);
    acc.runs += 1;
    if (row.status === "done") acc.doneRuns += 1;
    if (row.status === "failed") acc.failedRuns += 1;
    acc.totalCents += (row.spent_cents as number) ?? 0;
    const dur = Math.max(
      0,
      new Date(row.last_event_at as string).getTime() -
        new Date(row.created_at as string).getTime(),
    );
    acc.totalDurationMs += dur;
    bucket.set(slug, acc);
  }

  const out = Array.from(bucket.values()).map((row) => ({
    ...row,
    avgDurationMs: row.runs ? Math.round(row.totalDurationMs / row.runs) : 0,
  }));
  out.sort((a, b) => b.totalCents - a.totalCents);
  return out;
}

// Per-ticket badge data: { ticketId → { role, cost_cents, duration_ms, attempts } }
export type TicketMetricRow = {
  ticketId: string;
  primaryRole: string; // last/dominant role observed across runs
  primaryDisplay: string;
  totalCents: number;
  durationMs: number; // wall clock first run start → last run end
  runs: number;
  retries: number;
};

export async function loadTicketMetricsForProject(
  tenantId: string,
  projectId: string,
): Promise<Map<string, TicketMetricRow>> {
  const supabase = supabaseService();
  const ticketIds = await loadProjectTicketIds(tenantId, projectId);
  if (ticketIds.length === 0) return new Map();

  const [{ data: runs }, { data: agents }, { data: tickets }] = await Promise.all([
    supabase
      .from("runs")
      .select("id, ticket_id, agent_id, fan_out_role, spent_cents, created_at, last_event_at")
      .in("ticket_id", ticketIds)
      // See loadProjectStats: a clean ticket id does not imply a clean run.
      .eq("tenant_id", tenantId),
    supabase.from("agents").select("id, name, role"),
    supabase.from("tickets").select("id, retry_count").in("id", ticketIds),
  ]);

  const agentMap = new Map<string, { name: string; role: string }>(
    (agents ?? []).map((a) => [a.id as string, { name: a.name as string, role: a.role as string }]),
  );
  const retryByTicket = new Map<string, number>(
    (tickets ?? []).map((t) => [t.id as string, (t.retry_count as number) ?? 0]),
  );

  const out = new Map<string, TicketMetricRow>();
  for (const r of runs ?? []) {
    const tid = r.ticket_id as string;
    const fan = (r.fan_out_role as string | null) ?? null;
    const agentEntry = r.agent_id ? agentMap.get(r.agent_id as string) : null;
    const slug = fan ?? agentEntry?.role ?? "unassigned";
    const display = agentEntry?.name ?? slug;
    const acc =
      out.get(tid) ??
      ({
        ticketId: tid,
        primaryRole: slug,
        primaryDisplay: display,
        totalCents: 0,
        durationMs: 0,
        runs: 0,
        retries: retryByTicket.get(tid) ?? 0,
      } satisfies TicketMetricRow);
    acc.runs += 1;
    acc.totalCents += (r.spent_cents as number) ?? 0;
    // Track the LAST observed role (most recent dispatch) as "primary" — that's
    // usually what the operator wants to see surfaced on the ticket card.
    acc.primaryRole = slug;
    acc.primaryDisplay = display;
    out.set(tid, acc);
  }

  // Compute per-ticket wall-clock duration = max(last_event_at) − min(created_at)
  const tStart = new Map<string, number>();
  const tEnd = new Map<string, number>();
  for (const r of runs ?? []) {
    const tid = r.ticket_id as string;
    const s = new Date(r.created_at as string).getTime();
    const e = new Date(r.last_event_at as string).getTime();
    tStart.set(tid, Math.min(tStart.get(tid) ?? Infinity, s));
    tEnd.set(tid, Math.max(tEnd.get(tid) ?? 0, e));
  }
  for (const acc of out.values()) {
    const s = tStart.get(acc.ticketId);
    const e = tEnd.get(acc.ticketId);
    if (s && e && e > s) acc.durationMs = e - s;
  }
  return out;
}
