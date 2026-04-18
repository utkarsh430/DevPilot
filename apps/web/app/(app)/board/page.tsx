import { Suspense } from "react";
import { requireUser, requireTenantId } from "@/lib/auth";
import { loadBoardTickets, loadTicketDependencies } from "@/lib/board/queries";
import { BoardClient } from "@/components/board/BoardClient";
import { requireActiveProjectId } from "@/lib/projects/current";
import { loadProjectById } from "@/lib/projects/load";
import { loadEffectiveCatalog } from "@/lib/roles/effective-catalog.server";
import { loadProjectAutomationState, loadTenantAutomationState } from "@/lib/automation/queries";
import { BoardSkeleton } from "./board-skeleton";

export const dynamic = "force-dynamic";

// The (app) layout already mounts the sidebar + topbar (with user menu and
// sign-out). It renders WITHOUT awaiting any board data, so the shell flushes
// to the browser first; the board's own data streams in under the <Suspense>
// boundary below (S1 — decouple shell first paint from the board query). The
// page component stays synchronous on purpose so nothing blocks that flush;
// all awaiting lives in <BoardContent>.
export default function BoardPage() {
  return (
    <Suspense fallback={<BoardSkeleton />}>
      <BoardContent />
    </Suspense>
  );
}

async function BoardContent() {
  // Auth + tenant are independent round trips — resolve them together.
  const [, tenantId] = await Promise.all([requireUser(), requireTenantId()]);
  // Project-first: a tenant with no projects is redirected to onboarding;
  // otherwise this is always a real project id (cookie → most-recent fallback).
  const activeProjectId = await requireActiveProjectId(tenantId);
  // Phase 2.5+ / M7: thread the project NAME (not just id) down to the
  // header so the PlanSheetButton can render it in the planning Sheet's
  // top strip without doing its own client-side fetch. The lookup is cheap
  // and resolves the cookie-encoded id; the board ticket query parallelizes
  // because it doesn't depend on this.
  //
  // Phase 2 / F3: also load the effective role catalog (built-ins ∪ tenant
  // custom agents) so the New Ticket dialog can offer custom roles in the
  // picker instead of forcing operators to set `requested_role` by hand.
  // Failures inside `loadEffectiveCatalog` degrade to the built-in list and
  // never throw, so this parallelizes safely.
  //
  // G2 — also load `ticket_dependencies` rows so the Graph view can render
  // the DAG without a follow-up client fetch. The loader scopes to the
  // active project (intersecting both edge endpoints) so cross-project
  // edges don't leak in.
  const [tickets, project, roleCatalog, dependencies, projectAutomation, tenantAutomation] =
    await Promise.all([
      // `tenantId` is what scopes the landing-evidence reads (pending_pushes +
      // integration_queue) behind each card's landing chip; without it the
      // loader skips them and the chips simply don't render.
      loadBoardTickets(activeProjectId, tenantId),
      loadProjectById(activeProjectId),
      loadEffectiveCatalog(tenantId),
      loadTicketDependencies(activeProjectId),
      loadProjectAutomationState(activeProjectId),
      loadTenantAutomationState(tenantId),
    ]);
  // Tenant pause masters project pause — disables the board's Pause toggle.
  const tenantPaused = tenantAutomation?.tenant.state === "paused";

  return (
    <div className="flex h-full flex-col">
      <BoardClient
        // Remount on project switch so the client re-seeds from the new
        // project's snapshot instead of briefly filtering the previous
        // project's tickets by the new id (which flashes an empty board).
        key={activeProjectId}
        tickets={tickets}
        tenantId={tenantId}
        activeProjectId={activeProjectId}
        activeProjectName={project?.name ?? null}
        roleCatalog={roleCatalog}
        dependencies={dependencies}
        automationState={projectAutomation?.state ?? "running"}
        automationPausedAt={projectAutomation?.pausedAt ?? null}
        tenantPaused={tenantPaused}
      />
    </div>
  );
}
