"use client";

// Phase 2 / M5a — Sidebar project switcher (project-first redesign).
//
// Props (from the app layout):
//   - initial.projects  — every project in the caller's tenant.
//   - initial.activeId  — the resolved active project id (cookie reconciled
//                         against the live list; always one of `projects`).
//
// The dropdown is PURE SELECTION: it lists the tenant's projects with the
// active one checked, and nothing else. Creating + managing projects lives on
// the /projects page (reached from the sidebar "Projects" nav item), so the
// menu no longer mixes "which project am I in" with "manage my projects".
// "All projects" mode was removed — the app always operates inside one project.
//
// On select → setActiveProjectAction (writes the cookie + revalidates the
// layout) → then either navigate to a surface valid for the new project (when
// the current URL is pinned to the old one, e.g. /projects/<id> or a
// /runs|/changes detail) or router.refresh() in place, so the rest of the shell
// (board / changes / runs) re-reads the cookie and re-scopes. The layout hides
// this switcher entirely when the tenant has no projects (onboarding).

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronsUpDown, FolderGit2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { setActiveProjectAction } from "@/app/(app)/projects/actions";

export type ProjectSwitcherItem = {
  id: string;
  name: string;
};

export type ProjectSwitcherProps = {
  initial: {
    activeId: string | null;
    projects: ProjectSwitcherItem[];
  };
  /** "topbar" keeps the compact, max-width trigger.
   *  "sidebar" stretches the trigger to fill the rail row. */
  variant?: "topbar" | "sidebar";
};

const TRUNCATE_AT = 24;

function truncate(s: string): string {
  return s.length > TRUNCATE_AT ? s.slice(0, TRUNCATE_AT - 1) + "…" : s;
}

// Where to land after switching to `newProjectId`, given the current path.
// Returns a URL to navigate to, or null to just refresh in place.
//
// The active project lives in a cookie, not the URL, so most project-scoped
// surfaces (/board, /runs, /changes, /plan) re-scope on a plain refresh. Two
// kinds of route are pinned to a SPECIFIC project by their URL, though, and
// would otherwise show the old project (or 404) after a switch:
//   • /projects/<oldId>[/...]   → jump to the new project's overview.
//   • /runs/<id>, /changes/<id> → the id belongs to the old project and can't
//                                  exist under the new one; bounce to the list.
function switchTarget(pathname: string, newProjectId: string): string | null {
  const projectDetail = pathname.match(/^\/projects\/([^/]+)(?:\/.*)?$/);
  if (projectDetail && projectDetail[1] !== "new") {
    return `/projects/${newProjectId}`;
  }
  for (const base of ["/runs", "/changes"]) {
    if (pathname.startsWith(base + "/")) return base;
  }
  return null;
}

export function ProjectSwitcher({ initial, variant = "topbar" }: ProjectSwitcherProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const [pendingId, setPendingId] = React.useState<string | undefined>(undefined);
  const [open, setOpen] = React.useState(false);

  // The active project is server truth (cookie → resolved in the layout and
  // handed down as `initial.activeId`). Derive the highlight straight from the
  // prop instead of holding a local copy, so a switch made elsewhere (the ☰
  // drawer) reflects here after the refresh rather than going stale.
  const activeId = initial.activeId;
  const active = React.useMemo(
    () => initial.projects.find((p) => p.id === activeId) ?? null,
    [initial.projects, activeId],
  );

  // If the cookie names a project that no longer exists, the lookup misses;
  // show a neutral label rather than a stale name. The next switch reconciles.
  const triggerLabel = active ? truncate(active.name) : "Select project";

  async function onPick(projectId: string) {
    if (projectId === activeId) {
      setOpen(false);
      return;
    }
    setPendingId(projectId);
    const res = await setActiveProjectAction({ projectId });
    if (!res.ok) {
      setPendingId(undefined);
      setOpen(false);
      toast.error("Couldn't switch project", { description: res.error });
      return;
    }
    setOpen(false);
    const name = truncate(initial.projects.find((p) => p.id === projectId)?.name ?? "project");
    // Land on a surface that's valid for the NEW project. Project-detail and
    // per-resource URLs (/runs/<id>, /changes/<id>) are pinned to the old
    // project, so navigate; top-level surfaces just re-scope on refresh. The
    // server action already revalidated the layout, so either path re-reads the
    // new cookie across the whole shell.
    const target = switchTarget(pathname, projectId);
    if (target) router.push(target);
    else router.refresh();
    setPendingId(undefined);
    toast.success(`Switched to ${name}`);
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Switch project"
          className={cn("gap-2", variant === "sidebar" ? "w-full justify-start" : "max-w-[200px]")}
        >
          <FolderGit2 className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate text-left">{triggerLabel}</span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64"
        // Stop the trigger from re-stealing focus while the user is mid-tap.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuLabel className="text-muted-foreground text-[10px] uppercase tracking-wide">
          Projects
        </DropdownMenuLabel>

        <div className="max-h-[40vh] overflow-y-auto">
          {initial.projects.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onSelect={(e) => {
                e.preventDefault();
                void onPick(p.id);
              }}
              className="cursor-pointer"
            >
              <SwitcherRow
                label={p.name}
                icon={<FolderGit2 className="text-muted-foreground h-3.5 w-3.5" />}
                selected={activeId === p.id}
                pending={pendingId === p.id}
              />
            </DropdownMenuItem>
          ))}
        </div>

        {initial.projects.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-center text-xs italic">
            No projects yet.
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SwitcherRow({
  label,
  icon,
  selected,
  pending,
}: {
  label: string;
  icon: React.ReactNode;
  selected: boolean;
  pending: boolean;
}) {
  return (
    <div className="flex w-full items-center gap-2">
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{label}</p>
      </div>
      <span className="shrink-0">
        {pending ? (
          <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
        ) : selected ? (
          <Check className={cn("text-foreground h-3.5 w-3.5")} />
        ) : null}
      </span>
    </div>
  );
}
