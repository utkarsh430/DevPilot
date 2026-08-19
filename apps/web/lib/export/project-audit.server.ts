import "server-only";

// Audit-export aggregation for a whole project.
//
// ── TWO different tenant checks, and both are needed ────────────────────────
// They answer different questions, and conflating them is how a leak got in:
//
//   1. "May this CALLER see project P?" — `assertProjectAccess`, read through
//      RLS so a foreign project id returns NO ROW rather than a row we then have
//      to remember to compare. The explicit `tenant_id !== tenantId` after it is
//      defence in depth, not the primary control.
//
//   2. "Do the ROWS WE SCAN belong to P's tenant?" — a separate fact, and NOT
//      implied by (1). Every rollup here is a SERVICE-ROLE read (RLS off), and
//      `tickets_member_write` constrains a row's own `tenant_id` but never its
//      `project_id`, so another tenant can write a ticket carrying THIS
//      project's id. `lib/metrics/project.ts` therefore takes a REQUIRED
//      `tenantId` and filters on it; passing `row.tenant_id` below is what keeps
//      a foreign tenant's tickets and runs out of this project's totals.
//
// (1) was there from the start; (2) was the miss. Asserting membership and then
// handing a bare `projectId` to an unscoped service-role scan reads as safe and
// is not.
//
// The background job takes the OTHER path (`loadProjectAuditExportForJob`),
// because a durable Inngest function has no session and therefore no RLS
// identity at all. There, the trust root is the `exports` job row: the row was
// written by an already-authorised request that stamped its own tenant, and the
// job re-reads that stamped tenant and requires the project to match it. The
// job NEVER accepts a tenant from its event payload.

import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { supabaseServer, supabaseService } from "@/lib/db/server";
import {
  loadProjectStats,
  loadRoleUsage,
  loadTicketMetricsForProject,
} from "@/lib/metrics/project";
import { loadStackSelection } from "@/lib/stack/persist.server";
import { loadTicketAuditBatchServer } from "@/lib/export/ticket-audit.server";
import { compareByBuildOrder } from "@/lib/export/build-order";
import {
  untrusted,
  type ProjectAuditExport,
  type ExportProject,
  type TicketSummary,
} from "@/lib/export/types";
import type { TicketStatus } from "@/lib/board/state";
import { normalizeTicketCeiling } from "@/lib/board/agent-ticket";

/**
 * How many tickets get FULL per-ticket detail. Beyond this they render as one
 * summary line each, and `bounding.truncated` says so in the document with a
 * pointer at the per-ticket export.
 *
 * 30 is a deliberate compromise: a full ticket section is roughly 1-4 pages once
 * narration and evidence are in, so 30 keeps a big-board export near ~100 pages
 * and a few seconds of aggregation, rather than a 1000-page artifact nobody
 * reads that times out the job producing it. The number is a constant, not a
 * request parameter — a bound a caller can raise is not a bound.
 */
export const MAX_FULL_TICKETS = 30;

/** Which tickets get full detail when the board is over the cap. */
export type ProjectExportMode =
  /** Most recently updated first — "what happened lately". The default. */
  | "recent"
  /** Done + failed first — "what shipped and what didn't". */
  | "outcomes";

export type ProjectExportOptions = {
  mode?: ProjectExportMode;
  /** Lower the cap (e.g. a smoke test). Values above MAX_FULL_TICKETS are clamped. */
  cap?: number;
};

type ProjectRow = {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  repo_url: string | null;
  default_branch: string | null;
  integration_branch: string | null;
  auto_land_enabled: boolean | null;
  agent_ticket_creation: boolean | null;
  agent_ticket_max_per_run: number | null;
  project_type: string | null;
  team_tier: string | null;
  stack_ecosystem: string | null;
  llm_provider: string | null;
  llm_base_url: string | null;
  llm_model: string | null;
  created_at: string;
};

// Read explicitly rather than through PROJECT_COLUMNS: this select is scoped to
// what an export prints, and it must NOT pull `llm_credential_ref` at all. Not
// selecting a secret pointer is a stronger guarantee than selecting it and
// remembering not to render it.
const PROJECT_EXPORT_COLUMNS =
  "id, tenant_id, name, description, repo_url, default_branch, integration_branch, " +
  "auto_land_enabled, agent_ticket_creation, agent_ticket_max_per_run, " +
  "project_type, team_tier, stack_ecosystem, " +
  "llm_provider, llm_base_url, llm_model, created_at";

/**
 * Redact the project's LLM configuration for export.
 *
 * `llm_credential_ref` never enters this module (it is not in the select).
 * `llm_base_url` IS selected — because we need to know whether one exists — but
 * only its EXISTENCE escapes, as `customEndpoint`. The URL itself is an
 * operator's private endpoint and the SSRF-sensitive value the provider seam
 * guards; a downloadable PDF is precisely the wrong place for it.
 */
function toExportProject(row: ProjectRow): ExportProject {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch ?? "main",
    integrationBranch: row.integration_branch,
    autoLandEnabled: row.auto_land_enabled === true,
    agentTicketCreation: row.agent_ticket_creation === true,
    agentTicketMaxPerRun: normalizeTicketCeiling(row.agent_ticket_max_per_run),
    projectType: row.project_type ?? "other",
    teamTier: row.team_tier ?? "—",
    stackEcosystem: row.stack_ecosystem ?? "unset",
    createdAt: row.created_at,
    llm: {
      provider: row.llm_provider,
      model: row.llm_model,
      customEndpoint: typeof row.llm_base_url === "string" && row.llm_base_url.length > 0,
    },
  };
}

/**
 * Assert the CURRENT SESSION may export this project, and return the row.
 *
 * Reads through RLS: a project outside the caller's tenants simply is not there.
 * Returns null on any failure so the caller can 404 without distinguishing
 * "missing" from "not yours" — the two must look identical from outside.
 */
export async function assertProjectAccess(
  projectId: string,
): Promise<{ row: ProjectRow; tenantId: string } | null> {
  await requireUser();
  const tenantId = await getCurrentTenantId();
  if (!tenantId) return null;

  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_EXPORT_COLUMNS)
    .eq("id", projectId)
    .maybeSingle();
  if (error) {
    console.error(`[export] project access check failed for ${projectId}: ${error.message}`);
    return null;
  }
  const row = data as unknown as ProjectRow | null;
  if (!row || row.tenant_id !== tenantId) return null;
  return { row, tenantId };
}

/** Order the full-detail window. Pure — the selection rule is testable. */
export function selectFullTicketIds(
  tickets: ReadonlyArray<{ id: string; status: string; updatedAt: string }>,
  mode: ProjectExportMode,
  cap: number,
): { full: string[]; rest: string[] } {
  const ordered = [...tickets];
  if (mode === "outcomes") {
    const rank = (s: string) => (s === "done" ? 0 : s === "failed" ? 1 : 2);
    ordered.sort((a, b) => {
      const d = rank(a.status) - rank(b.status);
      if (d !== 0) return d;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
  } else {
    ordered.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
  return {
    full: ordered.slice(0, cap).map((t) => t.id),
    rest: ordered.slice(cap).map((t) => t.id),
  };
}

type TicketIndexRow = {
  id: string;
  ticket_number: number | null;
  title: string;
  status: string;
  source_run_id: string | null;
  retry_count: number | null;
  updated_at: string;
};

/**
 * How many model turns across the WHOLE project ran on a provider we have no
 * price table for, keyed by ticket.
 *
 * Its own read rather than a derivation, for a specific reason: the export caps
 * full detail at `MAX_FULL_TICKETS`, so counting unpriced turns from the exported
 * tickets would silently under-report on precisely the boards big enough to be
 * capped — and this flag exists to stop `$0.00` reading as "free". Under-reporting
 * it is the one direction that must not happen.
 *
 * The filter is the SQL twin of the shared `isUnpricedMarker` rule: unpriced iff
 * `cost_priced` is exactly `false`. A step written before WI-12 has no
 * `cost_priced` key, so `payload->>` is NULL and does not match — legacy steps
 * count as PRICED, exactly as `toTurn` treats them. (PostgREST cannot distinguish
 * an absent key from a JSON `null` here; see `isUnpricedMarker` for why that is
 * the right trade rather than a gap.) Two queries, both `.in(…)`-batched, on the
 * background path only.
 */
async function loadUnpricedTurnsByTicket(
  supabase: SupabaseClient,
  tenantId: string,
  ticketIds: readonly string[],
): Promise<{ byTicket: Map<string, number>; total: number }> {
  const byTicket = new Map<string, number>();
  if (ticketIds.length === 0) return { byTicket, total: 0 };

  const { data: runRows, error: runErr } = await supabase
    .from("runs")
    .select("id, ticket_id")
    .in("ticket_id", ticketIds as string[])
    // A tenant-clean ticket id does NOT make the RUN clean — `runs_member_write`
    // constrains only the run's own tenant_id, so a foreign run attached to our
    // ticket would inflate the unpriced count and flip the costPriced caveat.
    .eq("tenant_id", tenantId);
  // Fail loud, for the same reason the verification read does: a swallowed error
  // here yields `costPriced: true`, i.e. it asserts the total IS trustworthy —
  // the strongest claim on the page — on the strength of a failed query.
  if (runErr) throw new Error(`export: unpriced-turn run scan failed: ${runErr.message}`);
  const runs = (runRows ?? []) as unknown as Array<{ id: string; ticket_id: string | null }>;
  if (runs.length === 0) return { byTicket, total: 0 };

  const ticketByRun = new Map(runs.map((r) => [r.id, r.ticket_id]));
  const { data: stepRows, error: stepErr } = await supabase
    .from("run_steps")
    .select("run_id")
    .in(
      "run_id",
      runs.map((r) => r.id),
    )
    .eq("kind", "think")
    .eq("payload->>cost_priced", "false");
  if (stepErr) throw new Error(`export: unpriced-turn step scan failed: ${stepErr.message}`);

  let total = 0;
  for (const s of (stepRows ?? []) as unknown as Array<{ run_id: string }>) {
    total += 1;
    const ticketId = ticketByRun.get(s.run_id);
    if (!ticketId) continue;
    byTicket.set(ticketId, (byTicket.get(ticketId) ?? 0) + 1);
  }
  return { byTicket, total };
}

/**
 * Aggregate, given an ALREADY-AUTHORISED project row + a client to read tickets
 * with. Shared by the session path and the background-job path so there is one
 * aggregation, and authorisation is the only thing that differs between them.
 */
async function aggregate(args: {
  row: ProjectRow;
  supabase: SupabaseClient;
  options: ProjectExportOptions;
  generatedAt: string;
}): Promise<ProjectAuditExport> {
  const { row, supabase, options, generatedAt } = args;
  const mode: ProjectExportMode = options.mode ?? "recent";
  const cap = Math.max(1, Math.min(options.cap ?? MAX_FULL_TICKETS, MAX_FULL_TICKETS));

  const { data: indexData, error: indexErr } = await supabase
    .from("tickets")
    .select("id, ticket_number, title, status, source_run_id, retry_count, updated_at")
    .eq("project_id", row.id)
    // Tenant-scoped explicitly, because on the background-job path `supabase` is
    // the SERVICE client (no session ⇒ RLS off) and `tickets_member_write` gates
    // a row's OWN tenant_id, NOT its project_id — so a foreign tenant can point a
    // ticket at this project id. Without this filter such a row reaches
    // `summaries` (which are built straight off this index) and renders another
    // tenant's title. `loadFullTicketsByIds` filters the full-detail path
    // independently; this covers the summary path.
    .eq("tenant_id", row.tenant_id);
  if (indexErr) throw new Error(`export: project ticket index failed: ${indexErr.message}`);
  const index = (indexData ?? []) as unknown as TicketIndexRow[];

  const { full, rest } = selectFullTicketIds(
    index.map((t) => ({ id: t.id, status: t.status, updatedAt: t.updated_at })),
    mode,
    cap,
  );

  // Membership is already asserted by the caller — these service-role rollups
  // are safe to reach here and NOT one line earlier. `row.tenant_id` is the
  // second, separate control (see the header): membership says the CALLER may
  // look, the tenant argument says WHICH ROWS get counted.
  const [stats, roleUsage, ticketMetrics, stack, fullTickets, unpriced] = await Promise.all([
    loadProjectStats(row.tenant_id, row.id),
    loadRoleUsage(row.tenant_id, row.id),
    loadTicketMetricsForProject(row.tenant_id, row.id),
    loadStackSelection({ tenantId: row.tenant_id, projectId: row.id }),
    // ONE batch for every full-detail ticket — constant query count, not N×9.
    //
    // `row.tenant_id` is load-bearing, not decorative: on the background-job path
    // `supabase` here is the SERVICE client (no session ⇒ no RLS), so this is the
    // only thing scoping the aggregation's relation/sub-issue reads to a tenant.
    // It comes off the project row we already authorised.
    loadTicketAuditBatchServer(supabase, row.tenant_id, full),
    // Project-WIDE, so the headline caveat is right even when detail is capped.
    loadUnpricedTurnsByTicket(
      supabase,
      row.tenant_id,
      index.map((t) => t.id),
    ),
  ]);

  const byId = new Map(index.map((t) => [t.id, t]));
  const summaries: TicketSummary[] = rest
    .map((id) => byId.get(id))
    .filter((t): t is TicketIndexRow => t !== undefined)
    .map((t) => {
      const m = ticketMetrics.get(t.id);
      return {
        id: t.id,
        ticketNumber: t.ticket_number,
        title: untrusted(t.source_run_id ? "agent" : "human", t.title),
        status: t.status as TicketStatus,
        role: m?.primaryRole ?? null,
        totalCents: m?.totalCents ?? 0,
        costPriced: (unpriced.byTicket.get(t.id) ?? 0) === 0,
        runs: m?.runs ?? 0,
        retries: m?.retries ?? t.retry_count ?? 0,
        updatedAt: t.updated_at,
      };
    })
    // Read front-to-back — the summary table opens on the earliest ticket, not
    // the most-recently-touched one (`selectFullTicketIds`' `updatedAt DESC` order
    // decides SELECTION under the cap, never rendered order). See `build-order.ts`.
    .sort(compareByBuildOrder);

  return {
    project: toExportProject(row),
    stack: stack.map((s) => ({
      // Catalog-owned display strings only — `loadStackSelection` already
      // re-derives both entries from their stored keys through the catalog
      // gates, so an unknown key is dropped rather than rendered.
      capability: s.capability.displayName,
      service: s.service.displayName,
      provider: s.service.provider,
      freeTier: s.service.freeTier.kind,
      freeTierNote: "note" in s.service.freeTier ? s.service.freeTier.note : null,
      overridden: s.overridden,
    })),
    rollups: {
      totalSpendCents: stats.totalSpendCents,
      // Project-wide, so the headline "Total spend" tile cannot claim a
      // self-hosted project cost $0.00 without saying it is unpriced.
      unpricedTurns: unpriced.total,
      costPriced: unpriced.total === 0,
      totalRuns: stats.totalRuns,
      totalTickets: stats.totalTickets,
      ticketsDone: stats.ticketsDone,
      ticketsFailed: stats.ticketsFailed,
      ticketsInFlight: stats.ticketsInFlight,
      totalRetries: stats.totalRetries,
      totalRunTimeMs: stats.totalRunTimeMs,
      avgTicketConvergenceMs: stats.avgTicketConvergenceMs,
      lastActivityAt: stats.lastActivityAt,
      byRole: roleUsage.map((r) => ({
        role: r.role,
        displayName: r.displayName,
        runs: r.runs,
        doneRuns: r.doneRuns,
        failedRuns: r.failedRuns,
        totalCents: r.totalCents,
        avgDurationMs: r.avgDurationMs,
      })),
    },
    // Rendered in build order — first ticket first, reading forward. The
    // per-ticket bookmark refs derive from this array's index
    // (`project-document.tsx`), so the outline follows suit automatically. The
    // batch load returns tickets in `full`'s order (`updatedAt DESC`); we re-sort
    // the SELECTED set here rather than reorder the selection.
    tickets: [...fullTickets].sort((a, b) => compareByBuildOrder(a.ticket, b.ticket)),
    summaries,
    bounding: {
      totalTickets: index.length,
      fullCount: fullTickets.length,
      summaryCount: summaries.length,
      cap,
      truncated: summaries.length > 0,
    },
    generatedAt,
  };
}

/**
 * Session-authenticated project export. Asserts membership through RLS FIRST,
 * then aggregates. Returns null when the project is missing or not the caller's
 * — indistinguishable on purpose.
 */
export async function loadProjectAuditExport(
  projectId: string,
  options: ProjectExportOptions = {},
): Promise<ProjectAuditExport | null> {
  const access = await assertProjectAccess(projectId);
  if (!access) return null;
  const supabase = await supabaseServer();
  return aggregate({
    row: access.row,
    supabase: supabase as unknown as SupabaseClient,
    options,
    generatedAt: new Date().toISOString(),
  });
}

/**
 * Background-job project export. There is NO session here, so RLS cannot be the
 * control — the `exports` job row is.
 *
 * `tenantId` MUST come from the job row the caller already read, never from the
 * Inngest event payload (an event is data on a queue; a row is a record an
 * authorised request wrote). The project is re-fetched with the service client
 * and required to match that tenant, so a job row pointing at a project outside
 * its own tenant produces nothing.
 */
export async function loadProjectAuditExportForJob(args: {
  projectId: string;
  tenantId: string;
  options?: ProjectExportOptions;
  generatedAt: string;
}): Promise<ProjectAuditExport | null> {
  const svc = supabaseService();
  const { data, error } = await svc
    .from("projects")
    .select(PROJECT_EXPORT_COLUMNS)
    .eq("id", args.projectId)
    // Re-scope the service client to the job's stamped tenant. This is the line
    // that replaces RLS for a session-less caller.
    .eq("tenant_id", args.tenantId)
    .maybeSingle();
  if (error) throw new Error(`export: project load failed: ${error.message}`);
  const row = data as unknown as ProjectRow | null;
  if (!row) return null;

  return aggregate({
    row,
    supabase: svc as unknown as SupabaseClient,
    options: args.options ?? {},
    generatedAt: args.generatedAt,
  });
}
