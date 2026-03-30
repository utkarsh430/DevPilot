"use client";

// Phase 2.5 / M6 — Suggest data sources modal.
//
// Shown from the role-node Inspector when the operator clicks "Suggest data
// sources". The parent action (`suggestDataSourcesAction`) returns a ranked
// list of installed data sources (id + name + kind + rationale). This modal
// lets the operator pick which ones to attach; on confirm the parent wires
// each selected id as a `data_source` node + linear edge from the role.
//
// Dialog uses `modal={false}` (the same workaround we adopted in role-select)
// so the underlying canvas keeps responding to scroll while the picker is
// open. The confirm button stays disabled until at least one item is selected
// because filing a "suggest" round-trip with zero picks is just noise.

import * as React from "react";
import { Sparkles, Loader2 } from "lucide-react";
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

export type SuggestModalItem = {
  dataSourceId: string;
  name: string;
  kind: string;
  rationale: string;
  /** When true the row is greyed out + non-selectable (already attached). */
  alreadyAttached?: boolean;
};

export type SuggestModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suggestions: SuggestModalItem[];
  onConfirm: (selectedIds: string[]) => void;
  loading?: boolean;
};

export function SuggestModal({
  open,
  onOpenChange,
  suggestions,
  onConfirm,
  loading,
}: SuggestModalProps) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  // Reset the selection set every time the modal opens with a fresh batch of
  // suggestions — stale ticks across opens would otherwise confuse the user.
  React.useEffect(() => {
    if (open) setSelected(new Set());
  }, [open, suggestions]);

  const toggle = React.useCallback((id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const confirm = React.useCallback(() => {
    onConfirm(Array.from(selected));
    onOpenChange(false);
  }, [onConfirm, onOpenChange, selected]);

  const canConfirm = selected.size > 0 && !loading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="text-chart-4 h-4 w-4" />
            Suggested data sources
          </DialogTitle>
          <DialogDescription>
            Ranked by recent tickets matching this role. Pick the ones to attach — each becomes a
            data-source node wired to the role.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-2 max-h-[420px] overflow-y-auto overscroll-contain px-2">
          {loading ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Asking Haiku to rank candidates…
            </div>
          ) : suggestions.length === 0 ? (
            <div className="text-muted-foreground py-12 text-center text-sm">
              No data sources to suggest. Connect one from the Data Sources page first.
            </div>
          ) : (
            <ul className="space-y-2">
              {suggestions.map((s) => {
                const checked = selected.has(s.dataSourceId);
                const disabled = !!s.alreadyAttached;
                return (
                  <li key={s.dataSourceId}>
                    <label
                      className={cn(
                        "border-border/70 flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors",
                        disabled
                          ? "cursor-not-allowed opacity-60"
                          : checked
                            ? "border-chart-4/40 bg-chart-4/5"
                            : "hover:bg-accent",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggle(s.dataSourceId)}
                        className="border-input text-chart-4 focus:ring-ring focus:ring-offset-background mt-0.5 h-3.5 w-3.5 cursor-pointer rounded focus:ring-2 focus:ring-offset-1"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{s.name}</span>
                          <Badge tone="violet" className="h-4 px-1.5 text-[9px]">
                            {s.kind}
                          </Badge>
                          {s.alreadyAttached && (
                            <Badge tone="muted" className="h-4 px-1.5 text-[9px]">
                              attached
                            </Badge>
                          )}
                        </div>
                        <p className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px]">
                          {s.rationale}
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
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={!canConfirm}>
            Attach {selected.size > 0 ? `(${selected.size})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
