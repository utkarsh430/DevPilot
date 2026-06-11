"use client";

// The ONE masked-input form DevPilot uses to collect env var values from a human.
//
// Extracted from `SecretRequestCard` when the Vercel env push needed to ask for
// the same thing. Both surfaces render this; both write through the same
// `setProjectSecretAction`. There is deliberately no second form, no second
// write path, and no place where a value is held anywhere but this component's
// local state and the encrypted column it is sent to.
//
// The two callers differ only in what happens AFTER the values land:
//
//   • `SecretRequestCard` (a parked ticket) posts a human comment, which is what
//     transitions `input_required → in_progress` and re-dispatches the agent.
//   • The Vercel env plan (a project page) has nothing to resume — nothing is
//     waiting — so it just re-reads the plan.
//
// That difference is the `onSaved` callback, and nothing else.
//
// ── Partial saves are reported, not hidden ────────────────────────────────
// Values are written one key at a time, so a failure on key 5 of 8 leaves 4
// persisted. The previous version of this loop stopped on the first failure
// under a comment claiming "we never partially commit", which was not true and
// became likelier as the key count grew. It now reports exactly which keys
// landed, so the operator retries the remainder instead of re-typing everything
// or, worse, believing nothing was saved.

import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { setProjectSecretAction } from "@/app/(app)/projects/[projectId]/secret-actions";

export type SecretValuesFormProps = {
  projectId: string;
  /** Ordered env var names to collect. */
  keys: string[];
  /** Optional per-key hint, e.g. the `.env.example` description. */
  descriptions?: Record<string, string | null>;
  submitLabel?: string;
  /** Runs after at least one key saved successfully. Receives the keys that
   *  actually landed — never all of them by assumption. */
  onSaved?: (savedKeys: string[]) => void | Promise<void>;
  footerNote?: React.ReactNode;
};

export function SecretValuesForm({
  projectId,
  keys,
  descriptions,
  submitLabel = "Save values",
  onSaved,
  footerNote,
}: SecretValuesFormProps) {
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  const filled = keys.filter((k) => (values[k] ?? "").trim().length > 0);
  const canSubmit = !busy && filled.length === keys.length && keys.length > 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);

    const saved: string[] = [];
    let failure: { key: string; error: string } | null = null;
    for (const k of keys) {
      const res = await setProjectSecretAction({
        projectId,
        secretKey: k,
        value: values[k]?.trim() ?? "",
      });
      if (!res.ok) {
        failure = { key: k, error: res.error };
        break;
      }
      saved.push(k);
    }

    if (failure) {
      toast.error(`Couldn't save ${failure.key}`, {
        description:
          saved.length > 0
            ? `${failure.error} Saved so far: ${saved.join(", ")}. Re-enter the rest and try again.`
            : failure.error,
      });
    } else {
      toast.success(`Saved ${saved.length} value${saved.length === 1 ? "" : "s"}`);
    }

    // Clear what landed so a retry does not re-send values already stored, and
    // so plaintext does not sit in component state longer than it must.
    setValues((cur) => {
      const next = { ...cur };
      for (const k of saved) delete next[k];
      return next;
    });
    setBusy(false);

    if (saved.length > 0) await onSaved?.(saved);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      {keys.map((k) => (
        <div key={k}>
          <label htmlFor={`secret-${k}`} className="mb-1 flex items-center gap-2">
            <Badge tone="muted" className="font-mono text-[10px]">
              {k}
            </Badge>
            {descriptions?.[k] ? (
              <span className="text-muted-foreground text-[11px]">{descriptions[k]}</span>
            ) : null}
          </label>
          <Input
            id={`secret-${k}`}
            type="password"
            placeholder={`Value for ${k}`}
            value={values[k] ?? ""}
            onChange={(e) => setValues((cur) => ({ ...cur, [k]: e.target.value }))}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
          <ShieldCheck className="h-3 w-3" />
          {footerNote ?? "encrypted at rest · written to .env.local on next run"}
        </span>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
