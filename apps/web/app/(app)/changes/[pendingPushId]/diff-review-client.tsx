"use client";

// Phase 2 / M5c — Diff review client.
//
// Two-pane layout (left: file list, right: diff viewer). Header carries the
// project name + branch + Push/Discard actions + Open PR toggle. The push
// CTA also pins to the bottom on mobile so a long file list doesn't bury it.
//
// react-diff-viewer-continued is the only new dependency. We render it in
// split mode by default; for binary/missing/too-big files we surface a
// placeholder instead of the viewer (the library renders nothing useful for
// those cases anyway).
//
// The Open PR toggle is implemented as a native `<button role="switch">` —
// the `components/ui` set doesn't ship a Switch primitive and adding one is
// out of scope for M5c.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpFromLine,
  Loader2,
  Pencil,
  Save,
  Trash2,
  GitBranch,
  GitPullRequest,
  FileCode2,
  FilePlus2,
  FileMinus2,
  Plus,
  Minus,
  Image as ImageIcon,
  Ban,
  X,
  AlertTriangle,
  Wrench,
} from "lucide-react";
import ReactDiffViewer from "react-diff-viewer-continued";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useTheme } from "@/components/shell/theme-provider";
import { RunPanel } from "@/app/(app)/projects/[projectId]/run-panel";
import { LiveTab } from "./live-tab";
import { ConflictsTab } from "./conflicts-tab";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import {
  discardPendingChangesAction,
  pushPendingChangesAction,
  recoverPendingPushAction,
} from "../actions";
import { readWorkspaceFileAction, writeWorkspaceFileAction } from "./live-actions";

export type DiffReviewFileKind = "text" | "binary" | "too_big" | "missing";

export type DiffReviewFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  kind: DiffReviewFileKind;
  oldValue: string;
  newValue: string;
};

export type DiffReviewPendingPush = {
  id: string;
  projectId: string;
  ticketId: string | null;
  runId: string | null;
  branch: string;
  workspacePath: string;
  unpushedCount: number;
  filesChanged: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
  headSha: string | null;
  pushedAt: string | null;
  pushedPrUrl: string | null;
  createdAt: string;
  updatedAt: string;
  // Slice IB-B — conflict state surfaces the Conflicts tab when non-null.
  conflictState: "clean" | "rebased" | "conflict" | "resolved" | null;
  conflictDetail: {
    files: string[];
    stderr: string;
    base_sha: string | null;
    branch_sha: string | null;
  } | null;
  rebasedOntoSha: string | null;
  mergerTicketId: string | null;
};

export type DiffReviewProject = {
  id: string;
  name: string;
  repoUrl: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  defaultBranch: string;
  // Slice IB — used by the Conflicts tab banner and the rebase target.
  integrationBranch: string | null;
};

export type DiffReviewTicket = {
  id: string;
  title: string | null;
  description: string | null;
  status: string | null;
};

type PushState =
  | { kind: "idle" }
  | { kind: "pushing" }
  | { kind: "discarding" }
  | { kind: "recovering" }
  | { kind: "done"; prUrl: string | undefined }
  | { kind: "error"; message: string };

/**
 * The workspace this change points at is gone (reaped before the branch was
 * pushed) or belongs to another host. Held SEPARATELY from `PushState` on
 * purpose: it is a property of the workspace, not of an in-flight action, so it
 * must stay on screen while a rebuild runs - folding it into `PushState` made
 * the banner vanish the instant the operator clicked Rebuild.
 */
type WorkspaceGone = { message: string; recoverable: boolean };

export function DiffReviewClient({
  tenantId,
  pendingPush,
  project,
  ticket,
  files,
}: {
  tenantId: string;
  pendingPush: DiffReviewPendingPush;
  project: DiffReviewProject;
  ticket: DiffReviewTicket | null;
  files: DiffReviewFile[];
}) {
  const router = useRouter();
  const [activePath, setActivePath] = React.useState<string | null>(files[0]?.path ?? null);
  const [openPr, setOpenPr] = React.useState(true);
  const [state, setState] = React.useState<PushState>({ kind: "idle" });
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [workspaceGone, setWorkspaceGone] = React.useState<WorkspaceGone | null>(null);

  const totalAdds = files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const totalDels = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const canOpenPr = Boolean(project.githubOwner && project.githubRepo);

  const activeFile = files.find((f) => f.path === activePath) ?? files[0] ?? null;

  async function onPush() {
    setState({ kind: "pushing" });
    const res = await pushPendingChangesAction({
      id: pendingPush.id,
      openPr: openPr && canOpenPr,
    });
    if (!res.ok) {
      if ("kind" in res && res.kind === "workspace_gone") {
        setWorkspaceGone({ message: res.error, recoverable: res.recoverable });
        setState({ kind: "idle" });
        toast.error("The workspace for this change is gone", { description: res.error });
        return;
      }
      setState({ kind: "error", message: res.error });
      toast.error("Push failed", { description: res.error });
      return;
    }
    setState({ kind: "done", prUrl: res.prUrl });
    toast.success("Pushed!", {
      description: res.prUrl ? `PR opened: ${res.prUrl}` : "Branch pushed to origin.",
    });
    router.push("/changes");
  }

  // Rebuild the branch from the diff DevPilot saved before the workspace died,
  // and push that. The tree is restored faithfully; the original commit history
  // is not (it died with the workspace) - the reconstructed commit says so.
  async function onRecover() {
    setState({ kind: "recovering" });
    const res = await recoverPendingPushAction({
      id: pendingPush.id,
      openPr: openPr && canOpenPr,
    });
    if (!res.ok) {
      setState({ kind: "error", message: res.error });
      toast.error("Rebuild failed", { description: res.error });
      return;
    }
    setState({ kind: "done", prUrl: res.prUrl });
    toast.success("Branch rebuilt and pushed", {
      description: res.prUrl
        ? `Reconstructed from the saved diff. PR opened: ${res.prUrl}`
        : "Reconstructed from the saved diff and pushed to origin.",
    });
    router.push("/changes");
  }

  async function onDiscard() {
    setState({ kind: "discarding" });
    const res = await discardPendingChangesAction({ id: pendingPush.id });
    if (!res.ok) {
      setState({ kind: "error", message: res.error });
      toast.error("Discard failed", { description: res.error });
      return;
    }
    toast.success("Discarded", {
      description:
        "Review entry removed. The workspace is untouched in case you want to inspect it manually.",
    });
    router.push("/changes");
  }

  const busy =
    state.kind === "pushing" || state.kind === "discarding" || state.kind === "recovering";

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <Header
        project={project}
        pendingPush={pendingPush}
        ticket={ticket}
        totalAdds={totalAdds}
        totalDels={totalDels}
        openPr={openPr}
        setOpenPr={setOpenPr}
        canOpenPr={canOpenPr}
        busy={busy}
        pushing={state.kind === "pushing"}
        discarding={state.kind === "discarding"}
        onPush={onPush}
        confirmDiscard={confirmDiscard}
        setConfirmDiscard={setConfirmDiscard}
        onDiscard={onDiscard}
      />

      {workspaceGone ? (
        <div className="border-destructive/40 bg-destructive/10 border-b px-4 py-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-destructive text-sm font-medium">
                This change&rsquo;s workspace no longer exists
              </p>
              <p className="text-muted-foreground mt-1 text-sm">{workspaceGone.message}</p>
              {workspaceGone.recoverable ? (
                <div className="mt-3 flex items-center gap-2">
                  <Button size="sm" variant="primary" onClick={onRecover} disabled={busy}>
                    {state.kind === "recovering" ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wrench className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Rebuild from saved diff
                  </Button>
                  <span className="text-muted-foreground text-xs">
                    Replays the diff below onto a fresh clone of{" "}
                    <code className="font-mono">
                      {project.integrationBranch ?? project.defaultBranch}
                    </code>{" "}
                    and pushes it as <code className="font-mono">{pendingPush.branch}</code>. The
                    file tree is restored; the original commit history is not.
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Phase 2 / M5e — Run on localhost panel, scoped to this pending push's
          workspace. WI-10 — the branch props let both pickers pin the change's
          own branch (the default a run serves), production and integration, so
          the operator can preview `dev` and come back without leaving the page. */}
      <div className="border-b px-4 py-3">
        <RunPanel
          tenantId={tenantId}
          projectId={project.id}
          scope={{ kind: "pending_push" }}
          pendingPushId={pendingPush.id}
          defaultBranch={project.defaultBranch}
          integrationBranch={project.integrationBranch}
          scopeBranch={pendingPush.branch}
        />
      </div>

      {/* Phase 2 / M5e — Tabs: existing Files diff (default) + new Live workspace browser */}
      {/* min-h-0 on every flex link in the chain so inner scroll containers
          actually get a definite height. Without it, flex-1 children swell
          to their content height and the page itself scrolls instead of the
          panels. */}
      <Tabs defaultValue="files" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TabsList className="mx-4 mt-2 w-fit">
          <TabsTrigger value="files">Files ({files.length})</TabsTrigger>
          <TabsTrigger value="live">Live</TabsTrigger>
          {pendingPush.conflictState ? (
            <TabsTrigger value="conflicts">
              Conflicts
              {pendingPush.conflictState === "conflict" ? (
                <span className="bg-destructive ml-1.5 inline-block h-1.5 w-1.5 rounded-full" />
              ) : null}
            </TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent
          value="files"
          className="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          <div className="grid h-full grid-cols-1 overflow-hidden md:grid-cols-[280px_minmax(0,1fr)]">
            {/* Left: file list */}
            <aside className="bg-card/40 hidden h-full min-h-0 border-r md:flex md:flex-col">
              <div className="text-muted-foreground border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-wider">
                {files.length} {files.length === 1 ? "file" : "files"}
              </div>
              {/* Native scroll container — Radix ScrollArea swallowed the height
              from its flex parent which left the inner viewport at 0px and
              the operator couldn't scroll a 48-file list. */}
              <div className="min-h-0 flex-1 overflow-y-auto">
                <ul className="flex flex-col">
                  {files.map((f) => (
                    <li key={f.path}>
                      <button
                        type="button"
                        onClick={() => setActivePath(f.path)}
                        className={cn(
                          "hover:bg-accent/40 group flex w-full items-start gap-2 border-l-2 border-transparent px-3 py-2 text-left text-xs transition-colors",
                          activePath === f.path && "border-foreground bg-accent/60",
                        )}
                      >
                        <FileStatusIcon status={f.status} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-[11px]">{f.path}</div>
                          <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-[10px]">
                            <span className="text-success inline-flex items-center gap-0.5">
                              <Plus className="h-2.5 w-2.5" />
                              {f.additions}
                            </span>
                            <span className="text-destructive inline-flex items-center gap-0.5">
                              <Minus className="h-2.5 w-2.5" />
                              {f.deletions}
                            </span>
                            {f.kind !== "text" && (
                              <span className="text-muted-foreground">{f.kind}</span>
                            )}
                          </div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </aside>

            {/* Right: diff viewer */}
            <main className="flex h-full min-h-0 flex-col overflow-hidden">
              {/* Mobile file picker */}
              <div className="bg-card/40 border-b px-4 py-2 md:hidden">
                <select
                  value={activeFile?.path ?? ""}
                  onChange={(e) => setActivePath(e.target.value)}
                  className="border-input h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                  aria-label="File"
                >
                  {files.map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.path} (+{f.additions} −{f.deletions})
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="p-4 pb-32 md:pb-4">
                  {activeFile ? (
                    <FileDiffPane file={activeFile} pendingPushId={pendingPush.id} />
                  ) : (
                    <EmptyFiles />
                  )}
                </div>
              </div>

              {/* Sticky mobile push bar */}
              <div className="bg-background/95 sticky bottom-0 flex items-center justify-between gap-2 border-t px-4 py-3 backdrop-blur md:hidden">
                <Button variant="outline" size="sm" onClick={() => router.push("/changes")}>
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </Button>
                <Button variant="primary" size="sm" onClick={onPush} disabled={busy}>
                  {state.kind === "pushing" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowUpFromLine className="h-3.5 w-3.5" />
                  )}
                  Push{openPr && canOpenPr ? " & PR" : ""}
                </Button>
              </div>
            </main>
          </div>
        </TabsContent>

        <TabsContent
          value="live"
          className="min-h-0 flex-1 overflow-hidden p-4 data-[state=inactive]:hidden"
        >
          <LiveTab tenantId={tenantId} pendingPushId={pendingPush.id} />
        </TabsContent>

        {pendingPush.conflictState ? (
          <TabsContent
            value="conflicts"
            className="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
          >
            <ConflictsTab
              state={{
                pendingPushId: pendingPush.id,
                conflictState: pendingPush.conflictState,
                conflictDetail: pendingPush.conflictDetail,
                rebasedOntoSha: pendingPush.rebasedOntoSha,
                mergerTicketId: pendingPush.mergerTicketId,
                sourceTicketId: pendingPush.ticketId,
                integrationBranch: project.integrationBranch ?? project.defaultBranch,
                sourceBranch: pendingPush.branch,
              }}
            />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}

function Header({
  project,
  pendingPush,
  ticket,
  totalAdds,
  totalDels,
  openPr,
  setOpenPr,
  canOpenPr,
  busy,
  pushing,
  discarding,
  onPush,
  confirmDiscard,
  setConfirmDiscard,
  onDiscard,
}: {
  project: DiffReviewProject;
  pendingPush: DiffReviewPendingPush;
  ticket: DiffReviewTicket | null;
  totalAdds: number;
  totalDels: number;
  openPr: boolean;
  setOpenPr: (next: boolean) => void;
  canOpenPr: boolean;
  busy: boolean;
  pushing: boolean;
  discarding: boolean;
  onPush: () => void;
  confirmDiscard: boolean;
  setConfirmDiscard: (open: boolean) => void;
  onDiscard: () => void;
}) {
  return (
    <header className="bg-background/95 flex flex-col gap-3 border-b px-4 py-3 backdrop-blur md:flex-row md:items-center md:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Link
          href="/changes"
          className="text-muted-foreground hover:bg-accent hover:text-accent-foreground inline-flex h-8 w-8 items-center justify-center rounded-md"
          aria-label="Back to changes"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <Badge tone="muted" className="font-mono text-[10px]">
              {project.name}
            </Badge>
            <span className="inline-flex items-center gap-1">
              <GitBranch className="h-3 w-3" />
              <code className="bg-muted rounded px-1 font-mono text-[10px]">
                {pendingPush.branch}
              </code>
              <span className="text-muted-foreground">→ {project.defaultBranch}</span>
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="text-success inline-flex items-center gap-0.5">
                <Plus className="h-3 w-3" />
                {totalAdds}
              </span>
              <span className="text-destructive inline-flex items-center gap-0.5">
                <Minus className="h-3 w-3" />
                {totalDels}
              </span>
            </span>
          </div>
          <h1 className="mt-0.5 truncate text-sm font-semibold tracking-tight">
            {ticket?.title ?? "Untitled change"}
          </h1>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <OpenPrToggle
          checked={openPr && canOpenPr}
          disabled={!canOpenPr || busy}
          onChange={setOpenPr}
        />

        <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Discard
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Discard this review?</DialogTitle>
              <DialogDescription>
                We&apos;ll remove the entry from <code>/changes</code> so it stops showing up. The
                workspace at <code className="break-all">{pendingPush.workspacePath}</code> is
                untouched — your local commits stay on <code>{pendingPush.branch}</code> in case you
                want to inspect or salvage them manually.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDiscard(false)}
                disabled={discarding}
              >
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={onDiscard} disabled={discarding}>
                {discarding ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                Discard
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Button
          variant="primary"
          size="sm"
          onClick={onPush}
          disabled={busy}
          title={
            openPr && canOpenPr
              ? `Push ${pendingPush.branch} and open a PR`
              : `Push ${pendingPush.branch} to origin`
          }
        >
          {pushing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowUpFromLine className="h-3.5 w-3.5" />
          )}
          {pushing ? "Pushing…" : openPr && canOpenPr ? "Push & PR" : "Push"}
        </Button>
      </div>
    </header>
  );
}

function OpenPrToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      title={
        disabled
          ? "Connect this project to GitHub to open PRs automatically."
          : checked
            ? "A PR will be opened after the push."
            : "Push the branch only; don't open a PR."
      }
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-md border px-2 text-xs font-medium transition-colors",
        disabled
          ? "border-border bg-muted/30 text-muted-foreground cursor-not-allowed"
          : checked
            ? "border-chart-1/40 bg-chart-1/10 text-chart-1"
            : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground bg-transparent",
      )}
    >
      <GitPullRequest className="h-3.5 w-3.5" />
      <span>Open PR</span>
      <span
        className={cn(
          "ml-1 inline-flex h-3.5 w-6 items-center rounded-full px-0.5 transition-colors",
          checked ? "bg-chart-1" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "bg-background inline-block h-2.5 w-2.5 rounded-full transition-transform",
            checked && "translate-x-2.5",
          )}
        />
      </span>
    </button>
  );
}

function FileDiffPane({ file, pendingPushId }: { file: DiffReviewFile; pendingPushId: string }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // Reset edit state whenever the active file changes; otherwise switching
  // away from a half-edited file and back surfaces stale draft content.
  React.useEffect(() => {
    setEditing(false);
    setDraft("");
  }, [file.path]);

  async function startEdit() {
    setLoading(true);
    const res = await readWorkspaceFileAction({
      pendingPushId,
      path: file.path,
    });
    setLoading(false);
    if (!res.ok) {
      toast.error("Couldn't read file", { description: res.error });
      return;
    }
    if (res.binary || res.truncated || res.content === null) {
      toast.error(
        res.binary
          ? "Can't inline-edit a binary file."
          : "File is too large to edit inline; open it in VS Code instead.",
      );
      return;
    }
    setDraft(res.content);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    const res = await writeWorkspaceFileAction({
      pendingPushId,
      path: file.path,
      content: draft,
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Save failed", { description: res.error });
      return;
    }
    toast.success("Saved", {
      description: "Diff will refresh on the next agent commit; the working tree is updated now.",
    });
    setEditing(false);
    router.refresh();
  }

  const canEdit = file.kind === "text";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="inline-flex items-center gap-2 font-mono text-[11px]">
          <FileStatusIcon status={file.status} />
          <span>{file.path}</span>
        </div>
        <div className="inline-flex items-center gap-2 text-[11px]">
          <span className="text-success inline-flex items-center gap-0.5">
            <Plus className="h-3 w-3" />
            {file.additions}
          </span>
          <span className="text-destructive inline-flex items-center gap-0.5">
            <Minus className="h-3 w-3" />
            {file.deletions}
          </span>
          {canEdit && !editing ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void startEdit()}
              disabled={loading}
              title="Edit this file inline"
              className="ml-1"
            >
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Pencil className="h-3 w-3" />
              )}
              Edit
            </Button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-[10px]">
            Saves the current workspace file on the runner host. The diff above re-renders from the
            tracker snapshot, so it may look stale until the next agent commit re-captures it.
          </p>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="min-h-[40vh] font-mono text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              <X className="h-3 w-3" />
              Cancel
            </Button>
            <Button size="xs" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <Card className="overflow-hidden">
          {file.kind === "text" ? (
            <DiffViewerSafe oldValue={file.oldValue} newValue={file.newValue} splitView />
          ) : (
            <DiffPlaceholder kind={file.kind} path={file.path} />
          )}
        </Card>
      )}
    </div>
  );
}

// Wrap the diff viewer so any rendering crash on a malformed diff (rare) shows
// a non-fatal fallback rather than blowing up the whole page. The viewer
// itself is robust but the `useDarkTheme` heuristic depends on `prefers-color-
// scheme`, which is a media query — keep the render safe in SSR.
function DiffViewerSafe({
  oldValue,
  newValue,
  splitView,
}: {
  oldValue: string;
  newValue: string;
  splitView: boolean;
}) {
  // Honor the app's theme rather than the OS preference. Reading
  // `useTheme().resolvedMode` keeps the diff colours in sync with the rest
  // of the page when the operator picks Light / Dark explicitly in the
  // topbar — previously the viewer used `matchMedia(prefers-color-scheme)`
  // which ignored those choices and forced OS-default coloring.
  const { resolvedMode } = useTheme();
  const dark = resolvedMode === "dark";

  return (
    <div className="text-xs">
      <ReactDiffViewer
        oldValue={oldValue}
        newValue={newValue}
        splitView={splitView}
        useDarkTheme={dark}
        disableWordDiff={false}
        showDiffOnly={true}
        styles={{
          variables: {
            light: {
              diffViewerBackground: "transparent",
            },
            dark: {
              diffViewerBackground: "transparent",
            },
          },
        }}
      />
    </div>
  );
}

function DiffPlaceholder({ kind, path }: { kind: DiffReviewFileKind; path: string }) {
  const copy: Record<DiffReviewFileKind, { title: string; body: string; icon: React.ReactNode }> = {
    text: {
      title: "",
      body: "",
      icon: null,
    },
    binary: {
      title: "Binary file",
      body: "Binary contents aren't rendered. Check it locally in the workspace.",
      icon: <ImageIcon className="h-4 w-4" />,
    },
    too_big: {
      title: "Too large to render",
      body: `${path} is over the diff renderer's line cap. View the raw file in the workspace before pushing.`,
      icon: <Ban className="h-4 w-4" />,
    },
    missing: {
      title: "Diff not captured",
      body: "The tracker didn't capture this file's diff (it may have been elided). The file change is included in the push.",
      icon: <Ban className="h-4 w-4" />,
    },
  };
  const c = copy[kind];
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-2 px-4 py-10 text-center text-xs">
      <div className="bg-muted flex h-9 w-9 items-center justify-center rounded-full">{c.icon}</div>
      <p className="text-foreground text-sm font-medium">{c.title}</p>
      <p>{c.body}</p>
    </div>
  );
}

function EmptyFiles() {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-2 py-20 text-center text-xs">
      <p>No files were captured for this push.</p>
    </div>
  );
}

function FileStatusIcon({ status }: { status: string }) {
  // Status codes from git: A/M/D/R/C/U. We collapse to three icons.
  const s = (status ?? "M").toUpperCase();
  if (s === "A") return <FilePlus2 className="text-success h-3.5 w-3.5 shrink-0" />;
  if (s === "D") return <FileMinus2 className="text-destructive h-3.5 w-3.5 shrink-0" />;
  return <FileCode2 className="text-muted-foreground h-3.5 w-3.5 shrink-0" />;
}
