"use client";

// Topbar readiness checklist (design-review A4). The welcome screen's four
// onboarding checks — GitHub / project / runner / first run — as a compact,
// durable topbar entry, so the guidance stays reachable after welcome starts
// redirecting to the board (the moment a project + runner exist, the hardest
// remaining step, the first run, is still ahead).
//
// Lifecycle:
//   • renders only while the checklist is incomplete AND not dismissed;
//   • completing all four hides it permanently (`devpilot:readiness:complete`);
//   • "Dismiss" hides it permanently too (`devpilot:readiness:dismissed`);
//   • live state: seeded server-side (zero layout shift on load), then
//     re-fetched from /api/onboarding/readiness on popover open, on tab
//     focus, and on a background poll while incomplete — so a runner coming
//     online flips its tick without a reload.
//
// Visual language mirrors StepCard (components/setup/step-card.tsx) at
// popover scale: numbered circles that flip to success checks.

import * as React from "react";
import Link from "next/link";
import { Check, ListChecks } from "lucide-react";
import { cn } from "@/lib/cn";
import { getItemWithLegacy } from "@/lib/storage/legacy-key";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  readinessChecks,
  readinessComplete,
  readinessDoneCount,
  runnerConnectedFromHealth,
  type ReadinessSnapshot,
} from "@/lib/onboarding/readiness";
import type { SystemHealthSnapshot } from "@/lib/health/types";

export type ReadinessSeed = { githubConnected: boolean; firstRunDone: boolean };

// Operator UI state lives under the `devpilot:*` localStorage namespace. Both
// flags are shown-once, so they read through to their pre-rename `ace:*` key
// (lib/storage/legacy-key.ts) — a plain rename would resurrect a checklist the
// operator already dismissed.
const DISMISSED_KEY = "devpilot:readiness:dismissed";
const COMPLETE_KEY = "devpilot:readiness:complete";
const LEGACY_DISMISSED_KEY = "ace:readiness:dismissed";
const LEGACY_COMPLETE_KEY = "ace:readiness:complete";

// Matches DOT_POLL_MS in use-system-health — the runner watchdog threshold is
// 60s, so a faster checklist poll wouldn't learn anything sooner.
const POLL_MS = 60_000;

function readHiddenFlag(): boolean {
  try {
    return (
      getItemWithLegacy(DISMISSED_KEY, LEGACY_DISMISSED_KEY) === "1" ||
      getItemWithLegacy(COMPLETE_KEY, LEGACY_COMPLETE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

export function ReadinessChecklist({
  seed,
  hasProject,
  healthInitial,
}: {
  seed: ReadinessSeed;
  hasProject: boolean;
  healthInitial: SystemHealthSnapshot;
}) {
  const initial: ReadinessSnapshot = {
    githubConnected: seed.githubConnected,
    hasProject,
    runnerConnected: runnerConnectedFromHealth(healthInitial),
    expectsLocalRunner: healthInitial.expectsLocalRunner,
    firstRunDone: seed.firstRunDone,
  };
  // A client fetch is always fresher than the SSR seed; once one lands it wins.
  const [fetched, setFetched] = React.useState<ReadinessSnapshot | null>(null);
  const snapshot = fetched ?? initial;
  const complete = readinessComplete(snapshot);

  const [open, setOpen] = React.useState(false);
  // `hidden` mirrors the localStorage flags. It starts false so SSR + first
  // client render agree (localStorage is client-only); the inline script
  // below hides the DOM node pre-paint for dismissed users, so flipping the
  // state after mount never causes a visible flash or layout shift.
  const [hidden, setHidden] = React.useState(false);
  React.useEffect(() => {
    if (readHiddenFlag()) setHidden(true);
  }, []);

  // Completing all four checks retires the checklist permanently — even if a
  // check later regresses (e.g. the runner goes offline), the system-health
  // dot owns that story, not onboarding.
  React.useEffect(() => {
    if (!complete) return;
    try {
      localStorage.setItem(COMPLETE_KEY, "1");
    } catch {
      // Ignore — the checklist just re-hides on the next complete snapshot.
    }
    setHidden(true);
  }, [complete]);

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/onboarding/readiness", { cache: "no-store" });
      if (!res.ok) return;
      setFetched((await res.json()) as ReadinessSnapshot);
    } catch {
      // Keep the last good snapshot on a transient fetch failure.
    }
  }, []);

  // Background poll while the checklist is live, gated on tab visibility
  // (same pattern as use-system-health).
  React.useEffect(() => {
    if (hidden || complete) return;
    const tick = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    const timer = setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hidden, complete, refresh]);

  function dismiss() {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Ignore — worst case the checklist reappears next load.
    }
    setOpen(false);
    setHidden(true);
  }

  // Fully onboarded tenants render nothing on the server AND the client, so
  // the steady state costs no topbar space at all.
  if (complete || hidden) return null;

  const [githubDone, projectDone, runnerDone, firstRunDone] = readinessChecks(snapshot);
  const done = readinessDoneCount(snapshot);

  const items: {
    title: string;
    done: boolean;
    hint?: string;
    cta?: { label: string; href: string };
  }[] = [
    {
      title: "Connect GitHub",
      done: githubDone,
      cta: { label: "Connect", href: "/settings/github-integration" },
    },
    {
      title: "Create your first project",
      done: projectDone,
      // next=/welcome returns to onboarding so the runner step isn't skipped
      // (same routing as the welcome screen).
      cta: { label: "Create", href: "/projects/new?next=%2Fwelcome" },
    },
    {
      title: "Connect your runner",
      done: runnerDone,
      hint: !snapshot.expectsLocalRunner
        ? "Not needed — this tenant runs on the API runner."
        : undefined,
      // The welcome screen hosts the guided runner step (command + live
      // health) once a project exists.
      cta: { label: "Set up", href: "/welcome" },
    },
    {
      title: "Finish your first run",
      done: firstRunDone,
      hint: firstRunDone ? undefined : "Dispatch a ticket and watch the crew take it to Done.",
      cta: { label: "Open board", href: "/board" },
    },
  ];

  return (
    // display:contents wrapper — exists only so the pre-hydration script can
    // hide the trigger for dismissed users before first paint (localStorage
    // isn't readable during SSR). suppressHydrationWarning: that script adds
    // a style attribute React didn't render.
    <div className="contents" suppressHydrationWarning>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) void refresh();
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 px-2.5"
            aria-label={`Setup checklist: ${done} of 4 steps complete`}
          >
            <ListChecks className="text-primary h-3.5 w-3.5" />
            <span className="font-mono text-[11px] tabular-nums">{done}/4</span>
            <span className="hidden text-xs lg:inline">Get started</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-80 p-0">
          <div className="border-b px-3 py-2">
            <div className="text-sm font-medium">Get started with DevPilot</div>
            <p className="text-muted-foreground mt-0.5 text-[11px]">
              {4 - done} step{4 - done === 1 ? "" : "s"} left before your crew runs end to end.
            </p>
          </div>
          <ol className="divide-y">
            {items.map((item, i) => (
              <li key={item.title} className="flex items-start gap-2.5 px-3 py-2.5">
                <span
                  className={cn(
                    "mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] font-semibold",
                    item.done
                      ? "border-success/40 bg-success/10 text-success"
                      : "border-border bg-muted text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {item.done ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "text-xs font-medium",
                      item.done ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {item.title}
                    <span className="sr-only">{item.done ? " — done" : " — to do"}</span>
                  </div>
                  {item.hint ? (
                    <p className="text-muted-foreground mt-0.5 text-[11px]">{item.hint}</p>
                  ) : null}
                </div>
                {!item.done && item.cta ? (
                  <Link
                    href={item.cta.href}
                    onClick={() => setOpen(false)}
                    className="text-primary mt-px shrink-0 text-[11px] font-medium underline-offset-2 hover:underline"
                  >
                    {item.cta.label} →
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-between border-t px-3 py-2">
            <button
              type="button"
              onClick={dismiss}
              className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
            >
              Dismiss for good
            </button>
            <Link
              href="/welcome"
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
            >
              Full guide →
            </Link>
          </div>
        </PopoverContent>
      </Popover>
      <script
        // Pre-paint localStorage check so a dismissed/completed checklist
        // never flashes in: inline scripts execute during HTML parse, before
        // first paint and before hydration. Reads the pre-rename keys too —
        // otherwise a dismissed checklist flashes in for one paint before
        // readHiddenFlag's read-through hides it again on mount.
        dangerouslySetInnerHTML={{
          __html: `try{var f=function(k,l){var v=localStorage.getItem(k);return v===null?localStorage.getItem(l):v;};if(f(${JSON.stringify(DISMISSED_KEY)},${JSON.stringify(LEGACY_DISMISSED_KEY)})==="1"||f(${JSON.stringify(COMPLETE_KEY)},${JSON.stringify(LEGACY_COMPLETE_KEY)})==="1"){var e=document.currentScript&&document.currentScript.parentElement;if(e)e.style.display="none";}}catch(_){}`,
        }}
      />
    </div>
  );
}
