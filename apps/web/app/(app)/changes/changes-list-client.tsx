"use client";

// Phase 2 / M5c — `/changes` list (client).
//
// The page renders one card per `pending_pushes` row. The initial list is
// hydrated from the server (so first paint matches what was on the user's
// screen at request-time), and `useLivePendingPushes` folds in INSERTs/UPDATEs
// after mount so the list stays current without a refresh.
//
// Joining `pending_pushes → projects/tickets` from the browser would be a
// chain of follow-up requests; instead we re-use the labels that came down
// with the server-rendered seed and fall back to a "Project · Ticket" lookup
// the first time a row arrives over realtime (handled below in a tiny cache).
//
// Clicking a card routes to `/changes/<id>` for the diff review screen.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GitBranch, Inbox, Loader2, Plus, Minus, FileDiff } from "lucide-react";
import { supabaseBrowser } from "@/lib/db/browser";
import { useLivePendingPushes, type PendingPushFile } from "@/lib/realtime/use-pending-pushes";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { relativeTime } from "@/lib/relative-time";

export type ChangesListItem = {
  id: string;
  projectId: string;
  projectName: string;
  ticketId: string | null;
  ticketTitle: string | null;
  branch: string;
  unpushedCount: number;
  filesChanged: PendingPushFile[];
  updatedAt: string;
};

type Labels = {
  projectName: string;
  ticketTitle: string | null;
};

export function ChangesListClient({
  initialItems,
  tenantId,
  activeProjectId,
}: {
  initialItems: ChangesListItem[];
  tenantId: string;
  activeProjectId: string | null;
}) {
  const router = useRouter();
  const { items, isLive, loading } = useLivePendingPushes({
    tenantId,
    projectId: activeProjectId,
  });

  // Tiny browser-side label cache. The server seed comes in with
  // projectName/ticketTitle baked in; realtime INSERTs do not. We back-fill
  // labels lazily for rows that don't yet have them.
  const [labels, setLabels] = React.useState<Map<string, Labels>>(() => {
    const m = new Map<string, Labels>();
    for (const r of initialItems) {
      m.set(r.id, {
        projectName: r.projectName,
        ticketTitle: r.ticketTitle,
      });
    }
    return m;
  });

  // Rows we haven't yet resolved labels for — fired once on each change.
  const unlabelled = React.useMemo(() => items.filter((r) => !labels.has(r.id)), [items, labels]);

  React.useEffect(() => {
    if (unlabelled.length === 0) return;
    let cancelled = false;
    const supabase = supabaseBrowser();
    const projectIds = Array.from(new Set(unlabelled.map((r) => r.projectId)));
    const ticketIds = Array.from(
      new Set(unlabelled.map((r) => r.ticketId).filter((id): id is string => Boolean(id))),
    );

    async function resolve() {
      const [{ data: projects }, { data: tickets }] = await Promise.all([
        projectIds.length
          ? supabase.from("projects").select("id, name").in("id", projectIds)
          : Promise.resolve({ data: [] as { id: string; name: string }[] }),
        ticketIds.length
          ? supabase.from("tickets").select("id, title").in("id", ticketIds)
          : Promise.resolve({ data: [] as { id: string; title: string | null }[] }),
      ]);
      if (cancelled) return;
      const projectName = new Map<string, string>(
        (projects ?? []).map((p) => [p.id as string, p.name as string]),
      );
      const ticketTitle = new Map<string, string | null>(
        (tickets ?? []).map((t) => [t.id as string, (t.title as string | null) ?? null]),
      );
      setLabels((cur) => {
        const next = new Map(cur);
        for (const r of unlabelled) {
          next.set(r.id, {
            projectName: projectName.get(r.projectId) ?? "Unknown project",
            ticketTitle: r.ticketId ? (ticketTitle.get(r.ticketId) ?? null) : null,
          });
        }
        return next;
      });
    }
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [unlabelled]);

  // The live `items` list takes precedence once we have it (post-mount); the
  // server seed only matters for the very first paint. `useLivePendingPushes`
  // does its own bootstrap fetch, so we hand the seed over to it explicitly:
  // we render the seed while `loading === true` to prevent a 0-row flash.
  const displayItems = React.useMemo(() => {
    if (loading) return initialItems;
    return items.map((r) => {
      const cached = labels.get(r.id);
      return {
        id: r.id,
        projectId: r.projectId,
        projectName: cached?.projectName ?? "…",
        ticketId: r.ticketId,
        ticketTitle: cached?.ticketTitle ?? null,
        branch: r.branch,
        unpushedCount: r.unpushedCount,
        filesChanged: r.filesChanged,
        updatedAt: r.updatedAt,
      } satisfies ChangesListItem;
    });
  }, [items, loading, initialItems, labels]);

  if (displayItems.length === 0) {
    return (
      <Card className="bg-card/50 flex flex-col items-center gap-3 border-dashed px-6 py-16 text-center">
        <div className="bg-muted text-muted-foreground flex h-12 w-12 items-center justify-center rounded-full">
          <Inbox className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm font-medium">No pending changes</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Agents will surface commits here for your review before pushing.
          </p>
        </div>
        <Link
          href="/board"
          className="text-foreground text-xs font-medium underline-offset-2 hover:underline"
        >
          File a ticket on the board
        </Link>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-muted-foreground flex items-center justify-between text-xs">
        <span>
          {displayItems.length} {displayItems.length === 1 ? "change" : "changes"} pending
          {activeProjectId ? " in this project" : " across all projects"}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className={
              isLive
                ? "bg-success h-1.5 w-1.5 rounded-full"
                : "bg-muted-foreground h-1.5 w-1.5 rounded-full"
            }
          />
          {isLive ? "Live" : loading ? "Loading…" : "Offline"}
        </span>
      </div>

      <ul className="flex flex-col gap-3">
        {displayItems.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => router.push(`/changes/${item.id}`)}
              className="block w-full text-left transition-colors"
            >
              <ChangeCard item={item} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChangeCard({ item }: { item: ChangesListItem }) {
  const filesSummary = summarizeFiles(item.filesChanged);
  return (
    <Card className="hover:border-foreground/30 cursor-pointer p-4 hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Badge tone="muted" className="font-mono text-[10px]">
              {item.projectName}
            </Badge>
            <span className="inline-flex items-center gap-1">
              <GitBranch className="h-3 w-3" />
              <code className="bg-muted rounded px-1 font-mono text-[10px]">{item.branch}</code>
            </span>
          </div>
          <p className="mt-1 truncate text-sm font-medium">
            {item.ticketTitle ?? "Untitled change"}
          </p>
          <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1">
              <FileDiff className="h-3 w-3" />
              {filesSummary.text}
            </span>
            <span className="text-success inline-flex items-center gap-1">
              <Plus className="h-3 w-3" />
              {filesSummary.additions}
            </span>
            <span className="text-destructive inline-flex items-center gap-1">
              <Minus className="h-3 w-3" />
              {filesSummary.deletions}
            </span>
            {item.unpushedCount > 0 && (
              <Badge tone="info" className="h-4 px-1.5 text-[10px]">
                {item.unpushedCount} {item.unpushedCount === 1 ? "commit" : "commits"}
              </Badge>
            )}
          </div>
        </div>
        <div className="text-muted-foreground text-right text-xs">
          {relativeTime(item.updatedAt)}
        </div>
      </div>
    </Card>
  );
}

function summarizeFiles(files: PendingPushFile[]): {
  text: string;
  additions: number;
  deletions: number;
} {
  const count = files.length;
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
  }
  return {
    text: `${count} ${count === 1 ? "file" : "files"}`,
    additions,
    deletions,
  };
}

// Re-export for the empty-state spinner if a parent ever wants it. Kept here
// (rather than `_components`) because it's strictly local to /changes today.
export function ChangesLoading() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
    </div>
  );
}
