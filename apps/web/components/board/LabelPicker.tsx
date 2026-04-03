"use client";

// Multi-select label picker. Parent owns the attached-labels list and the
// catalog of all labels in the tenant; this component renders the menu and
// calls onToggle / onCreate. It does NOT fetch — keeping it data-agnostic
// lets the same component drive the drawer (per-ticket) and the filter bar
// (per-board).

import * as React from "react";
import { Check, Plus, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

export type LabelOption = {
  id: string;
  name: string;
  color: string;
};

export type LabelPickerProps = {
  /** Full catalog visible to the operator. */
  options: ReadonlyArray<LabelOption>;
  /** Currently attached label ids. */
  selectedIds: ReadonlyArray<string>;
  onToggle: (label: LabelOption) => void | Promise<void>;
  /** Optional: called when the operator types a label that doesn't exist
   *  and confirms with Enter. Parent decides whether to allow creation. */
  onCreate?: (name: string) => void | Promise<void>;
  /** Compact trigger for the card; otherwise a labelled button for panels. */
  trigger?: React.ReactNode;
  className?: string;
  openSignal?: number;
};

export function LabelPicker({
  options,
  selectedIds,
  onToggle,
  onCreate,
  trigger,
  className,
  openSignal,
}: LabelPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    if (openSignal === undefined || openSignal === 0) return;
    setOpen(true);
  }, [openSignal]);

  const selectedSet = React.useMemo(() => new Set(selectedIds), [selectedIds]);
  const trimmed = query.trim();
  const exactMatch = options.some((o) => o.name.toLowerCase() === trimmed.toLowerCase());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className={cn("gap-1.5", className)}>
            <Tag className="h-3 w-3" />
            <span className="text-xs">Labels</span>
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Filter or create…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No labels yet.</CommandEmpty>
            <CommandGroup>
              {options.map((lbl) => {
                const checked = selectedSet.has(lbl.id);
                return (
                  <CommandItem
                    key={lbl.id}
                    value={lbl.name}
                    onSelect={() => {
                      void onToggle(lbl);
                    }}
                  >
                    <Badge tone={lbl.color as never} className="h-5 px-1.5 text-[10px] font-medium">
                      {lbl.name}
                    </Badge>
                    <span className="flex-1" />
                    {checked ? <Check className="h-3.5 w-3.5" /> : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {onCreate && trimmed.length > 0 && !exactMatch ? (
              <>
                <CommandSeparator />
                <CommandGroup heading="Create">
                  <CommandItem
                    value={`__create__${trimmed}`}
                    onSelect={() => {
                      void onCreate(trimmed);
                      setQuery("");
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span className="flex-1 text-sm">Create label “{trimmed}”</span>
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
