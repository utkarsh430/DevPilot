"use client";

// Copyable command / value blocks shared by the welcome runner step and the
// setup wizards. Extracted from app/(app)/welcome/connect-runner-step.tsx.
//
// `secret` mode masks what's SHOWN while copying the real value — for
// generated credentials (registration keys, encryption keys) that the operator
// pastes elsewhere but shouldn't leave readable on screen.

import * as React from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";

export function CommandItem({
  n,
  label,
  hint,
  commands,
}: {
  n: number;
  label: React.ReactNode;
  hint?: React.ReactNode;
  commands: string[];
}) {
  return (
    <li className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-muted-foreground font-mono text-[11px]">{n}.</span>
        <span className="text-foreground text-sm">{label}</span>
      </div>
      <div className="space-y-1.5 pl-5">
        {commands.map((cmd) => (
          <CommandLine key={cmd} value={cmd} />
        ))}
        {hint ? <p className="text-muted-foreground text-[11px]">{hint}</p> : null}
      </div>
    </li>
  );
}

export function CommandLine({
  value,
  secret = false,
  prompt = "$ ",
}: {
  value: string;
  /** Mask the rendered value (•••) while still copying the real one. */
  secret?: boolean;
  /** Leading prompt glyph; pass "" for plain values that aren't shell commands. */
  prompt?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const [revealed, setRevealed] = React.useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      // Clipboard can fail on insecure origins — the command stays selectable.
    }
  }

  const shown = secret && !revealed ? "•".repeat(Math.min(value.length, 32)) : value;

  return (
    <div className="bg-muted/70 group flex items-center gap-2 rounded-md border px-2.5 py-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px]">
        {prompt ? <span className="text-muted-foreground select-none">{prompt}</span> : null}
        {shown}
      </code>
      {secret ? (
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? "Hide value" : "Show value"}
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
        >
          {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Copied" : "Copy"}
        className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
