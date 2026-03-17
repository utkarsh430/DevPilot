"use client";

import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  ArrowRight,
  CheckSquare,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TicketCard } from "@/components/board/TicketCard";
import { type BoardColumn, type BoardTicket, type TicketPriority } from "@/components/board/types";
import { ColumnDot, CountPill } from "@/components/board/column-chrome";
import type { BoardDensity } from "@/components/board/board-prefs";
import { PRIORITY_META, PRIORITY_VALUES } from "@/lib/board/priority";
import type { LabelOption } from "@/components/board/LabelPicker";
import { LabelPicker } from "@/components/board/LabelPicker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";

export type ColumnSelection = {
  mode: boolean;
  selectedIds: ReadonlySet<string>;
  inFlight: boolean;
  onToggleMode: () => void;
  onToggleTicket: (ticketId: string) => void;
  onCancel: () => void;
  onDelete: () => void | Promise<void>;
  /** Promote to Ready — only meaningful on the Backlog column. Omit for
   *  terminal columns (Done, Failed) and any other column that doesn't
   *  promote into Ready. The button only renders when this is provided. */
  onMoveToReady?: () => void | Promise<void>;
  /** M1 — bulk priority / label apply. Optional so older callers keep working. */
  onSetPriority?: (p: TicketPriority) => void | Promise<void>;
  onAddLabel?: (labelId: string) => void | Promise<void>;
  /** Tenant label catalog for the bulk label dropdown. */
  labelCatalog?: ReadonlyArray<LabelOption>;
};

export function Column({
  column,
  tickets,
  onOpenTicket,
  selection,
  collapsed,
  onToggleCollapse,
  density = "comfortable",
  reducedMotion = false,
}: {
  column: BoardColumn;
  tickets: BoardTicket[];
  onOpenTicket: (id: string) => void;
  /** Multi-select wiring; undefined for columns where it doesn't apply. */
  selection?: ColumnSelection;
  /** Linear-style collapse. When true the column renders as a narrow
   *  vertical strip; drag-drop is still wired so a card dropped onto a
   *  collapsed column lands in it (and auto-expands). */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Card rhythm, threaded to each TicketCard. */
  density?: BoardDensity;
  /** prefers-reduced-motion — drops the column's own color fade and each
   *  card's drag/hover animation. */
  reducedMotion?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  // Auto-expand on drag-over so the operator sees where the drop will land.
  // Without this, dropping onto a collapsed column would hide the result
  // until the next render — a small but real footgun.
  const prevIsOverRef = React.useRef(isOver);
  React.useEffect(() => {
    if (collapsed && isOver && !prevIsOverRef.current) {
      onToggleCollapse?.();
    }
    prevIsOverRef.current = isOver;
  }, [isOver, collapsed, onToggleCollapse]);
  // Two-step delete confirm so a fat-finger on a 30-ticket batch doesn't nuke
  // the backlog. Reset by Cancel or any selection change.
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  React.useEffect(() => {
    if (!selection?.mode) setConfirmingDelete(false);
  }, [selection?.mode, selection?.selectedIds]);

  const selectedCount = selection?.selectedIds.size ?? 0;

  if (collapsed) {
    return (
      <section
        ref={setNodeRef}
        className={cn(
          "bg-muted/30 flex w-11 shrink-0 flex-col items-center rounded-xl border py-3",
          reducedMotion ? "transition-none" : "transition-colors",
          isOver && "border-ring bg-accent/60",
        )}
        aria-label={`${column.label} column (collapsed)`}
      >
        <button
          type="button"
          onClick={() => onToggleCollapse?.()}
          aria-label={`Expand ${column.label}`}
          title={`Expand ${column.label}`}
          className="text-muted-foreground hover:bg-background hover:text-foreground flex h-7 w-7 items-center justify-center rounded-md"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </button>
        <div className="my-2 flex flex-1 flex-col items-center gap-2">
          <ColumnDot tone={column.tone} />
          <CountPill count={tickets.length} wipLimit={column.wipLimit} />
          {/* Vertical label — uses CSS writing-mode for clean rotation
              rather than a transform, so the text baseline stays
              predictable and Tailwind hover/focus styles still apply. */}
          <span className="text-foreground text-xs font-semibold uppercase tracking-wide [writing-mode:vertical-rl]">
            {column.label}
          </span>
        </div>
      </section>
    );
  }

  return (
    <section
      className={cn(
        "bg-muted/30 flex w-80 shrink-0 flex-col rounded-xl border",
        reducedMotion ? "transition-none" : "transition-colors",
        isOver && "border-ring bg-accent/60",
      )}
      aria-label={`${column.label} column`}
    >
      <header className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <ColumnDot tone={column.tone} />
          <h2 className="text-foreground text-xs font-semibold uppercase tracking-wide">
            {column.label}
          </h2>
        </div>
        <div className="flex items-center gap-1">
          {selection ? (
            <button
              type="button"
              onClick={selection.onToggleMode}
              aria-pressed={selection.mode}
              title={selection.mode ? "Exit selection mode" : "Select multiple"}
              className={cn(
                "text-muted-foreground hover:bg-background hover:text-foreground rounded-md p-1 transition-colors",
                selection.mode && "bg-background text-foreground",
              )}
            >
              <CheckSquare className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <CountPill count={tickets.length} wipLimit={column.wipLimit} />
          {onToggleCollapse ? (
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={`Collapse ${column.label}`}
              title={`Collapse ${column.label}`}
              className="text-muted-foreground hover:bg-background hover:text-foreground rounded-md p-1 transition-colors"
            >
              <ChevronsLeft className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </header>

      {selection?.mode ? (
        <div className="border-chart-1/30 bg-chart-1/5 mx-2 mb-2 flex flex-col gap-1.5 rounded-md border p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-foreground font-medium">{selectedCount} selected</span>
            <button
              type="button"
              onClick={selection.onCancel}
              disabled={selection.inFlight}
              className="text-muted-foreground hover:bg-background hover:text-foreground rounded p-0.5 transition-colors disabled:opacity-50"
              aria-label="Cancel selection"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {confirmingDelete ? (
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="destructive"
                size="xs"
                onClick={() => {
                  setConfirmingDelete(false);
                  void selection.onDelete();
                }}
                disabled={selection.inFlight || selectedCount === 0}
                className="flex-1"
              >
                {selection.inFlight ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="mr-1 h-3 w-3" />
                )}
                Confirm delete {selectedCount}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setConfirmingDelete(false)}
                disabled={selection.inFlight}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {selection.onMoveToReady ? (
                <Button
                  type="button"
                  variant="primary"
                  size="xs"
                  onClick={() => void selection.onMoveToReady?.()}
                  disabled={selection.inFlight || selectedCount === 0}
                  className="flex-1"
                >
                  {selection.inFlight ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <ArrowRight className="mr-1 h-3 w-3" />
                  )}
                  Move to Ready
                </Button>
              ) : null}
              {selection.onSetPriority ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={selection.inFlight || selectedCount === 0}
                      title="Set priority on selected"
                    >
                      Priority
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-44 p-1">
                    {PRIORITY_VALUES.map((p) => {
                      const meta = PRIORITY_META[p];
                      return (
                        <button
                          key={p}
                          type="button"
                          onClick={() => void selection.onSetPriority?.(p)}
                          className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm transition-colors"
                        >
                          <span aria-hidden className={cn("h-2 w-2 rounded-full", meta.dotClass)} />
                          <span className="flex-1">{meta.label}</span>
                          <span className="text-muted-foreground text-[10px]">{meta.shortcut}</span>
                        </button>
                      );
                    })}
                  </PopoverContent>
                </Popover>
              ) : null}
              {selection.onAddLabel && selection.labelCatalog ? (
                <LabelPicker
                  options={selection.labelCatalog}
                  selectedIds={[]}
                  onToggle={(lbl) => void selection.onAddLabel?.(lbl.id)}
                  trigger={
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={selection.inFlight || selectedCount === 0}
                      title="Add label to selected"
                    >
                      Label
                    </Button>
                  }
                />
              ) : null}
              <Button
                type="button"
                variant={selection.onMoveToReady ? "ghost" : "destructive"}
                size="xs"
                onClick={() => setConfirmingDelete(true)}
                disabled={selection.inFlight || selectedCount === 0}
                title="Delete selected"
                className={cn(
                  selection.onMoveToReady ? "text-destructive hover:text-destructive" : "flex-1",
                )}
              >
                <Trash2 className={cn("h-3 w-3", !selection.onMoveToReady && "mr-1")} />
                {/* On terminal columns the trash button is the only action;
                    surface the count so the operator knows what they're
                    about to delete without needing the confirm step. */}
                {!selection.onMoveToReady && selectedCount > 0 ? `Delete ${selectedCount}` : null}
              </Button>
            </div>
          )}
        </div>
      ) : null}

      <ScrollArea ref={setNodeRef} className="min-h-[40vh] flex-1 px-2 pb-2">
        <div className="flex flex-col gap-2 py-1">
          {tickets.length === 0 ? (
            <div className="border-border/70 text-muted-foreground rounded-lg border border-dashed px-3 py-6 text-center text-[11px]">
              {isOver ? "Drop to move" : "No tickets"}
            </div>
          ) : (
            // SortableContext makes each card a sortable item, so dragging
            // one card onto another inside this column emits over.id =
            // target-card-id (rather than the column id). BoardClient.onDragEnd
            // then arrayMove + persists via reorderTicketsAction. Cross-column
            // drops still resolve over.id = card-id, but with a different
            // source column → handled as a status move.
            <SortableContext
              items={tickets.map((t) => t.id)}
              strategy={verticalListSortingStrategy}
            >
              {tickets.map((t) => (
                <TicketCard
                  key={t.id}
                  ticket={t}
                  onOpen={() => onOpenTicket(t.id)}
                  density={density}
                  reducedMotion={reducedMotion}
                  selection={
                    selection?.mode
                      ? {
                          selected: selection.selectedIds.has(t.id),
                          onToggle: () => selection.onToggleTicket(t.id),
                        }
                      : undefined
                  }
                />
              ))}
            </SortableContext>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
