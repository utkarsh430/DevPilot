"use client";

// Project context tabs — GitHub-style horizontal tab strip under the top bar,
// scoped to the active project. Mirrors `settings/tabs.tsx` (border-b-2 underline
// + usePathname active states). Self-hides on non-project (global) routes so
// global pages — Projects list / Agents / Marketplace / Settings — and the
// onboarding screen render without it.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FolderGit2,
  GitBranch,
  Inbox,
  KanbanSquare,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { ChangesBadge } from "@/components/shell/changes-badge";

type Tab = { key: string; href: string; label: string; icon: LucideIcon };

// Is the current route a PROJECT-scoped surface (where the tabs belong)?
//
// A /projects/<id> overview counts even when <id> ≠ the active project: during
// a switch the cookie flips before the URL does, and matching only the active
// id would blank the whole tab strip in that window (the bug where the entire
// Overview/Board/Runs/Changes/Plans row vanishes). The global list (/projects)
// and the create flow (/projects/new) are NOT project surfaces.
function isProjectRoute(pathname: string): boolean {
  for (const base of ["/board", "/runs", "/changes", "/plan"]) {
    if (pathname === base || pathname.startsWith(base + "/")) return true;
  }
  const detail = pathname.match(/^\/projects\/([^/]+)(?:\/.*)?$/);
  return detail !== null && detail[1] !== "new";
}

export function ProjectTabs({
  activeProjectId,
  tenantId,
}: {
  activeProjectId: string | null;
  tenantId: string | null;
}) {
  const pathname = usePathname() ?? "";

  // No project (onboarding) or a global route → no tabs.
  if (!activeProjectId || !isProjectRoute(pathname)) return null;

  const tabs: Tab[] = [
    { key: "overview", href: `/projects/${activeProjectId}`, label: "Overview", icon: FolderGit2 },
    { key: "board", href: "/board", label: "Board", icon: KanbanSquare },
    { key: "runs", href: "/runs", label: "Runs", icon: Inbox },
    { key: "changes", href: "/changes", label: "Changes", icon: GitBranch },
    { key: "plans", href: "/plan", label: "Plans", icon: Sparkles },
  ];

  const isActive = (t: Tab): boolean => pathname === t.href || pathname.startsWith(t.href + "/");

  return (
    <div className="bg-background/60 border-b">
      <nav className="flex items-end overflow-x-auto px-4">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = isActive(t);
          return (
            <Link
              key={t.key}
              href={t.href}
              className={cn(
                "-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors",
                active
                  ? "border-primary text-foreground font-semibold"
                  : "text-muted-foreground hover:text-foreground hover:border-border border-transparent font-medium",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {t.label}
              {t.key === "changes" && tenantId ? (
                <ChangesBadge tenantId={tenantId} activeProjectId={activeProjectId} />
              ) : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
