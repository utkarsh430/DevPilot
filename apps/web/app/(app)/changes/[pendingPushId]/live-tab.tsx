"use client";

// Phase 2 / M5e — Live tab on /changes/[pendingPushId].
//
// Self-contained client tab. B5's orchestrator wraps the existing
// `<DiffReviewClient>` in shadcn Tabs and renders this component inside
// a `<TabsContent value="live">`. We expose a single top-level export so
// the wrapping pattern is one-line.
//
// Behaviour:
//   • On mount: fetch the workspace tree via `getWorkspaceTreeAction`.
//   • On `useLivePendingPushes` UPDATE for our row: refetch the tree.
//     This is what makes the tree refresh when the agent's just-finished
//     commit lands — no manual reload needed.
//   • Manual Refresh button is always available (defensive: covers cases
//     where the tracker hasn't fired a row update yet but the workspace
//     has changed, e.g. an `Input Required` ticket sitting idle).
//   • Selecting a file calls `readWorkspaceFileAction`; the preview pane
//     swaps to a loading state, then renders the content via the
//     react-diff-viewer-continued single-pane mode (newValue only —
//     oldValue="" so the library shows the full file without a diff
//     gutter on the left side).
//   • Binary / too-big / error files surface placeholder cards instead
//     of attempting to render bytes the diff viewer can't handle.
//
// SSR safety: react-diff-viewer-continued uses `prefers-color-scheme`
// for its dark heuristic. We mirror the same pattern as
// `DiffReviewClient` — a `useEffect`-driven `dark` state — so the
// initial render is light, then promotes to dark when the media query
// matches.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil, RefreshCw, Loader2, ExternalLink, Save, X } from "lucide-react";
import ReactDiffViewer from "react-diff-viewer-continued";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { useTheme } from "@/components/shell/theme-provider";
import { FileTree, type TreeNode } from "@/components/workspace/file-tree";
import { useLivePendingPushes } from "@/lib/realtime/use-pending-pushes";
import {
  getWorkspaceTreeAction,
  readWorkspaceFileAction,
  writeWorkspaceFileAction,
} from "./live-actions";
// Slice C — server action that resolves the workspace path and returns a
// vscode:// URL. The path never reaches the DOM; we only navigate to the URL.
import { getVscodeOpenUrlAction } from "@/lib/workspace/open-actions";

type FilePreview =
  | { kind: "loading" }
  | { kind: "text"; content: string; bytes: number }
  | { kind: "binary"; bytes: number }
  | { kind: "too_big"; bytes: number }
  | { kind: "error"; message: string }
  | null;

export function LiveTab({ tenantId, pendingPushId }: { tenantId: string; pendingPushId: string }) {
  const [root, setRoot] = React.useState<TreeNode | null>(null);
  const [totals, setTotals] = React.useState<{
    totalFiles: number;
    changedFiles: number;
  } | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<FilePreview>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // Realtime substrate: when the pending_pushes row for this id receives an
  // UPDATE (the tracker just stamped a new head_sha / files_changed), we
  // refetch the tree. We dedupe via the row's `updated_at` so a tab that's
  // already fetching doesn't queue a second refresh.
  const { items } = useLivePendingPushes({ tenantId });
  const ourRow = items.find((r) => r.id === pendingPushId) ?? null;
  const lastSeenUpdatedAt = React.useRef<string | null>(null);
  const lastFetchedRef = React.useRef<Promise<void> | null>(null);

  const refetchTree = React.useCallback(async () => {
    setRefreshing(true);
    setLoadError(null);
    try {
      const res = await getWorkspaceTreeAction({ pendingPushId });
      if (!res.ok) {
        setLoadError(res.error);
        return;
      }
      setRoot(res.root as TreeNode);
      setTotals({
        totalFiles: res.totalFiles,
        changedFiles: res.changedFiles,
      });
    } finally {
      setRefreshing(false);
    }
  }, [pendingPushId]);

  // Initial load + auto-refresh on row update.
  React.useEffect(() => {
    if (ourRow) {
      if (lastSeenUpdatedAt.current === null) {
        // First seen — fetch the tree (initial mount path).
        lastSeenUpdatedAt.current = ourRow.updatedAt;
        lastFetchedRef.current = refetchTree();
        return;
      }
      if (ourRow.updatedAt !== lastSeenUpdatedAt.current) {
        // Row updated since we last fetched — refresh the tree.
        lastSeenUpdatedAt.current = ourRow.updatedAt;
        lastFetchedRef.current = refetchTree();
      }
      return;
    }
    // The hook hasn't seeded our row yet. Kick off an initial fetch on the
    // first mount so the tab isn't empty while the realtime channel boots.
    if (lastSeenUpdatedAt.current === null) {
      lastSeenUpdatedAt.current = "";
      lastFetchedRef.current = refetchTree();
    }
  }, [ourRow, refetchTree]);

  // Re-fetch the selected file when the tree refreshes (its bytes may have
  // changed). Done in a separate effect so the selection logic stays
  // independent of the row-update detection above.
  React.useEffect(() => {
    if (!selected) return;
    if (!root) return;
    void selectFile(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  async function selectFile(filePath: string) {
    setSelected(filePath);
    setPreview({ kind: "loading" });
    const res = await readWorkspaceFileAction({
      pendingPushId,
      path: filePath,
    });
    if (!res.ok) {
      setPreview({ kind: "error", message: res.error });
      toast.error("Failed to read file", { description: res.error });
      return;
    }
    if (res.binary) {
      setPreview({ kind: "binary", bytes: res.bytes });
      return;
    }
    if (res.truncated) {
      setPreview({ kind: "too_big", bytes: res.bytes });
      return;
    }
    setPreview({
      kind: "text",
      content: res.content ?? "",
      bytes: res.bytes,
    });
  }

  return (
    <div className="grid h-full grid-cols-1 gap-3 overflow-hidden md:grid-cols-[300px_minmax(0,1fr)]">
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-muted-foreground truncate text-xs">
            {totals
              ? `${totals.changedFiles} changed of ${totals.totalFiles}`
              : refreshing
                ? "Loading…"
                : "…"}
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              onClick={async () => {
                const res = await getVscodeOpenUrlAction({
                  kind: "pending_push",
                  pendingPushId,
                });
                if (!res.ok) {
                  toast.error("Couldn't open in VS Code", { description: res.error });
                  return;
                }
                window.location.href = res.value.url;
              }}
              title="Open workspace in VS Code"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={refetchTree}
              disabled={refreshing}
              title="Refresh tree"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
          {loadError ? (
            <div className="text-destructive px-3 py-4 text-xs">
              Failed to load tree: {loadError}
            </div>
          ) : root ? (
            <FileTree root={root} selectedPath={selected} onSelect={selectFile} />
          ) : (
            <div className="text-muted-foreground flex items-center gap-2 px-3 py-4 text-xs">
              <Loader2 className="h-3 w-3 animate-spin" />
              Reading workspace…
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-col">
        <PreviewPane
          preview={preview}
          path={selected}
          pendingPushId={pendingPushId}
          onSaved={() => void refetchTree()}
        />
      </div>
    </div>
  );
}

function PreviewPane({
  preview,
  path,
  pendingPushId,
  onSaved,
}: {
  preview: FilePreview;
  path: string | null;
  pendingPushId: string;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // Drop any in-flight edit when the preview target changes.
  React.useEffect(() => {
    setEditing(false);
    setDraft("");
  }, [path]);

  async function save() {
    if (!path) return;
    setSaving(true);
    const res = await writeWorkspaceFileAction({
      pendingPushId,
      path,
      content: draft,
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Save failed", { description: res.error });
      return;
    }
    toast.success("Saved");
    setEditing(false);
    onSaved();
    router.refresh();
  }

  if (preview === null) {
    return (
      <Card className="text-muted-foreground flex h-[60vh] items-center justify-center px-6 py-10 text-center text-xs">
        Select a file from the tree to preview its content.
      </Card>
    );
  }
  if (preview.kind === "loading") {
    return (
      <Card className="text-muted-foreground flex h-[60vh] items-center justify-center px-6 py-10 text-center text-xs">
        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
        Reading file…
      </Card>
    );
  }
  if (preview.kind === "error") {
    return (
      <Card className="flex h-[60vh] flex-col items-center justify-center gap-2 px-6 py-10 text-center text-xs">
        <p className="text-foreground text-sm font-medium">Couldn&apos;t read file</p>
        <p className="text-muted-foreground">{preview.message}</p>
      </Card>
    );
  }
  if (preview.kind === "binary") {
    return (
      <Card className="flex h-[60vh] flex-col items-center justify-center gap-2 px-6 py-10 text-center text-xs">
        <p className="text-foreground text-sm font-medium">Binary file</p>
        <p className="text-muted-foreground">
          {path ? `${path} ` : ""}is {formatBytes(preview.bytes)}. Binary contents aren&apos;t
          rendered in the preview.
        </p>
      </Card>
    );
  }
  if (preview.kind === "too_big") {
    return (
      <Card className="flex h-[60vh] flex-col items-center justify-center gap-2 px-6 py-10 text-center text-xs">
        <p className="text-foreground text-sm font-medium">File too large to preview</p>
        <p className="text-muted-foreground">
          {path ? `${path} ` : ""}is {formatBytes(preview.bytes)} — over the preview cap (256 KB).
          Open it in your editor to inspect.
        </p>
      </Card>
    );
  }
  // text — preview / edit
  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="bg-card/40 text-muted-foreground flex items-center justify-between gap-2 border-b px-3 py-1.5 text-[10px]">
        <span className="truncate font-mono">{path}</span>
        <div className="flex items-center gap-2">
          <span className="tabular-nums">{formatBytes(preview.bytes)}</span>
          {!editing ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setDraft(preview.content);
                setEditing(true);
              }}
              title="Edit this file inline"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </Button>
          ) : null}
        </div>
      </div>
      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 font-mono text-xs"
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
        <FilePreviewBody content={preview.content} />
      )}
    </Card>
  );
}

function FilePreviewBody({ content }: { content: string }) {
  // Use the diff viewer in single-pane mode for the preview so we get the
  // line numbers + syntax-aware coloring without a parallel rendered file.
  // `oldValue=""` + `newValue=content` + `splitView={false}` is the
  // documented single-pane recipe; `showDiffOnly={false}` is mandatory
  // (the library defaults to true, which would render nothing for a file
  // with no diff).
  const { resolvedMode } = useTheme();
  const dark = resolvedMode === "dark";

  return (
    <div className="min-h-0 flex-1 overflow-auto text-xs">
      <ReactDiffViewer
        oldValue=""
        newValue={content}
        splitView={false}
        useDarkTheme={dark}
        disableWordDiff
        showDiffOnly={false}
        styles={{
          variables: {
            light: { diffViewerBackground: "transparent" },
            dark: { diffViewerBackground: "transparent" },
          },
        }}
      />
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
