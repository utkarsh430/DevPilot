"use client";

// Platform secrets manager — a "bring your own keys" surface for the whole
// workspace. Every catalog key is a row grouped by area; editable keys get an
// inline masked editor (set/update/remove a per-tenant override), and bootstrap
// / shared-infra keys render read-only ("Managed in env"). Values never reach
// the client — only masked tails (last ≤4 chars) from a security-definer RPC.
//
// Refresh model: refetch the overview after every mutation (+ a manual button).
// We don't subscribe to realtime here — the table has no member-read RLS policy
// (values are service-role-only), so a postgres_changes subscription wouldn't
// deliver; the refetch-after-write path is the source of truth.

import * as React from "react";
import { Bot, Eye, EyeOff, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import {
  PLATFORM_SECRET_GROUP_ORDER,
  type PlatformSecretCatalogEntry,
  type PlatformSecretGroup,
} from "@/lib/platform-secrets/catalog";
import { isAgentShareableKey } from "@/lib/platform-secrets/agent-shared";
import type { PlatformSecretsOverview } from "@/lib/platform-secrets/store";
import type { VercelConnectionStatus } from "@/lib/vercel/connection";
import { VercelPreflightCard } from "./vercel-preflight-card";
import {
  deletePlatformSecretAction,
  getPlatformSecretsOverviewAction,
  setPlatformSecretAction,
} from "./secret-actions";

type RowModel = PlatformSecretCatalogEntry & {
  configured: boolean;
  tail: string | null;
  /** An instance-wide default exists (set from Settings → Setup). */
  instanceConfigured: boolean;
};

function buildRows(o: PlatformSecretsOverview): RowModel[] {
  const tailByKey = new Map(o.configured.map((c) => [c.key, c.tail]));
  const configuredSet = new Set(o.configured.map((c) => c.key));
  const instanceSet = new Set((o.instanceConfigured ?? []).map((c) => c.key));
  return o.catalog.map((e) => ({
    ...e,
    configured: configuredSet.has(e.key),
    tail: tailByKey.get(e.key) ?? null,
    instanceConfigured: instanceSet.has(e.key),
  }));
}

export function PlatformSecretsClient({
  initial,
  isOperator,
  vercelTokenConfigured,
  vercelConnection,
  vercelIntegrationConfigured,
}: {
  initial: PlatformSecretsOverview;
  /** Owner/admin of the install's first tenant — gates `operatorOnly` rows. */
  isOperator: boolean;
  vercelTokenConfigured: boolean;
  /** Metadata only — never carries a token. */
  vercelConnection: VercelConnectionStatus;
  vercelIntegrationConfigured: boolean;
}) {
  const [overview, setOverview] = React.useState(initial);
  const [refreshing, setRefreshing] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await getPlatformSecretsOverviewAction();
      if (res.ok) setOverview(res.value);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const rows = React.useMemo(() => buildRows(overview), [overview]);
  const editable = rows.filter((r) => r.editable);
  const overrides = editable.filter((r) => r.configured).length;

  const byGroup = React.useMemo(() => {
    const m = new Map<PlatformSecretGroup, RowModel[]>();
    for (const r of rows) {
      const arr = m.get(r.group) ?? [];
      arr.push(r);
      m.set(r.group, arr);
    }
    return m;
  }, [rows]);

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <KeyRound className="text-muted-foreground h-5 w-5" />
            <h1 className="font-display text-xl font-bold tracking-tight">Platform secrets</h1>
          </div>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            Credentials &amp; config this workspace uses. Values are stored encrypted and resolved
            at runtime as <span className="font-medium">your override → environment default</span>.
            Bootstrap and shared-infrastructure keys are managed in the environment and shown
            read-only.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </header>

      <div className="text-muted-foreground mb-5 text-xs">
        {overrides} of {editable.length} editable keys overridden for this workspace · the rest use
        the environment default.
      </div>

      <VercelPreflightCard
        tokenConfigured={vercelTokenConfigured}
        isOperator={isOperator}
        connection={vercelConnection}
        integrationConfigured={vercelIntegrationConfigured}
      />

      <div className="space-y-7">
        {PLATFORM_SECRET_GROUP_ORDER.map((group) => {
          const groupRows = byGroup.get(group);
          if (!groupRows || groupRows.length === 0) return null;
          return (
            <section key={group}>
              <h2 className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-wider">
                {group}
              </h2>
              <ul className="space-y-2.5">
                {groupRows.map((row) => (
                  <SecretRow
                    key={row.key}
                    row={row}
                    isOperator={isOperator}
                    onChanged={() => void refresh()}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ReqBadge({ required }: { required: boolean }) {
  return required ? <Badge tone="warn">Required</Badge> : <Badge tone="muted">Optional</Badge>;
}

function StatusBadge({ row }: { row: RowModel }) {
  if (!row.editable) return <Badge tone="muted">Managed in env</Badge>;
  if (row.configured) {
    return (
      <Badge tone="ok">
        <span className="font-mono">{row.secret ? `••••${row.tail ?? ""}` : "set"}</span> using
        yours
      </Badge>
    );
  }
  if (row.instanceConfigured) return <Badge tone="info">Instance default set</Badge>;
  return <Badge tone="muted">Env default</Badge>;
}

function SecretRow({
  row,
  isOperator,
  onChanged,
}: {
  row: RowModel;
  isOperator: boolean;
  onChanged: () => void;
}) {
  const [value, setValue] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // An `operatorOnly` key is refused server-side for a non-operator. Rendering
  // the editor anyway would let someone paste a credential and only then be
  // told no — so the row goes read-only with the reason stated. This is UI
  // honesty, NOT the control: the gate in `secret-actions.ts` is.
  const locked = row.operatorOnly === true && !isOperator;

  // "Which of my credentials are exposed to autonomous agents" is not something
  // an operator should have to infer from code — a wrong belief there stays
  // wrong for months. Every shared key is badged AND spells out the consequence
  // inline. Derived from the same predicate the dispatch path uses, so the badge
  // cannot drift from the behaviour.
  const agentShared = isAgentShareableKey(row.key);

  async function onSave() {
    const v = value.trim();
    if (v.length === 0) {
      toast.error("Value can't be empty");
      return;
    }
    setBusy(true);
    const res = await setPlatformSecretAction({ secretKey: row.key, value: v });
    setBusy(false);
    if (!res.ok) {
      toast.error(`Couldn't save ${row.key}`, { description: res.error });
      return;
    }
    toast.success(`${row.configured ? "Updated" : "Saved"} ${row.key}`);
    setValue("");
    setShow(false);
    onChanged();
  }

  async function onRemove() {
    if (
      !confirm(
        `Remove your ${row.key} override? This workspace falls back to the environment default.`,
      )
    ) {
      return;
    }
    setBusy(true);
    const res = await deletePlatformSecretAction({ secretKey: row.key });
    setBusy(false);
    if (!res.ok) {
      toast.error(`Couldn't remove ${row.key}`, { description: res.error });
      return;
    }
    toast.success(`Removed ${row.key} override`);
    onChanged();
  }

  return (
    <li className="border-border bg-card/40 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium">{row.label}</span>
          <code className="bg-muted text-muted-foreground rounded px-1 py-0.5 font-mono text-[9px]">
            {row.key}
          </code>
          <ReqBadge required={row.required} />
          {agentShared ? (
            <Badge tone="warn">
              <Bot className="h-3 w-3" />
              Agents can read
            </Badge>
          ) : null}
        </div>
        <StatusBadge row={row} />
      </div>

      <p className="text-muted-foreground mt-1 text-[11px] leading-snug">
        {row.description}
        {row.url ? (
          <>
            {" "}
            <a
              href={row.url}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-foreground underline underline-offset-2"
            >
              {row.url.replace(/^https?:\/\//, "")}
            </a>
          </>
        ) : null}
      </p>

      {agentShared ? (
        <p className="text-warning mt-2 text-[11px] leading-snug">
          <span className="font-medium">Shared with agents.</span> This value is placed in every
          project&apos;s agent environment (and workspace <code>.env.local</code>) when that project
          does not define <code>{row.key}</code> itself — a project value always wins. Any agent
          running on this workspace can read it.
        </p>
      ) : null}

      {row.editable && locked ? (
        <p className="text-muted-foreground mt-2 text-[11px] italic">
          Only an instance operator can change this key.
        </p>
      ) : null}

      {row.editable && !locked ? (
        <div className="mt-2 flex items-center gap-1.5">
          <div className="relative flex-1">
            <Input
              type={show || !row.secret ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              placeholder={
                row.configured
                  ? row.secret
                    ? `New value (current ••••${row.tail ?? ""})`
                    : "New value (override set)"
                  : "Paste a value to override the env default"
              }
              className="pr-9 font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void onSave();
                }
              }}
            />
            {row.secret ? (
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
            onClick={() => void onSave()}
            disabled={busy || value.trim().length === 0}
          >
            {row.configured ? "Update" : "Save"}
          </Button>
          {row.configured ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void onRemove()}
              disabled={busy}
              aria-label={`Remove ${row.key}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
