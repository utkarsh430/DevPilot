"use client";

// Phase 2 / M5e — File tree for the Live tab on /changes/[id].
//
// Recursive renderer for the `TreeNode` shape returned by
// `getWorkspaceTreeAction`. Folders are collapsible (default open through
// depth 2 so the typical Next.js scaffold lands you straight in `app/`).
// Files are clickable and propagate the selection up via `onSelect(path)`.
//
// Status markers per node mirror the plan's ASCII spec:
//   • unchanged   →  no marker
//   • modified    →  text-warning `✱`
//   • added       →  text-success `+`
//   • deleted     →  text-destructive `−`
//   • dir w/ N    →  small `N` badge (count of changed descendants)
//
// We use lucide-react icons (ChevronRight rotates 90° on expand;
// Folder / FolderOpen for collapsed vs expanded dirs; FileText for files)
// to match the rest of the app's iconography.

import * as React from "react";
import { ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/cn";

export type TreeNode = {
  path: string;
  name: string;
  kind: "dir" | "file";
  status: "unchanged" | "modified" | "added" | "deleted";
  children?: TreeNode[];
  changedDescendants?: number;
};

const DEFAULT_OPEN_DEPTH = 2;

export function FileTree({
  root,
  selectedPath,
  onSelect,
}: {
  root: TreeNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  // Top-level children of root render as the visible tree. The root node
  // itself is implicit (no row for the workspace dir — the tab header
  // already names the workspace).
  const top = root.children ?? [];
  if (top.length === 0) {
    return (
      <div className="text-muted-foreground px-3 py-6 text-center text-xs">Workspace is empty.</div>
    );
  }
  return (
    <ul className="flex flex-col py-1">
      {top.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeRow({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = React.useState(() => depth < DEFAULT_OPEN_DEPTH);
  const isDir = node.kind === "dir";
  const isSelected = node.path === selectedPath;

  // Indent is depth * 12px; the chevron + icon together take ~24px so the
  // tree visually breathes without using up the 280px sidebar width.
  const indentPx = depth * 12;

  return (
    <li>
      <button
        type="button"
        onClick={() => {
          if (isDir) setOpen((o) => !o);
          else onSelect(node.path);
        }}
        className={cn(
          "hover:bg-accent/40 group flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left text-xs transition-colors",
          isSelected && "bg-accent/60",
        )}
        style={{ paddingLeft: `${8 + indentPx}px` }}
        title={node.path}
      >
        {isDir ? (
          <>
            <ChevronRight
              className={cn(
                "text-muted-foreground h-3 w-3 shrink-0 transition-transform",
                open && "rotate-90",
              )}
            />
            {open ? (
              <FolderOpen className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
            ) : (
              <Folder className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
            )}
          </>
        ) : (
          <>
            {/* Spacer so file rows align with folder rows after the chevron. */}
            <span className="h-3 w-3 shrink-0" />
            <FileText className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          </>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{node.name}</span>
        <StatusMarker node={node} />
      </button>
      {isDir && open && node.children && node.children.length > 0 && (
        <ul className="flex flex-col">
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function StatusMarker({ node }: { node: TreeNode }) {
  // Dirs surface the changed-descendant count as a small numeric badge;
  // files surface a single-character marker. Both occupy the same trailing
  // slot so the rows align.
  if (node.kind === "dir") {
    const n = node.changedDescendants ?? 0;
    if (n === 0) return <span className="ml-1 inline-block w-4" aria-hidden />;
    return (
      <span
        className="bg-muted text-muted-foreground ml-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums"
        title={`${n} changed file${n === 1 ? "" : "s"} inside`}
      >
        {n}
      </span>
    );
  }
  if (node.status === "modified") {
    return (
      <span
        className="text-warning ml-1 inline-block w-4 text-center"
        aria-label="modified"
        title="Modified"
      >
        ✱
      </span>
    );
  }
  if (node.status === "added") {
    return (
      <span
        className="text-success ml-1 inline-block w-4 text-center"
        aria-label="added"
        title="Added"
      >
        +
      </span>
    );
  }
  if (node.status === "deleted") {
    return (
      <span
        className="text-destructive ml-1 inline-block w-4 text-center"
        aria-label="deleted"
        title="Deleted"
      >
        −
      </span>
    );
  }
  return <span className="ml-1 inline-block w-4" aria-hidden />;
}
