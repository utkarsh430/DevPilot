"use client";

// Phase 1 / M14 — client UI for the API keys page.
// Owns the create/revoke flow and the "show secret once" affordance.

import Link from "next/link";
import * as React from "react";
import { Check, Copy, KeyRound, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/sonner";
import { relativeTime } from "@/lib/relative-time";
import { createApiKeyAction, createWidgetTokenAction, revokeApiKeyAction } from "./actions";

export type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  scope: "api" | "widget";
  agentId: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type AgentOption = { id: string; name: string; role: string | null };

type Reveal =
  | { kind: "none" }
  | { kind: "api"; name: string; cleartext: string }
  | { kind: "widget"; agentId: string; cleartext: string };

type CreateMode = "api" | "widget";

export function KeyList({ initial, agents }: { initial: KeyRow[]; agents: AgentOption[] }) {
  const [rows, setRows] = React.useState<KeyRow[]>(initial);
  const [reveal, setReveal] = React.useState<Reveal>({ kind: "none" });
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createMode, setCreateMode] = React.useState<CreateMode>("api");
  const [newName, setNewName] = React.useState("");
  const [widgetAgent, setWidgetAgent] = React.useState<string>(agents[0]?.id ?? "");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = React.useState<KeyRow | null>(null);
  const [copied, setCopied] = React.useState(false);

  function closeCreate() {
    setCreateOpen(false);
    setNewName("");
    setErr(null);
  }

  async function onCreateApi() {
    setErr(null);
    if (!newName.trim()) {
      setErr("Name is required");
      return;
    }
    setBusy(true);
    const res = await createApiKeyAction({ name: newName.trim() });
    setBusy(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    setReveal({ kind: "api", name: res.name, cleartext: res.cleartext });
    setRows((prev) => [
      {
        id: res.id,
        name: res.name,
        prefix: res.prefix,
        scope: "api",
        agentId: null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date().toISOString(),
      },
      ...prev,
    ]);
    setNewName("");
    setCreateOpen(false);
  }

  async function onCreateWidget() {
    setErr(null);
    if (!widgetAgent) {
      setErr("Pick an agent");
      return;
    }
    setBusy(true);
    const res = await createWidgetTokenAction({ agentId: widgetAgent });
    setBusy(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    setReveal({ kind: "widget", agentId: res.agentId, cleartext: res.cleartext });
    setRows((prev) => [
      {
        id: res.id,
        name: `widget:${agents.find((a) => a.id === res.agentId)?.name ?? res.agentId.slice(0, 8)}`,
        prefix: res.prefix,
        scope: "widget",
        agentId: res.agentId,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date().toISOString(),
      },
      ...prev,
    ]);
    setCreateOpen(false);
  }

  async function confirmRevoke() {
    if (!pendingRevoke) return;
    const id = pendingRevoke.id;
    setBusy(true);
    const res = await revokeApiKeyAction({ id });
    setBusy(false);
    setPendingRevoke(null);
    if (!res.ok) {
      toast.error("Revoke failed", { description: res.error });
      return;
    }
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, revokedAt: new Date().toISOString() } : r)),
    );
    toast.success("Key revoked", {
      description: "New requests using this key will be refused.",
    });
  }

  async function copyReveal() {
    if (reveal.kind === "none") return;
    try {
      await navigator.clipboard?.writeText(reveal.cleartext);
      setCopied(true);
      toast.success("Copied to clipboard");
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Couldn't copy — select the text and copy manually");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setCreateMode("api");
            setCreateOpen(true);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          Create new key
        </Button>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold">
              Existing keys <span className="text-muted-foreground">({rows.length})</span>
            </h2>
            <p className="text-muted-foreground text-xs">
              Revoked keys remain visible for audit but cannot authenticate.
            </p>
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-center text-sm">
            <KeyRound className="h-5 w-5" />
            No keys yet. Create one to start hitting the public API.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className={r.revokedAt ? "opacity-60" : undefined}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="text-foreground font-medium">{r.name}</span>
                      {r.revokedAt ? (
                        <Badge tone="danger" className="uppercase">
                          revoked
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <code className="text-muted-foreground font-mono text-xs">
                      ace_{r.prefix}_…
                    </code>
                  </TableCell>
                  <TableCell>
                    <Badge tone={r.scope === "widget" ? "violet" : "info"}>{r.scope}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {r.lastUsedAt ? relativeTime(r.lastUsedAt) : "never"}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {relativeTime(r.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {!r.revokedAt ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setPendingRevoke(r)}
                            disabled={busy}
                            aria-label="Revoke key"
                          >
                            <Trash2 className="text-destructive h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Revoke key</TooltipContent>
                      </Tooltip>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Create dialog — API or widget token in one place. */}
      <Dialog open={createOpen} onOpenChange={(o) => (o ? setCreateOpen(true) : closeCreate())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new key</DialogTitle>
            <DialogDescription>
              The full secret is shown once after creation. Store it in a password manager or your
              deployment&apos;s secret store.
            </DialogDescription>
          </DialogHeader>

          <div className="bg-muted/30 flex gap-2 rounded-md border p-1 text-xs">
            <button
              type="button"
              onClick={() => setCreateMode("api")}
              className={
                "flex-1 rounded px-3 py-1.5 font-medium transition-colors " +
                (createMode === "api"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              API key
            </button>
            <button
              type="button"
              onClick={() => setCreateMode("widget")}
              className={
                "flex-1 rounded px-3 py-1.5 font-medium transition-colors " +
                (createMode === "widget"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              Widget token
            </button>
          </div>

          {createMode === "api" ? (
            <div className="flex flex-col gap-2">
              <label className="text-muted-foreground text-xs font-medium" htmlFor="key-name">
                Name
              </label>
              <Input
                id="key-name"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. production-backend"
                disabled={busy}
              />
              <p className="text-muted-foreground text-xs">
                Full-surface key. Grants access to{" "}
                <code className="font-mono">/v1/agents/&lt;id&gt;/runs</code> and{" "}
                <code className="font-mono">/v1/chat/completions</code>.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label className="text-muted-foreground text-xs font-medium" htmlFor="widget-agent">
                Agent
              </label>
              {agents.length === 0 ? (
                <p className="border-warning/30 bg-warning/10 text-warning rounded-md border px-3 py-2 text-xs">
                  No agents in this tenant yet. Create one via{" "}
                  <Link className="underline" href="/agents/new">
                    /agents/new
                  </Link>{" "}
                  first.
                </p>
              ) : (
                <select
                  id="widget-agent"
                  value={widgetAgent}
                  onChange={(e) => setWidgetAgent(e.target.value)}
                  className="border-input bg-background focus-visible:ring-ring flex h-9 w-full rounded-md border px-2 text-sm focus-visible:outline-none focus-visible:ring-2"
                  disabled={busy}
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} {a.role ? `(${a.role})` : ""}
                    </option>
                  ))}
                </select>
              )}
              <p className="text-muted-foreground text-xs">
                Single-agent scoped token used by the embeddable widget at{" "}
                <code className="font-mono">/widget/&lt;agentId&gt;</code>. Cannot call the full
                agent surface.
              </p>
            </div>
          )}

          {err ? (
            <p
              role="alert"
              className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
            >
              {err}
            </p>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={closeCreate} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={createMode === "api" ? onCreateApi : onCreateWidget}
              disabled={
                busy || (createMode === "api" ? newName.trim().length === 0 : agents.length === 0)
              }
            >
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time reveal dialog — copy now or lose it. */}
      <Dialog
        open={reveal.kind !== "none"}
        onOpenChange={(o) => {
          if (!o) setReveal({ kind: "none" });
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="text-warning h-4 w-4" />
              Copy your new {reveal.kind === "widget" ? "widget token" : "API key"}
            </DialogTitle>
            <DialogDescription>
              This is the only time the full secret will be shown. If you close this dialog without
              copying, you&apos;ll need to create a new key.
            </DialogDescription>
          </DialogHeader>
          {reveal.kind !== "none" ? (
            <div className="flex flex-col gap-2">
              <div className="bg-muted/40 rounded-md border p-3">
                <code className="text-foreground block break-all font-mono text-xs">
                  {reveal.cleartext}
                </code>
              </div>
              <Button
                variant={copied ? "secondary" : "primary"}
                size="sm"
                onClick={copyReveal}
                className="w-full"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy to clipboard
                  </>
                )}
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setReveal({ kind: "none" })}>
              I&apos;ve saved it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm-revoke dialog. */}
      <Dialog
        open={pendingRevoke !== null}
        onOpenChange={(o) => {
          if (!o) setPendingRevoke(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke this key?</DialogTitle>
            <DialogDescription>
              In-flight requests using{" "}
              <code className="font-mono text-xs">ace_{pendingRevoke?.prefix ?? ""}_…</code> will
              continue, but new ones will be refused with a 401. This cannot be undone — issue a new
              key if you need to restore access.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingRevoke(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmRevoke} disabled={busy}>
              {busy ? "Revoking…" : "Revoke key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
