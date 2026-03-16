"use client";

// Swimlane-by-role board view (optional; the flat columns are the default).
//
// Layout is a single horizontally- and vertically-scrolling grid: a sticky
// header row of status columns across the top, then one horizontal band per
// role lane with a sticky left gutter. Each (lane, status) cell is its own
// dnd-kit droppable so cross-status drags still work; the enclosing DndContext
// (and DragOverlay) live in BoardClient. Role is derived, not stored, so
// dragging a card into another lane only changes its status — it re-lands in
// its own lane on the next render. Within-lane reorder is intentionally a
// no-op here (see BoardClient.onDragEnd) to keep the shared `column_position`
// ordering coherent with the flat view.

import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { TicketCard } from "@/components/board/TicketCard";
import type { BoardColumn, BoardTicket } from "@/components/board/types";
import { laneKeyOf, type BoardLane } from "@/components/board/roles";
import { ColumnDot, CountPill } from "@/components/board/column-chrome";
import type { BoardDensity } from "@/components/board/board-prefs";
import { cn } from "@/lib/cn";

const LANE_DOT: Record<BoardLane["tone"], string> = {
  info: "bg-chart-1",
  warn: "bg-warning",
  danger: "bg-destructive",
  ok: "bg-success",
  muted: "bg-muted-foreground/40",
  violet: "bg-chart-4",
};

/** Compound droppable id for a (status, lane) cell. BoardClient.onDragEnd
 *  parses the status back out by splitting on this separator. */
export const CELL_ID_SEP = "@@";
export function cellDropId(status: string, laneKey: string): string {
  return `${status}${CELL_ID_SEP}${laneKey}`;
}
/** Resolve a droppable id (flat column id OR swimlane cell id) to its status. */
export function statusFromDropId(dropId: string): string {
  const idx = dropId.indexOf(CELL_ID_SEP);
  return idx === -1 ? dropId : dropId.slice(0, idx);
}

function LaneCell({
  status,
  laneKey,
  tickets,
  onOpenTicket,
  density,
  reducedMotion,
}: {
  status: string;
  laneKey: string;
  tickets: BoardTicket[];
  onOpenTicket: (id: string) => void;
  density: BoardDensity;
  reducedMotion: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: cellDropId(status, laneKey) });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "w-80 shrink-0 rounded-lg border border-dashed p-1.5",
        reducedMotion ? "transition-none" : "transition-colors",
        isOver ? "border-ring bg-accent/50" : "border-transparent",
      )}
    >
      {tickets.length === 0 ? (
        <div className="text-muted-foreground flex min-h-[56px] items-center justify-center rounded-md text-[11px]">
          {isOver ? "Drop to move" : ""}
        </div>
      ) : (
        <SortableContext items={tickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-2">
            {tickets.map((t) => (
              <TicketCard
                key={t.id}
                ticket={t}
                onOpen={() => onOpenTicket(t.id)}
                density={density}
                reducedMotion={reducedMotion}
              />
            ))}
          </div>
        </SortableContext>
      )}
    </div>
  );
}

export function BoardSwimlanes({
  columns,
  lanes,
  ticketsByColumn,
  onOpenTicket,
  density,
  reducedMotion,
}: {
  columns: ReadonlyArray<BoardColumn>;
  lanes: ReadonlyArray<BoardLane>;
  /** Column tickets sorted exactly as the flat board sorts them. */
  ticketsByColumn: ReadonlyMap<string, BoardTicket[]>;
  onOpenTicket: (id: string) => void;
  density: BoardDensity;
  reducedMotion: boolean;
}) {
  return (
    <div className="flex-1 overflow-auto px-6 py-5">
      <div className="min-w-max">
        {/* Sticky status-header row. Aggregate counts + WIP affordance. */}
        <div className="bg-background/80 sticky top-0 z-20 flex gap-3 pb-2 backdrop-blur">
          <div className="bg-background/80 sticky left-0 z-10 w-44 shrink-0" aria-hidden />
          {columns.map((col) => {
            const count = ticketsByColumn.get(col.id)?.length ?? 0;
            return (
              <div key={col.id} className="flex w-80 shrink-0 items-center gap-2 px-1.5">
                <ColumnDot tone={col.tone} />
                <h2 className="text-foreground text-xs font-semibold uppercase tracking-wide">
                  {col.label}
                </h2>
                <CountPill
                  count={count}
                  wipLimit={col.wipLimit}
                  restingClassName="bg-muted text-muted-foreground"
                  className="ml-auto"
                />
              </div>
            );
          })}
        </div>

        {/* One band per role lane. */}
        <div className="flex flex-col gap-2">
          {lanes.map((lane) => {
            const laneTotal = Array.from(ticketsByColumn.values())
              .flat()
              .filter((t) => laneKeyOf(t) === lane.key).length;
            return (
              <div key={lane.key} className="flex gap-3">
                <div className="bg-background/95 sticky left-0 z-10 flex w-44 shrink-0 items-start gap-2 pt-2.5 backdrop-blur">
                  <span
                    aria-hidden
                    className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", LANE_DOT[lane.tone])}
                  />
                  <div className="min-w-0">
                    <div className="text-foreground truncate text-sm font-medium">{lane.label}</div>
                    <div className="text-muted-foreground text-[11px] tabular-nums">
                      {laneTotal} ticket{laneTotal === 1 ? "" : "s"}
                    </div>
                  </div>
                </div>
                {columns.map((col) => {
                  const cellTickets = (ticketsByColumn.get(col.id) ?? []).filter(
                    (t) => laneKeyOf(t) === lane.key,
                  );
                  return (
                    <LaneCell
                      key={col.id}
                      status={col.id}
                      laneKey={lane.key}
                      tickets={cellTickets}
                      onOpenTicket={onOpenTicket}
                      density={density}
                      reducedMotion={reducedMotion}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
