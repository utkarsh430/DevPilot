"use client";

// Guided credential input — masked paste box + "Validate & save" + a tri-state
// result line. The building block for every wizard step that takes a pasted
// key. Validation is advisory by design: a positive rejection ("invalid")
// blocks the save; an inconclusive check ("unverified") saves anyway with a
// warning, so a flaky network or an unknown provider response never locks an
// operator out of finishing setup.

import * as React from "react";
import { Check, CircleAlert, Eye, EyeOff, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import type { ValidationResult, ValidationState } from "@/lib/setup/types";

export function CredentialField({
  label,
  secret = true,
  placeholder,
  configuredHint,
  validate,
  onSave,
  saveLabel = "Validate & save",
  disabled = false,
}: {
  label: string;
  secret?: boolean;
  placeholder?: string;
  /** Rendered under the input when a value is already configured ("current ••••abcd"). */
  configuredHint?: string;
  /** Optional pre-save check. Omit for values saved as-is (format-only handled server-side). */
  validate?: (value: string) => Promise<ValidationResult>;
  onSave: (value: string) => Promise<{ ok: boolean; error?: string }>;
  saveLabel?: string;
  disabled?: boolean;
}) {
  const [value, setValue] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<ValidationResult | null>(null);
  const [savedNote, setSavedNote] = React.useState<string | null>(null);

  async function onSubmit() {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    setSavedNote(null);
    setResult(null);
    try {
      let check: ValidationResult | null = null;
      if (validate) {
        check = await validate(v);
        setResult(check);
        if (check.state === "invalid") return;
      }
      const res = await onSave(v);
      if (!res.ok) {
        setResult({ state: "invalid", message: res.error ?? "Save failed" });
        return;
      }
      setSavedNote(
        check?.state === "unverified"
          ? "Saved (couldn't verify — double-check the value)"
          : "Saved",
      );
      setValue("");
      setShow(false);
    } catch {
      setResult({
        state: "invalid",
        message: "Couldn't reach the server - check that it's running and try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <label className="text-muted-foreground text-xs font-medium">{label}</label>
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Input
            type={show || !secret ? "text" : "password"}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setResult(null);
              setSavedNote(null);
            }}
            disabled={busy || disabled}
            spellCheck={false}
            autoComplete="off"
            placeholder={placeholder}
            className={cn("font-mono text-xs", secret && "pr-9")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void onSubmit();
              }
            }}
          />
          {secret ? (
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShow((s) => !s)}
              className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
              aria-label={show ? "Hide value" : "Show value"}
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          ) : null}
        </div>
        <Button
          size="sm"
          onClick={() => void onSubmit()}
          disabled={busy || disabled || value.trim().length === 0}
        >
          {busy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking…
            </>
          ) : (
            saveLabel
          )}
        </Button>
      </div>
      {configuredHint && !result && !savedNote ? (
        <p className="text-muted-foreground text-[11px]">{configuredHint}</p>
      ) : null}
      {result ? <ValidationNotice state={result.state} message={result.message} /> : null}
      {savedNote ? (
        <p
          className={cn(
            "flex items-center gap-1.5 text-[11px]",
            savedNote.startsWith("Saved (") ? "text-warning" : "text-success",
          )}
          role="status"
        >
          <Check className="h-3 w-3 shrink-0" />
          {savedNote}
        </p>
      ) : null}
    </div>
  );
}

/** Shared tri-state result line, also used by steps that validate several
 *  fields as one unit (the boot Supabase step). */
export function ValidationNotice({ state, message }: { state: ValidationState; message: string }) {
  const Icon = state === "valid" ? Check : state === "invalid" ? CircleAlert : TriangleAlert;
  return (
    <p
      role={state === "invalid" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-1.5 text-[11px] leading-snug",
        state === "valid" && "text-success",
        state === "invalid" && "text-destructive",
        state === "unverified" && "text-warning",
      )}
    >
      <Icon className="mt-px h-3 w-3 shrink-0" />
      <span>{message}</span>
    </p>
  );
}
