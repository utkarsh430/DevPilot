"use client";

// Per-schedule activity feed. Rendered inline inside the ScheduleDialog when
// the operator expands an active-schedule row. Fetches the last 20 rows via
// the RLS-bound browser supabase client.

import * as React from "react";
import { AlertTriangle, CheckCircle2, Clock, PauseCircle, PlayCircle, XCircle } from "lucide-react";
import { supabaseBrowser } from "@/lib/db/browser";
import { relativeTime } from "@/lib/relative-time";
import { Badge } from "@/components/ui/badge";

type ActivityRow = {
  id: number;
  kind: "fired" | "skipped" | "ticket-advanced" | "completed" | "error";
  reason: string | null;
  ticket_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type Props = {
  scheduleId: string;
};

export function ScheduleActivityList({ scheduleId }: Props) {
  const [rows, setRows] = React.useState<ActivityRow[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = supabaseBrowser();
      const { data } = await supabase
        .from("schedule_activity")
        .select("id, kind, reason, ticket_id, metadata, created_at")
        .eq("schedule_id", scheduleId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (!cancelled) {
        setRows((data ?? []) as ActivityRow[]);
      }
    })();

    // Live tail — append new rows as the cron / drain writes them.
    const supabase = supabaseBrowser();
    const channel = supabase
      .channel(`schedule_activity_${scheduleId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "schedule_activity",
          filter: `schedule_id=eq.${scheduleId}`,
        },
        (payload) => {
          const row = payload.new as ActivityRow;
          setRows((prev) => (prev ? [row, ...prev].slice(0, 20) : [row]));
        },
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [scheduleId]);

  if (rows === null) {
    return <p className="text-muted-foreground px-2 py-2 text-[11px]">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground px-2 py-2 text-[11px]">
        No activity yet. The cron writes a row each time it fires, skips, or the drain advances a
        ticket.
      </p>
    );
  }

  return (
    <ul className="bg-muted/30 flex flex-col gap-1 border-t px-2 py-2">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-[11px]">
          <ActivityIcon kind={r.kind} reason={r.reason} />
          <span className="text-muted-foreground font-mono tabular-nums">
            {relativeTime(r.created_at)}
          </span>
          <span className="flex-1 truncate">
            <ActivityLabel row={r} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function ActivityIcon({ kind, reason }: { kind: ActivityRow["kind"]; reason: string | null }) {
  if (kind === "fired") return <PlayCircle className="h-3 w-3 text-emerald-600" />;
  if (kind === "skipped") return <PauseCircle className="h-3 w-3 text-amber-600" />;
  if (kind === "completed") return <CheckCircle2 className="h-3 w-3 text-emerald-600" />;
  if (kind === "error") return <AlertTriangle className="text-destructive h-3 w-3" />;
  // ticket-advanced — colour by outcome reason.
  if (reason === "done") return <CheckCircle2 className="h-3 w-3 text-emerald-600" />;
  if (reason === "failed") return <XCircle className="text-destructive h-3 w-3" />;
  if (reason === "stuck" || reason === "timeout")
    return <AlertTriangle className="h-3 w-3 text-amber-600" />;
  return <Clock className="text-muted-foreground h-3 w-3" />;
}

function ActivityLabel({ row }: { row: ActivityRow }) {
  const meta = row.metadata ?? {};
  if (row.kind === "fired") {
    return (
      <span>
        Fired{" "}
        <span className="text-muted-foreground">
          ({(meta as { mode?: string }).mode ?? "recurring"})
        </span>
      </span>
    );
  }
  if (row.kind === "skipped") {
    return (
      <span className="flex items-center gap-1.5">
        Skipped
        <Badge tone="warn" className="text-[10px]">
          {row.reason ?? "unknown"}
        </Badge>
      </span>
    );
  }
  if (row.kind === "completed") {
    const drained = (meta as { drained?: number }).drained ?? 0;
    return (
      <span>
        Drain complete{" "}
        <span className="text-muted-foreground">
          ({drained} ticket{drained === 1 ? "" : "s"})
        </span>
      </span>
    );
  }
  if (row.kind === "error") {
    return <span className="text-destructive">Error: {row.reason}</span>;
  }
  // ticket-advanced
  const slot = (meta as { slot?: number }).slot;
  const total = (meta as { total?: number }).total;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span>Ticket advanced</span>
      <Badge
        tone={row.reason === "done" ? "ok" : row.reason === "failed" ? "danger" : "warn"}
        className="text-[10px]"
      >
        {row.reason ?? "?"}
      </Badge>
      {slot && total ? (
        <span className="text-muted-foreground">
          {slot}/{total}
        </span>
      ) : null}
      {row.ticket_id ? (
        <span className="text-muted-foreground font-mono text-[10px]">
          {row.ticket_id.slice(0, 8)}
        </span>
      ) : null}
    </span>
  );
}
