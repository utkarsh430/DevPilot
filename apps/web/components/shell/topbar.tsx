"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  Check,
  ChevronDown,
  Cpu,
  FolderGit2,
  Loader2,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Palette,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Sun,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { THEMES, useTheme } from "@/components/shell/theme-provider";
import { GLOBAL_NAV, NAV_GROUPS } from "@/components/shell/nav-config";
import { ProjectSwitcher, type ProjectSwitcherItem } from "@/components/shell/project-switcher";
import { DevPilotLogo, DevPilotMark } from "@/components/shell/devpilot-mark";
import { SystemStatus } from "@/components/shell/system-status";
import type { SystemHealthSnapshot } from "@/lib/health/types";
import { NotificationsBell } from "@/components/shell/notifications-bell";
import { ReadinessChecklist, type ReadinessSeed } from "@/components/shell/readiness-checklist";
import { AutomationToggle } from "@/components/shell/automation-toggle";
import { ActivityIndicator } from "@/components/shell/activity-indicator";
import { toast } from "@/components/ui/sonner";
import { setActiveProjectAction } from "@/app/(app)/projects/actions";

export type TopBarUser = {
  email: string | null;
  initial: string;
};

export type TopBarAutomation = {
  tenantId: string;
  state: "running" | "paused";
  pausedAt: string | null;
};

export type TopBarProjectSwitcher = {
  activeId: string | null;
  projects: ProjectSwitcherItem[];
};

/** Active-state test for a global nav link. `/projects` (the list) matches only
 *  itself + the create flow — NOT `/projects/[id]`, which is a project's
 *  overview owned by the project tabs. */
function isGlobalNavActive(href: string, pathname: string): boolean {
  if (href === "/projects") return pathname === "/projects" || pathname === "/projects/new";
  return pathname === href || pathname.startsWith(href + "/");
}

export function TopBar({
  user,
  tenantId,
  automation,
  projectSwitcher,
  systemHealth,
  readiness,
}: {
  user: TopBarUser;
  /** Current tenant — powers the ambient agent-activity indicator, which is
   *  tenant-wide (every project) rather than scoped to the active one. Passed
   *  separately from `automation` because that prop is nullable for an
   *  unrelated reason and activity must not go dark when it is absent.
   *  Null for a session with no resolved tenant; the indicator renders nothing,
   *  which is already its idle state. */
  tenantId: string | null;
  automation: TopBarAutomation | null;
  /** Global control — present only when the tenant has ≥1 project. */
  projectSwitcher?: TopBarProjectSwitcher;
  /** Server-rendered seed for the always-visible system-health dot. */
  systemHealth?: SystemHealthSnapshot;
  /** Server-rendered seed for the onboarding readiness checklist (A4). The
   *  other two checks come from props already here: project presence from
   *  `projectSwitcher`, runner state from `systemHealth`. */
  readiness?: ReadinessSeed | null;
}) {
  const [commandOpen, setCommandOpen] = React.useState(false);

  // ⌘K / Ctrl-K opens the palette.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCommandOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-3 backdrop-blur sm:px-4">
      {/* Global drawer (hamburger) + brand. The project switcher lives in the
          right cluster (see below). */}
      <GlobalDrawer projectSwitcher={projectSwitcher} automation={automation} />
      <Link
        href="/board"
        className="chrome-no-select flex items-center gap-2 transition-opacity hover:opacity-80"
        aria-label="DevPilot home"
      >
        <DevPilotMark className="h-[18px] w-[18px] sm:hidden" />
        <DevPilotLogo className="hidden h-[22px] sm:inline-flex" alt="" />
      </Link>
      <div className="ml-auto flex items-center gap-2">
        {/* Command palette trigger */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCommandOpen(true)}
          className="text-muted-foreground hidden gap-2 md:inline-flex"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden lg:inline">Quick jump…</span>
          <span className="ml-2 flex items-center gap-0.5">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setCommandOpen(true)}
          className="md:hidden"
        >
          <Search className="h-4 w-4" />
        </Button>

        {/* Project switcher — topbar far-right, just left of the account
            controls. Separated from them by a thin divider so project context
            still reads distinctly from notifications / theme / account. */}
        {projectSwitcher ? <ProjectSwitcher initial={projectSwitcher} variant="topbar" /> : null}
        {projectSwitcher ? (
          <div className="bg-border mx-0.5 hidden h-5 w-px sm:block" aria-hidden />
        ) : null}

        {/* Ambient agent activity — renders NOTHING when nothing is running,
            so it costs no chrome on an idle workspace. Placed beside the health
            dot because both answer "what is the system doing", and deliberately
            NOT beside the automation toggle, which answers the different
            question of whether the system is allowed to work at all. */}
        <ActivityIndicator tenantId={tenantId} />

        {readiness && systemHealth ? (
          <ReadinessChecklist
            seed={readiness}
            hasProject={Boolean(projectSwitcher)}
            healthInitial={systemHealth}
          />
        ) : null}
        {systemHealth ? <SystemStatus initial={systemHealth} /> : null}
        <NotificationsBell />
        <ThemeToggle />
        <UserMenu user={user} />
      </div>

      <CommandPalette open={commandOpen} setOpen={setCommandOpen} />
    </header>
  );
}

// ── Global drawer — the ☰ slide-out (GitHub-style). Holds the tenant-level nav
//    (Projects / Agents / Marketplace / Settings) plus a "Your projects" list
//    that switches the active project on click. Shown on every viewport.
function GlobalDrawer({
  projectSwitcher,
  automation,
}: {
  projectSwitcher?: TopBarProjectSwitcher;
  automation: TopBarAutomation | null;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const [open, setOpen] = React.useState(false);
  const [switching, setSwitching] = React.useState<string | null>(null);

  async function switchProject(id: string) {
    if (id === projectSwitcher?.activeId) {
      setOpen(false);
      router.push("/board");
      return;
    }
    setSwitching(id);
    const res = await setActiveProjectAction({ projectId: id });
    setSwitching(null);
    setOpen(false);
    if (!res.ok) {
      toast.error("Couldn't switch project", { description: res.error });
      return;
    }
    router.push("/board");
    router.refresh();
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Open menu">
          <Menu className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-72 flex-col p-0">
        <SheetHeader className="border-b px-4 py-3 text-left">
          <SheetTitle className="text-sm">Menu</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-0.5 p-3">
          {GLOBAL_NAV.map((item) => {
            const Icon = item.icon;
            const active = isGlobalNavActive(item.href, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </div>

        {projectSwitcher && projectSwitcher.projects.length > 0 ? (
          <div className="border-t p-3">
            <div className="text-muted-foreground px-2.5 pb-1.5 text-[10px] font-medium uppercase tracking-wider">
              Your projects
            </div>
            <div className="flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto">
              {projectSwitcher.projects.map((p) => {
                const isCurrent = p.id === projectSwitcher.activeId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => void switchProject(p.id)}
                    disabled={switching !== null}
                    className={cn(
                      "hover:bg-accent hover:text-accent-foreground flex h-9 items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors disabled:opacity-60",
                      isCurrent ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <FolderGit2 className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate">{p.name}</span>
                    {switching === p.id ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    ) : isCurrent ? (
                      <Check className="h-3.5 w-3.5 shrink-0" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {automation ? (
          <div className="mt-auto border-t p-3">
            <div className="text-muted-foreground mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wider">
              Automation
            </div>
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-muted-foreground text-xs">
                {automation.state === "paused" ? "Workspace paused" : "Pause all projects"}
              </span>
              <AutomationToggle
                scope="tenant"
                scopeId={automation.tenantId}
                initialState={automation.state}
                initialPausedAt={automation.pausedAt}
              />
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Pick a theme">
          <Palette className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as never)}>
          {THEMES.map((t) => {
            const SysIcon =
              t.value === "light"
                ? Sun
                : t.value === "dark"
                  ? Moon
                  : t.value === "system"
                    ? Monitor
                    : null;
            return (
              <DropdownMenuRadioItem key={t.value} value={t.value} className="pr-2">
                <span className="flex flex-1 items-center gap-2">
                  {t.swatch ? (
                    <span
                      className="border-border/60 inline-flex h-4 w-4 overflow-hidden rounded-sm border"
                      aria-hidden
                    >
                      <span className="h-full w-1/2" style={{ background: t.swatch.bg }} />
                      <span className="h-full w-1/2" style={{ background: t.swatch.fg }} />
                    </span>
                  ) : SysIcon ? (
                    <SysIcon className="h-3.5 w-3.5" />
                  ) : null}
                  <span className="text-xs">{t.label}</span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/appearance" className="text-muted-foreground text-xs">
            Customize in Appearance settings →
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({ user }: { user: TopBarUser }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 pl-1.5 pr-2">
          <Avatar className="h-6 w-6">
            <AvatarFallback className="text-[10px]">{user.initial}</AvatarFallback>
          </Avatar>
          <span className="hidden max-w-[120px] truncate text-xs sm:inline">
            {user.email ?? "anonymous"}
          </span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col">
            <span className="text-muted-foreground text-xs">Signed in as</span>
            <span className="truncate text-sm font-medium">{user.email ?? "anonymous"}</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <SettingsIcon className="mr-2 h-3.5 w-3.5" /> Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href="/auth/signout">
            <LogOut className="mr-2 h-3.5 w-3.5" /> Sign out
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CommandPalette({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="top"
        className="top-[12vh] mx-auto h-auto max-w-xl rounded-md border p-0 sm:max-w-xl"
      >
        {/* Radix Dialog requires a Title (and warns without a Description) for
            screen-reader users. The palette is visual-first, so render both
            sr-only rather than showing them. */}
        <SheetTitle className="sr-only">Quick jump</SheetTitle>
        <SheetDescription className="sr-only">
          Search pages, actions, and roles, then press Enter to navigate.
        </SheetDescription>
        <Command>
          <CommandInput placeholder="Jump to…  (page, action, role)" />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            {NAV_GROUPS.map((g) => (
              <CommandGroup key={g.label} heading={g.label}>
                {g.items.map((i) => {
                  const Icon = i.icon;
                  return (
                    <CommandItem
                      key={i.href}
                      onSelect={() => {
                        setOpen(false);
                        if (typeof window !== "undefined") window.location.href = i.href;
                      }}
                    >
                      <Icon /> {i.label}
                      {i.shortcut && <CommandShortcut>G {i.shortcut}</CommandShortcut>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
            <CommandSeparator />
            <CommandGroup heading="Actions">
              <CommandItem
                onSelect={() => {
                  setOpen(false);
                  window.location.href = "/agents/new";
                }}
              >
                <Sparkles /> Create role from JD
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setOpen(false);
                  window.location.href = "/builder";
                }}
              >
                <Cpu /> New workflow in Builder
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </SheetContent>
    </Sheet>
  );
}
