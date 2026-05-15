// Phase 2 / M5c — `/changes` list page.
//
// Server shell: auth gate, resolve the active project from the cookie
// (A4 produces `getCurrentProjectIdFromCookie`), load the initial pending
// pushes for the tenant + (optional) project filter, then hand off to the
// live client.
//
// The list itself is rendered by `<ChangesListClient>` which subscribes to
// realtime via `useLivePendingPushes`. We pass `tenantId` + `activeProjectId`
// down so the hook can scope its channel + filter without re-reading the
// session.

import { GitBranch } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { requireActiveProjectId } from "@/lib/projects/current";
import { ChangesListClient, type ChangesListItem } from "./changes-list-client";

export const dynamic = "force-dynamic";

// Shape returned by the initial-load query. We snake_case the columns straight
// from PostgREST and the client maps them into `ChangesListItem`. The join on
// `tickets` is left-side because a pending push may not be tied to a ticket
// (e.g. a future ad-hoc commit flow); the join on `projects` is left-side too
// for the same defensive reason though every present row has a project.
type Raw = {
  id: string;
  tenant_id: string;
  project_id: string;
  ticket_id: string | null;
  branch: string;
  unpushed_count: number | null;
  pushed_at: string | null;
  files_changed: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }> | null;
  head_sha: string | null;
  created_at: string;
  updated_at: string;
  projects: { id: string; name: string } | null;
  tickets: { id: string; title: string | null } | null;
};

export default async function ChangesPage() {
  await requireUser();
  const tenantId = await requireTenantId();
  // Project-first: redirects to onboarding if the tenant has no projects;
  // otherwise always a real project id, so /changes scopes to one project.
  const activeProjectId = await requireActiveProjectId(tenantId);

  const supabase = supabaseService();
  const { data } = await supabase
    .from("pending_pushes")
    .select(
      "id, tenant_id, project_id, ticket_id, branch, unpushed_count, pushed_at, files_changed, head_sha, created_at, updated_at, projects:project_id (id, name), tickets:ticket_id (id, title)",
    )
    .eq("tenant_id", tenantId)
    .is("pushed_at", null)
    .eq("project_id", activeProjectId)
    .order("updated_at", { ascending: false });

  const rawRows = ((data as unknown) ?? []) as Raw[];
  const items: ChangesListItem[] = rawRows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectName: row.projects?.name ?? "Unknown project",
    ticketId: row.ticket_id,
    ticketTitle: row.tickets?.title ?? null,
    branch: row.branch,
    unpushedCount: row.unpushed_count ?? 0,
    filesChanged: Array.isArray(row.files_changed) ? row.files_changed : [],
    updatedAt: row.updated_at,
  }));

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wider">
            <GitBranch className="h-3.5 w-3.5" />
            Review queue
          </div>
          <h1 className="font-display mt-1 text-2xl font-bold tracking-tight">Changes</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Agents commit locally on{" "}
            <code className="bg-muted rounded px-1 font-mono text-xs">devpilot/&lt;slug&gt;</code>{" "}
            branches. Review the diff and push when you&apos;re happy.
          </p>
        </div>
      </header>

      <ChangesListClient
        initialItems={items}
        tenantId={tenantId}
        activeProjectId={activeProjectId}
      />
    </div>
  );
}
