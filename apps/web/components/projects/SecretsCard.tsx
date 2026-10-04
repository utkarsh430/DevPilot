"use client";

// Phase 2.5++ — Per-project environment & secrets manager.
//
// A "bring your own keys" surface: every env key the project DECLARES (parsed
// from .env.example by the runner on a localhost run, stored in
// projects.env_catalog) is shown as a row alongside any keys the operator has
// set — each with its KEY name, a Required / Optional / Custom label, a status
// (Configured ••••tail / Not set), the .env.example description, and an inline
// masked input to set/update + a Remove control.
//
// Values never reach the client: the list of configured keys + masked tails
// (last ≤4 chars) is derived server-side (decrypt the AES bytea, keep only the
// tail); full values flow only to the runner via the engine-only
// loadProjectSecretsJson path.
//
// Realtime: subscribes to `project_secrets` so cross-tab edits re-fetch.

import * as React from "react";
import { Eye, EyeOff, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { supabaseBrowser } from "@/lib/db/browser";
import type { ProjectSecretsOverview } from "@/lib/projects/secrets";
import {
  deleteProjectSecretAction,
  getProjectSecretsOverviewAction,
  setProjectSecretAction,
} from "@/app/(app)/projects/[projectId]/secret-actions";

type Props = {
  projectId: string;
  tenantId: string;
  initial: ProjectSecretsOverview;
};

// A merged row: catalog ∪ configured. `required` is null for "custom" keys —
// ones the operator set that the project doesn't declare in .env.example.
type SecretRowModel = {
  key: string;
  required: boolean | null;
  description: string | null;
  configured: boolean;
  tail: string | null;
};

function buildRows(o: ProjectSecretsOverview): SecretRowModel[] {
  const byKey = new Map<string, SecretRowModel>();
  for (const c of o.catalog) {
    byKey.set(c.key, {
      key: c.key,
      required: c.required,
      description: c.description,
      configured: false,
      tail: null,
    });
  }
  for (const s of o.configured) {
    const existing = byKey.get(s.key);
    if (existing) {
      existing.configured = true;
      existing.tail = s.tail;
    } else {
      byKey.set(s.key, {
        key: s.key,
        required: null, // not declared → custom
        description: null,
        configured: true,
        tail: s.tail,
      });
    }
  }
  // Sort: missing-required first (the action items), then missing-optional,
  // then configured-declared, then custom. Alphabetical within each bucket.
  const rank = (r: SecretRowModel): number => {
    if (!r.configured && r.required === true) return 0;
    if (!r.configured && r.required === false) return 1;
    if (r.configured && r.required !== null) return 2;
    return 3;
  };
  return [...byKey.values()].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}

export function SecretsCard({ projectId, initial }: Props) {
  const [overview, setOverview] = React.useState<ProjectSecretsOverview>(initial);
  const [adding, setAdding] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  // Per-mount suffix to avoid Supabase realtime channel-name collisions when
  // multiple instances of this card mount in the same page. Same pattern as
  // `useLivePendingPushes`.
  const channelSuffix = React.useId();

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await getProjectSecretsOverviewAction({ projectId });
      if (res.ok) setOverview(res.value);
    } finally {
      setRefreshing(false);
    }
  }, [projectId]);

  // Realtime: when another tab inserts/updates/deletes a secret, re-fetch.
  React.useEffect(() => {
    const sb = supabaseBrowser();
    const channel = sb
      .channel(`project-secrets:${projectId}:${channelSuffix}`)
      .on(
        "postgres_changes" as never,
        {
          event: "*",
          schema: "public",
          table: "project_secrets",
          filter: `project_id=eq.${projectId}`,
        },
        () => {
          void refresh();
        },
      )
      .subscribe();
    return () => {
      void sb.removeChannel(channel);
    };
  }, [projectId, channelSuffix, refresh]);

  const rows = React.useMemo(() => buildRows(overview), [overview]);
  const requiredMissing = rows.filter((r) => !r.configured && r.required === true).length;
  const configuredCount = rows.filter((r) => r.configured).length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" /> Environment &amp; secrets
          </CardTitle>
          <CardDescription>
            Keys the project declares in <code>.env.example</code> plus your own. Written to{" "}
            <code>.env.local</code> in the agent&apos;s workspace and injected into{" "}
            <code>pnpm dev</code>. Values never leave the engine.
          </CardDescription>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add custom key
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length > 0 && (
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-[11px]">
            {requiredMissing > 0 ? (
              <Badge tone="warn">{requiredMissing} required missing</Badge>
            ) : (
              <Badge tone="ok">All required keys set</Badge>
            )}
            <span>
              {configuredCount} configured · {rows.length} total
            </span>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No keys yet. Run the project on localhost once to detect the keys it declares in{" "}
            <code>.env.example</code>, or add a custom key now.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {rows.map((row) => (
              <SecretRow
                key={row.key}
                projectId={projectId}
                row={row}
                onChanged={() => void refresh()}
              />
            ))}
          </ul>
        )}
      </CardContent>
      <SecretFormDialog
        open={adding}
        onOpenChange={setAdding}
        projectId={projectId}
        onSuccess={() => void refresh()}
      />
    </Card>
  );
}

function TypeBadge({ required }: { required: boolean | null }) {
  if (required === null) return <Badge tone="violet">Custom</Badge>;
  if (required) return <Badge tone="warn">Required</Badge>;
  return <Badge tone="muted">Optional</Badge>;
}

function StatusBadge({ configured, tail }: { configured: boolean; tail: string | null }) {
  if (configured) {
    return (
      <Badge tone="ok">
        <span className="font-mono">••••{tail ?? ""}</span> configured
      </Badge>
    );
  }
  return <Badge tone="muted">Not set</Badge>;
}

function SecretRow({
  projectId,
  row,
  onChanged,
}: {
  projectId: string;
  row: SecretRowModel;
  onChanged: () => void;
}) {
  const [value, setValue] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  async function onSave() {
    const v = value.trim();
    if (v.length === 0) {
      toast.error("Value can't be empty");
      return;
    }
    setBusy(true);
    const res = await setProjectSecretAction({ projectId, secretKey: row.key, value: v });
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
    if (!confirm(`Remove ${row.key}? Agents lose access on next dispatch.`)) return;
    setBusy(true);
    const res = await deleteProjectSecretAction({ projectId, secretKey: row.key });
    setBusy(false);
    if (!res.ok) {
      toast.error(`Couldn't remove ${row.key}`, { description: res.error });
      return;
    }
    toast.success(`Removed ${row.key}`);
    onChanged();
  }

  return (
    <li className="border-border bg-card/40 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <code className="truncate font-mono text-sm font-semibold">{row.key}</code>
          <TypeBadge required={row.required} />
        </div>
        <StatusBadge configured={row.configured} tail={row.tail} />
      </div>
      {row.description && (
        <p className="text-muted-foreground mt-1 text-[11px] leading-snug">{row.description}</p>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <div className="relative flex-1">
          <Input
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            placeholder={
              row.configured
                ? `New value (current ••••${row.tail ?? ""})`
                : "Paste value to configure"
            }
            className="pr-9 font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void onSave();
              }
            }}
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShow((s) => !s)}
            className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
            aria-label={show ? "Hide value" : "Show value"}
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <Button
          size="sm"
          onClick={() => void onSave()}
          disabled={busy || value.trim().length === 0}
        >
          {row.configured ? "Update" : "Save"}
        </Button>
        {row.configured && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void onRemove()}
            disabled={busy}
            aria-label={`Remove ${row.key}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </li>
  );
}

function SecretFormDialog({
  open,
  onOpenChange,
  projectId,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  onSuccess?: () => void;
}) {
  const [secretKey, setSecretKey] = React.useState("");
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setSecretKey("");
      setValue("");
    }
  }, [open]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmedKey = secretKey.trim();
    const trimmedVal = value.trim();
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(trimmedKey)) {
      toast.error("Key must be UPPER_SNAKE_CASE (e.g. DATABASE_URL)");
      return;
    }
    if (trimmedVal.length === 0) {
      toast.error("Value can't be empty");
      return;
    }
    setBusy(true);
    const res = await setProjectSecretAction({
      projectId,
      secretKey: trimmedKey,
      value: trimmedVal,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error("Couldn't save secret", { description: res.error });
      return;
    }
    toast.success(`Saved ${trimmedKey}`);
    onOpenChange(false);
    onSuccess?.();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Add a custom key</DialogTitle>
            <DialogDescription>
              For env values the project doesn&apos;t declare in <code>.env.example</code>. The
              value is encrypted at rest (AES-256-GCM) and never leaves the engine.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs font-medium" htmlFor="secret-key">
                Key
              </label>
              <Input
                id="secret-key"
                placeholder="DATABASE_URL"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                disabled={busy}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
              />
            </div>
            <div>
              <label className="text-xs font-medium" htmlFor="secret-value">
                Value
              </label>
              <Input
                id="secret-value"
                type="password"
                placeholder="postgres://…"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
