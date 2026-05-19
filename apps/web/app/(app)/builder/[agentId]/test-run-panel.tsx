"use client";

// Phase 1 / M16 — Test Run sidebar.
//
// Files an ad-hoc ticket against the current canvas via fileTestTicketAction,
// then tails the spawned ticket's status using the shared `useLiveTickets`
// Realtime hook. We don't need a new endpoint or event plumbing — the hook
// already subscribes per-tenant and we just pick out the row we filed.

import * as React from "react";
import {
  Beaker,
  ExternalLink,
  PlayCircle,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Hourglass,
  PauseCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { useLiveTickets } from "@/lib/realtime/use-tickets";
import { fileTestTicketAction } from "./actions";
import type { BuilderCanvas } from "@/lib/builder/types";
import type { TicketStatus } from "@/lib/board/state";

type Props = {
  canvas: BuilderCanvas;
  agentId: string | null;
};

type TestState =
  | { kind: "idle" }
  | { kind: "firing" }
  | { kind: "fired"; ticketId: string; ephemeralAgentId: string; at: number }
  | { kind: "error"; message: string };

export function TestRunPanel({ canvas, agentId }: Props) {
  const [title, setTitle] = React.useState("M16 builder test: password-reset");
  const [description, setDescription] = React.useState(
    "Operator passwords need a one-time reset link via email. Plan, implement, and verify the change.",
  );
  const [state, setState] = React.useState<TestState>({ kind: "idle" });

  async function onFire() {
    setState({ kind: "firing" });
    const res = await fileTestTicketAction({
      agentId: agentId ?? "new",
      canvas,
      ticketTitle: title,
      ticketDescription: description,
    });
    if (!res.ok) {
      setState({ kind: "error", message: res.error });
      toast.error(`Test ticket failed: ${res.error}`);
      return;
    }
    setState({
      kind: "fired",
      ticketId: res.ticketId,
      ephemeralAgentId: res.ephemeralAgentId,
      at: Date.now(),
    });
    toast.success("Test ticket filed — watch the pill for status.");
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2 p-3 pb-1.5">
          <CardTitle className="text-muted-foreground flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
            <Beaker className="h-3.5 w-3.5" />
            Test run
          </CardTitle>
          {state.kind === "fired" && <LiveTicketPill ticketId={state.ticketId} />}
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-2 p-3 pt-1 text-[11px]">
          <p>
            Files an ad-hoc ticket against an ephemeral agent built from this canvas. The dispatcher
            kicks off normally; the saved agent isn&apos;t touched.
          </p>
          <div className="space-y-2 pt-1">
            <label className="block">
              <span className="text-muted-foreground mb-1 block text-[10px] font-medium uppercase tracking-wide">
                Title
              </span>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ticket title"
              />
            </label>
            <label className="block">
              <span className="text-muted-foreground mb-1 block text-[10px] font-medium uppercase tracking-wide">
                Description
              </span>
              <Textarea
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what the agent should do"
              />
            </label>
            <Button
              onClick={onFire}
              disabled={state.kind === "firing"}
              className="w-full gap-1.5"
              size="sm"
            >
              {state.kind === "firing" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Filing…
                </>
              ) : (
                <>
                  <PlayCircle className="h-3.5 w-3.5" />
                  File test ticket
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {state.kind === "fired" && (
        <Card className="border-success/30 bg-success/5">
          <CardContent className="space-y-2 p-3 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-success flex items-center gap-1.5 font-medium">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Ticket filed
              </span>
              <LiveTicketPill ticketId={state.ticketId} />
            </div>
            <div className="text-muted-foreground font-mono text-[10px]">
              ticket {state.ticketId.slice(0, 8)}… · agent {state.ephemeralAgentId.slice(0, 8)}…
            </div>
            <Button asChild size="sm" variant="outline" className="w-full gap-1.5">
              <a href={`/board?ticket=${state.ticketId}`} target="_blank" rel="noreferrer">
                Open on board
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </CardContent>
        </Card>
      )}

      {state.kind === "error" && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="text-destructive flex items-start gap-2 p-3 text-[11px]">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{state.message}</span>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Live ticket status pill ──────────────────────────────────────────────
//
// Subscribes via `useLiveTickets` (one Realtime channel scoped to the
// tenant). We seed `initial` as empty — the hook resyncs from the server
// snapshot once the channel reports SUBSCRIBED.

function LiveTicketPill({ ticketId }: { ticketId: string }) {
  const { tickets, isLive } = useLiveTickets([]);
  const ticket = tickets.find((t) => t.id === ticketId);
  const status = (ticket?.status ?? "unknown") as TicketStatus | "unknown";
  const meta = STATUS_PILL_META[status] ?? STATUS_PILL_META.unknown;
  return (
    <Badge
      tone={meta.tone}
      className="gap-1 font-normal"
      title={
        isLive ? `Live · last seen ${ticket?.updatedAt ?? "—"}` : "Subscribing to live updates…"
      }
    >
      {meta.icon}
      <span>{meta.label}</span>
    </Badge>
  );
}

const STATUS_PILL_META: Record<
  TicketStatus | "unknown",
  {
    tone: React.ComponentProps<typeof Badge>["tone"];
    label: string;
    icon: React.ReactNode;
  }
> = {
  unknown: {
    tone: "muted",
    label: "Connecting…",
    icon: <Hourglass className="h-2.5 w-2.5" />,
  },
  backlog: { tone: "muted", label: "Backlog", icon: <Hourglass className="h-2.5 w-2.5" /> },
  ready: { tone: "info", label: "Ready", icon: <Hourglass className="h-2.5 w-2.5" /> },
  assigned: { tone: "info", label: "Assigned", icon: <Hourglass className="h-2.5 w-2.5" /> },
  in_progress: {
    tone: "info",
    label: "In progress",
    icon: <Loader2 className="h-2.5 w-2.5 animate-spin" />,
  },
  input_required: {
    tone: "warn",
    label: "Input required",
    icon: <AlertCircle className="h-2.5 w-2.5" />,
  },
  blocked: { tone: "warn", label: "Blocked", icon: <AlertCircle className="h-2.5 w-2.5" /> },
  in_review: { tone: "violet", label: "In review", icon: <Hourglass className="h-2.5 w-2.5" /> },
  paused: { tone: "muted", label: "Paused", icon: <PauseCircle className="h-2.5 w-2.5" /> },
  done: { tone: "ok", label: "Done", icon: <CheckCircle2 className="h-2.5 w-2.5" /> },
  failed: { tone: "danger", label: "Failed", icon: <AlertCircle className="h-2.5 w-2.5" /> },
};
