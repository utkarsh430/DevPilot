// Plans page — planning sessions for the ACTIVE project.
//
// Project-scoped (like Board / Runs / Changes): reads recent planning_sessions
// for the selected project and hands them to <PlanHistoryList /> for the
// "Resume" interaction. The project detail page's PlanningCard shows the same
// sessions inline; this is the project-nav entry point for them.

import { Sparkles } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { requireActiveProjectId } from "@/lib/projects/current";
import { supabaseServer } from "@/lib/db/server";
import type { PlanSession, PlanStatus, StackFlavor } from "@/lib/plan/types";
import { PlanHistoryList, type PlanHistoryRow } from "./history-list";

export const dynamic = "force-dynamic";

type Row = {
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
  // The generated types model an embedded selection as an array, but PostgREST
  // returns a single OBJECT for a to-one embed like this one - so both shapes
  // have to be accepted, and reading only `[0]` resolved to `undefined` for
  // EVERY row. With `!inner` there is always a project, so "(unknown project)"
  // was unreachable-by-design and printed on every plan in the list.
  projects: { name: string }[] | { name: string } | null;
};

/** The embedded project's name, tolerating either PostgREST embed shape. */
function embeddedProjectName(projects: Row["projects"]): string | null {
  if (!projects) return null;
  const one = Array.isArray(projects) ? projects[0] : projects;
  return one?.name ?? null;
}

export default async function PlanHistoryPage() {
  // Auth + tenant are independent round trips — resolve them together.
  const [, tenantId] = await Promise.all([requireUser(), requireTenantId()]);
  // Project-first: redirects to onboarding if the tenant has no projects;
  // otherwise scope plans to the active project.
  const activeProjectId = await requireActiveProjectId(tenantId);
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("planning_sessions")
    .select(
      "id, tenant_id, project_id, created_by, goal_summary, status, stack_flavor, stack_preferences, spent_cents, billed_at, created_at, updated_at, projects!inner ( name )",
    )
    .eq("project_id", activeProjectId)
    .order("updated_at", { ascending: false })
    .limit(50);

  const rows: PlanHistoryRow[] = ((data ?? []) as Row[]).map((r) => ({
    session: {
      id: r.id,
      tenantId: r.tenant_id,
      projectId: r.project_id,
      createdBy: r.created_by,
      goalSummary: r.goal_summary,
      status: r.status,
      stackFlavor: r.stack_flavor,
      stackPreferences: r.stack_preferences ?? "",
      spentCents: r.spent_cents ?? 0,
      billedAt: r.billed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    } satisfies PlanSession,
    projectName: embeddedProjectName(r.projects) ?? "(unknown project)",
  }));

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-6 flex items-center gap-2">
        <Sparkles className="text-chart-1 h-5 w-5" />
        <div>
          <h1 className="font-display text-xl font-bold tracking-tight">Plans</h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Planning sessions for this project. The panel keeps running server-side while
            you&apos;re away — open the bell when it finishes.
          </p>
        </div>
      </header>
      <PlanHistoryList rows={rows} />
    </div>
  );
}
