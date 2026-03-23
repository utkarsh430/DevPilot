"use client";

// Phase 2.5 / M6 — Runners picker.
//
// Authors the `allowed_runner_user_ids` field on the agent's config. Two
// states:
//   • "all"   (literal string sentinel) — the workflow is open to every
//             tenant member. Default for new and migrated canvases.
//   • string[] — explicit list of `auth.users.id` values allowed to file
//             tickets against this workflow.
//
// The board's `createTicketAction` reads this field via `checkRunnersGate`;
// non-allowed members are blocked before the ticket is inserted.
//
// UI matches the rest of the builder Inspector — Card-ish, compact rows,
// chart-N accent on the active state.

import * as React from "react";
import { Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

export type RunnersPickerMember = {
  userId: string;
  displayName: string;
  email: string;
};

export type RunnersPickerProps = {
  /** "all" = open; string[] = restricted to those user ids. */
  value: string[] | "all";
  onChange: (next: string[] | "all") => void;
  members: RunnersPickerMember[];
  disabled?: boolean;
};

export function RunnersPicker({ value, onChange, members, disabled }: RunnersPickerProps) {
  const allowAll = value === "all";
  const selected = React.useMemo(
    () => (Array.isArray(value) ? new Set(value) : new Set<string>()),
    [value],
  );

  const toggleAllowAll = React.useCallback(() => {
    if (allowAll) {
      // Switching from "open" → "restricted". Seed the list with an empty
      // array (operator picks who, explicitly).
      onChange([]);
    } else {
      onChange("all");
    }
  }, [allowAll, onChange]);

  const toggleMember = React.useCallback(
    (userId: string) => {
      if (allowAll) return;
      const next = new Set(selected);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      onChange(Array.from(next));
    },
    [allowAll, onChange, selected],
  );

  return (
    <div className="space-y-2">
      <label
        className={cn(
          "border-border/70 bg-card/40 flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <span className="flex items-center gap-2">
          <Users className="text-muted-foreground h-3.5 w-3.5" />
          <span>Allow all tenant members</span>
        </span>
        <input
          type="checkbox"
          checked={allowAll}
          disabled={disabled}
          onChange={toggleAllowAll}
          className="border-input text-chart-1 focus:ring-ring focus:ring-offset-background h-3.5 w-3.5 cursor-pointer rounded focus:ring-2 focus:ring-offset-1"
        />
      </label>

      {!allowAll && (
        <div className="border-border/70 bg-card/40 space-y-1.5 rounded-md border p-2">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
              Members
            </span>
            <Badge tone="muted" className="h-4 px-1.5 text-[9px]">
              {selected.size} / {members.length}
            </Badge>
          </div>
          {members.length === 0 ? (
            <p className="text-muted-foreground px-1 py-2 text-[11px]">No tenant members loaded.</p>
          ) : (
            <ul className="space-y-1">
              {members.map((m) => {
                const checked = selected.has(m.userId);
                return (
                  <li key={m.userId}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                        checked ? "bg-chart-1/10 text-foreground" : "hover:bg-accent",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleMember(m.userId)}
                        className="border-input text-chart-1 focus:ring-ring focus:ring-offset-background h-3.5 w-3.5 cursor-pointer rounded focus:ring-2 focus:ring-offset-1"
                      />
                      <div className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate font-medium">{m.displayName}</span>
                        {m.email && m.email !== m.displayName && (
                          <span className="text-muted-foreground truncate font-mono text-[10px]">
                            {m.email}
                          </span>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
