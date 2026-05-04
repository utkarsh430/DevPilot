"use client";

// WI-12 — the optional "LLM provider" section shared by both project-create
// forms. Collapsed by default and sending `undefined` until the operator opens
// it, so the overwhelmingly common path (use the workspace default) stays a
// single click away and the create action sees no provider at all.
//
// The API key is write-only: it goes into the encrypted per-project vault via the
// server action and is never read back to any client.

import * as React from "react";
import { ChevronDown, Cpu } from "lucide-react";
import { Input } from "@/components/ui/input";
import { LLM_PROVIDER_META, type LlmProvider } from "@/lib/llm/provider";
import type { LlmProviderFormInput } from "@/lib/llm/provider-form";

export type LlmDraft = {
  provider: LlmProvider | "inherit";
  baseUrl: string;
  model: string;
  apiKey: string;
};

export const EMPTY_LLM_DRAFT: LlmDraft = {
  provider: "inherit",
  baseUrl: "",
  model: "",
  apiKey: "",
};

/** Draft → the action's optional `llm` field. `undefined` when the operator left
 *  it on the workspace default, so the create path is byte-for-byte today's. */
export function llmDraftToInput(draft: LlmDraft): LlmProviderFormInput | undefined {
  if (draft.provider === "inherit") return undefined;
  return {
    provider: draft.provider,
    baseUrl: draft.provider === "openai_compatible" ? draft.baseUrl.trim() : null,
    model: draft.model.trim().length > 0 ? draft.model.trim() : null,
    apiKey: draft.apiKey.length > 0 ? draft.apiKey : undefined,
  };
}

export function LlmProviderFields({
  draft,
  onChange,
  disabled,
}: {
  draft: LlmDraft;
  onChange: (next: LlmDraft) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const set = (patch: Partial<LlmDraft>) => onChange({ ...draft, ...patch });

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <Cpu className="text-muted-foreground h-3.5 w-3.5" />
          <span className="text-sm font-medium">LLM provider</span>
          <span className="text-muted-foreground text-xs">
            {draft.provider === "inherit"
              ? "Workspace default"
              : LLM_PROVIDER_META[draft.provider].label}
          </span>
        </span>
        <ChevronDown
          className={
            "text-muted-foreground h-4 w-4 transition-transform " + (open ? "rotate-180" : "")
          }
        />
      </button>

      {open ? (
        <div className="space-y-3 border-t px-4 py-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium">Provider</span>
            <select
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              value={draft.provider}
              disabled={disabled}
              onChange={(e) => set({ provider: e.target.value as LlmDraft["provider"] })}
            >
              <option value="inherit">Workspace default (recommended)</option>
              <option value="anthropic">{LLM_PROVIDER_META.anthropic.label}</option>
              <option value="openai_compatible">{LLM_PROVIDER_META.openai_compatible.label}</option>
            </select>
          </label>

          {draft.provider === "openai_compatible" ? (
            <>
              <SmallField
                label="Base URL"
                hint="Must be https. We resolve the host and refuse private or loopback addresses."
              >
                <Input
                  value={draft.baseUrl}
                  onChange={(e) => set({ baseUrl: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  disabled={disabled}
                />
              </SmallField>
              <SmallField label="Model" hint="The model your endpoint serves.">
                <Input
                  value={draft.model}
                  onChange={(e) => set({ model: e.target.value })}
                  placeholder="llama3.1:70b"
                  disabled={disabled}
                />
              </SmallField>
              <SmallField
                label="API key"
                hint="Optional — a local Ollama needs none. Stored encrypted; never shown again."
              >
                <Input
                  type="password"
                  value={draft.apiKey}
                  onChange={(e) => set({ apiKey: e.target.value })}
                  autoComplete="off"
                  placeholder="sk-…"
                  disabled={disabled}
                />
              </SmallField>
              <p className="text-muted-foreground text-[11px]">
                Runs on the API path — the Claude Code subscription runner is the Claude CLI and
                can&apos;t speak this protocol.
              </p>
            </>
          ) : null}

          {draft.provider === "anthropic" ? (
            <SmallField
              label="Model (optional)"
              hint="Blank uses your account's default. `opus`, `sonnet`, or `haiku` pick the best your plan allows."
            >
              <Input
                value={draft.model}
                onChange={(e) => set({ model: e.target.value })}
                placeholder="sonnet"
                disabled={disabled}
              />
            </SmallField>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SmallField({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium">{label}</span>
      {children}
      <span className="text-muted-foreground block text-[11px]">{hint}</span>
    </label>
  );
}
