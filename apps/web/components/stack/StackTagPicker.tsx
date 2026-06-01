"use client";

// Phase 2.5++ / WI-15 — multi-select stack picker for the create-project form.
//
// The operator ticks the services this project actually runs on. The chosen set
// is persisted to `project_stack_tags` and rendered as a HARD frame at the top
// of every plan prompt, so this control is the one place a human decides what
// the panel agents are allowed to reach for by default.
//
// Not the old `StackFlavorToggle` (cut in the plan-revamp Phase 1 declutter —
// it was a single-select radiogroup over three prose moods, subsumed by
// `EcosystemPicker`). This is a genuine multi-select — a project runs on
// Postgres AND Redis AND S3 — so it is a grid of native checkboxes, matching
// the `generatePlan` / `isPrivate` tick-boxes the same form already uses. No
// Radix primitive: the repo has no `ui/checkbox`, and a native input gets us
// the keyboard and a11y story for free.
//
// Detection provenance is visible, not hidden. Boxes that arrived pre-ticked
// from repo fingerprinting carry a "detected" badge, because detected tags come
// from ATTACKER-CONTROLLED repo content: the operator confirming (or unticking)
// them here is the security control that stops raw detection from being
// auto-trusted into the prompt. Unticking a detected box drops it entirely.

import * as React from "react";
import { Loader2, ScanSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { groupCatalogByProvider } from "@/lib/stack/service-catalog";

export function StackTagPicker({
  selected,
  detected,
  onChange,
  disabled,
  scanning,
}: {
  /** Service keys currently ticked. */
  selected: ReadonlySet<string>;
  /** Service keys that came from repo detection (drives the "detected" badge). */
  detected?: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
  /** Repo scan in flight — shown on the connect-existing form. */
  scanning?: boolean;
}) {
  const groups = React.useMemo(() => groupCatalogByProvider(), []);

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          Committed stack
        </label>
        <span className="text-muted-foreground text-[11px] tabular-nums">
          {scanning ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              scanning repo…
            </span>
          ) : (
            `${selected.size} selected`
          )}
        </span>
      </div>
      <div className="space-y-3 rounded-md border p-3">
        {groups.map((group) => (
          <fieldset key={group.provider} disabled={disabled} className="min-w-0">
            <legend className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase tracking-wide">
              {group.displayName}
            </legend>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {group.entries.map((entry) => {
                const checked = selected.has(entry.key);
                const wasDetected = detected?.has(entry.key) ?? false;
                return (
                  <label
                    key={entry.key}
                    title={entry.purpose}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors",
                      checked
                        ? "border-primary/40 bg-primary/5"
                        : "hover:bg-muted/50 border-transparent",
                      disabled && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(entry.key)}
                      disabled={disabled}
                      className="border-input accent-primary h-3.5 w-3.5 shrink-0 rounded"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">{entry.displayName}</span>
                    {wasDetected ? (
                      <Badge tone="info" className="shrink-0 px-1 py-0 text-[11px]">
                        <ScanSearch className="h-2.5 w-2.5" /> detected
                      </Badge>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <p className="text-muted-foreground mt-1 text-[11px]">
        Planning agents treat these as decided and must flag anything they propose outside the set.
        {detected && detected.size > 0
          ? " Pre-ticked entries were detected in the repo — review them; nothing is saved until you submit."
          : " Leave empty if the stack isn't settled yet."}
      </p>
    </div>
  );
}
