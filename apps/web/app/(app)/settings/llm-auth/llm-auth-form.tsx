"use client";

// LLM auth-mode selector. Two cards — Claude Code subscription (default /
// recommended) and Anthropic API key. Optimistic local selection; a server
// failure rolls back and toasts. Mirrors the appearance card selector's shape
// and the notifications form's optimistic-save-with-rollback pattern.

import * as React from "react";
import { Check, Cpu, KeyRound } from "lucide-react";
import { toast as sonnerToast } from "sonner";
import { cn } from "@/lib/cn";
import { LLM_AUTH_MODES, LLM_AUTH_MODE_META, type LlmAuthMode } from "@/lib/llm/auth-mode";
import { setLlmAuthModeAction } from "./actions";

const ICON: Record<LlmAuthMode, typeof Cpu> = {
  claude_code: Cpu,
  api_key: KeyRound,
};

export function LlmAuthForm({ initialMode }: { initialMode: LlmAuthMode }) {
  const [mode, setMode] = React.useState<LlmAuthMode>(initialMode);
  const [saving, setSaving] = React.useState<LlmAuthMode | null>(null);

  async function select(next: LlmAuthMode) {
    if (next === mode || saving) return;
    const before = mode;
    setMode(next);
    setSaving(next);
    const res = await setLlmAuthModeAction(next);
    setSaving(null);
    if (!res.ok) {
      setMode(before);
      sonnerToast.error("Couldn't save LLM auth mode", { description: res.error });
      return;
    }
    sonnerToast.success(`LLM auth set to ${LLM_AUTH_MODE_META[next].label}`);
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {LLM_AUTH_MODES.map((value) => {
        const meta = LLM_AUTH_MODE_META[value];
        const Icon = ICON[value];
        const active = mode === value;
        const busy = saving === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={saving !== null}
            onClick={() => select(value)}
            className={cn(
              "bg-card group flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors",
              active ? "border-ring ring-ring/40 ring-2" : "hover:border-foreground/30",
              saving !== null && !busy && "opacity-60",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="bg-muted text-foreground/80 flex h-8 w-8 items-center justify-center rounded-md">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="text-sm font-medium tracking-tight">{meta.label}</span>
              </div>
              {active ? (
                <span className="bg-foreground text-background flex h-5 w-5 items-center justify-center rounded-full">
                  <Check className="h-3 w-3" />
                </span>
              ) : null}
            </div>

            <p className="text-muted-foreground text-xs">{meta.tagline}</p>

            <div className="flex items-center gap-2">
              {meta.recommended ? (
                <span className="border-border text-muted-foreground rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                  Recommended · default
                </span>
              ) : null}
              {busy ? <span className="text-muted-foreground text-[10px]">Saving…</span> : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}
