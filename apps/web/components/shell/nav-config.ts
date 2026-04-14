// Sidebar nav config — the single source of truth for left-rail entries.
//
// Add a new page by adding an entry here; the sidebar + command palette pick
// it up automatically. Groups keep related surfaces together; icons come from
// lucide-react.
//
// IA model — two-level navigation (Supabase/Vercel style):
//   - GLOBAL_NAV (Projects / Agents / Marketplace) + the project switcher live
//     in the TOP BAR: tenant-level, "where am I in the workspace".
//   - PROJECT_NAV (Board / Runs / Changes / Plans) lives in the LEFT SIDEBAR,
//     scoped to the active project; the sidebar header is the project's
//     overview (/projects/[id]).
//   - "Builder" and "New role from JD" are create-flows, surfaced as actions
//     on /agents and in the ⌘K palette, not as primary destinations.
//   - Account/tenant settings (API keys, Billing, GitHub) live under /settings
//     and are reached via the avatar menu in the topbar.

import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Bot,
  FolderGit2,
  GitBranch,
  GraduationCap,
  Inbox,
  KanbanSquare,
  Settings,
  ShoppingBag,
  Sparkles,
  Trophy,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Optional short keyboard hint (used in the command palette). */
  shortcut?: string;
  /** Optional badge — string label or numeric count for "new" surfaces. */
  badge?: string;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

// Global / tenant-level destinations — rendered in the TOP BAR (horizontal),
// alongside the project switcher. Not tied to any one project.
export const GLOBAL_NAV: NavItem[] = [
  { href: "/projects", label: "Projects", icon: FolderGit2 },
  { href: "/agents", label: "Agents", icon: Bot, shortcut: "A" },
  { href: "/learnings", label: "Lessons", icon: GraduationCap },
  { href: "/scoreboard", label: "Scoreboard", icon: Trophy },
  { href: "/marketplace", label: "Marketplace", icon: ShoppingBag },
  { href: "/guide", label: "Guide", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];

// Project-scoped work surfaces — rendered in the LEFT SIDEBAR, scoped to the
// active project via the devpilot_active_project_id cookie.
export const PROJECT_NAV: NavItem[] = [
  { href: "/board", label: "Board", icon: KanbanSquare, shortcut: "B" },
  { href: "/runs", label: "Runs", icon: Inbox, shortcut: "R" },
  { href: "/changes", label: "Changes", icon: GitBranch, shortcut: "C" },
  { href: "/plan", label: "Plans", icon: Sparkles, shortcut: "P" },
];

// Grouped view (Workspace + Project) for the ⌘K command palette and the mobile
// drawer, which show both scopes at once. The desktop chrome splits them: the
// top bar renders GLOBAL_NAV, the sidebar renders PROJECT_NAV.
export const NAV_GROUPS: NavGroup[] = [
  { label: "Workspace", items: GLOBAL_NAV },
  { label: "Project", items: PROJECT_NAV },
];

// Flat list — used by the command palette and breadcrumb resolver.
export const NAV_FLAT: NavItem[] = [...GLOBAL_NAV, ...PROJECT_NAV];

// Friendly labels for top-of-page breadcrumb resolution. Add patterns here as
// the route surface grows. Includes routes not in the sidebar so direct visits
// (settings, project detail, create flows) still render readable crumbs.
export const BREADCRUMB_LABELS: Record<string, string> = {
  "/board": "Board",
  "/runs": "Runs",
  "/agents": "Agents",
  "/agents/new": "Create role",
  "/builder": "Agent builder",
  "/marketplace": "Marketplace",
  "/guide": "Guide",
  "/settings": "Settings",
  "/settings/api-keys": "API keys",
  "/settings/platform-secrets": "Platform secrets",
  "/settings/notifications": "Notifications",
  "/settings/agent-preferences": "Agent preferences",
  "/learnings": "Lessons",
  "/scoreboard": "Scoreboard",
  "/settings/billing": "Billing",
  "/settings/github-integration": "GitHub integration",
  "/settings/system-health": "System health",
  "/projects": "Projects",
  "/projects/new": "New project",
  "/changes": "Changes",
  "/plan": "Plans",
};
