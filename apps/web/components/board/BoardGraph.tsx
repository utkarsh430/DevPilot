"use client";

// Phase 2 / G2 — React Flow DAG view of the work board.
//
// Reuses the same chrome the Agent Builder canvas uses (Background dots,
// Controls, MiniMap) and the same BFS auto-layout idea: roots are tickets
// with no incoming "blocked-by" edges (i.e. nobody is blocking them yet);
// each downstream node sits one column to the right of its deepest blocker.
// Within a level we stack tickets by status order so similar work clusters
// vertically (backlog → ready → … → done).
//
// Edge semantics mirror the `ticket_dependencies` row: source =
// `blocks_ticket_id`, target = `ticket_id` — the blocker points to the
// blocked. Edges that flow INTO a `done` ticket render faded; both endpoints
// done means the relationship is historical, the operator should be able to
// see it but not have it pull focus.
//
// Empty states:
//   • zero tickets — centered card explaining no tickets to graph.
//   • tickets present but zero deps — render the nodes anyway (operator can
//     still see parallel orphans) and overlay a hint pill.

import * as React from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Workflow, Network } from "lucide-react";
import { TicketNode, type TicketNodeData } from "@/components/board/TicketNode";
import { COLUMNS, type BoardTicket } from "@/components/board/types";
import type { TicketStatus } from "@/lib/board/state";
import type { TicketDependencyEdge } from "@/lib/board/queries";

const NODE_TYPES = { ticket: TicketNode };

const STATUS_ORDER: ReadonlyArray<TicketStatus> = COLUMNS.map((c) => c.id);

const COL_GAP = 300;
const ROW_GAP = 150;
const X_ORIGIN = 120;
const Y_ORIGIN = 80;

type Layout = Record<string, { x: number; y: number }>;

/**
 * Compute a BFS column-by-level layout.
 *
 * Levels: a ticket's level is `max(level(blocker)) + 1` for each blocker
 * pointing at it; a ticket with no blockers has level 0. Cycles (which
 * shouldn't exist — the dispatcher guards against them — but we don't
 * crash on bad data) get placed at the first level where they fit.
 *
 * Within a level we sort by STATUS_ORDER (backlog first, failed/done last)
 * then by columnPosition / updatedAt so ordering is deterministic.
 */
function computeLayout(tickets: BoardTicket[], edges: TicketDependencyEdge[]): Layout {
  const ticketIds = new Set(tickets.map((t) => t.id));
  // Only keep edges where both endpoints are visible (already scoped by
  // the loader, but defensive).
  const liveEdges = edges.filter(
    (e) => ticketIds.has(e.ticket_id) && ticketIds.has(e.blocks_ticket_id),
  );
  // adjacency: blocker -> [blocked]
  const out = new Map<string, string[]>();
  // reverse: blocked -> [blocker]
  const inDeg = new Map<string, string[]>();
  for (const id of ticketIds) {
    out.set(id, []);
    inDeg.set(id, []);
  }
  for (const e of liveEdges) {
    out.get(e.blocks_ticket_id)!.push(e.ticket_id);
    inDeg.get(e.ticket_id)!.push(e.blocks_ticket_id);
  }

  // Kahn-style BFS from roots (nodes with no blockers).
  const levels = new Map<string, number>();
  const queue: string[] = [];
  for (const id of ticketIds) {
    if ((inDeg.get(id) ?? []).length === 0) {
      levels.set(id, 0);
      queue.push(id);
    }
  }
  while (queue.length) {
    const id = queue.shift()!;
    const lvl = levels.get(id) ?? 0;
    for (const next of out.get(id) ?? []) {
      const nextLvl = lvl + 1;
      const existing = levels.get(next);
      if (existing === undefined || nextLvl > existing) {
        levels.set(next, nextLvl);
        queue.push(next);
      }
    }
  }
  // Any ticket the BFS missed (cycle membership) lands one past the max.
  let maxLvl = 0;
  for (const lvl of levels.values()) {
    if (lvl > maxLvl) maxLvl = lvl;
  }
  for (const id of ticketIds) {
    if (!levels.has(id)) levels.set(id, maxLvl + 1);
  }

  // Bucket by level, sort each bucket by status then columnPosition then
  // updatedAt (newer last so done sinks to the bottom of its level).
  const buckets = new Map<number, BoardTicket[]>();
  const byId = new Map(tickets.map((t) => [t.id, t] as const));
  for (const [id, lvl] of levels) {
    const t = byId.get(id);
    if (!t) continue;
    const arr = buckets.get(lvl) ?? [];
    arr.push(t);
    buckets.set(lvl, arr);
  }
  const statusIdx = (s: TicketStatus) => {
    const i = STATUS_ORDER.indexOf(s);
    return i === -1 ? STATUS_ORDER.length : i;
  };
  const layout: Layout = {};
  for (const [lvl, arr] of buckets) {
    arr.sort((a, b) => {
      const si = statusIdx(a.status) - statusIdx(b.status);
      if (si !== 0) return si;
      const pa = a.columnPosition ?? Number.MAX_SAFE_INTEGER;
      const pb = b.columnPosition ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
    arr.forEach((t, i) => {
      layout[t.id] = { x: X_ORIGIN + lvl * COL_GAP, y: Y_ORIGIN + i * ROW_GAP };
    });
  }
  return layout;
}

function BoardGraphInner({
  tickets,
  dependencies,
  onOpenTicket,
}: {
  tickets: BoardTicket[];
  dependencies: TicketDependencyEdge[];
  onOpenTicket: (id: string) => void;
}) {
  const layout = React.useMemo(() => computeLayout(tickets, dependencies), [tickets, dependencies]);

  const doneSet = React.useMemo(() => {
    const s = new Set<string>();
    for (const t of tickets) if (t.status === "done") s.add(t.id);
    return s;
  }, [tickets]);

  const nodes: Node[] = React.useMemo(
    () =>
      tickets.map<Node>((t) => ({
        id: t.id,
        type: "ticket",
        data: { ticket: t, onOpen: onOpenTicket } as TicketNodeData,
        position: layout[t.id] ?? { x: 0, y: 0 },
        // Disable React Flow's drag — board nodes aren't authored, they're
        // just visualised. Operators move tickets in the Kanban view.
        draggable: false,
      })),
    [tickets, layout, onOpenTicket],
  );

  const edges: Edge[] = React.useMemo(() => {
    // Dedupe by (source, target) — the table PK already enforces this but
    // belt-and-braces against stale realtime payloads.
    const seen = new Set<string>();
    const out: Edge[] = [];
    for (const d of dependencies) {
      const id = `${d.blocks_ticket_id}->${d.ticket_id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const faded = doneSet.has(d.ticket_id);
      out.push({
        id,
        source: d.blocks_ticket_id,
        target: d.ticket_id,
        type: "default",
        animated: false,
        style: {
          stroke: faded
            ? "hsl(var(--muted-foreground) / 0.3)"
            : "hsl(var(--muted-foreground) / 0.6)",
          strokeWidth: 1.5,
        },
      });
    }
    return out;
  }, [dependencies, doneSet]);

  const noTickets = tickets.length === 0;
  const noEdges = !noTickets && edges.length === 0;

  return (
    <div className="relative h-full w-full">
      {/* Soft dotted grid to echo the Builder canvas. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:18px_18px]"
      />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
        className="!bg-transparent"
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="transparent" />
        <Controls
          showInteractive={false}
          className="!border-border !bg-card !text-foreground [&>button]:!border-border [&>button]:!bg-card [&>button]:!text-foreground hover:[&>button]:!bg-accent !rounded-md !border !shadow-sm"
        />
        <MiniMap
          pannable
          zoomable
          maskColor="hsl(var(--background) / 0.6)"
          className="!border-border !bg-card !rounded-md !border !shadow-sm"
          nodeColor={() => "hsl(var(--muted-foreground))"}
          nodeStrokeWidth={2}
        />
      </ReactFlow>

      {noTickets && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="bg-card/70 pointer-events-auto max-w-sm rounded-lg border border-dashed p-6 text-center shadow-sm backdrop-blur">
            <div className="bg-muted mx-auto flex h-10 w-10 items-center justify-center rounded-md">
              <Workflow className="text-muted-foreground h-5 w-5" />
            </div>
            <div className="mt-3 text-sm font-semibold">No tickets to graph yet</div>
            <p className="text-muted-foreground mt-1 text-xs">
              File a ticket from the header — once it has a dependency, the edge shows up here.
            </p>
          </div>
        </div>
      )}

      {noEdges && (
        <div className="pointer-events-none absolute right-4 top-4">
          <div className="border-border bg-card/80 text-muted-foreground pointer-events-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] shadow-sm backdrop-blur">
            <Network className="h-3 w-3" />
            Tickets have no dependencies yet
          </div>
        </div>
      )}
    </div>
  );
}

export function BoardGraph(props: {
  tickets: BoardTicket[];
  dependencies: TicketDependencyEdge[];
  onOpenTicket: (id: string) => void;
}) {
  // Wrap in a Provider so useReactFlow hooks (if added later) work without
  // the consumer caring; matches the Builder pattern.
  return (
    <ReactFlowProvider>
      <BoardGraphInner {...props} />
    </ReactFlowProvider>
  );
}
