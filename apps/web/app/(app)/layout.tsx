// Authenticated app shell (GitHub-style). Wraps every page under (app)/* with
// the top bar (☰ global drawer + logo + project switcher) and a project tab
// strip; each page handler focuses on its own content. Pages stay reachable at
// their original URLs — the (app) segment is a route group, not a URL prefix.

import { redirect } from "next/navigation";
import { getUser, getCurrentTenantId } from "@/lib/auth";
import { TopBar } from "@/components/shell/topbar";
import { ProjectTabs } from "@/components/shell/project-tabs";
import { NotificationsProvider } from "@/components/shell/notifications-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getCurrentProjectIdFromCookie, pickActiveProjectId } from "@/lib/projects/current";
import { loadShellBootstrap } from "@/lib/shell/bootstrap";
import { ReconnectBanner } from "@/components/shell/reconnect-banner";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect("/login");

  const initial = (user.email?.match(/^([a-z0-9])/i)?.[1] ?? "?").toUpperCase();

  // Phase 2 / M5 — fetch the project-switcher payload + active-project cookie
  // for the topbar dropdown and the sidebar's Changes badge. Both surfaces are
  // tenant-scoped; we resolve the tenant once here so individual segments don't
  // re-query.
  const tenantId = await getCurrentTenantId();
  // Everything the shell needs from the database - the topbar payload
  // (project switcher, notifications bell + toast seed, health dot, automation
  // switch), the runner-disconnected banner, and the readiness-checklist seed -
  // comes back in ONE round trip via `loadShellBootstrap` (the `shell_bootstrap`
  // SQL function). It replaces the former ~9-query parallel batch; the only
  // remaining hops are the two auth lookups above plus the active-project
  // cookie read (no DB). The returned field shapes match the individual loaders
  // exactly, so the component props below are unchanged.
  const [bootstrap, cookieProjectId] = await Promise.all([
    loadShellBootstrap(user.id, tenantId),
    getCurrentProjectIdFromCookie(),
  ]);
  const {
    projects,
    initialNotifications,
    automation,
    disconnected,
    systemHealth,
    githubConnected,
    firstRunDone,
  } = bootstrap;
  const activeProjectId = pickActiveProjectId(projects, cookieProjectId);
  // The project switcher is a GLOBAL control — it renders in the top bar, and
  // only when the tenant has projects to switch between (otherwise onboarding).
  const projectSwitcher =
    projects.length > 0
      ? { activeId: activeProjectId, projects: projects.map((p) => ({ id: p.id, name: p.name })) }
      : undefined;

  return (
    <TooltipProvider delayDuration={150}>
      <NotificationsProvider userId={user.id} initial={initialNotifications}>
        <div className="flex h-screen w-full flex-col overflow-hidden">
          <TopBar
            user={{ email: user.email, initial }}
            tenantId={tenantId}
            projectSwitcher={projectSwitcher}
            systemHealth={systemHealth}
            readiness={{ githubConnected, firstRunDone }}
            automation={
              automation
                ? {
                    tenantId: automation.tenantId,
                    state: automation.tenant.state,
                    pausedAt: automation.tenant.pausedAt,
                  }
                : null
            }
          />
          <ProjectTabs activeProjectId={activeProjectId} tenantId={tenantId} />
          {disconnected.count > 0 ? (
            <ReconnectBanner
              count={disconnected.count}
              sampleTitles={disconnected.sampleTitles}
              mostRecentPausedAt={disconnected.mostRecentPausedAt}
            />
          ) : null}
          <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        </div>
        <Toaster />
      </NotificationsProvider>
    </TooltipProvider>
  );
}
