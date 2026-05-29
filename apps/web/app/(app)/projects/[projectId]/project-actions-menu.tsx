"use client";

// Project header action menu. Houses the operator affordances for a project:
//
//   • Rename project — changes the local display name on the DevPilot side. Has
//     no effect on the GitHub repo. The switcher, list cards, and detail
//     header all re-read from projects.name after router.refresh().
//
//   • Refresh from GitHub — re-queries the GitHub API for the project's
//     stored repo and writes the latest owner/repo/branch/url back. Lets
//     the operator catch up after they renamed or transferred the repo on
//     github.com. Toasts a friendly diff so they can see what moved. When
//     GitHub no longer has the repo (deleted / made private / moved out of
//     token reach), the action returns `code: "repo_gone"` and we turn the
//     dead end into an offer to remove the now-orphaned project from DevPilot.
//
//   • Export project PDF — enqueues the async audit-export job and, once it
//     lands in the private `exports` bucket, downloads it through a short-lived
//     signed URL. Unlike the other items this one is NOT a server action: the
//     render is far too slow for a request, so it goes through a durable Inngest
//     function (see components/export/use-project-export.ts).
//
//   • Delete project — hard-removes the project row on the DevPilot side only.
//     The GitHub repo is NOT touched, and existing tickets are kept
//     (tickets.project_id is ON DELETE SET NULL). Guarded by a type-the-name
//     confirmation because it drops the project's DevPilot-side config (team tier,
//     branch routing, env catalog, secret links). After a delete the current
//     detail page has no project to render, so we leave for /projects.
//
// All actions hit the server via app/(app)/projects/actions.ts and rely on
// `router.refresh()` (or a push) to repaint server components (detail page,
// list cards, switcher).

import * as React from "react";
import { useRouter } from "next/navigation";
import { FileDown, Loader2, MoreHorizontal, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProjectExport } from "@/components/export/use-project-export";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  deleteProjectAction,
  refreshProjectFromGithubAction,
  renameProjectAction,
} from "@/app/(app)/projects/actions";

export function ProjectActionsMenu({
  projectId,
  currentName,
  currentGithubFullName,
}: {
  projectId: string;
  currentName: string;
  /** "owner/repo" — used in the refresh toast diff and the repo-gone /
   *  delete copy. Null when the row was created without github metadata
   *  (legacy connect-by-url path). */
  currentGithubFullName: string | null;
}) {
  const router = useRouter();
  const projectExport = useProjectExport(projectId);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(currentName);
  const [renameSaving, setRenameSaving] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteConfirm, setDeleteConfirm] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);
  // Opened when "Refresh from GitHub" discovers the repo is gone — lets the
  // operator clean up the orphan instead of leaving them at a dead end.
  const [repoGoneOpen, setRepoGoneOpen] = React.useState(false);

  // Keep the rename input in sync with the current name when it changes
  // server-side (e.g. another tab renamed it).
  React.useEffect(() => {
    if (!renameOpen) setRenameValue(currentName);
  }, [currentName, renameOpen]);

  // Reset the type-to-confirm field whenever the delete dialog closes so a
  // re-open always starts empty (the Delete button re-arms).
  React.useEffect(() => {
    if (!deleteOpen) setDeleteConfirm("");
  }, [deleteOpen]);

  async function onRenameSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next = renameValue.trim();
    if (next.length === 0) {
      toast.error("Name can't be empty");
      return;
    }
    if (next === currentName) {
      setRenameOpen(false);
      return;
    }
    setRenameSaving(true);
    const res = await renameProjectAction({ projectId, name: next });
    setRenameSaving(false);
    if (!res.ok) {
      toast.error("Rename failed", { description: res.error });
      return;
    }
    toast.success(`Renamed to "${next}"`);
    setRenameOpen(false);
    router.refresh();
  }

  async function onRefresh() {
    setRefreshing(true);
    const res = await refreshProjectFromGithubAction({ projectId });
    setRefreshing(false);
    if (!res.ok) {
      // Repo no longer reachable on GitHub — offer cleanup instead of a
      // dead-end toast.
      if (res.code === "repo_gone") {
        setRepoGoneOpen(true);
        return;
      }
      toast.error("Refresh failed", { description: res.error });
      return;
    }
    if (!res.value.changed) {
      toast.success("Already up to date with GitHub");
      return;
    }
    const before = res.value.before;
    const after = res.value.after;
    const beforeLabel =
      before.githubOwner && before.githubRepo
        ? `${before.githubOwner}/${before.githubRepo}`
        : (currentGithubFullName ?? "(unknown)");
    const afterLabel = `${after.githubOwner}/${after.githubRepo}`;
    const parts: string[] = [];
    if (beforeLabel !== afterLabel) parts.push(`${beforeLabel} → ${afterLabel}`);
    if (before.defaultBranch !== after.defaultBranch) {
      parts.push(`branch ${before.defaultBranch ?? "?"} → ${after.defaultBranch}`);
    }
    toast.success("Refreshed from GitHub", {
      description: parts.length > 0 ? parts.join(" · ") : "Metadata updated",
    });
    router.refresh();
  }

  // Shared delete path for both the type-to-confirm dialog and the repo-gone
  // offer. On success the current detail page no longer has a project to show,
  // so we leave for the projects list (the layout switcher revalidates too).
  async function runDelete() {
    if (deleting) return;
    setDeleting(true);
    const res = await deleteProjectAction({ projectId });
    if (!res.ok) {
      setDeleting(false);
      toast.error("Delete failed", { description: res.error });
      return;
    }
    setDeleteOpen(false);
    setRepoGoneOpen(false);
    toast.success(`Deleted "${currentName}"`);
    router.push("/projects");
    router.refresh();
    // Leave `deleting` true: we're navigating away, so the buttons stay
    // disabled until this component unmounts (avoids a double-submit flash).
  }

  // Type-the-name gate. Compared trimmed so stray whitespace doesn't block a
  // correct entry.
  const confirmMatches = deleteConfirm.trim() === currentName.trim();
  const repoLabel = currentGithubFullName ?? "This repo";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon-sm" aria-label="Project actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setRenameOpen(true);
            }}
          >
            <Pencil className="mr-2 h-3.5 w-3.5" />
            Rename project…
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={refreshing}
            onSelect={(e) => {
              e.preventDefault();
              void onRefresh();
            }}
          >
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing…" : "Refresh from GitHub"}
          </DropdownMenuItem>
          {/* Audit PDF for the whole project: overview, rollups, and full
              per-ticket detail (narration + cost + evidence) up to the export
              cap, with the rest summarised. Async — the hook fires the job and
              toasts through to the download. */}
          <DropdownMenuItem
            disabled={projectExport.busy}
            onSelect={(e) => {
              e.preventDefault();
              void projectExport.start();
            }}
          >
            {projectExport.busy ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileDown className="mr-2 h-3.5 w-3.5" />
            )}
            {projectExport.busy ? "Building PDF…" : "Export project PDF…"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            onSelect={(e) => {
              e.preventDefault();
              setDeleteOpen(true);
            }}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Rename — local display label only. */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>
            Changes the local label shown in the project switcher and on project cards. Doesn&apos;t
            touch the GitHub repo.
          </DialogDescription>
          <form onSubmit={onRenameSubmit} className="mt-3 flex flex-col gap-3">
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Project name"
              autoFocus
              maxLength={80}
              disabled={renameSaving}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setRenameOpen(false)}
                disabled={renameSaving}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={renameSaving}>
                {renameSaving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete — type-the-name to confirm. Removes the DevPilot row only. */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>Delete &ldquo;{currentName}&rdquo;?</DialogTitle>
          <DialogDescription>
            Removes this project from DevPilot only. Your GitHub repo and existing tickets are{" "}
            <span className="text-foreground font-medium">not</span> deleted — but the
            project&apos;s DevPilot-side config (team tier, branch routing, env catalog, secret
            links) is dropped. This can&apos;t be undone.
          </DialogDescription>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmMatches) void runDelete();
            }}
            className="mt-3 flex flex-col gap-3"
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor="delete-confirm" className="text-muted-foreground text-xs">
                Type <span className="text-foreground font-mono font-medium">{currentName}</span> to
                confirm
              </label>
              <Input
                id="delete-confirm"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder={currentName}
                autoFocus
                autoComplete="off"
                disabled={deleting}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDeleteOpen(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                disabled={!confirmMatches || deleting}
              >
                {deleting ? "Deleting…" : "Delete project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Repo gone — surfaced by Refresh when GitHub no longer has the repo. */}
      <Dialog open={repoGoneOpen} onOpenChange={setRepoGoneOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>Repo not found on GitHub</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{repoLabel}</span> no longer exists on GitHub — it may have
            been deleted, made private, or moved out of reach of your token. Remove this project
            from DevPilot? Existing tickets are kept.
          </DialogDescription>
          <DialogFooter className="mt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRepoGoneOpen(false)}
              disabled={deleting}
            >
              Keep
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void runDelete()}
              disabled={deleting}
            >
              {deleting ? "Removing…" : "Remove project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
