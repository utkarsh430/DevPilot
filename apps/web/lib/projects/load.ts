// Phase 2 / M5a — Project record loaders.
//
// Service-role reads from the `projects` table (created by A1's migration).
// The engine-side dispatch path uses these to resolve the right repo + author
// identity for each ticket: ticket → project_id → projects.repo_url → token.
// Tickets with `project_id IS NULL` fall through to the legacy ENGINEER_REPO_URL
// env var (handled by the caller in run-agent.ts).
//
// All reads bypass RLS via the service-role client because the engine runs
// outside any user session. UI-facing project listing should use the RLS-bound
// client in `lib/db/server.ts#supabaseServer()` instead.

import { cache } from "react";
import { supabaseService } from "@/lib/db/server";
import { isLlmProvider, type LlmProvider } from "@/lib/llm/provider";
import { DEFAULT_TEAM_TIER, type TeamTier } from "@/lib/team-tiers/tiers";
import { toProjectType, type ProjectType } from "@/lib/projects/project-type";
import { DEFAULT_ECOSYSTEM, isEcosystemChoice, type EcosystemChoice } from "@/lib/stack/rank";
import { isProdDeployMode, type ProdDeployMode } from "@/lib/vercel/deploy-policy";
// ONE definition of "what counts as a valid per-run ticket ceiling", shared with
// the resolver the route uses. A second copy here is exactly the drift that lets
// a display and an enforcement disagree about the same column.
import { normalizeTicketCeiling } from "@/lib/board/agent-ticket";

export type ProjectRecord = {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  repoUrl: string | null;
  githubRepoId: number | null;
  githubOwner: string | null;
  githubRepo: string | null;
  defaultBranch: string;
  /** Phase 2.5+ / Slice IB — optional integration branch (e.g. "dev"). When
   *  set, ticket workspaces clone --branch <integration_branch> and the
   *  pending-push PR opens with base=<integration_branch>. NULL = legacy:
   *  cut from default_branch and PR directly into it. */
  integrationBranch: string | null;
  /** WI-4 — per-project auto-land opt-in. When true, a done ticket with a branch
   *  is enqueued on integration_queue and squash-merged onto integrationBranch by
   *  the land worker. False = the legacy manual push/PR/merge flow. */
  autoLandEnabled: boolean;
  /** WI-14 - per-project opt-in: may an agent running a ticket in this project
   *  file NEW backlog tickets (`devpilot_create_ticket`)? OFF by default. Agent-filed
   *  tickets always land in `backlog` with no requested role, so they still need
   *  a human to promote them before anything runs. */
  agentTicketCreation: boolean;
  /** WI-14 follow-up - how many tickets ONE run may file in this project. NULL
   *  = inherit (`DEVPILOT_MAX_TICKETS_PER_RUN`, then the built-in default). Raised
   *  on decomposition-heavy projects, where a single ticket legitimately fans
   *  out to five or more children. Resolve it through `resolveMaxTicketsPerRun`
   *  rather than reading it raw - NULL here means inherit, never "no cap". */
  agentTicketMaxPerRun: number | null;
  /** Per-project opt-in: may the runner-resident project supervisor REMEDIATE
   *  on this board (release a deadlocked dispatch queue, hand a stalled ticket
   *  back to a human) when the engine's own Inngest crons have stopped
   *  executing? OFF by default. Detection and reporting are never gated by this
   *  - only action is. See lib/engine/supervisor-policy.ts. */
  supervisorEnabled: boolean;
  /** Per-project escape hatch from the PER-RUN budget ceiling
   *  (`assertCanProceed`, lib/engine/budget.ts). OFF by default - an existing
   *  project's runs are stopped exactly as before. When on, this project's
   *  ticket runs are never cut off for exceeding `runs.budget_cents`; the
   *  tenant-wide cost-velocity circuit breaker is NEVER bypassed by this flag
   *  and remains the backstop. See budget-ceiling-policy.ts. */
  budgetCapOverrideEnabled: boolean;
  /** Operator-chosen team-tier preset. Drives roster + ticket count on every
   *  planning session unless the session sets its own override. */
  teamTier: TeamTier;
  /** WI-11 — operator-chosen target platform, picked at creation/import. Steers
   *  the dev/preview command (stack-detect) and plan mode (prompts). 'other' =
   *  no platform asserted, which steers nothing. */
  projectType: ProjectType;
  /** WI-12 — per-project LLM provider. NULL = inherit (tenant » instance » env).
   *  `openai_compatible` forces the run onto the API runner. */
  llmProvider: LlmProvider | null;
  /** Endpoint for an OpenAI-compatible provider. SSRF-validated at write AND call
   *  time — never dereference this without going through `validateLlmBaseUrl`. */
  llmBaseUrl: string | null;
  /** OPAQUE pointer to the provider credential (see lib/llm/credential-ref.ts).
   *  A name, not a secret — the VALUE is resolved server-side only, and no read
   *  surface ever returns it. */
  llmCredentialRef: string | null;
  /** Explicit model id/alias. NULL = tier map (API) / account default (subscription,
   *  where it means no `--model` flag at all). */
  llmModel: string | null;
  /** Stack advisor - the ecosystem the operator committed to. Drives the
   *  ranker's native-first ordering. 'unset' = no commitment asserted, which
   *  steers nothing (same posture as `projectType: 'other'`). */
  stackEcosystem: EcosystemChoice;
  /** Vercel project id (`prj_…`). NULL = not linked. The single "is this project
   *  linked to Vercel?" flag. */
  vercelProjectId: string | null;
  vercelProjectName: string | null;
  /** Written by PR 4 on a successful production deploy. */
  vercelProductionUrl: string | null;
  /** SNAPSHOT of Vercel's `link.productionBranch` at link time — Vercel's API
   *  exposes it READ-ONLY, so this is a display/audit fallback for when the live
   *  read fails, never an authority. Rendered as "last known" when used. */
  vercelProductionBranch: string | null;
  /** The branch the operator expects Vercel to deploy production from (normally
   *  the integration branch). DevPilot cannot apply it — `link.productionBranch`
   *  is read-only in Vercel's API — so it exists to be compared against the live
   *  value, which is what turns "Vercel is still on main" from invisible into a
   *  warning with manual steps. */
  vercelProductionBranchDesired: string | null;
  /** The operator's recorded INTENT for git-push → production deploys. Vercel is
   *  the authority on the live state; this makes intent-vs-reality divergence
   *  detectable instead of silent. */
  vercelProdDeployMode: ProdDeployMode | null;
  vercelLinkedAt: string | null;
  vercelLinkedBy: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type ProjectRow = {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  repo_url: string | null;
  github_repo_id: number | string | null;
  github_owner: string | null;
  github_repo: string | null;
  default_branch: string | null;
  integration_branch: string | null;
  auto_land_enabled?: boolean | null;
  agent_ticket_creation?: boolean | null;
  agent_ticket_max_per_run?: number | string | null;
  supervisor_enabled?: boolean | null;
  budget_cap_override_enabled?: boolean | null;
  team_tier: TeamTier | null;
  project_type?: string | null;
  llm_provider?: string | null;
  llm_base_url?: string | null;
  llm_credential_ref?: string | null;
  llm_model?: string | null;
  stack_ecosystem?: string | null;
  vercel_project_id?: string | null;
  vercel_project_name?: string | null;
  vercel_production_url?: string | null;
  vercel_production_branch?: string | null;
  vercel_production_branch_desired?: string | null;
  vercel_prod_deploy_mode?: string | null;
  vercel_linked_at?: string | null;
  vercel_linked_by?: string | null;
  created_by: string | null;
  created_at: string;
};

/** Map a raw `projects` row (PostgREST or the `shell_bootstrap` RPC's jsonb) to
 *  the domain shape. Exported so the shell-bootstrap loader maps the RPC's
 *  project payload through the SAME logic — the topbar switcher stays identical
 *  whether the layout fetched projects directly or via the bootstrap bundle. */
export function mapProjectRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    repoUrl: row.repo_url,
    // pg `bigint` may serialise as string via PostgREST; normalise to number
    // (the GitHub repo id always fits in a JS safe integer).
    githubRepoId:
      row.github_repo_id == null
        ? null
        : typeof row.github_repo_id === "string"
          ? Number(row.github_repo_id)
          : row.github_repo_id,
    githubOwner: row.github_owner,
    githubRepo: row.github_repo,
    defaultBranch: row.default_branch ?? "main",
    integrationBranch: row.integration_branch ?? null,
    autoLandEnabled: row.auto_land_enabled ?? false,
    agentTicketCreation: row.agent_ticket_creation ?? false,
    // Same reasoning as `projectType` / `stackEcosystem` below: this mapper also
    // maps the `shell_bootstrap` RPC's jsonb, where the column arrives untyped,
    // so an unexpected value must degrade to "inherit" rather than crash a
    // render. Degrading to NULL is also the safe direction for a ceiling - it
    // falls through to the env/default rung, never to "no cap". The resolver
    // (`resolveMaxTicketsPerRun`) guards the same property independently; both
    // layers are deliberate, because this one is a display concern and that one
    // is the safety property.
    agentTicketMaxPerRun: normalizeTicketCeiling(row.agent_ticket_max_per_run),
    // `?? false` for the same reason as `agentTicketCreation`: this mapper also
    // maps the `shell_bootstrap` RPC's jsonb, where an absent column arrives as
    // undefined. Degrading a safety opt-in to OFF is the correct direction - the
    // supervisor observes and reports either way, and only ACTION is gated.
    supervisorEnabled: row.supervisor_enabled ?? false,
    // `?? false` for the same reason as `supervisorEnabled`: this mapper also
    // maps the `shell_bootstrap` RPC's jsonb, where an absent column arrives
    // as undefined. Degrading a cost override to OFF is the correct
    // direction - the run stays capped either way, never silently uncapped.
    budgetCapOverrideEnabled: row.budget_cap_override_enabled ?? false,
    teamTier: row.team_tier ?? DEFAULT_TEAM_TIER,
    // Narrowed rather than cast: the column is an enum the DB guarantees, but
    // this mapper also maps the `shell_bootstrap` RPC's jsonb, so an unexpected
    // or absent value must degrade to the no-steering default, never crash a Run.
    projectType: toProjectType(row.project_type),
    // WI-12 — `isLlmProvider` rather than `normalizeLlmProvider`: NULL here means
    // INHERIT (fall through to the tenant default), which is a different thing
    // from "anthropic". Normalising would collapse the two and quietly pin every
    // project to Anthropic, defeating the tenant-level setting.
    llmProvider: isLlmProvider(row.llm_provider) ? row.llm_provider : null,
    llmBaseUrl: row.llm_base_url ?? null,
    llmCredentialRef: row.llm_credential_ref ?? null,
    llmModel: row.llm_model ?? null,
    // Same reasoning as `projectType` above: this mapper also maps the
    // `shell_bootstrap` RPC's jsonb, so an unexpected/absent value must
    // degrade to the no-steering default rather than crash.
    stackEcosystem: isEcosystemChoice(row.stack_ecosystem)
      ? row.stack_ecosystem
      : DEFAULT_ECOSYSTEM,
    vercelProjectId: row.vercel_project_id ?? null,
    vercelProjectName: row.vercel_project_name ?? null,
    vercelProductionUrl: row.vercel_production_url ?? null,
    vercelProductionBranch: row.vercel_production_branch ?? null,
    vercelProductionBranchDesired: row.vercel_production_branch_desired ?? null,
    // Narrowed, not cast, for the same reason as `projectType` above: this
    // mapper also maps the `shell_bootstrap` RPC's jsonb, and an unexpected
    // value must degrade to "no recorded intent" rather than crash a render.
    vercelProdDeployMode: isProdDeployMode(row.vercel_prod_deploy_mode)
      ? row.vercel_prod_deploy_mode
      : null,
    vercelLinkedAt: row.vercel_linked_at ?? null,
    vercelLinkedBy: row.vercel_linked_by ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// Keep in sync with the `projects` select list inside the `shell_bootstrap` SQL
// function — both feed `mapProjectRow`, so a column that is here but not there
// comes back silently defaulted on the shell-bootstrap path.
const PROJECT_COLUMNS =
  "id, tenant_id, name, description, repo_url, github_repo_id, github_owner, github_repo, default_branch, integration_branch, auto_land_enabled, agent_ticket_creation, agent_ticket_max_per_run, supervisor_enabled, budget_cap_override_enabled, team_tier, project_type, llm_provider, llm_base_url, llm_credential_ref, llm_model, stack_ecosystem, vercel_project_id, vercel_project_name, vercel_production_url, vercel_production_branch, vercel_production_branch_desired, vercel_prod_deploy_mode, vercel_linked_at, vercel_linked_by, created_by, created_at";

/**
 * All projects for a tenant. Used by the topbar switcher to enumerate
 * available projects for the current user.
 *
 * React.cache: the app layout and `resolveActiveProjectId` (called by most
 * pages) both need this list on the same request — dedupe to one query.
 * Outside an RSC render (engine/Inngest code) cache() is a passthrough.
 */
export const loadProjectsForTenant = cache(async (tenantId: string): Promise<ProjectRecord[]> => {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`loadProjectsForTenant failed: ${error.message}`);
  }
  return (data as ProjectRow[] | null)?.map(mapProjectRow) ?? [];
});

/**
 * Single project by id. Returns null if it doesn't exist.
 */
export async function loadProjectById(projectId: string): Promise<ProjectRecord | null> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_COLUMNS)
    .eq("id", projectId)
    .maybeSingle();
  if (error) {
    throw new Error(`loadProjectById failed: ${error.message}`);
  }
  return data ? mapProjectRow(data as ProjectRow) : null;
}

/**
 * Resolve the project for a given ticket via `tickets.project_id`.
 * Returns null if the ticket has no project (= legacy fallback path; caller
 * should fall through to env.ENGINEER_REPO_URL).
 */
export async function loadProjectForTicket(ticketId: string): Promise<ProjectRecord | null> {
  const supabase = supabaseService();
  // First fetch the ticket's project_id. We do this as a two-step (rather
  // than a joined select) because PostgREST's nested-select returns the
  // related row wrapped in an object — keeping it flat as a two-step is
  // both simpler to type and cheaper when project_id is null.
  const { data: ticket, error: ticketErr } = await supabase
    .from("tickets")
    .select("project_id")
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketErr) {
    throw new Error(`loadProjectForTicket: ticket lookup failed: ${ticketErr.message}`);
  }
  const projectId = (ticket as { project_id: string | null } | null)?.project_id;
  if (!projectId) return null;
  return loadProjectById(projectId);
}
