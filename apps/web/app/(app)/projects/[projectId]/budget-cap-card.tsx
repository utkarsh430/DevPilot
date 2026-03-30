"use client";

// The per-project control for the PER-RUN budget ceiling escape hatch.
//
// Placed with the other cost-adjacent settings (team tier, LLM provider) so
// an operator deciding about spend actually finds it, and shaped like
// `SupervisorCard` beside it: the HEADING names what turning this switch ON
// changes (stop cutting a run off for exceeding its per-run ceiling), the
// body then explains the DEFAULT it overrides (a run stops cleanly at its
// next step boundary, never mid-write, once it crosses its cap) and states
// just as plainly what it does NOT change — the tenant-wide velocity
// breaker, which stays in force either way.
//
// The heading/toggle relationship is the whole point and previously read
// backwards: a heading describing the ENFORCED behaviour ("stop a run the
// moment it exceeds its budget") sat above a toggle reading "Disabled" in
// exactly the state where that enforcement is happening — i.e. the default,
// the state every project is in. A reader saw "stopping is Disabled" and
// concluded runs are NOT stopped, the opposite of the truth. The heading now
// names what ENABLING the override does (matching the badge's "Cap
// ignored"/"Cap enforced" vocabulary), so `Enabled`/`Disabled` reads
// correctly in both states. A silently-on cost override is exactly the trap
// this card exists to make impossible to miss: the switch's own state is
// the loudest thing on the card, never a buried toggle.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Gauge } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { setBudgetCapOverrideAction } from "./budget-cap-actions";

export function BudgetCapCard({
  projectId,
  budgetCapOverrideEnabled,
}: {
  projectId: string;
  budgetCapOverrideEnabled: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = React.useState(budgetCapOverrideEnabled);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setEnabled(budgetCapOverrideEnabled);
  }, [budgetCapOverrideEnabled]);

  async function onToggle(next: boolean) {
    setSaving(true);
    // Optimistic, snapped back on failure — the switch is the only thing
    // that moves, and leaving it stale would misreport a cost setting.
    setEnabled(next);
    const res = await setBudgetCapOverrideAction({ projectId, enabled: next });
    setSaving(false);
    if (!res.ok) {
      setEnabled(!next);
      toast.error(res.error);
      return;
    }
    toast.success(
      next
        ? "This project's ticket runs will no longer be stopped for exceeding their per-run budget."
        : "This project's ticket runs are stopped again, at their next step boundary, once they exceed their per-run budget.",
    );
    router.refresh();
  }

  return (
    <div className="bg-card rounded-xl border">
      <div className="flex items-center justify-between gap-2 border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <Gauge className="text-muted-foreground h-4 w-4" />
          <span className="text-sm font-medium">Budget cap</span>
        </div>
        <span
          className={
            enabled
              ? "rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400"
              : "text-muted-foreground bg-muted rounded-full px-2 py-0.5 text-xs font-medium"
          }
        >
          {enabled ? "Cap ignored" : "Cap enforced"}
        </span>
      </div>

      <div className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-foreground text-sm font-medium">
            Don&apos;t stop runs for exceeding their budget cap
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Every ticket run carries a per-run spend ceiling ($5 by default). DevPilot checks it
            before every step and again immediately after — once a run has spent past its ceiling,
            it stops cleanly at its next step boundary rather than mid-write. Committed work is
            never lost; the run just does not go on to spend more.
          </p>
          <p className="text-muted-foreground mt-2 text-xs">
            <span className="text-foreground font-medium">
              Some tickets are legitimately expensive.
            </span>{" "}
            Turning this on stops this project&apos;s runs from being cut off for exceeding their
            per-run ceiling — for work you have already decided is worth letting finish.
          </p>
          <p className="text-muted-foreground mt-2 text-xs">
            This does <span className="text-foreground font-medium">not</span> remove every ceiling.
            The workspace-wide cost-velocity circuit breaker still applies to this project&apos;s
            runs exactly as it does to every other project — so a single run can still be stopped if
            the tenant as a whole is spending too fast, and one overridden project can never starve
            every other project&apos;s work.
          </p>
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
