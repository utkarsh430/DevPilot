"use client";

// Ambient agent-activity indicator — the answer to "how would a normal user
// know an agent is working in the background?"
//
// Lives in the topbar on EVERY page, next to the system-health dot it is often
// mistaken for. It is not the automation toggle either: that reports whether
// the system is ALLOWED to work; this reports whether it IS working.
//
// ── THE QUIET STATE IS THE DEFAULT ───────────────────────────────────────────
// When nothing is running this renders `null` — no zero badge, no greyed dot,
// nothing. It is on every page in the app, so a persistent element competing
// for attention while conveying "nothing is happening" is worse than absent.
// The indicator EARNS its pixels by appearing.
//
// ── THE NUMBER IS ONLY WORKING RUNS ──────────────────────────────────────────
// `summary.workingCount`, never working + waiting. A run parked on a human
// decision is reported on its own line, worded as waiting on YOU, because
// folding it into one "3 working" badge reads as "the machine is busy" when
// the truth is the opposite. See `lib/activity/active-runs.ts` for the full
// argument and the exclusions.
//
// ── SCOPE IS STATED, NOT IMPLIED ─────────────────────────────────────────────
// Tenant-wide across every project. The popover header says so in words and
// each row names its own project, because with several projects a bare count
// is ambiguous in a way the operator cannot resolve by looking.
//
// ── READ-ONLY ────────────────────────────────────────────────────────────────
// Observes only. No stop/cancel/retry control anywhere — every row is a link
// into the existing run view rather than a duplicate of it.

import * as React from "react";
import Link from "next/link";
import { Loader2, ArrowRight, PauseCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useActiveRuns } from "@/lib/realtime/use-active-runs";
import { formatElapsed, formatRole, runHref, type ActivityRun } from "@/lib/activity/active-runs";

/**
 * How often the elapsed labels re-render.
 *
 * This is NOT a data poll — it issues no request. Labels are minute-granular
 * ("4m", "1h 12m"), so a 30s tick keeps them honest without a ticking-seconds
 * distraction, and it only runs while the indicator is actually visible.
 */
const ELAPSED_TICK_MS = 30_000;

export function ActivityIndicator({ tenantId }: { tenantId: string | null }) {
  // A session with no resolved tenant has nothing to observe. The hook already
  // no-ops on an empty id (it opens no channel and issues no query), so this
  // falls through to the same quiet state rather than needing its own branch.
  const { working, waiting, workingCount, waitingCount, idle, projectCount, isLive } =
    useActiveRuns({ tenantId: tenantId ?? "" });
  const [open, setOpen] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());

  // Tick only while something is on screen — an idle tenant runs no timer.
  React.useEffect(() => {
    if (idle) return;
    const t = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(t);
  }, [idle]);

  // THE QUIET STATE. Nothing running, nothing waiting → render nothing at all.
  if (idle) return null;

  const anyWorking = workingCount > 0;
  const label = anyWorking
    ? `${workingCount} agent${workingCount === 1 ? "" : "s"} working`
    : `${waitingCount} run${waitingCount === 1 ? "" : "s"} waiting for you`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={label}
          className={cn("gap-1.5 px-2", anyWorking ? "text-chart-1" : "text-warning")}
        >
          {anyWorking ? (
            // The spinner is the signal: motion is what makes "something is
            // happening right now" legible at a glance without reading a number.
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <PauseCircle className="h-3.5 w-3.5" aria-hidden />
          )}
          <span className="text-xs font-medium tabular-nums">
            {anyWorking ? workingCount : waitingCount}
          </span>
          <span className="hidden text-xs font-normal lg:inline">
            {anyWorking ? "working" : "waiting"}
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-[22rem] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
          <div className="flex flex-col">
            <span className="text-sm font-medium">Agent activity</span>
            {/* Scope is stated, not implied. */}
            <span className="text-muted-foreground text-[11px]">
              Across all projects
              {projectCount > 1 ? ` · ${projectCount} projects` : ""}
            </span>
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider",
              isLive ? "text-success" : "text-muted-foreground",
            )}
            title={isLive ? "Streaming live updates" : "Reconnecting…"}
          >
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                isLive ? "bg-success dp-anim-pulse" : "bg-muted-foreground",
              )}
              aria-hidden
            />
            {isLive ? "Live" : "Offline"}
          </span>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {workingCount > 0 ? (
            <Section
              title={`Working now · ${workingCount}`}
              runs={working}
              now={now}
              tone="working"
              onNavigate={() => setOpen(false)}
            />
          ) : null}

          {waitingCount > 0 ? (
            <Section
              // Worded as an ask, not as activity. These runs are stalled ON the
              // operator; describing them as "working" is the misleading-count
              // failure this surface exists to avoid.
              title={`Waiting for you · ${waitingCount}`}
              caption="Paused on a decision — not counted as working."
              runs={waiting}
              now={now}
              tone="waiting"
              onNavigate={() => setOpen(false)}
            />
          ) : null}
        </div>

        <div className="border-t px-3 py-2">
          <Link
            href="/runs"
            onClick={() => setOpen(false)}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
          >
            View all runs <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({
  title,
  caption,
  runs,
  now,
  tone,
  onNavigate,
}: {
  title: string;
  caption?: string;
  runs: ActivityRun[];
  now: number;
  tone: "working" | "waiting";
  onNavigate: () => void;
}) {
  return (
    <div className="border-b last:border-b-0">
      <div className="px-3 pb-1 pt-2.5">
        <div className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
          {title}
        </div>
        {caption ? (
          <div className="text-muted-foreground/80 mt-0.5 text-[11px]">{caption}</div>
        ) : null}
      </div>
      <div className="pb-1.5">
        {runs.map((run) => (
          <RunRow key={run.id} run={run} now={now} tone={tone} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}

/**
 * One line of "which agent, on which ticket, in which project, for how long".
 *
 * A count alone is a tease; this is the useful half. It is a LINK into the
 * existing run inspector — this surface never reimplements it.
 */
function RunRow({
  run,
  now,
  tone,
  onNavigate,
}: {
  run: ActivityRun;
  now: number;
  tone: "working" | "waiting";
  onNavigate: () => void;
}) {
  const elapsed = formatElapsed(run.startedAt, now);
  const ticketLabel =
    run.ticketTitle ??
    // A supervisor child or a headless run legitimately has no ticket. Say so
    // rather than rendering an empty line or inventing a title.
    "No ticket (background run)";

  return (
    <Link
      href={runHref(run)}
      onClick={onNavigate}
      className="hover:bg-accent flex items-start gap-2.5 px-3 py-2 transition-colors"
    >
      <span
        className={cn(
          "mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full",
          tone === "working" ? "bg-chart-1 dp-anim-pulse" : "bg-warning",
        )}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-xs font-medium">{formatRole(run.role)}</span>
          {run.ticketNumber != null ? (
            <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
              DevPilot-{run.ticketNumber}
            </span>
          ) : null}
        </span>
        <span className="text-muted-foreground truncate text-[11px]">{ticketLabel}</span>
        <span className="text-muted-foreground/80 flex items-center gap-1.5 text-[10px]">
          {/* Project named per row — with several projects a bare count is
              ambiguous in a way the operator cannot resolve by looking. */}
          {run.projectName ? <span className="truncate">{run.projectName}</span> : null}
          {run.projectName && elapsed ? <span aria-hidden>·</span> : null}
          {elapsed ? <span className="shrink-0 tabular-nums">{elapsed}</span> : null}
        </span>
      </span>
    </Link>
  );
}
