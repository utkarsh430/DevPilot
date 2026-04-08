"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  BarChartHorizontal,
  ChevronRight,
  Clock,
  ExternalLink,
  GitBranch,
  Hand,
  List,
  Rewind,
  Terminal as TerminalIcon,
  TicketIcon,
  Unplug,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/sonner";
import { StepTree } from "@/components/runs/StepTree";
import { RunWaterfall } from "@/components/runs/RunWaterfall";
import { RunTerminalPanel } from "@/components/runs/RunTerminalPanel";
import { TraceCoachMark } from "@/components/runs/TraceCoachMark";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relative-time";
import { fmtCents, fmtDuration } from "@/lib/runs/format";
import type { ReplayChainNode, RunHeader, RunStep, RunSibling } from "@/lib/runs/queries";
import { langfuseObservationUrl } from "@/lib/tracing/url";
import { useLiveRunSteps } from "@/lib/realtime/use-run-steps";
import { RunArtifactsProvider } from "@/components/runs/RunArtifactsContext";
import type { RunArtifact } from "@/lib/runs/artifacts";

const STATUS_TONE: Record<RunHeader["status"], "info" | "warn" | "ok" | "danger" | "muted"> = {
  running: "info",
  awaiting_human: "warn",
  done: "ok",
  failed: "danger",
  cancelled: "muted",
};

// Tiny live-pulse dot reused from the prior inspector. Sits next to the steps
// count so the operator sees realtime sub status at a glance.
function LiveDot({ isLive, title }: { isLive: boolean; title: string }) {
  const dotColor = isLive ? "bg-success" : "bg-warning";
  return (
    <span
      className="relative inline-flex h-2 w-2"
      title={title}
      aria-label={title}
      aria-live="polite"
    >
      {isLive ? (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${dotColor}`}
        />
      ) : null}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${dotColor}`} />
    </span>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <div className="text-foreground min-w-0 flex-1 text-right">{children}</div>
    </div>
  );
}

export function RunInspector({
  header,
  steps: initialSteps,
  siblings = [],
  replayChain = [],
  traceUrl,
  langfuseBaseUrl,
  langfuseProjectId,
  artifacts = [],
}: {
  header: RunHeader;
  steps: RunStep[];
  siblings?: RunSibling[];
  replayChain?: ReplayChainNode[];
  traceUrl: string | null;
  langfuseBaseUrl: string | null;
  langfuseProjectId: string | null;
  /** Browser screenshots this run's agent captured. Handed to the step views
   *  below and surfaced by `StepDetail` beside the step that produced them.
   *  Defaults to none so every existing caller is unaffected. */
  artifacts?: RunArtifact[];
}) {
  // Live-tail run_steps as the durable engine appends them.
  const { steps, isLive } = useLiveRunSteps(header.id, initialSteps);
  const [selectedId, setSelectedId] = React.useState<number | null>(steps[0]?.id ?? null);
  // "The trace is the product" — the waterfall is the default lens; the flat
  // list view stays available for dense scanning / copy-out.
  const [view, setView] = React.useState<"waterfall" | "list">("waterfall");

  const [replayingIdx, setReplayingIdx] = React.useState<number | null>(null);
  const router = useRouter();
  const onReplay = React.useCallback(
    async (stepIdx: number) => {
      setReplayingIdx(stepIdx);
      try {
        const res = await fetch(`/api/runs/${header.id}/replay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromStepIdx: stepIdx }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error("Replay failed", {
            description: body.error ?? `HTTP ${res.status}`,
          });
          return;
        }
        toast.success("Replay queued", {
          description: `Cloned run from step #${stepIdx}. The new run will appear in the chain shortly.`,
        });
        router.refresh();
      } catch (err) {
        toast.error("Replay failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setReplayingIdx(null);
      }
    },
    [header.id, router],
  );

  const replayEnabled = header.status === "done" || header.status === "failed";

  // "Take the wheel" — only local Claude Code runs can be driven interactively
  // (the API/multi-tenant path has no terminal to surface). The button shows
  // while the run is active; once taken over, the run is paused
  // (status='cancelled', status_reason='paused:takeover') and we show Release.
  const isLocalCc = header.runnerKind === "local-cc";
  const runActive = header.status === "running" || header.status === "awaiting_human";
  const underTakeover = header.status === "cancelled" && header.statusReason === "paused:takeover";
  const [takeoverBusy, setTakeoverBusy] = React.useState(false);

  // Track 3 — in-browser xterm.js terminal attached to the run's tmux pane.
  // Every local-cc run now spawns inside `devpilot-run-<runId-16char>` (Track 2);
  // the runner stamps the name on `runs.tmux_session_name` ~200ms after the
  // step starts. We show the affordance when the session is recorded AND the
  // run is in a state where the pane is likely live (running / awaiting_human
  // / or currently under takeover — even paused runs still have an attachable
  // pane because the takeover pane is what's running). The button is also
  // shown for paused-takeover runs as a faster alternative to the runner-
  // side native terminal window.
  const hasTmuxSession = isLocalCc && Boolean(header.tmuxSessionName);
  const terminalAvailable = hasTmuxSession && (runActive || underTakeover);
  const [terminalOpen, setTerminalOpen] = React.useState(false);
  // Auto-close the terminal panel if the run transitions to a terminal state
  // (done/failed/cancelled w/o takeover). The pty will exit on its own, but
  // hiding the panel keeps the UI honest.
  React.useEffect(() => {
    if (!terminalAvailable && terminalOpen) setTerminalOpen(false);
  }, [terminalAvailable, terminalOpen]);

  const onTakeover = React.useCallback(async () => {
    setTakeoverBusy(true);
    try {
      const res = await fetch(`/api/runs/${header.id}/takeover`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error("Take the wheel failed", {
          description: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      toast.success("You have the wheel", {
        description:
          "An interactive Claude session is opening on the runner host — attach via the terminal window that pops up. Your turns appear in this run's steps.",
      });
      router.refresh();
    } catch (err) {
      toast.error("Take the wheel failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTakeoverBusy(false);
    }
  }, [header.id, router]);

  const onRelease = React.useCallback(async () => {
    setTakeoverBusy(true);
    try {
      const res = await fetch(`/api/runs/${header.id}/release-takeover`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error("Release failed", {
          description: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      toast.success("Control released", {
        description:
          "The interactive session is winding down and the headless run is resuming from your committed work.",
      });
      router.refresh();
    } catch (err) {
      toast.error("Release failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTakeoverBusy(false);
    }
  }, [header.id, router]);

  // Per-step Langfuse deep link if the step persisted an observation id.
  const stepUrl = React.useCallback(
    (step: RunStep): string | null => {
      if (!langfuseBaseUrl || !langfuseProjectId) return null;
      const obsId = (step.payload as { langfuse_observation_id?: string }).langfuse_observation_id;
      if (!obsId) return null;
      return langfuseObservationUrl(langfuseBaseUrl, langfuseProjectId, header.id, obsId);
    },
    [langfuseBaseUrl, langfuseProjectId, header.id],
  );

  React.useEffect(() => {
    const first = steps[0];
    if (selectedId == null && first) setSelectedId(first.id);
  }, [steps, selectedId]);

  const totalMs = new Date(header.lastEventAt).getTime() - new Date(header.createdAt).getTime();

  // Cost progress bar — chart-2 / warning / destructive thresholds.
  const spentPct =
    header.budgetCents > 0
      ? Math.min(100, Math.round((header.spentCents / header.budgetCents) * 100))
      : 0;
  const costBarTone =
    spentPct < 70 ? "bg-chart-2" : spentPct < 95 ? "bg-warning" : "bg-destructive";

  // Why did this run fail? The failure handler records the reason in the
  // idx=9999 system-audit step's payload (`failed_reason`); some paths also
  // stamp `runs.status_reason`. Surface it next to the FAILED badge so the
  // status isn't mistaken for a budget/ceiling issue (the cost caption below
  // is static and NOT the cause). Only meaningful for a failed run.
  const failedStep = steps.find((s) => s.idx === 9999);
  const failedReason =
    header.status === "failed"
      ? ((failedStep?.payload as { failed_reason?: string } | undefined)?.failed_reason ??
        header.statusReason ??
        null)
      : null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      {/* Breadcrumb. */}
      <nav className="text-muted-foreground mb-4 flex items-center gap-1.5 text-xs">
        <Link href="/runs" className="hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-3 w-3" />
          Runs
        </Link>
        <ChevronRight className="h-3 w-3 opacity-50" />
        <span className="text-foreground font-mono">{header.id.slice(0, 8)}</span>
        {header.replayOfRunId ? (
          <>
            <ChevronRight className="h-3 w-3 opacity-50" />
            <Link
              href={`/runs/${header.replayOfRunId}`}
              className="hover:text-foreground inline-flex items-center gap-1"
            >
              <Rewind className="h-3 w-3" />
              replay of {header.replayOfRunId.slice(0, 8)}
            </Link>
          </>
        ) : null}
      </nav>

      {/* Header strip — title + primary actions. */}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-foreground font-mono text-lg font-semibold tracking-tight">
              run/{header.id.slice(0, 12)}
            </h1>
            <Badge tone={STATUS_TONE[header.status]}>{header.status}</Badge>
            {header.runnerKind ? <Badge tone="muted">{header.runnerKind}</Badge> : null}
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            Started {relativeTime(header.createdAt)} · {fmtDuration(Math.max(0, totalMs))} elapsed ·{" "}
            {steps.length} step{steps.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {terminalAvailable ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={terminalOpen ? "default" : "outline"}
                  size="sm"
                  onClick={() => setTerminalOpen((v) => !v)}
                  aria-pressed={terminalOpen}
                >
                  <TerminalIcon className="h-3.5 w-3.5" />
                  {terminalOpen ? "Hide terminal" : "Open terminal"}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Attach to this agent&apos;s live tmux pane right here in the browser — read-write,
                no terminal app switch. Type to talk to the agent; ^C to interrupt; ^B d to detach
                without killing it.
              </TooltipContent>
            </Tooltip>
          ) : null}
          {isLocalCc && runActive ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" onClick={onTakeover} disabled={takeoverBusy}>
                  <Hand className="h-3.5 w-3.5" />
                  {takeoverBusy ? "Opening…" : "Take the wheel"}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Pause the agent and drive this ticket by hand in a native Claude terminal window on
                the runner host. The in-browser terminal above is now the primary path — use Take
                the wheel when you need full file-system access via a desktop terminal.
              </TooltipContent>
            </Tooltip>
          ) : null}
          {underTakeover ? (
            <Button variant="outline" size="sm" onClick={onRelease} disabled={takeoverBusy}>
              <Unplug className="h-3.5 w-3.5" />
              {takeoverBusy ? "Releasing…" : "Release control"}
            </Button>
          ) : null}
          {header.ticketId ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/board?ticket=${header.ticketId}`}>
                <TicketIcon className="h-3.5 w-3.5" />
                Open ticket
              </Link>
            </Button>
          ) : null}
          {traceUrl ? (
            <Button asChild variant="outline" size="sm">
              <a href={traceUrl} target="_blank" rel="noreferrer noopener">
                Langfuse <ExternalLink className="h-3 w-3" />
              </a>
            </Button>
          ) : null}
        </div>
      </header>

      {/* Failure reason banner — shown when the run failed, so the operator
          sees WHY (postprocess crash, runner disconnect, …) instead of reading
          the static cost caption as the cause. */}
      {failedReason ? (
        <div className="border-destructive/30 bg-destructive/10 mb-6 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm">
          <Unplug className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-foreground font-medium">Run failed</p>
            <p className="text-muted-foreground mt-0.5 break-words font-mono text-xs">
              {failedReason}
            </p>
          </div>
        </div>
      ) : null}

      {/* "You have the wheel" banner — shown while an interactive takeover is
          active on this run. */}
      {underTakeover ? (
        <div className="border-success/30 bg-success/10 mb-6 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm">
          <Hand className="text-success mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-foreground">
            <strong>You have the wheel.</strong> An interactive Claude session is running on the
            runner — steer it via the in-browser terminal above (preferred), the native terminal
            window that popped up on the runner, or{" "}
            <code className="bg-muted rounded px-1 py-0.5 text-xs">tmux attach</code>. Your typed
            turns and the agent&apos;s actions appear in the steps below. Commit your work, then{" "}
            <strong>Release control</strong> to resume the agent from your commit.
          </p>
        </div>
      ) : null}

      {/* Track 3 — embedded xterm.js terminal attached to the run's tmux pane.
          Visible only when the operator clicks "Open terminal". */}
      {terminalOpen && header.tmuxSessionName ? (
        <div className="mb-6">
          <RunTerminalPanel
            runId={header.id}
            sessionName={header.tmuxSessionName}
            onClose={() => setTerminalOpen(false)}
          />
          <p className="text-muted-foreground mt-2 text-[11px]">
            Live attach to{" "}
            <code className="bg-muted rounded px-1 py-0.5">{header.tmuxSessionName}</code>.
            Read-write — anything you type goes straight to the agent&apos;s tmux pane. Closing the
            panel detaches without killing the agent.
          </p>
        </div>
      ) : null}

      {/* Two-column layout: metadata sidebar (left) + step tree (right). */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
        {/* LEFT — sticky metadata column, Linear-style. */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-muted-foreground text-xs uppercase tracking-wide">
                Properties
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              <MetaRow label="Status">
                <Badge tone={STATUS_TONE[header.status]}>{header.status}</Badge>
              </MetaRow>
              <MetaRow label="Runner">
                {header.runnerKind ? (
                  <Badge tone="muted">{header.runnerKind}</Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </MetaRow>
              <MetaRow label="Agent">
                <span className="truncate">
                  {header.agentName ?? <span className="text-muted-foreground">—</span>}
                </span>
              </MetaRow>
              {header.agentRole ? (
                <MetaRow label="Role">
                  <Badge tone="info">{header.agentRole}</Badge>
                </MetaRow>
              ) : null}
              {header.ticketTitle && header.ticketId ? (
                <MetaRow label="Ticket">
                  <Link
                    href={`/board?ticket=${header.ticketId}`}
                    className="block truncate text-left underline-offset-2 hover:underline"
                    title={header.ticketTitle}
                  >
                    {header.ticketTitle}
                  </Link>
                </MetaRow>
              ) : null}
              <MetaRow label="Created">
                <span title={new Date(header.createdAt).toLocaleString()}>
                  {relativeTime(header.createdAt)}
                </span>
              </MetaRow>
              <MetaRow label="Last event">
                <span title={new Date(header.lastEventAt).toLocaleString()}>
                  {relativeTime(header.lastEventAt)}
                </span>
              </MetaRow>
              <MetaRow label="Duration">
                <span className="inline-flex items-center gap-1">
                  <Clock className="text-muted-foreground h-3 w-3" />
                  {fmtDuration(Math.max(0, totalMs))}
                </span>
              </MetaRow>
              <MetaRow label="Steps">
                <span className="inline-flex items-center gap-1.5">
                  <span className="font-mono">{steps.length}</span>
                  <LiveDot isLive={isLive} title={isLive ? "Live subscribed" : "Connecting…"} />
                </span>
              </MetaRow>
              {header.tmuxSessionName ? (
                <MetaRow label="tmux">
                  <code
                    className="text-muted-foreground font-mono text-[11px]"
                    title="Attach manually: tmux attach -t <name>"
                  >
                    {header.tmuxSessionName}
                  </code>
                </MetaRow>
              ) : null}
            </CardContent>
          </Card>

          {/* Cost summary. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-muted-foreground text-xs uppercase tracking-wide">
                Cost
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-2xl font-semibold">{fmtCents(header.spentCents)}</span>
                <span className="text-muted-foreground text-xs">
                  of {fmtCents(header.budgetCents)} budget
                </span>
              </div>
              <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className={`h-full transition-all ${costBarTone}`}
                  style={{ width: `${spentPct}%` }}
                />
              </div>
              <p className="text-muted-foreground text-[11px]">
                {spentPct >= 100
                  ? `Per-run cap reached (${spentPct}%) — the engine refused new tool/think steps.`
                  : `${spentPct}% of the per-run cap. The engine only refuses new tool/think steps once the cap is hit; this run is under it.`}
              </p>
            </CardContent>
          </Card>

          {/* Fan-out cohort. */}
          {header.fanOutGroup ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-muted-foreground flex items-center gap-1.5 text-xs uppercase tracking-wide">
                  <GitBranch className="h-3 w-3" />
                  Cohort
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pt-0">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground font-mono">
                    {header.fanOutGroup.slice(0, 8)}
                  </span>
                  {header.fanOutRole ? <Badge tone="info">{header.fanOutRole}</Badge> : null}
                </div>
                {siblings.length > 0 ? (
                  <ul className="space-y-1">
                    {siblings.map((s) => (
                      <li key={s.id}>
                        <Link
                          href={`/runs/${s.id}`}
                          className="bg-muted/30 hover:border-foreground/20 flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs"
                        >
                          <span className="truncate">{s.fanOutRole ?? "sibling"}</span>
                          <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-[11px]">
                    No other siblings in this cohort.
                  </p>
                )}
              </CardContent>
            </Card>
          ) : null}

          {/* Replay chain navigator. */}
          {replayChain.length > 1 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-muted-foreground flex items-center gap-1.5 text-xs uppercase tracking-wide">
                  <Rewind className="h-3 w-3" />
                  Replay chain
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 pt-0">
                {replayChain.map((node, i) => (
                  <Link
                    key={node.id}
                    href={`/runs/${node.id}`}
                    className={
                      "flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors " +
                      (node.isCurrent
                        ? "border-foreground/30 bg-muted/60"
                        : "bg-muted/30 hover:border-foreground/20")
                    }
                  >
                    <span className="font-mono">
                      {node.isOriginal ? "original" : `replay-${i}`}
                    </span>
                    <Badge tone={STATUS_TONE[node.status]}>{node.status}</Badge>
                  </Link>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </aside>

        {/* RIGHT — the trace, as a waterfall (default) or the flat list. */}
        <main className="min-w-0">
          {/* A3 — one-time "this is the live trace" coach mark. */}
          <TraceCoachMark />
          <Card className="overflow-hidden">
            <CardHeader className="border-b">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-sm">Trace</CardTitle>
                <div className="flex items-center gap-3">
                  {/* Waterfall ↔ List segmented toggle. */}
                  <div
                    className="bg-muted inline-flex items-center rounded-md p-0.5"
                    role="tablist"
                    aria-label="Trace view"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={view === "waterfall"}
                      onClick={() => setView("waterfall")}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-[5px] px-2 py-1 text-xs transition-colors",
                        view === "waterfall"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <BarChartHorizontal className="h-3.5 w-3.5" />
                      Waterfall
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={view === "list"}
                      onClick={() => setView("list")}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-[5px] px-2 py-1 text-xs transition-colors",
                        view === "list"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <List className="h-3.5 w-3.5" />
                      List
                    </button>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                        <span className="font-mono">{steps.length}</span> steps
                        <LiveDot
                          isLive={isLive}
                          title={
                            isLive ? "Run steps stream subscribed" : "Run steps stream connecting"
                          }
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {isLive ? "Live tailing new steps" : "Reconnecting to realtime"}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {/* Scoped to the two step views because they are the only
                  consumers — StepDetail (rendered by both) reads it. Wrapping
                  the whole component instead would re-indent the entire file
                  for no behavioural gain. */}
              <RunArtifactsProvider artifacts={artifacts}>
                <ScrollArea viewportClassName="max-h-[calc(100vh-220px)] min-h-[400px]">
                  {view === "waterfall" ? (
                    <RunWaterfall
                      header={header}
                      steps={steps}
                      siblings={siblings}
                      selectedStepId={selectedId}
                      onSelect={setSelectedId}
                      onReplay={replayEnabled ? onReplay : undefined}
                      replayingIdx={replayingIdx}
                      stepUrl={stepUrl}
                      traceUrl={traceUrl}
                      isLive={isLive}
                    />
                  ) : (
                    <div className="p-3">
                      <StepTree
                        steps={steps}
                        selectedStepId={selectedId}
                        onSelect={setSelectedId}
                        onReplay={replayEnabled ? onReplay : undefined}
                        replayingIdx={replayingIdx}
                        stepUrl={stepUrl}
                        traceUrl={traceUrl}
                      />
                    </div>
                  )}
                </ScrollArea>
              </RunArtifactsProvider>
            </CardContent>
          </Card>
        </main>
      </div>
    </div>
  );
}
