"use client";

// Phase 2 / G2 — React Flow custom node for the Board Graph view.
//
// Visually mirrors TicketCard but compressed to ~260×130 px so a few dozen
// tickets fit on the canvas. Status tone drives the left border accent; click
// the node to open the existing <TicketDrawer> (the parent wires the
// `onOpen` callback through `data.onOpen`).
//
// Handles: target on the left (incoming "blocked by" edges), source on the
// right (outgoing "blocks" edges). The edge direction matches the
// dependency semantics: blocker → blocked, left → right, so the BFS
// auto-layout in BoardGraph reads naturally top-to-bottom-of-stage,
// left-to-right.

import * as React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Clock, MessageSquare, RotateCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relative-time";
import { COLUMNS, type BoardTicket } from "@/components/board/types";
import { formatTicketKey } from "@/lib/board/ticket-key";

export type TicketNodeData = {
  ticket: BoardTicket;
  onOpen: (id: string) => void;
};

// Border accent (left bar) per status tone. We can't reuse the Badge tone
// strings directly because they decorate a pill; we want a solid border
// color on the card. Keep these in lockstep with the Badge tone tokens.
const STATUS_ACCENT: Record<string, string> = {
  default: "border-l-border",
  info: "border-l-chart-1",
  warn: "border-l-warning",
  danger: "border-l-destructive",
  ok: "border-l-success",
  violet: "border-l-chart-4",
  muted: "border-l-muted-foreground/40",
};

export function TicketNode({ data, selected }: NodeProps) {
  const wrapped = data as unknown as TicketNodeData;
  const { ticket, onOpen } = wrapped;
  const colMeta = COLUMNS.find((c) => c.id === ticket.status);
  const tone = colMeta?.tone ?? "muted";
  const accentClass = STATUS_ACCENT[tone] ?? STATUS_ACCENT.muted;
  // Same identity the board card shows: the stable `DevPilot-<N>` key, falling
  // back to the short hex id for project-less tickets.
  const ticketKey = formatTicketKey(ticket.ticketNumber, ticket.id);
  const isDone = ticket.status === "done";

  return (
    <div
      onClick={() => onOpen(ticket.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(ticket.id);
        }
      }}
      className={cn(
        "bg-card text-card-foreground group w-[260px] cursor-pointer rounded-lg border border-l-[3px] shadow-sm transition-all",
        accentClass,
        "hover:border-ring/40 hover:shadow-md",
        selected && "ring-ring shadow-md ring-2",
        isDone && "opacity-80",
      )}
      data-ticket-id={ticket.id}
      aria-label={`Ticket ${ticket.title}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!border-muted-foreground/40 !bg-card !h-2 !w-2"
      />

      <div className="flex items-start gap-1.5 p-2.5">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Badge tone={tone} className="px-1.5 py-0 text-[10px]">
              {colMeta?.label ?? ticket.status}
            </Badge>
            {ticket.retryCount > 0 ? (
              <Badge tone="warn" className="gap-1 px-1.5 py-0 text-[10px]">
                <RotateCw className="h-2.5 w-2.5" /> retry {ticket.retryCount}
              </Badge>
            ) : null}
          </div>
          <p className="text-foreground line-clamp-2 text-sm font-medium leading-snug">
            {ticket.title}
          </p>
        </div>
        <span
          className="text-muted-foreground ml-1 mt-0.5 select-none whitespace-nowrap font-mono text-[10px] tracking-wider"
          aria-label="Ticket key"
        >
          {ticketKey}
        </span>
      </div>

      <footer className="bg-muted/30 flex items-center gap-2 border-t px-2.5 py-1.5 text-[10px]">
        {ticket.commentCount > 0 ? (
          <span className="text-muted-foreground flex items-center gap-1">
            <MessageSquare className="h-3 w-3" />
            <span className="tabular-nums">{ticket.commentCount}</span>
          </span>
        ) : null}
        <span className="text-muted-foreground ml-auto flex items-center gap-1 font-mono">
          <Clock className="h-3 w-3" />
          {relativeTime(ticket.updatedAt)}
        </span>
      </footer>

      <Handle
        type="source"
        position={Position.Right}
        className="!border-muted-foreground/40 !bg-card !h-2 !w-2"
      />
    </div>
  );
}
