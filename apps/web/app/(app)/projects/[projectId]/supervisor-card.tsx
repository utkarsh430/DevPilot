"use client";

// The per-project control for the runner-resident project supervisor.
//
// Its own card rather than a row on "Agent autonomy": that card is about what
// AGENTS may do to the board, this is about what the PLATFORM may do when its
// own recovery machinery has stopped. Conflating them would put a safety net
// behind a heading about agent permissions.
//
// The copy leads with the failure it exists to catch, because the setting is
// otherwise impossible to reason about - "supervision" tells an operator
// nothing, and a switch nobody understands stays off for the wrong reason. It
// also states the guarantee that makes it safe to turn on: nothing happens here
// while the engine's own crons are running.

import * as React from "react";
import { useRouter } from "next/navigation";
import { LifeBuoy } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { setSupervisorEnabledAction } from "./supervisor-actions";

export function SupervisorCard({
  projectId,
  supervisorEnabled,
}: {
  projectId: string;
  supervisorEnabled: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = React.useState(supervisorEnabled);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setEnabled(supervisorEnabled);
  }, [supervisorEnabled]);

  async function onToggle(next: boolean) {
    setSaving(true);
    // Optimistic, snapped back on failure - the switch is the only thing that
    // moves, and leaving it stale would misreport a safety setting.
    setEnabled(next);
    const res = await setSupervisorEnabledAction({ projectId, enabled: next });
    setSaving(false);
    if (!res.ok) {
      setEnabled(!next);
      toast.error(res.error);
      return;
    }
    toast.success(
      next
        ? "The supervisor may now recover this board if the engine's own crons stop running."
        : "The supervisor will report problems on this board but never act on them.",
    );
    router.refresh();
  }

  return (
    <div className="bg-card rounded-xl border">
      <div className="flex items-center gap-2 border-b px-5 py-3">
        <LifeBuoy className="text-muted-foreground h-4 w-4" />
        <span className="text-sm font-medium">Supervision</span>
      </div>

      <div className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-foreground text-sm font-medium">
            Recover this board when the engine&apos;s safety nets stop
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Every automatic recovery in DevPilot - the stuck-ticket sweeper, the orphan and
            stale-run reapers, the dispatch rescue - runs on the same scheduler. When that scheduler
            wedges they all stop at once, and a board can sit at &ldquo;WIP limit&rdquo; with
            nothing running for hours with no alarm anywhere. The supervisor lives in the runner
            process, so it keeps ticking when the scheduler does not.
          </p>
          <p className="text-muted-foreground mt-2 text-xs">
            <span className="text-foreground font-medium">
              It does nothing while the scheduler is healthy.
            </span>{" "}
            With the normal recovery alive it only watches and reports - two things acting on one
            ticket is worse than a stall. Only once the engine has provably stopped executing does
            it release a queue that nothing can drain, or hand a stalled ticket back to you as{" "}
            <span className="font-medium">Input required</span> with an explanation. It never starts
            a run, never approves anything, and never raises a WIP or budget limit.
          </p>
          <p className="text-muted-foreground mt-2 text-xs">
            Every fix it makes is recorded with its cause, and a fix that keeps firing for the same
            reason is escalated to you as a suspected defect rather than quietly absorbed.
          </p>
          {enabled ? null : (
            <p className="text-muted-foreground mt-2 text-xs italic">
              While this is off, problems on this board are still detected and shown in system
              health - only the automatic recovery is withheld.
            </p>
          )}
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="accent-primary h-4 w-4"
            checked={enabled}
            disabled={saving}
            onChange={(e) => void onToggle(e.target.checked)}
          />
          <span className="text-muted-foreground">{enabled ? "Enabled" : "Disabled"}</span>
        </label>
      </div>
    </div>
  );
}
