// Phase 2 / M5f — Per-role usage table. Server component. Sorted by total
// spend descending; rows highlight specialist Engineer roles ahead of the
// generic catchall when both ran.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCents, formatDurationMs } from "@/lib/format-units";
import type { RoleUsageRow } from "@/lib/metrics/project";

export function RoleUsageTable({ rows }: { rows: RoleUsageRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Roles used</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-[11px] italic">
            No runs yet. Roles will surface here once the first ticket runs.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Roles used</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground text-[10px] uppercase tracking-wider">
            <tr className="border-b">
              <th className="py-2 pl-4 text-left font-medium">Role</th>
              <th className="py-2 text-right font-medium">Runs</th>
              <th className="py-2 text-right font-medium">Done / fail</th>
              <th className="py-2 text-right font-medium">Spend</th>
              <th className="py-2 pr-4 text-right font-medium">Avg time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.role} className="border-b last:border-0">
                <td className="py-2 pl-4">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.displayName}</span>
                    <code className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">
                      {r.role}
                    </code>
                  </div>
                </td>
                <td className="py-2 text-right tabular-nums">{r.runs}</td>
                <td className="py-2 text-right">
                  <span className="text-success">{r.doneRuns}</span>
                  <span className="text-muted-foreground"> / </span>
                  <span className="text-destructive">{r.failedRuns}</span>
                </td>
                <td className="py-2 text-right tabular-nums">{formatCents(r.totalCents)}</td>
                <td className="text-muted-foreground py-2 pr-4 text-right tabular-nums">
                  {formatDurationMs(r.avgDurationMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
