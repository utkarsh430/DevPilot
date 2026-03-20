// Shared column chrome for the board's flat and swimlane views.
//
// Both the flat columns (Column.tsx) and the swimlane sticky header
// (BoardSwimlanes.tsx) render the same two glanceable affordances: a
// status-tone dot and a count pill that tips into a WIP-limit warning. Keeping
// them here means the two views can't drift on WIP styling or dot colors if one
// side is tweaked later — the exact class of bug flagged in review.

import * as React from "react";
import { COLUMNS } from "@/components/board/types";
import { cn } from "@/lib/cn";

export type ColumnTone = (typeof COLUMNS)[number]["tone"];

// Maps a column's workflow tone to a thin chip color. Uses the chart-N tokens
// rather than translucent "current" hacks.
const COLUMN_DOT: Record<ColumnTone, string> = {
  default: "bg-muted-foreground/50",
  info: "bg-chart-1",
  warn: "bg-warning",
  ok: "bg-success",
  danger: "bg-destructive",
  muted: "bg-muted-foreground/40",
};

/** Status-tone dot shared by the flat column header and the swimlane header. */
export function ColumnDot({ tone, className }: { tone: ColumnTone; className?: string }) {
  return <span aria-hidden className={cn("h-2 w-2 rounded-full", COLUMN_DOT[tone], className)} />;
}

/** True when a column is pulling more tickets than its soft WIP ceiling. */
export function isOverWip(count: number, wipLimit?: number): boolean {
  return wipLimit != null && count > wipLimit;
}

/**
 * Column count pill with an optional WIP-limit affordance. When the column
 * declares a `wipLimit`, the pill reads `count / limit` and tips into a warning
 * tone the moment the count exceeds the limit — a subtle, glanceable cue that
 * the stage is pulling more than it should. Columns without a limit render the
 * bare count. `restingClassName` lets each view set the non-warning background
 * that reads best against its own header surface; the warning tone and the
 * count/limit text stay shared so the two views can't diverge.
 */
export function CountPill({
  count,
  wipLimit,
  restingClassName = "bg-background text-muted-foreground",
  className,
}: {
  count: number;
  wipLimit?: number;
  restingClassName?: string;
  className?: string;
}) {
  const over = isOverWip(count, wipLimit);
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
        over ? "bg-warning/15 text-warning ring-warning/30 ring-1" : restingClassName,
        className,
      )}
      title={
        wipLimit != null
          ? over
            ? `${count} tickets — over the WIP limit of ${wipLimit}`
            : `${count} of ${wipLimit} WIP limit`
          : `${count} ticket${count === 1 ? "" : "s"}`
      }
      aria-label={
        wipLimit != null
          ? `${count} tickets, WIP limit ${wipLimit}${over ? ", over limit" : ""}`
          : `${count} tickets`
      }
    >
      {wipLimit != null ? `${count}/${wipLimit}` : count}
    </span>
  );
}
