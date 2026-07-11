// Phase 2 / M5f — 14-day daily-spend bar chart. Inline SVG, no chart library.
// Server component renders the markup; hover shows the per-day amount via
// native <title>.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/format-units";
import type { DailySpendPoint } from "@/lib/metrics/project";

export function SpendChart({ series }: { series: DailySpendPoint[] }) {
  const totalCents = series.reduce((s, p) => s + p.cents, 0);
  const totalRuns = series.reduce((s, p) => s + p.runs, 0);

  const maxCents = Math.max(...series.map((p) => p.cents), 1);
  const WIDTH = 720;
  const HEIGHT = 120;
  const PAD_X = 8;
  const PAD_Y_TOP = 6;
  const PAD_Y_BOTTOM = 18;
  const barWidth = (WIDTH - PAD_X * 2) / series.length - 2;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm">Spend, last 14 days</CardTitle>
        <div className="text-muted-foreground text-[11px]">
          {formatCents(totalCents)} · {totalRuns} run{totalRuns === 1 ? "" : "s"}
        </div>
      </CardHeader>
      <CardContent>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-32 w-full"
          role="img"
          aria-label="14-day spend chart"
        >
          {series.map((p, i) => {
            const h = (p.cents / maxCents) * (HEIGHT - PAD_Y_TOP - PAD_Y_BOTTOM) || 0;
            const x = PAD_X + i * ((WIDTH - PAD_X * 2) / series.length) + 1;
            const y = HEIGHT - PAD_Y_BOTTOM - h;
            const isToday = i === series.length - 1;
            return (
              <g key={p.date}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={Math.max(h, 1)}
                  rx={2}
                  className={
                    isToday ? "fill-primary" : p.cents > 0 ? "fill-foreground/80" : "fill-muted"
                  }
                >
                  <title>
                    {p.date}: {formatCents(p.cents)} · {p.runs} run
                    {p.runs === 1 ? "" : "s"}
                  </title>
                </rect>
                {/* day-of-month tick (every other day to stay readable) */}
                {i % 2 === 0 ? (
                  <text
                    x={x + barWidth / 2}
                    y={HEIGHT - 4}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[8px]"
                  >
                    {p.date.slice(8, 10)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </CardContent>
    </Card>
  );
}
