"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pause, Play, Zap, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { setAutomationStateAction, fireMissedScheduleAction } from "@/lib/automation/actions";
import type { MissedSchedule } from "@/lib/automation/queries";
import { relativeTime } from "@/lib/relative-time";

// Shared toggle. Reused for the workspace switch (in TopBar) and the
// per-project switch (in the project page header). Both flip the same
// pause column on different tables via `scope`.

type Props = {
  scope: "tenant" | "project";
  /** Tenant id or project id, depending on scope. */
  scopeId: string;
  initialState: "running" | "paused";
  initialPausedAt: string | null;
  /**
   * Compact mode: icon-only button (top-nav). When false, the button shows
   * a label + state and is wider — appropriate for a project header.
   */
  compact?: boolean;
  /**
   * Project toggle is disabled when the tenant is already paused (workspace
   * pause masters project pause). UI shows the disabled tooltip explaining.
   */
  disabled?: boolean;
  disabledReason?: string;
};

export function AutomationToggle({
  scope,
  scopeId,
  initialState,
  initialPausedAt,
  compact = false,
  disabled = false,
  disabledReason,
}: Props) {
  const [state, setState] = React.useState<"running" | "paused">(initialState);
  const [pausedAt, setPausedAt] = React.useState<string | null>(initialPausedAt);
  const [pending, setPending] = React.useState(false);
  const [missed, setMissed] = React.useState<MissedSchedule[] | null>(null);
  const router = useRouter();

  async function onToggle() {
    if (pending || disabled) return;
    const next = state === "running" ? "paused" : "running";
    setPending(true);
    const res = await setAutomationStateAction({
      scope,
      id: scopeId,
      state: next,
    });
    setPending(false);
    if (!res.ok) {
      toast.error(next === "paused" ? "Couldn't pause" : "Couldn't resume", {
        description: res.error,
      });
      return;
    }
    setState(res.newState);
    if (next === "paused") {
      setPausedAt(new Date().toISOString());
      toast.success(scope === "tenant" ? "Workspace paused" : "Project paused", {
        description:
          scope === "tenant"
            ? "No new dispatches. Every project's in-flight run halts at its next step; resume re-dispatches them."
            : "No new dispatches. In-flight runs halt at their next step; resume re-dispatches them.",
      });
    } else {
      setPausedAt(null);
      const missedCount = res.missedSchedules?.length ?? 0;
      toast.success(scope === "tenant" ? "Workspace resumed" : "Project resumed", {
        description:
          missedCount > 0
            ? `${missedCount} scheduled drain${missedCount === 1 ? "" : "s"} missed — review them.`
            : "Dispatcher is picking up queued work.",
      });
      if (missedCount > 0 && res.missedSchedules) {
        setMissed(res.missedSchedules);
      }
    }
    router.refresh();
  }

  const isPaused = state === "paused";

  const button = (
    <Button
      type="button"
      variant={isPaused ? "default" : compact ? "outline" : "ghost"}
      size={compact ? "icon-sm" : "sm"}
      onClick={onToggle}
      disabled={disabled || pending}
      aria-pressed={isPaused}
      className={cn(
        isPaused &&
          "bg-warning text-warning-foreground hover:bg-warning/90 focus-visible:ring-warning/40",
        compact ? "" : "gap-2",
      )}
      aria-label={
        isPaused
          ? `Resume ${scope === "tenant" ? "workspace" : "project"} automation`
          : `Pause ${scope === "tenant" ? "workspace" : "project"} automation`
      }
    >
      {isPaused ? (
        <Play className={compact ? "h-4 w-4" : "h-3.5 w-3.5"} />
      ) : (
        <Pause className={compact ? "h-4 w-4" : "h-3.5 w-3.5"} />
      )}
      {compact ? null : <span className="text-xs">{isPaused ? "Resume" : "Pause"}</span>}
    </Button>
  );

  const tooltip = (() => {
    if (disabled) {
      return (
        disabledReason ?? "Workspace is paused (overrides project setting). Resume workspace first."
      );
    }
    if (isPaused) {
      return pausedAt
        ? `${scope === "tenant" ? "Workspace" : "Project"} paused ${relativeTime(pausedAt)} — click to resume.`
        : `${scope === "tenant" ? "Workspace" : "Project"} paused — click to resume.`;
    }
    return scope === "tenant"
      ? "Pause workspace automation. Every project's in-flight run halts at its next step; new dispatches stop."
      : "Pause this project's automation. In-flight runs halt at their next step; new dispatches stop.";
  })();

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>

      <MissedSchedulesDialog schedules={missed} onClose={() => setMissed(null)} />
    </>
  );
}

function MissedSchedulesDialog({
  schedules,
  onClose,
}: {
  schedules: MissedSchedule[] | null;
  onClose: () => void;
}) {
  const [firing, setFiring] = React.useState<Set<string>>(new Set());
  const [fired, setFired] = React.useState<Set<string>>(new Set());

  async function onFire(scheduleId: string) {
    if (firing.has(scheduleId) || fired.has(scheduleId)) return;
    setFiring((prev) => new Set(prev).add(scheduleId));
    const res = await fireMissedScheduleAction(scheduleId);
    setFiring((prev) => {
      const next = new Set(prev);
      next.delete(scheduleId);
      return next;
    });
    if (!res.ok) {
      toast.error("Couldn't fire schedule", { description: res.error });
      return;
    }
    setFired((prev) => new Set(prev).add(scheduleId));
    toast.success("Drain queued", {
      description: "The schedule's drain is firing now.",
    });
  }

  const open = !!schedules && schedules.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock3 className="text-warning h-4 w-4" />
            Missed scheduled drains
          </DialogTitle>
          <DialogDescription>
            These drains would have fired while automation was paused. Fire any you want to catch up
            on now — the rest will resume on their next scheduled tick.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {(schedules ?? []).map((s) => {
            const isFired = fired.has(s.scheduleId);
            const isFiring = firing.has(s.scheduleId);
            return (
              <li
                key={s.scheduleId}
                className="bg-muted/40 flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-xs font-medium">Daily at {s.timeOfDay} UTC</span>
                  <span className="text-muted-foreground text-[11px]">
                    Expected {relativeTime(s.expectedAt)} ·{" "}
                    <span className="font-mono">project {s.projectId.slice(0, 8)}</span>
                  </span>
                </div>
                {isFired ? (
                  <Badge tone="ok">Queued</Badge>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => onFire(s.scheduleId)}
                    disabled={isFiring}
                  >
                    <Zap className="h-3 w-3" />
                    {isFiring ? "Firing…" : "Fire now"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Dismiss
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
