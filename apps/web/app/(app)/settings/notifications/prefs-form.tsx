"use client";

// Per-kind notification toggle grid. Two channels per row — `In-app` (writes
// a row, lights up the bell) and `Toast` (also pops a Sonner pop-over when
// fresh). Toast is meaningless without in-app, so the checkbox is disabled
// when the latter is off. Optimistic local update; server failure rolls back.

import * as React from "react";
import { toast as sonnerToast } from "sonner";
import { cn } from "@/lib/cn";
import type { NotificationKind } from "@/lib/notifications/kinds";
import { updateNotificationPreference } from "./actions";

export type PrefRow = {
  kind: NotificationKind;
  label: string;
  description: string;
  group: string;
  inApp: boolean;
  toast: boolean;
};

export function NotificationPrefsForm({ rows: seed }: { rows: PrefRow[] }) {
  const [rows, setRows] = React.useState<PrefRow[]>(seed);
  const [savingKind, setSavingKind] = React.useState<NotificationKind | null>(null);

  const grouped = React.useMemo(() => {
    const m = new Map<string, PrefRow[]>();
    for (const r of rows) {
      const list = m.get(r.group) ?? [];
      list.push(r);
      m.set(r.group, list);
    }
    return Array.from(m.entries());
  }, [rows]);

  async function save(kind: NotificationKind, next: { inApp: boolean; toast: boolean }) {
    const before = rows;
    setRows((prev) => prev.map((r) => (r.kind === kind ? { ...r, ...next } : r)));
    setSavingKind(kind);
    const res = await updateNotificationPreference({
      kind,
      inApp: next.inApp,
      toast: next.toast,
    });
    setSavingKind(null);
    if (!res.ok) {
      setRows(before);
      sonnerToast.error("Couldn't save preference", { description: res.error });
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {grouped.map(([group, list]) => (
        <section key={group}>
          <h2 className="mb-3 text-sm font-medium">{group}</h2>
          <div className="divide-y rounded-md border">
            <div className="text-muted-foreground flex items-center px-4 py-2 text-[10px] uppercase tracking-wider">
              <span className="flex-1">Event</span>
              <span className="w-16 text-center">In-app</span>
              <span className="w-16 text-center">Toast</span>
            </div>
            {list.map((r) => {
              const disabled = savingKind === r.kind;
              return (
                <div key={r.kind} className="flex items-center px-4 py-3">
                  <div className="flex-1 pr-4">
                    <div className="text-sm font-medium">{r.label}</div>
                    <div className="text-muted-foreground text-xs">{r.description}</div>
                  </div>
                  <div className="flex w-16 justify-center">
                    <Toggle
                      checked={r.inApp}
                      disabled={disabled}
                      onChange={(checked) =>
                        save(r.kind, {
                          inApp: checked,
                          toast: checked ? r.toast : false,
                        })
                      }
                      ariaLabel={`${r.label}: in-app`}
                    />
                  </div>
                  <div className="flex w-16 justify-center">
                    <Toggle
                      checked={r.toast}
                      disabled={disabled || !r.inApp}
                      onChange={(checked) => save(r.kind, { inApp: r.inApp, toast: checked })}
                      ariaLabel={`${r.label}: toast`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors",
        checked ? "bg-foreground border-transparent" : "border-border bg-muted",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        className={cn(
          "bg-background inline-block h-3.5 w-3.5 transform rounded-full shadow-sm transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}
