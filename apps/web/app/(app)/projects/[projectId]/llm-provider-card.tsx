"use client";

// WI-12 — per-project LLM provider settings card.
//
// Three states, and the default one is "inherit": a project that has never been
// touched here shows the workspace default and changes nothing. Selecting
// Anthropic pins the project to Claude (and optionally to a specific model);
// selecting the OpenAI-compatible provider asks for the endpoint, the model, and
// an optional key.
//
// The API key is WRITE-ONLY from this surface. We render whether one is
// configured, never the value — the server action puts it straight into the
// encrypted per-project vault and no read path returns it.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Cpu, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { LLM_PROVIDER_META, type LlmProvider } from "@/lib/llm/provider";
import { setProjectLlmProviderAction } from "./llm-actions";

type Selection = LlmProvider | "inherit";

export function LlmProviderCard({
  projectId,
  initialProvider,
  initialBaseUrl,
  initialModel,
  hasCredential,
}: {
  projectId: string;
  initialProvider: LlmProvider | null;
  initialBaseUrl: string | null;
  initialModel: string | null;
  /** Whether a provider key is stored in this project's vault. The VALUE never
   *  crosses this boundary — only its existence. */
  hasCredential: boolean;
}) {
  const router = useRouter();
  const [selection, setSelection] = React.useState<Selection>(initialProvider ?? "inherit");
  const [baseUrl, setBaseUrl] = React.useState(initialBaseUrl ?? "");
  const [model, setModel] = React.useState(initialModel ?? "");
  const [apiKey, setApiKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function onSave() {
    setBusy(true);
    const res = await setProjectLlmProviderAction({
      projectId,
      provider: selection === "inherit" ? null : selection,
      baseUrl: selection === "openai_compatible" ? baseUrl : null,
      model: model.trim().length > 0 ? model.trim() : null,
      // Undefined leaves an existing key untouched, so the operator can edit the
      // URL without re-pasting the secret.
      apiKey: apiKey.length > 0 ? apiKey : undefined,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error("Couldn't save the LLM provider", { description: res.error });
      return;
    }
    setApiKey("");
    toast.success(
      res.provider === null
        ? "Cleared — this project uses the workspace default provider."
        : `Provider set to ${LLM_PROVIDER_META[res.provider].label}.`,
    );
    router.refresh();
  }

  const openai = selection === "openai_compatible";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="text-muted-foreground h-4 w-4" />
          LLM provider
        </CardTitle>
        <CardDescription>
          Which model endpoint this project&apos;s agents talk to. Leave it on the workspace default
          unless you need a specific one.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <ProviderOption
            selected={selection === "inherit"}
            onSelect={() => setSelection("inherit")}
            label="Workspace default"
            tagline="Inherit the provider configured for this workspace (Settings → LLM auth). Recommended."
          />
          {(["anthropic", "openai_compatible"] as const).map((p) => (
            <ProviderOption
              key={p}
              selected={selection === p}
              onSelect={() => setSelection(p)}
              label={LLM_PROVIDER_META[p].label}
              tagline={LLM_PROVIDER_META[p].tagline}
            />
          ))}
        </div>

        {openai ? (
          <div className="space-y-3 rounded-lg border p-4">
            <Field
              label="Base URL"
              hint="Must be https. We resolve the host and refuse any private or loopback address."
            >
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                disabled={busy}
              />
            </Field>
            <Field label="Model" hint="The model your endpoint serves.">
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="llama3.1:70b"
                disabled={busy}
              />
            </Field>
            <Field
              label="API key"
              hint={
                hasCredential
                  ? "A key is stored, encrypted. Type a new one to replace it, or leave blank to keep it."
                  : "Optional — a local Ollama needs none. Stored encrypted; never shown again."
              }
            >
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasCredential ? "••••••••" : "sk-…"}
                autoComplete="off"
                disabled={busy}
              />
            </Field>
            {hasCredential ? (
              <Badge tone="info" className="text-[10px]">
                <ShieldCheck className="mr-1 h-3 w-3" />
                Key configured
              </Badge>
            ) : null}
            <p className="text-muted-foreground text-[11px]">
              An OpenAI-compatible project runs on the API path. The Claude Code subscription runner
              is the Claude CLI and can&apos;t speak this protocol, so those steps route to the API
              runner instead.
            </p>
          </div>
        ) : null}

        {selection === "anthropic" ? (
          <div className="space-y-3 rounded-lg border p-4">
            <Field
              label="Model (optional)"
              hint="Leave blank to use your account's default — that's today's behaviour. `opus`, `sonnet`, or `haiku` pick the best model your plan allows."
            >
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="sonnet"
                disabled={busy}
              />
            </Field>
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button onClick={() => void onSave()} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ProviderOption({
  selected,
  onSelect,
  label,
  tagline,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  tagline: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={
        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors " +
        (selected ? "border-primary bg-primary/5" : "hover:border-foreground/30")
      }
    >
      <span
        className={
          "mt-1 h-3 w-3 shrink-0 rounded-full border " +
          (selected ? "border-primary bg-primary" : "border-muted-foreground/40")
        }
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-muted-foreground text-xs">{tagline}</span>
      </span>
    </button>
  );
}

function Field({
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
      <span className="text-sm font-medium">{label}</span>
      {children}
      <span className="text-muted-foreground block text-[11px]">{hint}</span>
    </label>
  );
}
