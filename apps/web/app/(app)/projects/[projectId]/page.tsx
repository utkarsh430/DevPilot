// Phase 2 / M5a — Project detail page.
//
// Server component: loads the project, the most-recent tickets attached to it,
// and any pending pushes still waiting for review. Read-only on this page —
// mutations live elsewhere:
//   - File a ticket → /board
//   - Push pending changes → /changes
//   - Rename / Refresh from GitHub / Delete project → the ⋯ actions menu in
//     the header (ProjectActionsMenu), which calls the projects server actions.
//
// We intentionally avoid realtime here; the project shell rarely changes, and
// the live surfaces are /board / /changes / /runs which each have their own
// realtime subscriptions.

import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  ListTodo,
} from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { loadProjectById } from "@/lib/projects/load";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { relativeTime } from "@/lib/relative-time";
import { CopyButton } from "./copy-button";
import { ProjectActionsMenu } from "./project-actions-menu";
import { RunPanel } from "./run-panel";
import {
  loadProjectStats,
  loadDailySpend,
  loadRoleUsage,
  loadTicketMetricsForProject,
} from "@/lib/metrics/project";
import { ProjectStatsRow } from "@/components/metrics/project-stats-row";
import { SpendChart } from "@/components/metrics/spend-chart";
import { RoleUsageTable } from "@/components/metrics/role-usage-table";
import { formatCents, formatDurationMs } from "@/lib/format-units";
import { PlanningCard } from "@/components/plan/PlanningCard";
import { StackAdvisorPanel } from "@/components/stack/StackAdvisorPanel";
import type { PlanSession, PlanStatus, StackFlavor } from "@/lib/plan/types";
import { SecretsCard } from "@/components/projects/SecretsCard";
import { loadProjectSecretsOverview } from "@/lib/projects/secrets";
import { BranchRoutingCard } from "./branch-routing-card";
import { DeploymentCard } from "./deployment-card";
import { loadVercelLinkStatus } from "@/lib/vercel/link.server";
import { vercelTokenConfigured } from "@/lib/vercel/api.server";
import { listProjectDeployments } from "@/lib/vercel/deploy-write";
import { LlmProviderCard } from "./llm-provider-card";
import { TeamTierCard } from "./team-tier-card";
import { AgentAutonomyCard } from "./agent-autonomy-card";
import { SupervisorCard } from "./supervisor-card";
import { BudgetCapCard } from "./budget-cap-card";
import { resolveMaxTicketsPerRun } from "@/lib/board/agent-ticket";
import { AutomationToggle } from "@/components/shell/automation-toggle";
import { loadProjectAutomationState, loadTenantAutomationState } from "@/lib/automation/queries";

export const dynamic = "force-dynamic";

const RECENT_TICKET_LIMIT = 10;

type TicketRow = {
  id: string;
  title: string;
  status: string;
  requested_role: string | null;
  created_at: string;
  updated_at: string | null;
};

type PendingPushRow = {
  id: string;
  branch: string;
  unpushed_count: number | null;
  files_changed: unknown;
  head_sha: string | null;
  created_at: string;
  updated_at: string;
};

// Snake-case row shape PostgREST hands back for `planning_sessions`. We map
// to the `PlanSession` camelCase shape that the client component renders.
type PlanningSessionRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  created_by: string | null;
  goal_summary: string | null;
  status: PlanStatus;
  stack_flavor: StackFlavor;
  stack_preferences: string | null;
  spent_cents: number | null;
  billed_at: string | null;
  created_at: string;
  updated_at: string;
};

function mapPlanningSession(row: PlanningSessionRow): PlanSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    createdBy: row.created_by,
    goalSummary: row.goal_summary,
    status: row.status,
    stackFlavor: row.stack_flavor,
    stackPreferences: row.stack_preferences ?? "",
    spentCents: row.spent_cents ?? 0,
    billedAt: row.billed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const STATUS_TONE: Record<string, "info" | "warn" | "danger" | "ok" | "muted"> = {
  backlog: "muted",
  ready: "info",
  assigned: "info",
  in_progress: "info",
  input_required: "warn",
  blocked: "warn",
  in_review: "info",
  done: "ok",
  failed: "danger",
};

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const tenantId = await requireTenantId();

  const { projectId } = await params;
  const sp = (await searchParams) ?? {};
  // ?planSession=<uuid> auto-opens the PlanSheet to that session — used by
  // the new-project flow to land the operator straight in the plan chat.
  const planSessionRaw = sp.planSession;
  const initialOpenPlanSessionId = typeof planSessionRaw === "string" ? planSessionRaw : null;
  const project = await loadProjectById(projectId);
  if (!project || project.tenantId !== tenantId) {
    notFound();
  }

  const supabase = supabaseService();

  // Recent tickets attached to the project. We don't filter by status — the
  // operator wants to see active + recently-converged at a glance.
  //
  // `.eq("tenant_id")` is not redundant: this is the SERVICE client (RLS off),
  // and `tickets_member_write` constrains a row's own tenant_id but not its
  // project_id — so another tenant could point a ticket at this project and its
  // TITLE would render in this card. Migration 20260730000000 now blocks that
  // write, but a policy cannot unmake rows written before it, so the read stays
  // scoped. Same rule as lib/metrics/project.ts.
  const { data: ticketsData } = await supabase
    .from("tickets")
    .select("id, title, status, requested_role, created_at, updated_at")
    .eq("project_id", projectId)
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(RECENT_TICKET_LIMIT);
  const tickets = (ticketsData ?? []) as TicketRow[];

  // Phase 2 / M5f — metrics: project totals, daily spend timeline, per-role
  // aggregation, and per-ticket badge data. Each helper does its own ticket-id
  // lookup; cheap enough at the current scale + RLS-bypassing via service role.
  // Slice A also tucks in the secret-NAMES list so the card renders without
  // a client-side fetch on mount.
  //
  // `tenantId` is REQUIRED by each helper and is load-bearing, not ceremony:
  // these are service-role reads (RLS off) and `tickets_member_write` does not
  // constrain `project_id`, so another tenant can write a ticket carrying THIS
  // project's id. Without the tenant scope their tickets and runs contaminate
  // these tiles and the spend chart. See lib/metrics/project.ts.
  const [stats, dailySpend, roleUsage, ticketMetrics, secretsOverview] = await Promise.all([
    loadProjectStats(tenantId, projectId),
    loadDailySpend(tenantId, projectId, 14),
    loadRoleUsage(tenantId, projectId),
    loadTicketMetricsForProject(tenantId, projectId),
    loadProjectSecretsOverview(projectId, tenantId),
  ]);

  // Pending pushes still awaiting review. The /changes page renders the full
  // diff; here we just surface a count + link.
  const { data: pendingData } = await supabase
    .from("pending_pushes")
    .select("id, branch, unpushed_count, files_changed, head_sha, created_at, updated_at")
    .eq("project_id", projectId)
    // Same class: `pending_pushes_member_write` constrains only the row's own
    // tenant_id, so a foreign push row could claim this project and surface its
    // BRANCH NAME here.
    .eq("tenant_id", tenantId)
    .is("pushed_at", null)
    .order("updated_at", { ascending: false });
  const pendingPushes = (pendingData ?? []) as PendingPushRow[];

  // Slice IB — is there integration work waiting to be promoted into
  // production? Proxy: at least one pending_push has been pushed (pushed_at
  // IS NOT NULL) for this project. The promote action handles the
  // "already-up-to-date" case gracefully, so a stale signal here just lets
  // the operator try and get a friendly "nothing to do" toast.
  const { count: pushedPushCount } = await supabase
    .from("pending_pushes")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("tenant_id", tenantId)
    .not("pushed_at", "is", null);
  const canPromoteIntegration = (pushedPushCount ?? 0) > 0;

  // Vercel link state. Read LIVE from Vercel rather than from our own columns:
  // the production branch and whether git pushes deploy to production are
  // Vercel's state, changeable from its dashboard at any time with no webhook to
  // us, and this card's entire purpose is to be truthful about what is armed.
  // `loadVercelLinkStatus` never throws — a Vercel outage degrades the card to
  // "could not confirm", it does not 500 the project page.
  //
  // The deploy ledger is read alongside it so the deploy list paints with the
  // page rather than after a client round trip. It is a SERVICE-ROLE read keyed
  // on a project id, so the co-located `.eq("tenant_id", …)` inside
  // `listProjectDeployments` is the tenant boundary — `tenantId` here comes from
  // the session, never from the route param.
  const [vercelStatus, vercelTokenIsConfigured, deployments] = await Promise.all([
    loadVercelLinkStatus(tenantId, project),
    vercelTokenConfigured(tenantId),
    tenantId
      ? listProjectDeployments(supabaseService(), tenantId, project.id, 10)
      : Promise.resolve([]),
  ]);

  // Phase 2.5+ / M7 — Recent planning sessions for this project. Filter out
  // discarded by default; cap at 8 for header card density.
  //
  // LIVE HOLE, found by the fourth review. The comment that used to sit here —
  // "RLS lets us run through the service-role client safely because we've
  // already validated the project belongs to the caller's tenant" — is the
  // disproven reasoning at the heart of this whole class, so it is gone.
  // Validating that the CALLER may see project P says nothing about whether the
  // ROWS returned belong to P's tenant: `planning_sessions_member_write` pins
  // only the row's own tenant_id, so another tenant can point a session at this
  // project and its `goal_summary` / `stack_preferences` would render here.
  //
  // Note this read SELECTS `tenant_id`, which is why the round-3 source-scan
  // called it scoped — it tested for the substring, not for a predicate.
  const { data: planningData } = await supabase
    .from("planning_sessions")
    .select(
      "id, tenant_id, project_id, created_by, goal_summary, status, stack_flavor, stack_preferences, spent_cents, billed_at, created_at, updated_at",
    )
    .eq("project_id", projectId)
    .eq("tenant_id", tenantId)
    .neq("status", "discarded")
    .order("updated_at", { ascending: false })
    .limit(8);
  const planningSessions = (planningData ?? []).map((r) =>
    mapPlanningSession(r as PlanningSessionRow),
  );

  const browserRepoUrl = project.repoUrl ? project.repoUrl.replace(/\.git$/, "") : null;

  // Per-project automation pause state + workspace state to know whether
  // the project toggle should render as disabled (workspace overrides).
  const [projectAutomation, tenantAutomation] = await Promise.all([
    loadProjectAutomationState(project.id),
    loadTenantAutomationState(tenantId),
  ]);
  const tenantPaused = tenantAutomation?.tenant.state === "paused";

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <header className="mb-8 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="bg-muted text-muted-foreground flex h-9 w-9 items-center justify-center rounded-md">
              <FolderGit2 className="h-4 w-4" />
            </div>
            <div>
              <Link
                href="/projects"
                className="text-muted-foreground hover:text-foreground text-xs"
              >
                ← Projects
              </Link>
              <h1 className="font-display mt-0.5 text-2xl font-bold tracking-tight">
                {project.name}
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="muted" className="font-mono text-[10px]">
              <GitBranch className="h-3 w-3" />
              {project.defaultBranch}
            </Badge>
            {projectAutomation ? (
              <AutomationToggle
                scope="project"
                scopeId={project.id}
                initialState={projectAutomation.state}
                initialPausedAt={projectAutomation.pausedAt}
                disabled={tenantPaused}
                disabledReason="Workspace is paused — overrides project setting. Resume workspace first."
              />
            ) : null}
            <ProjectActionsMenu
              projectId={project.id}
              currentName={project.name}
              currentGithubFullName={
                project.githubOwner && project.githubRepo
                  ? `${project.githubOwner}/${project.githubRepo}`
                  : null
              }
            />
          </div>
        </div>

        {project.description ? (
          <p className="text-muted-foreground max-w-2xl text-sm">{project.description}</p>
        ) : null}

        {project.repoUrl ? (
          <div className="flex items-center gap-2">
            <code className="bg-muted/50 flex-1 truncate rounded-md border px-3 py-1.5 font-mono text-xs">
              {project.repoUrl}
            </code>
            <CopyButton value={project.repoUrl} />
            {browserRepoUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={browserRepoUrl} target="_blank" rel="noreferrer noopener">
                  <ExternalLink className="h-3 w-3" />
                  Open on GitHub
                </a>
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs italic">Repo not linked yet.</p>
        )}
      </header>

      {/* ─── Run on localhost (dev server) — primary day-to-day surface ── */}
      <section className="mb-8">
        <RunPanel
          tenantId={tenantId}
          projectId={projectId}
          scope={{ kind: "project" }}
          defaultBranch={project.defaultBranch}
          integrationBranch={project.integrationBranch}
        />
      </section>

      {/* ─── Environment & secrets — what the dev server needs to run ──── */}
      <section className="mb-8">
        <SecretsCard projectId={projectId} tenantId={tenantId} initial={secretsOverview} />
      </section>

      {/* ─── Project KPIs at a glance ──────────────────────────────────── */}
      <section className="mb-8">
        <ProjectStatsRow stats={stats} />
      </section>

      {/* ─── Phase 2.5+ / M7 — Plan-mode sessions for this project ────── */}
      <section className="mb-8">
        <PlanningCard
          projectId={projectId}
          projectName={project.name}
          projectTier={project.teamTier}
          sessions={planningSessions}
          initialOpenSessionId={initialOpenPlanSessionId}
        />
      </section>

      {/* ─── Stack advisor (Stage 5) — covers generatePlan:false projects,
          which never get a plan session ─────────────────────────────────── */}
      <section className="mb-8">
        <StackAdvisorPanel projectId={project.id} />
      </section>

      {/* ─── Pending pushes ─────────────────────────────────────────────── */}
      <section className="mb-8">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <GitPullRequest className="text-muted-foreground h-4 w-4" />
                Pending pushes
                {pendingPushes.length > 0 ? (
                  <Badge tone="warn">{pendingPushes.length}</Badge>
                ) : null}
              </CardTitle>
              <CardDescription className="text-xs">
                Commits sitting on local feature branches, waiting for your push.
              </CardDescription>
            </div>
            {pendingPushes.length > 0 ? (
              <Button asChild variant="primary" size="sm">
                <Link href="/changes">
                  Review on /changes
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Button>
            ) : null}
          </CardHeader>
          <CardContent>
            {pendingPushes.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                Nothing pending. Agents push to{" "}
                <code className="bg-muted rounded px-1 font-mono text-[10px]">
                  devpilot/&lt;slug&gt;
                </code>{" "}
                branches; when one lands here, you&apos;ll see it.
              </p>
            ) : (
              <ul className="divide-y">
                {pendingPushes.map((p) => {
                  const fileCount = Array.isArray(p.files_changed) ? p.files_changed.length : 0;
                  return (
                    <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <GitBranch className="text-muted-foreground h-3.5 w-3.5" />
                        <code className="truncate font-mono">{p.branch}</code>
                        <Badge tone="muted" className="font-mono text-[10px]">
                          {p.unpushed_count ?? 0} commit
                          {(p.unpushed_count ?? 0) === 1 ? "" : "s"}
                        </Badge>
                        {fileCount > 0 ? (
                          <span className="text-muted-foreground">
                            · {fileCount} file{fileCount === 1 ? "" : "s"}
                          </span>
                        ) : null}
                      </div>
                      <Link
                        href={`/changes/${p.id}`}
                        className="text-foreground hover:underline hover:underline-offset-2"
                      >
                        Review →
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ─── Recent tickets ─────────────────────────────────────────────── */}
      <section className="mb-8">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <ListTodo className="text-muted-foreground h-4 w-4" />
                Recent tickets
              </CardTitle>
              <CardDescription className="text-xs">
                The last {RECENT_TICKET_LIMIT} tickets attached to this project.
              </CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/board">Open board →</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {tickets.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                No tickets yet. Switch the topbar to this project and file one on{" "}
                <Link href="/board" className="underline">
                  /board
                </Link>
                .
              </p>
            ) : (
              <ul className="divide-y">
                {tickets.map((t) => {
                  const tone = STATUS_TONE[t.status] ?? "muted";
                  const updated = t.updated_at ?? t.created_at;
                  const m = ticketMetrics.get(t.id);
                  // Prefer the actual role observed across runs (m.primaryRole)
                  // over the requested_role hint, since the dispatcher's
                  // state-machine path doesn't set requested_role on most tickets.
                  const roleSlug = m?.primaryRole ?? t.requested_role ?? null;
                  const roleDisplay = m?.primaryDisplay ?? t.requested_role ?? null;
                  return (
                    <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={tone} className="text-[10px] uppercase">
                            {t.status}
                          </Badge>
                          {roleSlug ? (
                            <Badge
                              tone="muted"
                              className="font-mono text-[10px]"
                              title={`Role: ${roleDisplay} (slug: ${roleSlug})`}
                            >
                              {roleSlug}
                            </Badge>
                          ) : null}
                          {m && m.totalCents > 0 ? (
                            <Badge tone="info" className="text-[10px]">
                              {formatCents(m.totalCents)}
                            </Badge>
                          ) : null}
                          {m && m.durationMs > 0 ? (
                            <span className="text-muted-foreground text-[10px]">
                              {formatDurationMs(m.durationMs)}
                            </span>
                          ) : null}
                          {m && m.runs > 1 ? (
                            <span className="text-muted-foreground text-[10px]">{m.runs} runs</span>
                          ) : null}
                          {m && m.retries > 0 ? (
                            <span className="text-warning text-[10px]">retry {m.retries}</span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 truncate text-sm">{t.title}</p>
                      </div>
                      <span className="text-muted-foreground shrink-0 text-[11px]">
                        {relativeTime(updated)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ─── Spend + role-usage analytics ──────────────────────────────── */}
      <section className="mb-8 space-y-4">
        <SpendChart series={dailySpend} />
        <RoleUsageTable rows={roleUsage} />
      </section>

      {/* ─── Settings: branch routing ──────────────────────────────────── */}
      <section className="mb-8">
        <BranchRoutingCard
          projectId={project.id}
          defaultBranch={project.defaultBranch}
          integrationBranch={project.integrationBranch}
          autoLandEnabled={project.autoLandEnabled}
          canPromote={canPromoteIntegration}
          githubOwner={project.githubOwner}
          githubRepo={project.githubRepo}
        />
      </section>

      {/* ─── Settings: deployment (Vercel) ─────────────────────────────── */}
      <section className="mb-8">
        <DeploymentCard
          projectId={project.id}
          projectName={project.name}
          githubOwner={project.githubOwner}
          githubRepo={project.githubRepo}
          defaultBranch={project.defaultBranch}
          integrationBranch={project.integrationBranch}
          autoLandEnabled={project.autoLandEnabled}
          linked={vercelStatus.linked}
          vercelProjectId={vercelStatus.vercelProjectId}
          vercelProjectName={vercelStatus.vercelProjectName}
          dashboardUrl={vercelStatus.dashboardUrl}
          state={vercelStatus.state}
          productionBranch={vercelStatus.productionBranch}
          branchIsStale={vercelStatus.branchIsStale}
          desiredBranch={project.vercelProductionBranchDesired}
          recordedMode={vercelStatus.recordedMode}
          statusError={vercelStatus.error}
          tokenConfigured={vercelTokenIsConfigured}
          deployments={deployments}
        />
      </section>

      {/* ─── Settings: agent autonomy ──────────────────────────────────── */}
      <section className="mb-8">
        <AgentAutonomyCard
          projectId={project.id}
          agentTicketCreation={project.agentTicketCreation}
          agentTicketMaxPerRun={project.agentTicketMaxPerRun}
          // What this project would get with NO override, resolved through the
          // same function the route enforces with - so the placeholder can never
          // advertise a number the cap wouldn't actually apply.
          inheritedMaxPerRun={
            resolveMaxTicketsPerRun({
              project: null,
              env: process.env.DEVPILOT_MAX_TICKETS_PER_RUN,
            }).max
          }
        />
      </section>

      {/* ─── Settings: supervision ─────────────────────────────────────── */}
      <section className="mb-8">
        <SupervisorCard projectId={project.id} supervisorEnabled={project.supervisorEnabled} />
      </section>

      {/* ─── Settings: budget cap ──────────────────────────────────────── */}
      <section className="mb-8">
        <BudgetCapCard
          projectId={project.id}
          budgetCapOverrideEnabled={project.budgetCapOverrideEnabled}
        />
      </section>

      {/* ─── Settings: team tier ───────────────────────────────────────── */}
      <section className="mb-8">
        <TeamTierCard projectId={project.id} initialTier={project.teamTier} />
      </section>

      {/* ─── Settings: LLM provider (WI-12) ────────────────────────────── */}
      <section className="mb-8">
        <LlmProviderCard
          projectId={project.id}
          initialProvider={project.llmProvider}
          initialBaseUrl={project.llmBaseUrl}
          initialModel={project.llmModel}
          // Existence only — the key itself never crosses this boundary.
          hasCredential={Boolean(project.llmCredentialRef)}
        />
      </section>
    </div>
  );
}
