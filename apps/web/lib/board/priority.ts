// Priority encoding & display tokens, shared by card, drawer, filters, picker.
// Linear's encoding: 0=none, 1=urgent, 2=high, 3=medium, 4=low.

import type { TicketPriority } from "@/components/board/types";

export const PRIORITY_VALUES: ReadonlyArray<TicketPriority> = [0, 1, 2, 3, 4];

export type PriorityMeta = {
  value: TicketPriority;
  label: string;
  /** Single keyboard shortcut to set this priority on a focused card. */
  shortcut: string;
  /** Tailwind classes for the priority dot on the card (color only). */
  dotClass: string;
  /** Badge tone for chips in filters / pickers. */
  tone: "default" | "info" | "warn" | "ok" | "danger" | "muted" | "violet";
};

export const PRIORITY_META: Record<TicketPriority, PriorityMeta> = {
  0: {
    value: 0,
    label: "No priority",
    shortcut: "0",
    dotClass: "bg-muted-foreground/30",
    tone: "muted",
  },
  1: { value: 1, label: "Urgent", shortcut: "1", dotClass: "bg-destructive", tone: "danger" },
  2: { value: 2, label: "High", shortcut: "2", dotClass: "bg-warning", tone: "warn" },
  3: { value: 3, label: "Medium", shortcut: "3", dotClass: "bg-chart-1", tone: "info" },
  4: { value: 4, label: "Low", shortcut: "4", dotClass: "bg-muted-foreground/60", tone: "muted" },
};

/** Sort key — 0 ("no priority") sinks to the bottom of priority-sorted lists. */
export function prioritySortKey(p: TicketPriority): number {
  return p === 0 ? 99 : p;
}
