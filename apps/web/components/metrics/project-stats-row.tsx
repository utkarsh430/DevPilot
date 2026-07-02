// Phase 2 / M5f — 4-tile summary on the project detail page.

import { CircleDollarSign, Clock, GitMerge, ListChecks } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatCents, formatDurationMs, formatRelativeShort } from "@/lib/format-units";
import type { ProjectStats } from "@/lib/metrics/project";

export function ProjectStatsRow({ stats }: { stats: ProjectStats }) {
  const tiles = [
    {
      label: "Total spend",
      value: formatCents(stats.totalSpendCents),
      hint: `${stats.totalRuns} run${stats.totalRuns === 1 ? "" : "s"}`,
      Icon: CircleDollarSign,
    },
    {
      label: "Tickets",
      value: String(stats.totalTickets),
      hint:
        stats.ticketsDone +
        " done · " +
        stats.ticketsInFlight +
        " in flight · " +
        stats.ticketsFailed +
        " failed",
      Icon: ListChecks,
    },
    {
      label: "Total run time",
      value: formatDurationMs(stats.totalRunTimeMs),
      hint:
        stats.avgTicketConvergenceMs > 0
          ? `avg ${formatDurationMs(stats.avgTicketConvergenceMs)} per done ticket`
          : "no completed tickets yet",
      Icon: Clock,
    },
    {
      label: "Retries",
      value: String(stats.totalRetries),
      hint: stats.lastActivityAt
        ? `last activity ${formatRelativeShort(stats.lastActivityAt)}`
        : "no activity yet",
      Icon: GitMerge,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((t) => (
        <Card key={t.label} className="border-muted">
          <CardContent className="flex flex-col gap-1 p-4">
            <div className="text-muted-foreground flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider">
              <t.Icon className="h-3 w-3" />
              {t.label}
            </div>
            <div className="text-2xl font-semibold tracking-tight">{t.value}</div>
            <div className="text-muted-foreground truncate text-[11px]">{t.hint}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
