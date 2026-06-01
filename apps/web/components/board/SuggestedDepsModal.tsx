"use client";

// Phase 2.5+ / G3 — Suggested dependencies modal.
//
// Opened from the "review suggested dependencies" chip on a TicketCard once the
// background `suggestTicketDepsFn` parks a Haiku ranking on
// `tickets.suggested_dependencies`. (This used to open synchronously right after
// `createTicketAction` returned — but that flow blocked the create response on
// the Haiku call and hung the "Creating…" button, so the rerank moved to a
// background job and now surfaces asynchronously.) The operator either ticks a
// subset and clicks "Wire selected" (which writes `ticket_dependencies` rows +
// topo-places the new ticket below its picked blockers) or clicks "Skip" (which
// calls `acceptTicketDependenciesAction` with an empty blocker set). Either way
// the action clears the parked suggestions, so the chip disappears via realtime.
//
// Modal uses `modal={false}` (the same workaround we adopted in
// role-select / suggest-modal for the builder) so the underlying board
// keeps responding to scroll while the picker is open. The "Wire selected"
// button stays disabled until at least one item is selected — round-tripping
// with zero picks would just be a non-op.

import * as React from "react";
import { GitBranch, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { toast } from "@/components/ui/sonner";
import { COLUMNS } from "@/components/board/types";
import type { DepSuggestion } from "@/lib/engine/dep-suggest";
import { acceptTicketDependenciesAction } from "@/app/(app)/board/actions";

export type SuggestedDepsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The just-created ticket id we're wiring deps onto. */
  newTicketId: string;
  /** The Haiku-ranked suggestions (already filtered, sorted desc by score). */
  suggestions: DepSuggestion[];
  /** Called once the wire/skip round-trip resolves (success or no-op). */
  onComplete: () => void;
};

export function SuggestedDepsModal({
  open,
  onOpenChange,
  newTicketId,
  suggestions,
  onComplete,
}: SuggestedDepsModalProps) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  // We track "which button is in-flight" rather than a generic "loading"
  // flag so the spinner sits on the right control and we can disable the
  // other one without losing its visual state.
  const [pending, setPending] = React.useState<null | "skip" | "wire">(null);

  // Reset the picker every time we open with a fresh batch of suggestions —
  // stale ticks across opens would otherwise confuse the operator.
  React.useEffect(() => {
    if (open) {
      setSelected(new Set());
      setPending(null);
    }
  }, [open, suggestions]);

  const toggle = React.useCallback((id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const finish = React.useCallback(
    async (blockerIds: string[], kind: "skip" | "wire") => {
      setPending(kind);
      const res = await acceptTicketDependenciesAction({
        ticketId: newTicketId,
        blockerIds,
      });
      setPending(null);
      if (!res.ok) {
        toast.error("Couldn't wire dependencies", { description: res.error });
        return;
      }
      onOpenChange(false);
      onComplete();
    },
    [newTicketId, onComplete, onOpenChange],
  );

  const onSkip = React.useCallback(() => {
    void finish([], "skip");
  }, [finish]);

  const onWire = React.useCallback(() => {
    void finish(Array.from(selected), "wire");
  }, [finish, selected]);

  const canWire = selected.size > 0 && pending === null;
  const canSkip = pending === null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="text-chart-4 h-4 w-4" />
            Suggested dependencies for new ticket
          </DialogTitle>
          <DialogDescription>
            These existing tickets may need to finish before the new one. Pick which to wire.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-2 max-h-[420px] overflow-y-auto overscroll-contain px-2">
          {suggestions.length === 0 ? (
            <div className="text-muted-foreground py-12 text-center text-sm">
              No likely blockers found. Click Skip to drop the new ticket at the end of the backlog.
            </div>
          ) : (
            <ul className="space-y-2">
              {suggestions.map((s) => {
                const checked = selected.has(s.ticketId);
                const colMeta = COLUMNS.find((c) => c.id === s.status);
                const tone = colMeta?.tone ?? "muted";
                return (
                  <li key={s.ticketId}>
                    <label
                      className={cn(
                        "border-border/70 flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors",
                        checked ? "border-chart-4/40 bg-chart-4/5" : "hover:bg-accent",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(s.ticketId)}
                        className="border-input text-chart-4 focus:ring-ring focus:ring-offset-background mt-0.5 h-3.5 w-3.5 cursor-pointer rounded focus:ring-2 focus:ring-offset-1"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{s.title}</span>
                          <Badge tone={tone} className="h-4 px-1.5 text-[9px]">
                            {colMeta?.label ?? s.status}
                          </Badge>
                        </div>
                        <p className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px]">
                          {s.rationale.length > 140 ? `${s.rationale.slice(0, 140)}…` : s.rationale}
                        </p>
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onSkip} disabled={!canSkip}>
            {pending === "skip" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Skip
          </Button>
          <Button type="button" variant="primary" size="sm" onClick={onWire} disabled={!canWire}>
            {pending === "wire" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Wire selected{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
