"use client";

// Controlled priority picker built on cmdk + Popover. Stateless w.r.t. the
// ticket: parent supplies the current value and a setter. Used by the drawer
// Properties panel, the filters bar, and the bulk action bar.

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import type { TicketPriority } from "@/components/board/types";
import { PRIORITY_META, PRIORITY_VALUES } from "@/lib/board/priority";

export type PriorityPickerProps = {
  value: TicketPriority;
  onChange: (next: TicketPriority) => void;
  /** Render only the value (small) instead of a full button — used in the card. */
  compact?: boolean;
  className?: string;
  /** Imperative open trigger so the keyboard shortcut hook can pop the menu. */
  openSignal?: number;
};

export function PriorityPicker({
  value,
  onChange,
  compact,
  className,
  openSignal,
}: PriorityPickerProps) {
  const [open, setOpen] = React.useState(false);

  // External signal opens the popover (keyboard shortcut from useBoardShortcuts).
  React.useEffect(() => {
    if (openSignal === undefined || openSignal === 0) return;
    setOpen(true);
  }, [openSignal]);

  const meta = PRIORITY_META[value];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={compact ? "ghost" : "outline"}
          size={compact ? "icon-sm" : "sm"}
          className={cn("gap-1.5", className)}
          aria-label={`Priority: ${meta.label}`}
        >
          <span aria-hidden className={cn("h-2 w-2 rounded-full", meta.dotClass)} />
          {!compact ? (
            <>
              <span className="text-xs">{meta.label}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command>
          <CommandInput placeholder="Set priority…" />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {PRIORITY_VALUES.map((p) => {
                const m = PRIORITY_META[p];
                return (
                  <CommandItem
                    key={p}
                    value={`${m.shortcut} ${m.label}`}
                    onSelect={() => {
                      onChange(p);
                      setOpen(false);
                    }}
                  >
                    <span aria-hidden className={cn("h-2 w-2 rounded-full", m.dotClass)} />
                    <span className="flex-1 text-sm">{m.label}</span>
                    {value === p ? <Check className="h-3.5 w-3.5" /> : null}
                    <CommandShortcut>{m.shortcut}</CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
