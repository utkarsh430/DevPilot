"use client";

// Phase 2.5+ / Slice IB-B — Conflicts tab on /changes/[pendingPushId].
//
// Surfaces when the pending_push has a non-null conflict_state. Three jobs:
//
//   1. Banner: human-readable headline ("conflict against <integration>"),
//      links to the merger ticket and to the source ticket.
//   2. Timeline: every row of merge_conflict_events for this pending_push,
//      streamed live via supabaseBrowser realtime subscription. Each event
//      kind renders with its own affordance (detected = files list,
//      merger_spawned = merger link, file_resolved = file + strategy,
//      merger_completed = summary, operator_overrode = warning).
//   3. Operator actions:
//        - Retry push (re-runs pushPendingChangesAction; the second attempt
//          will re-rebase and either land or surface a new conflict).
//        - Force push (escape hatch — calls pushPendingChangesAction with
//          { force: true }; emits an `operator_overrode` audit event).
//        - Open merger ticket (deep link to the ticket drawer).
//
// Realtime: subscribes to INSERTs on `merge_conflict_events` filtered by
// pending_push_id. Tears down on unmount via removeChannel.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Circle,
  Cog,
  ExternalLink,
  FileWarning,
  GitBranch,
  Loader2,
  RotateCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relative-time";
import { supabaseBrowser } from "@/lib/db/browser";
import { pushPendingChangesAction } from "../actions";

export type ConflictDetail = {
  files: string[];
  stderr: string;
  base_sha: string | null;
  branch_sha: string | null;
};

export type ConflictTabState = {
  pendingPushId: string;
  conflictState: "clean" | "rebased" | "conflict" | "resolved";
  conflictDetail: ConflictDetail | null;
  rebasedOntoSha: string | null;
  mergerTicketId: string | null;
  sourceTicketId: string | null;
  integrationBranch: string;
  sourceBranch: string;
};

type ConflictEventKind =
  | "detected"
  | "merger_spawned"
  | "merger_started"
  | "file_resolved"
  | "merger_completed"
  | "operator_overrode"
  | "retry_pushed"
  | "retry_failed";

type EventRow = {
  id: string;
  kind: ConflictEventKind;
  payload: Record<string, unknown>;
  created_at: string;
};

export function ConflictsTab({ state }: { state: ConflictTabState }) {
  const router = useRouter();
  const [events, setEvents] = React.useState<EventRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [retrying, setRetrying] = React.useState(false);

  // Initial fetch + realtime subscription.
  React.useEffect(() => {
    const supabase = supabaseBrowser();
    let cancelled = false;
    let channel: RealtimeChannel | null = null;

    (async () => {
      const { data, error } = await supabase
        .from("merge_conflict_events")
        .select("id, kind, payload, created_at")
        .eq("pending_push_id", state.pendingPushId)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (error) {
        toast.error("Couldn't load conflict events", {
          description: error.message,
        });
      } else {
        setEvents((data ?? []) as EventRow[]);
      }
      setLoading(false);
    })();

    channel = supabase
      .channel(`conflict-events:${state.pendingPushId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "merge_conflict_events",
          filter: `pending_push_id=eq.${state.pendingPushId}`,
        },
        (payload) => {
          const row = payload.new as EventRow;
          setEvents((prev) => {
            if (prev.some((e) => e.id === row.id)) return prev;
            return [...prev, row].sort((a, b) => a.created_at.localeCompare(b.created_at));
          });
          // If a merger_completed lands, also refresh the page so the
          // pending_push row's conflict_state ('resolved') is reflected
          // in the banner above.
          if (row.kind === "merger_completed" || row.kind === "retry_pushed") {
            router.refresh();
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [state.pendingPushId, router]);

  async function onRetry(force: boolean) {
    setRetrying(true);
    const res = await pushPendingChangesAction({
      id: state.pendingPushId,
      openPr: false,
      force,
    });
    setRetrying(false);
    if (res.ok) {
      toast.success(force ? "Force-pushed" : "Push retried", {
        description: res.prUrl ? `PR: ${res.prUrl}` : undefined,
      });
      router.refresh();
      return;
    }
    if ("kind" in res && res.kind === "conflict") {
      toast.error("Still conflicting", {
        description: `Merger ticket ${res.mergerTicketId.slice(0, 8)} (re)opened.`,
      });
      router.refresh();
      return;
    }
    toast.error("Retry failed", { description: res.error });
  }

  return (
    // h-full so we fill the TabsContent slot (parent is NOT a flex container,
    // so flex-1 would no-op). Banner + footer stay pinned via shrink-0; the
    // timeline below is the only scrollable region.
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="shrink-0">
        <ConflictBanner state={state} />
      </div>

      {/* Operator action footer */}
      <Card className="flex shrink-0 flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-muted-foreground text-xs">
          {state.conflictState === "conflict" ? (
            <>
              A release engineer is resolving this. When it lands, click <strong>Retry push</strong>
              . If you can&apos;t wait, use <strong>Force-push</strong> to bypass the rebase
              entirely.
            </>
          ) : state.conflictState === "resolved" ? (
            <>
              Conflict resolved. <strong>Retry push</strong> to land the rebased branch on the
              integration tip.
            </>
          ) : (
            <>This branch is up to date with the integration tip.</>
          )}
        </div>
        <div className="flex items-center gap-2">
          {state.mergerTicketId ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/board?ticket=${state.mergerTicketId}`}>
                Open merger <ExternalLink className="h-3 w-3" />
              </Link>
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => onRetry(false)} disabled={retrying}>
            {retrying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCw className="h-3 w-3" />
            )}
            Retry push
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (
                !confirm(
                  "Force-push will bypass the rebase entirely and override the integration tip. Continue?",
                )
              ) {
                return;
              }
              onRetry(true);
            }}
            disabled={retrying}
            className="text-warning"
          >
            <ShieldAlert className="h-3 w-3" />
            Force-push
          </Button>
        </div>
      </Card>

      {/* Timeline — the only scrollable region. flex-1 + min-h-0 so it
          consumes whatever vertical space is left after the banner + footer,
          and overflow-y-auto scrolls the event list when it overflows. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="text-muted-foreground shrink-0 text-[10px] font-medium uppercase tracking-wider">
          Audit timeline ({events.length})
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {loading ? (
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading events…
            </div>
          ) : events.length === 0 ? (
            <div className="text-muted-foreground text-xs italic">No events recorded yet.</div>
          ) : (
            <ol className="flex flex-col gap-2">
              {events.map((ev) => (
                <EventRowCard key={ev.id} ev={ev} />
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

function ConflictBanner({ state }: { state: ConflictTabState }) {
  const tone =
    state.conflictState === "conflict"
      ? "destructive"
      : state.conflictState === "resolved"
        ? "success"
        : "info";
  const Icon =
    state.conflictState === "conflict"
      ? AlertTriangle
      : state.conflictState === "resolved"
        ? CheckCircle2
        : GitBranch;
  const title =
    state.conflictState === "conflict"
      ? `Cannot fast-forward onto ${state.integrationBranch}`
      : state.conflictState === "resolved"
        ? `Conflict resolved against ${state.integrationBranch}`
        : state.conflictState === "rebased"
          ? `Rebased onto ${state.integrationBranch}`
          : `Up to date with ${state.integrationBranch}`;

  const conflictFiles = state.conflictDetail?.files ?? [];

  return (
    <Card
      className={cn(
        "border-l-4 p-4",
        tone === "destructive" && "border-l-destructive",
        tone === "success" && "border-l-success",
        tone === "info" && "border-l-foreground/30",
      )}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0",
            tone === "destructive" && "text-destructive",
            tone === "success" && "text-success",
            tone === "info" && "text-muted-foreground",
          )}
        />
        <div className="flex-1">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-3 text-xs">
            <span>
              Source: <code className="font-mono">{state.sourceBranch}</code>
            </span>
            <span>→</span>
            <span>
              Target: <code className="font-mono">{state.integrationBranch}</code>
            </span>
            {state.rebasedOntoSha ? (
              <Badge tone="muted" className="font-mono text-[10px]">
                rebased onto {state.rebasedOntoSha.slice(0, 7)}
              </Badge>
            ) : null}
          </div>
          {conflictFiles.length > 0 ? (
            <details className="mt-3">
              <summary className="text-foreground cursor-pointer text-xs font-medium">
                {conflictFiles.length} conflicting file
                {conflictFiles.length === 1 ? "" : "s"}
              </summary>
              <ul className="text-muted-foreground mt-2 flex flex-col gap-1 pl-2 text-xs">
                {conflictFiles.map((f) => (
                  <li key={f} className="flex items-center gap-1.5">
                    <FileWarning className="text-destructive/70 h-3 w-3 shrink-0" />
                    <code className="font-mono">{f}</code>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {state.conflictDetail?.stderr ? (
            <details className="mt-2">
              <summary className="text-foreground cursor-pointer text-xs font-medium">
                Rebase output
              </summary>
              <pre className="bg-muted/40 mt-2 overflow-x-auto rounded-md p-2 text-[10px]">
                {state.conflictDetail.stderr.slice(0, 2000)}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function EventRowCard({ ev }: { ev: EventRow }) {
  const meta = describeEvent(ev);
  const Icon = meta.icon;
  return (
    <li className="bg-card flex items-start gap-3 rounded-md border p-3">
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", meta.iconClass)} />
      <div className="flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">{meta.title}</span>
          <span className="text-muted-foreground text-[10px]">{relativeTime(ev.created_at)}</span>
        </div>
        {meta.body ? (
          <div className="text-muted-foreground mt-1 text-[11px]">{meta.body}</div>
        ) : null}
      </div>
    </li>
  );
}

function describeEvent(ev: EventRow): {
  title: string;
  body: React.ReactNode | null;
  icon: typeof Circle;
  iconClass: string;
} {
  const p = ev.payload ?? {};
  switch (ev.kind) {
    case "detected":
      return {
        title: "Conflict detected",
        body: Array.isArray((p as { files?: unknown }).files)
          ? `${(p as { files: unknown[] }).files.length} file(s) reported conflicting`
          : null,
        icon: AlertTriangle,
        iconClass: "text-destructive",
      };
    case "merger_spawned": {
      const id = (p as { merger_ticket_id?: string }).merger_ticket_id;
      return {
        title: "Merger ticket opened",
        body: id ? (
          <Link href={`/board?ticket=${id}`} className="underline-offset-2 hover:underline">
            Ticket {id.slice(0, 8)} → opens the release_engineer flow
          </Link>
        ) : null,
        icon: Cog,
        iconClass: "text-foreground",
      };
    }
    case "merger_started":
      return {
        title: "Merger started",
        body: "Release engineer entered the source workspace.",
        icon: ArrowRight,
        iconClass: "text-foreground",
      };
    case "file_resolved": {
      const file = (p as { file?: string }).file;
      const strategy = (p as { strategy?: string }).strategy;
      const notes = (p as { notes?: string }).notes;
      return {
        title: file ? `Resolved \`${file}\`` : "File resolved",
        body: (
          <>
            {strategy ? (
              <Badge tone="muted" className="mr-2 text-[10px]">
                {strategy}
              </Badge>
            ) : null}
            {notes ?? null}
          </>
        ),
        icon: CheckCircle2,
        iconClass: "text-success",
      };
    }
    case "merger_completed": {
      const files = (p as { resolved_files?: string[] }).resolved_files;
      const summary = (p as { summary?: string }).summary;
      return {
        title: "Merger completed",
        body: (
          <>
            {Array.isArray(files) && files.length > 0 ? `${files.length} file(s) resolved. ` : null}
            {summary ?? null}
          </>
        ),
        icon: CheckCircle2,
        iconClass: "text-success",
      };
    }
    case "operator_overrode":
      return {
        title: "Operator force-pushed",
        body: "Pre-push rebase was skipped. The conflict resolution may have been overridden.",
        icon: ShieldAlert,
        iconClass: "text-warning",
      };
    case "retry_pushed":
      return {
        title: "Retry succeeded",
        body: "Branch landed on the integration tip.",
        icon: CheckCircle2,
        iconClass: "text-success",
      };
    case "retry_failed":
      return {
        title: "Retry still conflicting",
        body: "A new conflict surfaced after the merger landed — another merger has been spawned.",
        icon: XCircle,
        iconClass: "text-destructive",
      };
    default:
      return {
        title: ev.kind,
        body: JSON.stringify(p),
        icon: Circle,
        iconClass: "text-muted-foreground",
      };
  }
}
