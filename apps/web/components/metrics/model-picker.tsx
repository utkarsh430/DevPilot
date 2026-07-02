"use client";

// The one model-picking control, shared by every scope that picks a model.
//
// It owns NOTHING about scope. It does not know whether it is writing a project
// setting or a per-agent-per-project one, does not import a server action, and
// does not name what will be affected — the caller passes `onApply` and renders
// its own consequence copy. That is what lets `/agents`, `/scoreboard`'s
// per-agent popover, and the project-level card share one control instead of
// three copies of a select + Apply + dirty/saved/error block drifting apart.
//
// There is no shadcn `Select` in this repo; the two precedents are bare styled
// `<select>` elements (this file's ancestor in project-model-card.tsx, and
// `SelectShell` in the builder canvas), so `ModelLadderSelect` is the extracted
// styled select and the duplication goes with it.

import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { CLAUDE_MODEL_LADDER, ACCOUNT_DEFAULT_VALUE } from "@/lib/llm/claude-model-ladder";

export type ApplyModelResult = { ok: true } | { ok: false; error: string };

/** The styled `<select>` alone — the ladder plus the "nothing pinned" sentinel. */
export function ModelLadderSelect({
  id,
  value,
  onChange,
  disabled,
  ariaLabel,
  className,
  hideHints = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  /**
   * Drop the per-rung hint text. A `<select>` shows its selected option on one
   * line and clips the overflow, so in a narrow container the hint truncates
   * mid-word ("Opus — Most capable, slowest, most expen…") and the control reads
   * as broken. Narrow callers show labels only.
   */
  hideHints?: boolean;
}) {
  return (
    <>
      <label className="sr-only" htmlFor={id}>
        {ariaLabel}
      </label>
      <select
        id={id}
        className={cn(
          "border-input bg-background min-w-0 rounded-md border px-2 py-1 text-xs",
          "disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value={ACCOUNT_DEFAULT_VALUE}>
          {hideHints ? "Account default" : "Account default (nothing pinned)"}
        </option>
        {CLAUDE_MODEL_LADDER.map((rung) => (
          <option key={rung.value} value={rung.value} title={rung.hint}>
            {hideHints ? rung.label : `${rung.label} — ${rung.hint}`}
          </option>
        ))}
      </select>
    </>
  );
}

export type ModelPickerProps = {
  /** Unique within the page — becomes the select's id and its label target. */
  id: string;
  /** The currently stored ladder value; "" = nothing pinned. */
  currentValue: string;
  ariaLabel: string;
  /**
   * Persist the choice. The caller owns the scope entirely; this component only
   * reports what came back.
   */
  onApply: (value: string) => Promise<ApplyModelResult>;
  /** Inert control — e.g. a project that cannot serve a Claude model at all. */
  disabled?: boolean;
  /** Shown when `disabled`. Required in practice: an inert control with no
   *  explanation reads as a bug. */
  disabledReason?: string | null;
  /** Consequence copy, rendered only while the selection is dirty. */
  renderPreview?: (nextValue: string) => React.ReactNode;
  /** Defaults to the generic "Saved" line. */
  savedMessage?: string;
  /** Lay the select and Apply out on their own row (narrow containers). */
  stacked?: boolean;
};

export function ModelPicker({
  id,
  currentValue,
  ariaLabel,
  onApply,
  disabled = false,
  disabledReason = null,
  renderPreview,
  savedMessage = "Saved. New runs use the new model.",
  stacked = false,
}: ModelPickerProps) {
  const [choice, setChoice] = React.useState(currentValue);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  // A server revalidation can hand down a new stored value (another tab, or this
  // same save). Re-seed so the control is never dirty against stale state.
  React.useEffect(() => {
    setChoice(currentValue);
  }, [currentValue]);

  const dirty = choice !== currentValue;

  function apply() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await onApply(choice);
      if (result.ok) setSaved(true);
      else {
        setError(result.error);
        // Roll the control back to what is actually stored, so a failed apply
        // never leaves the UI asserting a model the server refused.
        setChoice(currentValue);
      }
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className={cn("flex items-center gap-2", stacked && "flex-wrap")}>
        <ModelLadderSelect
          id={id}
          value={choice}
          ariaLabel={ariaLabel}
          disabled={disabled || pending}
          className={stacked ? "flex-1" : undefined}
          hideHints={stacked}
          onChange={(next) => {
            setChoice(next);
            setSaved(false);
          }}
        />
        <Button size="sm" onClick={apply} disabled={!dirty || disabled || pending}>
          {pending ? "Applying…" : "Apply"}
        </Button>
      </div>

      {disabled && disabledReason && (
        <p className="text-muted-foreground flex items-start gap-1.5 text-[11px]">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{disabledReason}</span>
        </p>
      )}

      {dirty && !pending && !disabled && renderPreview && (
        <div className="text-[11px]">{renderPreview(choice)}</div>
      )}
      {saved && <p className="text-success text-[11px]">{savedMessage}</p>}
      {error && <p className="text-destructive text-[11px]">{error}</p>}
    </div>
  );
}

/** The ladder label for a stored value — "Account default" when nothing is pinned. */
export function ladderLabel(value: string): string {
  return CLAUDE_MODEL_LADDER.find((r) => r.value === value)?.label ?? "Account default";
}
