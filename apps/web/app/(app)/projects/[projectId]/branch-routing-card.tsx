"use client";

// Phase 2.5+ / Slice IB — Branch routing card for the project detail page.
//
// Two affordances live on this card:
//
//   • Show the production branch (projects.default_branch) and the optional
//     integration branch (projects.integration_branch). An "Edit" pencil
//     opens a dialog to set/clear the integration branch — clearing falls
//     back to legacy "cut from default_branch" behavior.
//
//   • When an integration branch is set, render a "Promote integration →
//     production" button. The promote dialog offers two strategies inside
//     one confirm: open a GitHub PR (default, respects branch protection)
//     or direct-merge via the GitHub API (advanced — bypasses protection).
//
// All state changes hit the server via integration-actions.ts; the page
// is a server component, so we `router.refresh()` after a successful
// mutation to repaint the badges and any related downstream sections
// (pending pushes count, etc).

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Pencil,
  ShieldAlert,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import {
  promoteIntegrationAction,
  setAutoLandEnabledAction,
  setIntegrationBranchAction,
  type PromoteIntegrationStrategy,
} from "./integration-actions";

export function BranchRoutingCard({
  autoLandEnabled,
  projectId,
  defaultBranch,
  integrationBranch,
  canPromote,
  githubOwner,
  githubRepo,
}: {
  projectId: string;
  defaultBranch: string;
  integrationBranch: string | null;
  autoLandEnabled: boolean;
  /** True when there's been at least one successful push since the last
   *  promotion — i.e. there's something to land in production. The page
   *  computes this from the pending_pushes / branch_promotions ledger. */
  canPromote: boolean;
  githubOwner: string | null;
  githubRepo: string | null;
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);
  const [editValue, setEditValue] = React.useState(integrationBranch ?? "");
  const [editSaving, setEditSaving] = React.useState(false);
  const [promoteOpen, setPromoteOpen] = React.useState(false);
  const [promoting, setPromoting] = React.useState<PromoteIntegrationStrategy | null>(null);
  const [autoLand, setAutoLand] = React.useState(autoLandEnabled);
  const [autoLandSaving, setAutoLandSaving] = React.useState(false);

  React.useEffect(() => {
    setAutoLand(autoLandEnabled);
  }, [autoLandEnabled]);

  async function onToggleAutoLand(next: boolean) {
    setAutoLandSaving(true);
    // Optimistic: the switch is the only thing that moves, and we snap it back
    // on failure rather than leaving the operator staring at a stale control.
    setAutoLand(next);
    const res = await setAutoLandEnabledAction({ projectId, enabled: next });
    setAutoLandSaving(false);
    if (!res.ok) {
      setAutoLand(!next);
      toast.error(res.error);
      return;
    }
    toast.success(
      next
        ? `Auto-land on. Done tickets squash-merge into ${integrationBranch} automatically.`
        : "Auto-land off. Tickets go back to the manual push/PR/merge flow.",
    );
    router.refresh();
  }

  React.useEffect(() => {
    if (!editOpen) setEditValue(integrationBranch ?? "");
  }, [integrationBranch, editOpen]);

  async function onEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    setEditSaving(true);
    const next = editValue.trim();
    const res = await setIntegrationBranchAction({
      projectId,
      branchName: next.length === 0 ? null : next,
    });
    setEditSaving(false);
    if (!res.ok) {
      toast.error("Couldn't update integration branch", {
        description: res.error,
      });
      return;
    }
    toast.success(
      res.integrationBranch
        ? `Integration branch set to "${res.integrationBranch}"`
        : "Integration branch cleared — back to direct production routing.",
    );
    setEditOpen(false);
    router.refresh();
  }

  async function onPromote(strategy: PromoteIntegrationStrategy) {
    setPromoting(strategy);
    const res = await promoteIntegrationAction({ projectId, strategy });
    setPromoting(null);
    if (!res.ok) {
      toast.error("Promotion failed", { description: res.error });
      return;
    }
    if (res.strategy === "pr" && res.prUrl) {
      toast.success("PR opened", {
        description: `${res.prUrl}`,
        action: {
          label: "Open",
          onClick: () => window.open(res.prUrl, "_blank", "noopener,noreferrer"),
        },
      });
    } else if (res.strategy === "direct") {
      if (res.alreadyUpToDate) {
        toast.info("Nothing to promote — production already up to date.");
      } else {
        toast.success(`Merged into ${defaultBranch} (${(res.mergeSha ?? "").slice(0, 7)}).`);
      }
    }
    setPromoteOpen(false);
    router.refresh();
  }

  const githubHasMetadata = Boolean(githubOwner && githubRepo);

  return (
    <div className="bg-card rounded-xl border">
      <div className="flex items-center justify-between border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <Workflow className="text-muted-foreground h-4 w-4" />
          <span className="text-sm font-medium">Branch routing</span>
        </div>
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
          aria-label="Edit integration branch"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-2">
        <BranchTile
          label="Production"
          branch={defaultBranch}
          hint="The default branch. Promotions land here."
          tone="primary"
        />
        <BranchTile
          label="Integration"
          branch={integrationBranch}
          hint={
            integrationBranch
              ? "Agent ticket branches cut from and PR into this. Operator promotes to production as a separate step."
              : "Not set — agents push directly against production. Set an integration branch (e.g. dev) for a staging buffer."
          }
          tone="muted"
        />
      </div>

      {integrationBranch ? (
        <div className="flex flex-col gap-2 border-t px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-foreground flex items-center gap-2 text-sm font-medium">
              <Workflow className="text-muted-foreground h-3.5 w-3.5" />
              Auto-land
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Squash-merge each done ticket into{" "}
              <span className="font-mono">{integrationBranch}</span> automatically, one at a time,
              in dependency order. Human review stays at{" "}
              <span className="font-mono">{integrationBranch}</span> →{" "}
              <span className="font-mono">{defaultBranch}</span>.
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="accent-primary h-4 w-4"
              checked={autoLand}
              disabled={autoLandSaving || !githubHasMetadata}
              onChange={(e) => void onToggleAutoLand(e.target.checked)}
            />
            <span className="text-muted-foreground">{autoLand ? "Enabled" : "Disabled"}</span>
          </label>
        </div>
      ) : null}

      {/* Half-configured notice — an integration branch is set but auto-land is
          off, so done tickets pile up unmerged and every dependent waits. Make
          that state visible instead of silently inert. */}
      {integrationBranch && !autoLand ? (
        <div className="border-warning/40 bg-warning/10 flex items-start gap-2 border-t px-5 py-3">
          <AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
          <div className="text-foreground/90 text-xs">
            <span className="font-medium">Half-configured.</span>{" "}
            {githubHasMetadata ? (
              <>
                Integration branch <span className="font-mono">{integrationBranch}</span> is set,
                but auto-land is off — done tickets won&apos;t squash-merge into it and dependents
                that <span className="font-mono">build on</span> them will wait. Enable auto-land
                above to arm the pipeline.
              </>
            ) : (
              <>
                Integration branch <span className="font-mono">{integrationBranch}</span> is set,
                but this project isn&apos;t connected to a GitHub repo yet, so auto-land can&apos;t
                be enabled. Connect the repo (Settings → GitHub), then turn on auto-land above.
              </>
            )}
          </div>
        </div>
      ) : null}

      {integrationBranch ? (
        <div className="bg-muted/30 flex flex-col gap-2 border-t px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-muted-foreground text-xs">
            Ready to land work in <span className="font-mono">{defaultBranch}</span>? Promotion
            opens a PR by default; direct merge available as an advanced option.
          </div>
          <Button
            size="sm"
            onClick={() => setPromoteOpen(true)}
            disabled={!canPromote || !githubHasMetadata}
            aria-disabled={!canPromote || !githubHasMetadata}
          >
            Promote <ArrowRight className="h-3 w-3" />
          </Button>
        </div>
      ) : null}

      {/* Edit integration branch dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogTitle>Integration branch</DialogTitle>
          <DialogDescription>
            Set the branch agents push into before production. Common names:{" "}
            <span className="font-mono">dev</span>, <span className="font-mono">develop</span>,{" "}
            <span className="font-mono">staging</span>. Leave empty to clear.
          </DialogDescription>
          <form onSubmit={onEditSubmit} className="mt-4 space-y-4">
            <Input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              placeholder={defaultBranch === "main" ? "dev" : "integration"}
              disabled={editSaving}
            />
            <div className="text-muted-foreground text-[11px]">
              <p>
                Production stays as <span className="font-mono">{defaultBranch}</span>. This setting
                only affects ticket branches dispatched <em>after</em> the save — in-flight tickets
                keep their current base.
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditOpen(false)}
                disabled={editSaving}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={editSaving}>
                {editSaving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Promote dialog */}
      <Dialog open={promoteOpen} onOpenChange={setPromoteOpen}>
        <DialogContent>
          <DialogTitle>
            Promote <span className="font-mono">{integrationBranch}</span> →{" "}
            <span className="font-mono">{defaultBranch}</span>
          </DialogTitle>
          <DialogDescription>Pick how this promotion lands in production.</DialogDescription>
          <div className="mt-4 space-y-3">
            <button
              type="button"
              onClick={() => onPromote("pr")}
              disabled={promoting !== null}
              className="bg-card hover:border-foreground/30 group flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors disabled:opacity-60"
            >
              <span className="bg-primary/10 text-primary mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md">
                <GitPullRequest className="h-4 w-4" />
              </span>
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-sm font-medium">
                  Open a pull request
                  <Badge tone="info" className="text-[10px]">
                    Recommended
                  </Badge>
                </span>
                <span className="text-muted-foreground text-xs">
                  DevPilot opens a PR. Branch protection, CODEOWNERS, and required reviews all
                  apply. Merge it on github.com when ready.
                </span>
                {promoting === "pr" ? (
                  <span className="text-muted-foreground mt-1 text-[11px]">Opening PR…</span>
                ) : null}
              </span>
              <ExternalLink className="text-muted-foreground mt-1 h-3 w-3" />
            </button>

            <button
              type="button"
              onClick={() => onPromote("direct")}
              disabled={promoting !== null}
              className="bg-card hover:border-foreground/30 group flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors disabled:opacity-60"
            >
              <span className="bg-warning/10 text-warning mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md">
                <ShieldAlert className="h-4 w-4" />
              </span>
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">Direct merge</span>
                <span className="text-muted-foreground text-xs">
                  DevPilot merges <span className="font-mono">{integrationBranch}</span> into{" "}
                  <span className="font-mono">{defaultBranch}</span> via the GitHub API. Bypasses
                  branch protection. Use only when you don&apos;t need a review step.
                </span>
                {promoting === "direct" ? (
                  <span className="text-muted-foreground mt-1 text-[11px]">Merging…</span>
                ) : null}
              </span>
            </button>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPromoteOpen(false)}
              disabled={promoting !== null}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BranchTile({
  label,
  branch,
  hint,
  tone,
}: {
  label: string;
  branch: string | null;
  hint: string;
  tone: "primary" | "muted";
}) {
  return (
    <div className="bg-background/40 rounded-lg border p-4">
      <div className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
        {label}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <GitBranch
          className={
            "h-4 w-4 " + (tone === "primary" ? "text-foreground" : "text-muted-foreground")
          }
        />
        {branch ? (
          <code className="text-sm font-medium">{branch}</code>
        ) : (
          <span className="text-muted-foreground text-sm italic">none</span>
        )}
      </div>
      <p className="text-muted-foreground mt-2 text-[11px]">{hint}</p>
    </div>
  );
}
