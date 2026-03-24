"use client";

// Due-date picker: native date input + a few one-tap presets. Lightweight on
// purpose — a full calendar component isn't needed for the engineering ops
// volume here, and the native picker covers keyboard + accessibility for free.

import * as React from "react";
import { CalendarClock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";

export type DueDatePickerProps = {
  /** ISO timestamp or null. */
  value: string | null;
  onChange: (next: string | null) => void | Promise<void>;
  trigger?: React.ReactNode;
  className?: string;
  openSignal?: number;
};

function toIso(dateStr: string): string {
  // dateStr is YYYY-MM-DD from <input type="date">. Anchor at end-of-day local
  // time so a "Due 2026-06-07" doesn't visually flip to "overdue" at 00:01.
  return new Date(`${dateStr}T23:59:59`).toISOString();
}

function fromIso(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

export function DueDatePicker({
  value,
  onChange,
  trigger,
  className,
  openSignal,
}: DueDatePickerProps) {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (openSignal === undefined || openSignal === 0) return;
    setOpen(true);
  }, [openSignal]);

  const label = value
    ? new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : "Due date";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className={cn("gap-1.5", className)}>
            <CalendarClock className="h-3 w-3" />
            <span className="text-xs">{label}</span>
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <div className="flex flex-col gap-2">
          <input
            type="date"
            value={fromIso(value)}
            onChange={(e) => {
              const v = e.target.value;
              void onChange(v ? toIso(v) : null);
            }}
            className="bg-background w-full rounded-md border px-2 py-1.5 text-sm"
          />
          <div className="grid grid-cols-3 gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                void onChange(toIso(fromIso(new Date().toISOString())));
                setOpen(false);
              }}
            >
              Today
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                void onChange(toIso(fromIso(addDays(1).toISOString())));
                setOpen(false);
              }}
            >
              Tomorrow
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                void onChange(toIso(fromIso(addDays(7).toISOString())));
                setOpen(false);
              }}
            >
              Next wk
            </Button>
          </div>
          {value ? (
            <Button
              variant="ghost"
              size="xs"
              className="text-destructive"
              onClick={() => {
                void onChange(null);
                setOpen(false);
              }}
            >
              <X className="h-3 w-3" /> Clear
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
