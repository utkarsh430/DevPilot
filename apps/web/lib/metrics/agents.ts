// PR 5 of the "Agent Learning + Scoreboard" system — the tenant-wide rollup that
// backs `/scoreboard`. Derived entirely from existing tables (`runs`, `agents`,
// `agent_mistakes`); no new schema, and a materialized cache is an explicit
// non-goal for v1.
//
// ── tenantId is a REQUIRED first parameter, and that is the boundary ────────
// This is a SERVICE-ROLE read, so RLS is OFF and nothing filters by tenant except
// the `.eq("tenant_id", …)` predicates written below. Same rule, same reason as
// `lib/metrics/project.ts`: required rather than optional, because an optional
// parameter is the thing callers forget, and forgetting is exactly how the
// cross-tenant read class shipped (four times, per AGENTS.md).
//
// This loader is scoped by `tenant_id` ALONE — no project/ticket pointer is
// involved (the tenant-wide precedent is `lib/billing/meter.ts`), so it is not in
// the "keyed on an attacker-controllable pointer" shape the tenant-scope scanner
// hunts. Every one of its three reads still carries the predicate explicitly,
// including `agents` (a name lookup, but a map keyed by foreign agent ids is a
// trap for the next caller who trusts it).
//
// ── Attribution ────────────────────────────────────────────────────────────
// A run belongs to `COALESCE(runs.fan_out_role, agents.role)` — fan-out siblings
// carry no `agent_id`, so the sibling's role column is authoritative when set.
// That is the rule already used by `lib/metrics/project.ts:loadRoleUsage`, and
// the one the harvester used to stamp `agent_mistakes.role`, so runs and mistakes
// bucket identically without a join.
//
// ── Identity: the ROLE, not the runner ─────────────────────────────────────
// The plan leaves "rank the reusable agent config, or individual runners?" open.
// v1 ranks the role slug: it is the only attribution that exists on every row
// (fan-out siblings have no `agent_id` at all), and it is the thing an operator
// can act on — a runner instance is disposable, a role config is edited.

import { supabaseService } from "@/lib/db/server";
import { ROLE_CATALOG } from "@/lib/roles/catalog";
import { loadProjectsForTenant } from "@/lib/projects/load";
import { isLlmProvider, LLM_PROVIDER_CONFIG_KEY, type LlmProvider } from "@/lib/llm/provider";
import type { RoleModelRow } from "@/lib/llm/role-model";
import {
  resolveModelByRole,
  resolveProjectModels,
  type AgentModel,
  type ProjectModelRow,
  type ProjectProviderInput,
} from "@/lib/metrics/agent-model";
import {
  buildRoleScoreRows,
  groupIntoCategoryLeaderboards,
  isMistakeType,
  isSyntheticPlatformRun,
  normalizeRole,
  summarizeUnattributed,
  type CategoryLeaderboard,
  type MistakeFact,
  type RoleScoreRow,
  type RunFact,
  type UnattributedSummary,
} from "@/lib/metrics/agent-score";

export type {
  CategoryLeaderboard,
  MistakeType,
  MistakeTypeCounts,
  RoleScoreRow,
  UnattributedSummary,
} from "@/lib/metrics/agent-score";

// `ProjectModelRow` / `AgentModel` now live in `lib/metrics/agent-model.ts` (THE
// shared resolver, also read by /agents). Re-exported so existing importers of
// this module are unaffected.
export type { AgentModel, ProjectModelRow } from "@/lib/metrics/agent-model";

export type AgentScoreboard = {
  /** Cross-role, ranked — clearly labelled NOT apples-to-apples in the UI. */
  overall: RoleScoreRow[];
  /** Below MIN_RANKED_RUNS: shown, never ranked. */
  needsMoreData: RoleScoreRow[];
  /** The real ranking: comparable peers only. */
  leaderboards: CategoryLeaderboard[];
  /**
   * Ticket-bound (or supervisor-parented) runs that resolve to no role. Real
   * work, shown for completeness — but NOT an agent, so this is a flat summary
   * with no score and no rank rather than a row on any board.
   */
  unattributed: UnattributedSummary;
  /** How many synthetic platform one-shot runs were excluded, for disclosure. */
  excludedSyntheticRuns: number;
  /** role slug → the model that role's runs actually run on. */
  modelByRole: Record<string, AgentModel>;
  /** Per-project model config — the scope the bump control actually writes to. */
  projectModels: ProjectModelRow[];
  totals: {
    roles: number;
    rankedRoles: number;
    runs: number;
    cleanRuns: number;
    /** Every harvested mistake, human corrections included. */
    mistakes: number;
    /** Only `counts_against_score = true`. */
    scoringMistakes: number;
  };
};

/**
 * PostgREST caps a response at `db.max_rows` (1000 in supabase/config.toml), and
 * it does so SILENTLY — a tenant past that many runs would get a truncated, and
 * therefore wrong, scoreboard with nothing indicating it. So every read here
 * pages explicitly.
 */
const PAGE_SIZE = 1000;
/** Safety stop so a pathological dataset can't spin forever. 200k rows. */
const MAX_PAGES = 200;

type Row = Record<string, unknown>;

async function fetchAllPages(
  table: string,
  columns: string,
  tenantId: string,
  supabase: ReturnType<typeof supabaseService>,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      // THE tenant boundary for this service-role read. Never remove.
      .eq("tenant_id", tenantId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      // Never swallow a Supabase error silently (AGENTS.md), and never return
      // what we got so far: a partial read renders as a smaller, entirely
      // plausible scoreboard, which is worse than a visible failure. Throwing
      // surfaces it through the route's error boundary instead of quietly
      // demoting an agent that simply did not fit in the page we managed to read.
      console.error(`[metrics/agents] ${table} page ${page} failed for tenant ${tenantId}:`, error);
      throw new Error(`scoreboard: failed reading ${table} (page ${page}): ${error.message}`);
    }
    const rows = (data ?? []) as unknown as Row[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * The tenant-level provider default (`tenants.config.llm_provider`).
 *
 * Read here rather than through `getTenantLlmProvider` (provider-config.server.ts)
 * on purpose: that module is `server-only`, and importing it would make this
 * whole loader — and therefore its tenant-scope tests — unloadable under Vitest.
 * Same posture as the rest of this file, which does all of its own reads. The
 * PRECEDENCE rule is not duplicated: that still lives in the pure `selectProvider`.
 *
 * A DB error swallows to null for the same reason the original does: a Supabase
 * blip must not silently relabel every project's model.
 */
async function readTenantProvider(
  tenantId: string,
  supabase: ReturnType<typeof supabaseService>,
): Promise<LlmProvider | null> {
  try {
    const { data, error } = await supabase
      .from("tenants")
      .select("config")
      // `tenants.id` IS the tenant — this is the scoped form for this table.
      .eq("id", tenantId)
      .maybeSingle();
    if (error || !data) return null;
    const cfg = (data.config ?? {}) as Record<string, unknown>;
    const raw = cfg[LLM_PROVIDER_CONFIG_KEY];
    return isLlmProvider(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The tenant's per-agent model overrides, BOTH scopes — a row with a NULL
 * `project_id` is that role's agent-wide default and is kept, not dropped.
 *
 * Read through this file's own paging helper for the same reason
 * `readTenantProvider` is inlined: `lib/llm/role-model.server.ts` is
 * `server-only`, and importing it would make this loader — and therefore its
 * tenant-scope tests — unloadable under Vitest. The tenant predicate comes from
 * `fetchAllPages`, which carries it on every page; the RULES are not duplicated,
 * they stay in the pure `applyRoleModelOverride`.
 */
async function readRoleModelOverrides(
  tenantId: string,
  supabase: ReturnType<typeof supabaseService>,
): Promise<RoleModelRow[]> {
  const rows = await fetchAllPages(
    "agent_project_models",
    "id, project_id, role_slug, provider, model",
    tenantId,
    supabase,
  );
  const out: RoleModelRow[] = [];
  for (const r of rows) {
    const projectId = (r.project_id as string | null) ?? null;
    const roleSlug = ((r.role_slug as string | null) ?? "").trim();
    const model = ((r.model as string | null) ?? "").trim();
    // An unrecognised provider can never match the winning one, so keeping it
    // would only produce a confusing "not in effect" label for a value nothing
    // can use.
    // `projectId` null is NOT a bad row — it is the agent-wide default.
    if (!roleSlug || !model || !isLlmProvider(r.provider)) continue;
    out.push({ projectId, roleSlug, provider: r.provider, model });
  }
  return out;
}

const CATALOG_BY_SLUG = new Map(ROLE_CATALOG.map((e) => [e.slug, e]));

/** Catalog section order — the leaderboard section order on the page. */
export const LEADERBOARD_CATEGORY_ORDER: string[] = (() => {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const entry of ROLE_CATALOG) {
    if (!seen.has(entry.category)) {
      seen.add(entry.category);
      order.push(entry.category);
    }
  }
  return order;
})();

/**
 * Tenant-wide agent scoreboard. `tenantId` is REQUIRED and is the isolation
 * boundary — see the header.
 */
export async function loadAgentScoreboard(tenantId: string): Promise<AgentScoreboard> {
  const supabase = supabaseService();

  const [
    runRows,
    agentRows,
    mistakeRows,
    ticketRows,
    projects,
    tenantProvider,
    roleModelOverrides,
  ] = await Promise.all([
    // `runner_kind` + `parent_run_id` are read ONLY for the synthetic-run filter
    // (see isSyntheticPlatformRun); they never reach scoring.
    fetchAllPages(
      "runs",
      "id, agent_id, fan_out_role, ticket_id, runner_kind, parent_run_id",
      tenantId,
      supabase,
    ),
    fetchAllPages("agents", "id, name, role", tenantId, supabase),
    fetchAllPages(
      "agent_mistakes",
      "id, role, type, counts_against_score, run_id, ticket_id",
      tenantId,
      supabase,
    ),
    // ticket → project, so a role's model can be resolved from the projects its
    // runs actually touched. Tenant-scoped like every other read here.
    fetchAllPages("tickets", "id, project_id", tenantId, supabase),
    loadProjectsForTenant(tenantId),
    readTenantProvider(tenantId, supabase),
    readRoleModelOverrides(tenantId, supabase),
  ]);

  const agentById = new Map<string, { name: string; role: string | null }>(
    agentRows.map((a) => [
      a.id as string,
      { name: (a.name as string) ?? "", role: (a.role as string | null) ?? null },
    ]),
  );

  // slug → the tenant's own agent-config name, when it has one. Preferred over
  // the catalog label so a renamed/custom agent shows the operator's own name.
  const tenantNameByRole = new Map<string, string>();
  for (const a of agentRows) {
    const role = (a.role as string | null) ?? null;
    const name = (a.name as string) ?? "";
    if (role && name && !tenantNameByRole.has(role)) tenantNameByRole.set(role, name);
  }

  const projectByTicket = new Map<string, string>();
  for (const t of ticketRows) {
    const projectId = (t.project_id as string | null) ?? null;
    if (projectId) projectByTicket.set(t.id as string, projectId);
  }

  // Drop synthetic platform one-shot runs BEFORE anything else sees them: they
  // are internal LLM plumbing, not agent work, and counting them is what put a
  // fictional 99.4% "unassigned" agent at #1. See isSyntheticPlatformRun.
  const syntheticRunIds = new Set<string>();
  const runs: RunFact[] = [];
  for (const r of runRows) {
    const fanOut = (r.fan_out_role as string | null) ?? null;
    const agentId = (r.agent_id as string | null) ?? null;
    const ticketId = (r.ticket_id as string | null) ?? null;
    if (
      isSyntheticPlatformRun({
        agentId,
        ticketId,
        fanOutRole: fanOut,
        parentRunId: (r.parent_run_id as string | null) ?? null,
        runnerKind: (r.runner_kind as string | null) ?? null,
      })
    ) {
      syntheticRunIds.add(r.id as string);
      continue;
    }
    const viaAgent = agentId ? (agentById.get(agentId)?.role ?? null) : null;
    runs.push({
      id: r.id as string,
      // null = unattributable. NOT a placeholder slug — a placeholder is a bucket,
      // and a bucket is rankable.
      role: normalizeRole(fanOut) ?? normalizeRole(viaAgent),
      ticketId,
      projectId: ticketId ? (projectByTicket.get(ticketId) ?? null) : null,
    });
  }

  const mistakes: MistakeFact[] = [];
  for (const m of mistakeRows) {
    const type = m.type;
    // The column is CHECK-constrained, but the vocabulary is closed in TS too —
    // an unknown value is dropped rather than widening the counts record.
    if (!isMistakeType(type)) continue;
    // A mistake harvested against a synthetic run is plumbing too — drop it with
    // its run, or the counts would name work that is no longer on the board.
    const runId = (m.run_id as string | null) ?? null;
    if (runId && syntheticRunIds.has(runId)) continue;
    mistakes.push({
      role: normalizeRole(m.role),
      type,
      countsAgainstScore: m.counts_against_score === true,
      runId,
      ticketId: (m.ticket_id as string | null) ?? null,
    });
  }

  const rows = buildRoleScoreRows({
    runs,
    mistakes,
    displayNameFor: (role) =>
      tenantNameByRole.get(role) ?? CATALOG_BY_SLUG.get(role)?.displayName ?? role,
    categoryFor: (role) => CATALOG_BY_SLUG.get(role)?.category ?? null,
  });

  const overall = rows.filter((r) => r.ranked);
  const needsMoreData = rows
    .filter((r) => !r.ranked)
    .sort((a, b) => b.totalRuns - a.totalRuns || a.role.localeCompare(b.role));

  // ── Model resolution ──────────────────────────────────────────────────────
  // Delegated WHOLE to `lib/metrics/agent-model.ts`, the ONE exported resolver
  // both /scoreboard and /agents read. It was inlined here, which is how the two
  // screens came to disagree about the same agent's model — /agents rendered the
  // static (and no-op) catalog `modelTier` instead. There is deliberately no
  // second place to compute this.
  const providerInputs: ProjectProviderInput[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    provider: p.llmProvider,
    baseUrl: p.llmBaseUrl,
    model: p.llmModel,
    credentialRef: p.llmCredentialRef,
  }));
  const projectModels = resolveProjectModels({ projects: providerInputs, tenantProvider });
  const modelByRole = resolveModelByRole({
    roles: rows.map((r) => ({ role: r.role, projectIds: r.projectIds })),
    projects: providerInputs,
    tenantProvider,
    roleOverrides: roleModelOverrides,
  });

  return {
    overall,
    needsMoreData,
    leaderboards: groupIntoCategoryLeaderboards(rows, LEADERBOARD_CATEGORY_ORDER),
    unattributed: summarizeUnattributed(runs, mistakes),
    excludedSyntheticRuns: syntheticRunIds.size,
    modelByRole,
    projectModels,
    totals: {
      roles: rows.length,
      rankedRoles: overall.length,
      runs: rows.reduce((n, r) => n + r.totalRuns, 0),
      cleanRuns: rows.reduce((n, r) => n + r.cleanRuns, 0),
      mistakes: rows.reduce((n, r) => n + r.mistakeCount, 0),
      scoringMistakes: rows.reduce((n, r) => n + r.scoringMistakeCount, 0),
    },
  };
}
