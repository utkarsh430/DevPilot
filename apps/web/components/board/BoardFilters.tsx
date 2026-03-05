"use client";

// Single "Filter" control above the board — one button that opens a popover
// holding every filter option (Priority / Labels / Overdue). Keeps the board
// toolbar uncluttered: the button carries an active-count badge and the active
// selections live inside the popover. URL-state so a filtered view round-trips
// on reload and is shareable.
//
// Keeps a single shared shape (`BoardFilterState`) consumed by BoardClient to
// derive its predicate. Empty arrays / false = no filter.

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, Filter, Hand } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import type { TicketPriority } from "@/components/board/types";
import { PRIORITY_META, PRIORITY_VALUES } from "@/lib/board/priority";
import type { LabelOption } from "@/components/board/LabelPicker";

export type BoardFilterState = {
  priorities: ReadonlySet<TicketPriority>;
  labelIds: ReadonlySet<string>;
  overdueOnly: boolean;
  /** One-click "needs a human" filter — narrows the board to the FSM states
   *  where an operator must act (`input_required` / `blocked`). Surfaced as a
   *  standalone toolbar chip (not buried in the popover) since it's the whole
   *  point of the human-in-the-loop states. URL-persisted like the rest. */
  needsAttention: boolean;
};

export function emptyFilterState(): BoardFilterState {
  return { priorities: new Set(), labelIds: new Set(), overdueOnly: false, needsAttention: false };
}

export function readFiltersFromParams(params: URLSearchParams): BoardFilterState {
  const pri = (params.get("priority") ?? "")
    .split(",")
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => n >= 0 && n <= 4) as TicketPriority[];
  const labels = (params.get("label") ?? "").split(",").filter(Boolean);
  return {
    priorities: new Set(pri),
    labelIds: new Set(labels),
    overdueOnly: params.get("overdue") === "1",
    needsAttention: params.get("attention") === "1",
  };
}

function writeFilterParams(current: URLSearchParams, next: BoardFilterState): URLSearchParams {
  const out = new URLSearchParams(current);
  if (next.priorities.size > 0) {
    out.set("priority", Array.from(next.priorities).sort().join(","));
  } else out.delete("priority");
  if (next.labelIds.size > 0) {
    out.set("label", Array.from(next.labelIds).join(","));
  } else out.delete("label");
  if (next.overdueOnly) out.set("overdue", "1");
  else out.delete("overdue");
  if (next.needsAttention) out.set("attention", "1");
  else out.delete("attention");
  return out;
}

/**
 * Shared URL-commit for the board filters — replaces the current history entry
 * with the new filter querystring (scroll preserved). Used by both the filter
 * popover and the standalone "Needs you" chip so they stay in lockstep.
 */
function useCommitFilters(): (next: BoardFilterState) => void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return React.useCallback(
    (next: BoardFilterState) => {
      const params = writeFilterParams(new URLSearchParams(searchParams.toString()), next);
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );
}

/**
 * The persistent "Needs you" chip. One click narrows the board to
 * `input_required` / `blocked`; clicking again clears it cleanly. Kept as a
 * dedicated toolbar control (rather than a popover row) so the human-in-the-
 * loop states are always one gesture away, with an optional live count.
 */
export function NeedsAttentionChip({ state, count }: { state: BoardFilterState; count?: number }) {
  const commit = useCommitFilters();
  const active = state.needsAttention;
  return (
    <Button
      type="button"
      variant={active ? "primary" : "outline"}
      size="sm"
      className="gap-1.5"
      aria-pressed={active}
      title={
        active
          ? "Showing only tickets that need you — click to clear"
          : "Show only tickets that need you (input required / blocked)"
      }
      onClick={() => commit({ ...state, needsAttention: !active })}
    >
      <Hand className="h-3.5 w-3.5" />
      Needs you
      {typeof count === "number" && count > 0 ? (
        <span
          className={cn(
            "ml-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
            active ? "bg-primary-foreground/20" : "bg-warning/20 text-warning",
          )}
        >
          {count}
        </span>
      ) : null}
    </Button>
  );
}

/** A selectable option row inside the filter popover (reserves the check column
 *  so rows don't shift when toggled). */
function OptionRow({
  checked,
  onClick,
  children,
}: {
  checked: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
        checked && "bg-accent/60",
      )}
    >
      {children}
      <Check
        className={cn("ml-auto h-3.5 w-3.5 shrink-0", checked ? "opacity-100" : "opacity-0")}
      />
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider first:pt-1">
      {children}
    </div>
  );
}

export function BoardFilters({
  state,
  labelCatalog,
}: {
  state: BoardFilterState;
  labelCatalog: ReadonlyArray<LabelOption>;
}) {
  const commit = useCommitFilters();

  // The popover badge counts only its own controls; the "Needs you" chip lives
  // outside the popover and carries its own active styling.
  const activeCount = state.priorities.size + state.labelIds.size + (state.overdueOnly ? 1 : 0);

  function togglePriority(p: TicketPriority) {
    const next = new Set(state.priorities);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    commit({ ...state, priorities: next });
  }
  function toggleLabel(id: string) {
    const next = new Set(state.labelIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    commit({ ...state, labelIds: next });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={activeCount > 0 ? "primary" : "outline"} size="sm" className="gap-1.5">
          <Filter className="h-3.5 w-3.5" />
          Filter
          {activeCount > 0 ? (
            <span className="bg-primary-foreground/20 ml-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="max-h-[70vh] overflow-y-auto p-1">
          <SectionLabel>Priority</SectionLabel>
          {PRIORITY_VALUES.map((p) => {
            const meta = PRIORITY_META[p];
            return (
              <OptionRow
                key={p}
                checked={state.priorities.has(p)}
                onClick={() => togglePriority(p)}
              >
                <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", meta.dotClass)} />
                <span className="flex-1">{meta.label}</span>
                <span className="text-muted-foreground text-[10px]">{meta.shortcut}</span>
              </OptionRow>
            );
          })}

          {labelCatalog.length > 0 ? (
            <>
              <SectionLabel>Labels</SectionLabel>
              {labelCatalog.map((l) => (
                <OptionRow
                  key={l.id}
                  checked={state.labelIds.has(l.id)}
                  onClick={() => toggleLabel(l.id)}
                >
                  <Badge tone={l.color as never} className="h-5 px-1.5 text-[10px] font-medium">
                    {l.name}
                  </Badge>
                </OptionRow>
              ))}
            </>
          ) : null}

          <SectionLabel>Other</SectionLabel>
          <OptionRow
            checked={state.overdueOnly}
            onClick={() => commit({ ...state, overdueOnly: !state.overdueOnly })}
          >
            <span className="flex-1">Overdue only</span>
          </OptionRow>
        </div>

        {activeCount > 0 ? (
          <div className="border-t p-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground w-full justify-start"
              onClick={() => commit(emptyFilterState())}
            >
              Clear all filters
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
