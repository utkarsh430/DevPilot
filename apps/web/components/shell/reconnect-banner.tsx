"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { PlugZap, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relative-time";
import { resumeAllRunnerDisconnectedAction } from "@/lib/automation/actions";

// Banner shown at the top of the app shell when one or more tickets sit in
// `paused` state with `paused_reason='runner-disconnected'` — i.e. the
// runner-watchdog auto-paused them while the runner heartbeat was offline.
// Click "Resume all" to batch-call resumeTicket on every one of them. Dismiss
// is session-scoped — refreshing the page brings the banner back if tickets
// are still in that state (intentional: the banner is data-driven).

type Props = {
  count: number;
  sampleTitles: string[];
  mostRecentPausedAt: string | null;
};

export function ReconnectBanner({ count, sampleTitles, mostRecentPausedAt }: Props) {
  const [dismissed, setDismissed] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const router = useRouter();

  if (dismissed || count <= 0) return null;

  async function onResumeAll() {
    if (pending) return;
    setPending(true);
    const res = await resumeAllRunnerDisconnectedAction();
    setPending(false);
    if (!res.ok) {
      toast.error("Couldn't resume tickets", { description: res.error });
      return;
    }
    if (res.resumed === 0 && res.refused === 0) {
      toast.info("No paused tickets found", {
        description: "Looks like they were already resumed.",
      });
    } else if (res.refused === 0) {
      toast.success(`Resumed ${res.resumed} ticket${res.resumed === 1 ? "" : "s"}`, {
        description: "The dispatcher is picking them up.",
      });
    } else {
      const refusedHint = res.refusedReasons[0]?.error ?? "";
      toast.warning(`Resumed ${res.resumed} · ${res.refused} refused`, {
        description: refusedHint
          ? `Some couldn't resume: ${refusedHint.slice(0, 120)}`
          : "Some tickets couldn't be resumed (workspace or project paused?).",
      });
    }
    // Banner rendered server-side via the layout; refresh to re-fetch the
    // count. If all tickets resumed, the layout will not render the banner
    // on the next pass.
    router.refresh();
  }

  const tooltipBody =
    sampleTitles.length === 0
      ? null
      : sampleTitles.length < count
        ? `${sampleTitles.slice(0, 3).join(" · ")} · +${count - 3} more`
        : sampleTitles.slice(0, 3).join(" · ");

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "border-warning/30 bg-warning/10 flex items-center gap-3 border-b px-4 py-2 text-xs",
      )}
    >
      <PlugZap className="text-warning h-4 w-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-foreground font-medium">
          {count} ticket{count === 1 ? "" : "s"} paused by runner disconnect
        </span>
        {mostRecentPausedAt ? (
          <span className="text-muted-foreground">{relativeTime(mostRecentPausedAt)}</span>
        ) : null}
        {tooltipBody ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground underline-offset-2 hover:underline"
              >
                View
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">{tooltipBody}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <Button
        type="button"
        variant="default"
        size="xs"
        onClick={onResumeAll}
        disabled={pending}
        className="bg-warning text-warning-foreground hover:bg-warning/90 shrink-0"
      >
        <RotateCcw className="h-3 w-3" />
        {pending ? "Resuming…" : "Resume all"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => setDismissed(true)}
        title="Dismiss for this session"
        aria-label="Dismiss"
        className="shrink-0"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
