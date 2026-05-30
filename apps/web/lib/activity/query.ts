// The one read behind the ambient activity indicator.
//
// Extracted out of `lib/realtime/use-active-runs.ts` so the tenant predicate is
// testable: a React hook calling `supabaseBrowser()` at module scope cannot be
// driven under the repo's node-environment Vitest, and an untestable tenant
// filter is exactly the shape of every leak this codebase has had to fix
// (see the tenant-scope notes in AGENTS.md).
//
// ── TENANT SCOPE ─────────────────────────────────────────────────────────────
// The co-located `.eq("tenant_id", tenantId)` is asserted by tests that drive a
// filter-APPLYING fake plus a CONTROL that neuters the predicate and proves the
// foreign row WOULD otherwise surface. A fake that ignores `.eq` makes the
// whole assertion vacuous.
//
// This read goes through the RLS-bound BROWSER client, so `runs_member_read`
// (`tenant_id in current_user_tenants()`) is the real boundary and the app-side
// predicate is defence in depth. It is still required: the surface renders in
// the chrome of every page, and a run attributed to the wrong workspace would
// tell the operator an agent is working for him when it is working for someone
// else.
//
// ── READ-ONLY ────────────────────────────────────────────────────────────────
// SELECT only. No insert/update/upsert/delete/rpc — enforced by a source scan in
// `__tests__/read-only.test.ts`, not by this comment.

import type { ActivityRun } from "@/lib/activity/active-runs";

/**
 * Statuses fetched. Broader than "working" on purpose: `awaiting_human` is
 * pulled so the popover can report it SEPARATELY as waiting-on-you. The
 * split into working-vs-waiting happens in `summarizeActivity`, never here —
 * one place decides what the badge number means.
 */
export const FETCHED_STATUSES = ["running", "awaiting_human"] as const;

/**
 * Hard row cap. A tenant should never have dozens of concurrent runs (the
 * subscription concurrency cap is ~1-3), so this bounds a pathological case
 * rather than truncating a realistic one.
 */
export const MAX_TRACKED = 50;

/**
 * FK-HINT form is required, not stylistic. `runs` and `tickets` carry TWO
 * relationships (`runs.ticket_id → tickets`, and `tickets.source_run_id → runs`
 * added by 20260717000000), so a bare `tickets ( … )` embed is ambiguous and
 * PostgREST answers PGRST201. There are likewise two FKs into `agents`.
 */
export const ACTIVITY_RUN_COLUMNS = `
  id, tenant_id, status, runner_kind, agent_id, ticket_id, parent_run_id,
  fan_out_role, created_at, last_event_at,
  agents!agent_id ( role ),
  tickets!ticket_id ( title, ticket_number, project_id, projects ( name ) )
`;

export type RawActivityRow = {
  id: string;
  tenant_id: string;
  status: string;
  runner_kind: string | null;
  agent_id: string | null;
  ticket_id: string | null;
  parent_run_id: string | null;
  fan_out_role: string | null;
  created_at: string;
  last_event_at: string | null;
  agents?: { role: string | null } | null;
  tickets?: {
    title: string | null;
    ticket_number: number | null;
    project_id: string | null;
    projects?: { name: string | null } | null;
  } | null;
};

export function rowToActivityRun(row: RawActivityRow): ActivityRun {
  const ticket = row.tickets ?? null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    runnerKind: row.runner_kind,
    agentId: row.agent_id,
    ticketId: row.ticket_id,
    parentRunId: row.parent_run_id,
    fanOutRole: row.fan_out_role,
    // Attribution is the PRODUCER: COALESCE(fan_out_role, agents.role) — the
    // rule lib/metrics/project.ts uses. A fan-out sibling carries no agent_id
    // at all, so reading agents.role alone would render it roleless.
    role: row.fan_out_role ?? row.agents?.role ?? null,
    ticketTitle: ticket?.title ?? null,
    ticketNumber: ticket?.ticket_number ?? null,
    projectId: ticket?.project_id ?? null,
    projectName: ticket?.projects?.name ?? null,
    startedAt: row.created_at,
    lastEventAt: row.last_event_at,
  };
}

/** Minimal structural type for the query builder this accessor drives. */
export type ActivityQueryClient = {
  from: (table: string) => {
    select: (columns: string) => ActivityQueryBuilder;
  };
};

export type ActivityQueryBuilder = {
  eq: (column: string, value: string) => ActivityQueryBuilder;
  in: (column: string, values: readonly string[]) => ActivityQueryBuilder;
  order: (column: string, opts: { ascending: boolean }) => ActivityQueryBuilder;
  limit: (n: number) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type FetchActiveRunsResult = {
  rows: ActivityRun[];
  error: unknown;
};

/**
 * Fetch every tracked run for one tenant, across all projects.
 *
 * On error returns `{ rows: [], error }` and lets the caller decide — the
 * caller LOGS rather than swallowing, because an ambiguous-embed failure
 * otherwise presents as a permanently quiet indicator indistinguishable from a
 * genuinely idle tenant.
 */
export async function fetchActiveRuns(
  client: ActivityQueryClient,
  tenantId: string,
): Promise<FetchActiveRunsResult> {
  const { data, error } = await client
    .from("runs")
    .select(ACTIVITY_RUN_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("status", FETCHED_STATUSES)
    .order("created_at", { ascending: true })
    .limit(MAX_TRACKED);

  if (error) return { rows: [], error };
  const raw = Array.isArray(data) ? (data as RawActivityRow[]) : [];
  return { rows: raw.map(rowToActivityRun), error: null };
}
