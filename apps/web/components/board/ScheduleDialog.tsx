"use client";

// Phase 2.5++ / Scheduler — operator dialog for "Run now" or recurring drain
// schedules. Sits behind the board header's "Schedule" button.
//
// Three sections, tabs-free for compactness:
//   0. Concurrency  - how many tickets the drain keeps in flight (the sliding
//                     window in `lib/engine/drain-window.ts`). Applies to both
//                     Run now and to the schedule being created. 1 = serial.
//   1. Run now      — single button; fires ticket-drain/requested immediately.
//   2. New schedule — day-of-week toggle row + time-of-day input + Save.
//                     Times are entered in the operator's LOCAL timezone for
//                     ergonomics; we convert to UTC before persisting (the
//                     cron compares against UTC wallclock).
//   3. Active schedules — listed below with pause/resume + delete.
//
// Realtime subscription on `ticket_schedules` keeps the list fresh across
// tabs (matches the publication entry added in 20260605000000_ticket_schedules).

import * as React from "react";
import {
  CalendarClock,
  ChevronDown,
  Clock,
  History,
  Loader2,
  Pause,
  Play,
  PlayCircle,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { ScheduleActivityList } from "@/components/board/ScheduleActivityList";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { supabaseBrowser } from "@/lib/db/browser";
import { DEFAULT_DRAIN_PARALLELISM, MAX_DRAIN_PARALLELISM } from "@/lib/engine/drain-window";
import {
  createTicketScheduleAction,
  deleteScheduleAction,
  runScheduleNowAction,
  toggleScheduleStatusAction,
} from "@/app/(app)/board/schedule-actions";

// Day-of-week labels indexed 0..6 = Sun..Sat (matches Date.getUTCDay()).
const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"] as const;
const DAY_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

type ScheduleRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  mode: "once" | "recurring";
  days_of_week: number[] | null;
  time_of_day: string | null;
  run_at: string | null;
  status: "active" | "paused" | "completed" | "cancelled";
  current_drain_run_id: string | null;
  drain_parallelism: number | null;
  created_at: string;
};

// Convert "HH:MM" local wallclock into a UTC "HH:MM" string for storage. The
// cron compares against UTC wallclock so we must store in UTC.
function localHHMMToUtc(localHHMM: string): string {
  const [hStr, mStr] = localHHMM.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  const utcH = String(d.getUTCHours()).padStart(2, "0");
  const utcM = String(d.getUTCMinutes()).padStart(2, "0");
  return `${utcH}:${utcM}`;
}

// And the reverse, for displaying a UTC "HH:MM" back to the operator.
function utcHHMMToLocal(utcHHMM: string): string {
  const [hStr, mStr] = utcHHMM.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  const d = new Date();
  d.setUTCHours(h, m, 0, 0);
  const lH = String(d.getHours()).padStart(2, "0");
  const lM = String(d.getMinutes()).padStart(2, "0");
  return `${lH}:${lM}`;
}

function describeSchedule(row: ScheduleRow): string {
  if (row.mode === "once" && row.run_at) {
    const d = new Date(row.run_at);
    return `Once at ${d.toLocaleString()}`;
  }
  if (row.mode === "recurring" && row.time_of_day) {
    const local = utcHHMMToLocal(row.time_of_day);
    const days = row.days_of_week ?? [];
    const dayLabel =
      days.length === 0 || days.length === 7
        ? "every day"
        : days.length === 5 && days.every((d) => d >= 1 && d <= 5)
          ? "weekdays"
          : days.map((d) => DAY_FULL[d]!.slice(0, 3)).join(", ");
    return `Daily ${local} (${dayLabel})`;
  }
  return "—";
}

export function ScheduleDialog({
  open,
  onOpenChange,
  activeProjectId,
  activeProjectName,
  backlogCount,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  activeProjectId: string | null;
  activeProjectName: string | null;
  backlogCount: number;
}) {
  const [schedules, setSchedules] = React.useState<ScheduleRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [runningNow, setRunningNow] = React.useState(false);
  const [savingNew, setSavingNew] = React.useState(false);
  // Which schedule rows have their activity feed expanded. Session-scoped.
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // Default to weekdays + 9:00am local — sensible "morning standup style" preset.
  const [days, setDays] = React.useState<number[]>([1, 2, 3, 4, 5]);
  const [timeLocal, setTimeLocal] = React.useState("09:00");
  // How many tickets the drain keeps in flight. Shared by Run now and by the
  // schedule being created - both fire the same drain.
  const [parallelism, setParallelism] = React.useState<number>(DEFAULT_DRAIN_PARALLELISM);
  const instanceId = React.useId();

  // Load + subscribe to active project's schedules whenever the dialog opens.
  React.useEffect(() => {
    if (!open || !activeProjectId) return;
    let cancelled = false;
    const supabase = supabaseBrowser();
    setLoading(true);
    void (async () => {
      const { data, error } = await supabase
        .from("ticket_schedules")
        .select(
          "id, tenant_id, project_id, mode, days_of_week, time_of_day, run_at, status, current_drain_run_id, drain_parallelism, created_at",
        )
        .eq("project_id", activeProjectId)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      setLoading(false);
      if (error) {
        toast.error("Couldn't load schedules", { description: error.message });
        return;
      }
      setSchedules((data ?? []) as ScheduleRow[]);
    })();

    const channel = supabase
      .channel(`ticket-schedules:${activeProjectId}:${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "ticket_schedules",
          filter: `project_id=eq.${activeProjectId}`,
        },
        (payload) => {
          setSchedules((cur) => {
            if (payload.eventType === "DELETE") {
              const oldId = (payload.old as { id?: string }).id;
              return oldId ? cur.filter((s) => s.id !== oldId) : cur;
            }
            const row = payload.new as ScheduleRow;
            const idx = cur.findIndex((s) => s.id === row.id);
            if (idx === -1) return [row, ...cur];
            const next = cur.slice();
            next[idx] = row;
            return next;
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [open, activeProjectId, instanceId]);

  function toggleDay(d: number) {
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));
  }

  async function onRunNow() {
    if (!activeProjectId || runningNow) return;
    if (backlogCount === 0) {
      toast.info("Backlog is empty — nothing to drain.");
      return;
    }
    setRunningNow(true);
    const res = await runScheduleNowAction({
      projectId: activeProjectId,
      drainParallelism: parallelism,
    });
    setRunningNow(false);
    if (!res.ok) {
      toast.error("Couldn't start drain", { description: res.error });
      return;
    }
    toast.success(
      parallelism === 1
        ? `Drain started - ${backlogCount} ticket${backlogCount === 1 ? "" : "s"} will run one after another.`
        : `Drain started - up to ${parallelism} of ${backlogCount} ticket${backlogCount === 1 ? "" : "s"} will run at once.`,
    );
    onOpenChange(false);
  }

  async function onSaveSchedule() {
    if (!activeProjectId || savingNew) return;
    if (days.length === 0) {
      toast.error("Pick at least one day", {
        description: "Or click All to schedule every day.",
      });
      return;
    }
    setSavingNew(true);
    const res = await createTicketScheduleAction({
      projectId: activeProjectId,
      mode: "recurring",
      daysOfWeek: days,
      timeOfDay: localHHMMToUtc(timeLocal),
      drainParallelism: parallelism,
    });
    setSavingNew(false);
    if (!res.ok) {
      toast.error("Couldn't save schedule", { description: res.error });
      return;
    }
    toast.success("Schedule saved", {
      description: `Will drain backlog at ${timeLocal} on selected days.`,
    });
    // Realtime will fold the new row in; nothing else to do here.
  }

  async function onToggle(s: ScheduleRow) {
    const target = s.status === "active" ? "paused" : "active";
    const res = await toggleScheduleStatusAction({
      scheduleId: s.id,
      status: target,
    });
    if (!res.ok) {
      toast.error("Couldn't update schedule", { description: res.error });
    }
  }

  async function onDelete(s: ScheduleRow) {
    if (!confirm("Delete this schedule?")) return;
    const res = await deleteScheduleAction({ scheduleId: s.id });
    if (!res.ok) {
      toast.error("Couldn't delete schedule", { description: res.error });
    }
  }

  const activeSchedules = schedules.filter((s) => s.status === "active" || s.status === "paused");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <div className="flex items-start gap-2">
          <div className="bg-chart-1/10 text-chart-1 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md">
            <CalendarClock className="h-4 w-4" />
          </div>
          <div className="flex-1">
            <DialogTitle className="text-base">
              Schedule a backlog drain
              {activeProjectName ? (
                <span className="text-muted-foreground ml-2 font-normal">
                  · {activeProjectName}
                </span>
              ) : null}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Run now, or set a recurring time. The drain works through the backlog in order,
              keeping up to the chosen number of tickets in flight and starting the next one each
              time a slot frees. Tickets with an open blocker wait for it - they never take a slot.
            </DialogDescription>
          </div>
        </div>

        {/* Concurrency - the drain's sliding window. Applies to Run now AND to
            the schedule created below (both emit the same drain event). */}
        <section className="bg-card mt-3 flex items-center justify-between gap-3 rounded-md border p-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={`${instanceId}-parallelism`} className="text-sm font-medium">
              Tickets in flight
            </label>
            <p className="text-muted-foreground text-xs">
              {parallelism === 1
                ? "One at a time - each ticket finishes before the next starts."
                : `Up to ${parallelism} tickets run at once.`}{" "}
              3 suits a local Claude Code runner; raise it only with API-runner capacity.
            </p>
          </div>
          <Input
            id={`${instanceId}-parallelism`}
            type="number"
            min={1}
            max={MAX_DRAIN_PARALLELISM}
            step={1}
            value={parallelism}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n)) return;
              setParallelism(Math.max(1, Math.min(MAX_DRAIN_PARALLELISM, Math.round(n))));
            }}
            className="h-8 w-16 shrink-0 text-sm"
          />
        </section>

        {/* Run now section */}
        <section className="bg-muted/20 mt-3 flex flex-col gap-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <p className="text-sm font-medium">Run now</p>
              <p className="text-muted-foreground text-xs">
                Drain all <span className="text-foreground font-medium">{backlogCount}</span>{" "}
                backlog ticket{backlogCount === 1 ? "" : "s"} immediately.
              </p>
            </div>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={onRunNow}
              disabled={runningNow || !activeProjectId || backlogCount === 0}
            >
              {runningNow ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlayCircle className="h-3.5 w-3.5" />
              )}
              {runningNow ? "Starting…" : "Run now"}
            </Button>
          </div>
        </section>

        {/* Recurring schedule builder */}
        <section className="bg-card mt-3 flex flex-col gap-3 rounded-md border p-3">
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-medium">New recurring schedule</p>
            <p className="text-muted-foreground text-xs">
              The drain kicks off at the chosen local time on selected days.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {DAY_LABELS.map((label, idx) => {
              const active = days.includes(idx);
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => toggleDay(idx)}
                  aria-label={DAY_FULL[idx]}
                  className={cn(
                    "inline-flex h-7 w-7 items-center justify-center rounded-md border text-[11px] font-medium transition-colors",
                    active
                      ? "border-chart-1/60 bg-chart-1/10 text-chart-1"
                      : "border-border bg-background text-muted-foreground hover:bg-muted",
                  )}
                  title={DAY_FULL[idx]}
                >
                  {label}
                </button>
              );
            })}
            <div className="ml-1 flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setDays([1, 2, 3, 4, 5])}
              >
                Weekdays
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setDays([0, 1, 2, 3, 4, 5, 6])}
              >
                Every day
              </Button>
              <Button type="button" variant="ghost" size="xs" onClick={() => setDays([])}>
                Clear
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="text-muted-foreground h-3.5 w-3.5" />
            <Input
              type="time"
              value={timeLocal}
              onChange={(e) => setTimeLocal(e.target.value)}
              className="h-8 w-32 text-sm"
            />
            <span className="text-muted-foreground text-[11px]">
              local time ({Intl.DateTimeFormat().resolvedOptions().timeZone})
            </span>
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="ml-auto"
              onClick={onSaveSchedule}
              disabled={savingNew || !activeProjectId || days.length === 0}
            >
              {savingNew ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {savingNew ? "Saving…" : "Save schedule"}
            </Button>
          </div>
        </section>

        {/* Active schedules */}
        <section className="mt-3 flex flex-col gap-2">
          <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
            Active schedules
          </p>
          {loading && schedules.length === 0 ? (
            <p className="text-muted-foreground text-xs">Loading…</p>
          ) : activeSchedules.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No schedules yet. Save one above or just hit Run now.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {activeSchedules.map((s) => {
                const draining = !!s.current_drain_run_id;
                const isExpanded = expanded.has(s.id);
                return (
                  <li key={s.id} className="bg-card overflow-hidden rounded-md border">
                    <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <p className="text-foreground truncate text-xs font-medium">
                          {describeSchedule(s)}
                        </p>
                        <div className="flex items-center gap-1.5">
                          <Badge
                            tone={s.status === "active" ? "ok" : "muted"}
                            className="text-[10px]"
                          >
                            {s.status}
                          </Badge>
                          <Badge tone="muted" className="text-[10px]">
                            {(s.drain_parallelism ?? DEFAULT_DRAIN_PARALLELISM) === 1
                              ? "serial"
                              : `${s.drain_parallelism ?? DEFAULT_DRAIN_PARALLELISM} in flight`}
                          </Badge>
                          {draining ? (
                            <Badge tone="info" className="text-[10px]">
                              <Loader2 className="h-2.5 w-2.5 animate-spin" />
                              draining
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => toggleExpanded(s.id)}
                          aria-expanded={isExpanded}
                          title={isExpanded ? "Hide activity" : "Show activity"}
                        >
                          <History className="h-3 w-3" />
                          Activity
                          <ChevronDown
                            className={cn(
                              "h-3 w-3 transition-transform",
                              isExpanded && "rotate-180",
                            )}
                          />
                        </Button>
                        <Button type="button" variant="ghost" size="xs" onClick={() => onToggle(s)}>
                          {s.status === "active" ? (
                            <>
                              <Pause className="h-3 w-3" />
                              Pause
                            </>
                          ) : (
                            <>
                              <Play className="h-3 w-3" />
                              Resume
                            </>
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => onDelete(s)}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    {isExpanded ? <ScheduleActivityList scheduleId={s.id} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="mt-1 flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            <X className="h-3.5 w-3.5" />
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
