"use client";

// RunWaterfall — timeline view of a run's steps (design-review item U1).
//
// DevPilot's thesis is "the trace is the product", but the legacy StepTree renders
// steps as a flat stack of cards with a text-only `+duration` gap. This view
// turns the same `RunStep[]` into a real waterfall:
//
//   • a shared time axis where every step is a proportional wall-clock bar, so
//     long steps are visually obvious instead of hidden behind a tiny label;
//   • think → tool_call → tool_result grouped into one collapsible "turn"
//     instead of three flat siblings that never read as a unit;
//   • bars coloured by kind via the design-system chart tokens (no hardcoded
//     hex) — the same kind→tone mapping the StepTree icons already use;
//   • a cumulative cost curve pinned to the same x-axis, rising toward the
//     run's budget ceiling so spend-against-cap is legible in time; and
//   • fan-out cohort siblings nested inline as lanes on the shared axis.
//
// It is fed entirely by data RunInspector already loads (`steps`, `siblings`,
// budget/spend on the header) — no new engine or DB reads. Selection, live
// tail, per-step Langfuse deep links and "Replay from here" are preserved so
// the List view (StepTree) and this view are interchangeable.

import * as React from "react";
import Link from "next/link";
import {
  Brain,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ExternalLink,
  GitBranch,
  Hand,
  Pause,
  Reply,
  Rewind,
  Settings2,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relative-time";
import { fmtCents, fmtDuration } from "@/lib/runs/format";
import type { RunStep, RunStepKind, RunSibling, RunHeader } from "@/lib/runs/queries";
import { StepDetail } from "@/components/runs/StepDetail";

type Tone = "default" | "info" | "warn" | "ok" | "danger" | "muted" | "violet";

// One source of truth for how each step kind reads: icon, badge tone, the
// chip tint used for the icon, and the bar fill. Chip + bar both resolve to
// `--chart-*` / semantic tokens so they retrack every palette. This mirrors
// the StepTree icon mapping so the two views feel like one system.
const KIND_VISUAL: Record<
  RunStepKind,
  {
    label: string;
    tone: Tone;
    Icon: React.ComponentType<{ className?: string }>;
    chip: string;
    bar: string;
  }
> = {
  think: {
    label: "think",
    tone: "info",
    Icon: Brain,
    chip: "bg-chart-1/15 text-chart-1",
    bar: "bg-chart-1/70",
  },
  tool_call: {
    label: "tool",
    tone: "violet",
    Icon: Wrench,
    chip: "bg-chart-4/15 text-chart-4",
    bar: "bg-chart-4/70",
  },
  tool_result: {
    label: "result",
    tone: "muted",
    Icon: Reply,
    chip: "bg-muted text-muted-foreground",
    bar: "bg-muted-foreground/40",
  },
  human_wait: {
    label: "human wait",
    tone: "warn",
    Icon: Pause,
    chip: "bg-warning/15 text-warning",
    bar: "bg-warning/70",
  },
  system: {
    label: "system",
    tone: "danger",
    Icon: Settings2,
    chip: "bg-destructive/15 text-destructive",
    bar: "bg-destructive/70",
  },
  human: {
    label: "you",
    tone: "ok",
    Icon: Hand,
    chip: "bg-success/15 text-success",
    bar: "bg-success/70",
  },
};

const STATUS_TONE: Record<RunHeader["status"], Tone> = {
  running: "info",
  awaiting_human: "warn",
  done: "ok",
  failed: "danger",
  cancelled: "muted",
};

// Shared grid template for the axis, cost strip, turns and cohort lanes. A
// FIXED label column (not content-sized) is what guarantees every lane starts
// at the same x, so bars across independent rows line up under the ruler.
const GRID = "grid grid-cols-[120px_1fr] gap-x-2 md:grid-cols-[180px_1fr]";

// Tiny steps would collapse to a sub-pixel sliver; floor the rendered width so
// every bar stays a clickable, visible mark on the axis.
const MIN_BAR_PCT = 0.8;

function shortText(s: unknown, n = 140): string {
  if (typeof s !== "string") return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function stepCost(step: RunStep): number {
  return typeof step.payload.cost_cents === "number" ? (step.payload.cost_cents as number) : 0;
}

function stepModel(step: RunStep): string | null {
  return typeof step.payload.model === "string" ? (step.payload.model as string) : null;
}

// One-line summary for a step, tuned per kind so a collapsed turn tells you
// what happened without expanding.
function stepPreview(step: RunStep): string {
  const p = step.payload;
  if (step.kind === "tool_call") {
    const tool = typeof p.tool === "string" ? p.tool : "tool";
    const input = typeof p.input === "string" ? shortText(p.input, 80) : "";
    return input ? `${tool} · ${input}` : tool;
  }
  if (step.kind === "tool_result") return shortText(p.result, 120) || "result";
  if (step.kind === "system") return shortText(p.failed_reason, 120) || "system event";
  if (step.kind === "think" || step.kind === "human") return shortText(p.text, 140);
  if (step.kind === "human_wait") return shortText(p.reason, 120) || "waiting for a human";
  return shortText(JSON.stringify(p), 120);
}

function detectQaVerdict(step: RunStep): "reject" | "approve" | null {
  if (step.kind !== "think") return null;
  const text = step.payload.text;
  if (typeof text !== "string") return null;
  if (/DECISION:\s*REJECT/i.test(text)) return "reject";
  if (/DECISION:\s*APPROVE/i.test(text)) return "approve";
  return null;
}

// A "turn": a think and the tool_call/tool_result steps it drove, collapsed
// into one unit. human / human_wait / system steps stand alone (they don't
// anchor tools), and leading tool steps with no think form their own turn.
type Turn = {
  key: string;
  anchor: RunStep;
  steps: RunStep[];
  startPct: number;
  widthPct: number;
  durationMs: number;
  cost: number;
};

// Group ordered steps into turns and place each step + turn on the [t0, tEnd]
// axis. A step occupies [createdAt, next step's createdAt]; the final step
// runs to the window end. Returns turns plus a per-step-id geometry map so the
// expanded sub-rows reuse the exact same placement.
function buildTurns(
  steps: RunStep[],
  t0: number,
  tEnd: number,
): { turns: Turn[]; geo: Map<number, { startPct: number; widthPct: number; durationMs: number }> } {
  const total = Math.max(1, tEnd - t0);
  const geo = new Map<number, { startPct: number; widthPct: number; durationMs: number }>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const next = steps[i + 1];
    const start = new Date(step.createdAt).getTime();
    const end = next ? new Date(next.createdAt).getTime() : tEnd;
    const durationMs = Math.max(0, end - start);
    const startPct = Math.min(100, Math.max(0, ((start - t0) / total) * 100));
    const widthPct = Math.max(MIN_BAR_PCT, Math.min(100 - startPct, (durationMs / total) * 100));
    geo.set(step.id, { startPct, widthPct, durationMs });
  }

  const newTurn = (s: RunStep): Turn => ({
    key: `turn-${s.id}`,
    anchor: s,
    steps: [s],
    startPct: 0,
    widthPct: 0,
    durationMs: 0,
    cost: 0,
  });

  // `openAttachable` marks whether the last turn can still adopt tool steps
  // (a think or a lead-tool group). Tracking it as a flag — rather than a
  // mutable `current` reassigned inside closures — keeps control-flow narrowing
  // sound under strict mode.
  const turns: Turn[] = [];
  let openAttachable = false;
  for (const s of steps) {
    if (s.kind === "think") {
      turns.push(newTurn(s));
      openAttachable = true;
    } else if (s.kind === "tool_call" || s.kind === "tool_result") {
      const last = turns[turns.length - 1];
      if (openAttachable && last) last.steps.push(s);
      else {
        turns.push(newTurn(s));
        openAttachable = true;
      }
    } else {
      // human / human_wait / system — standalone, and they close the group.
      turns.push(newTurn(s));
      openAttachable = false;
    }
  }

  // Roll up geometry + cost onto each turn from its member steps.
  for (const turn of turns) {
    const firstStep = turn.steps[0];
    const lastStep = turn.steps[turn.steps.length - 1];
    if (!firstStep || !lastStep) continue;
    const first = geo.get(firstStep.id);
    const last = geo.get(lastStep.id);
    if (!first || !last) continue;
    turn.startPct = first.startPct;
    turn.widthPct = Math.max(MIN_BAR_PCT, last.startPct + last.widthPct - first.startPct);
    turn.durationMs = turn.steps.reduce((acc, s) => acc + (geo.get(s.id)?.durationMs ?? 0), 0);
    turn.cost = turn.steps.reduce((acc, s) => acc + stepCost(s), 0);
  }
  return { turns, geo };
}

// Cumulative-spend staircase for the cost overlay. Points are in axis space
// (x = 0..100 time, y = 0..1 fraction of the y-scale). y-scale is the budget
// ceiling when one exists, else the total spend so the curve still fills.
function buildCostCurve(
  steps: RunStep[],
  t0: number,
  tEnd: number,
  budgetCents: number,
): { points: string; area: string; spent: number; yScaleCents: number } | null {
  const total = Math.max(1, tEnd - t0);
  let cum = 0;
  const raw: Array<{ x: number; y: number }> = [];
  for (const s of steps) {
    const cost = stepCost(s);
    if (cost <= 0) continue;
    const x = Math.min(100, Math.max(0, ((new Date(s.createdAt).getTime() - t0) / total) * 100));
    raw.push({ x, y: cum }); // step up happens at this x
    cum += cost;
    raw.push({ x, y: cum });
  }
  if (cum <= 0) return null;

  const yScaleCents = budgetCents > 0 ? budgetCents : cum;
  const norm = (y: number) => Math.min(1, y / yScaleCents);
  // Anchor at the left baseline, hold the final level out to the right edge.
  const pts: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }, ...raw, { x: 100, y: cum }];
  const line = pts.map((p) => `${p.x.toFixed(2)},${(1 - norm(p.y)).toFixed(4)}`).join(" ");
  const area = `0,1 ${line} 100,1`;
  return { points: line, area, spent: cum, yScaleCents };
}

export function RunWaterfall({
  header,
  steps,
  siblings = [],
  selectedStepId,
  onSelect,
  onReplay,
  replayingIdx,
  stepUrl,
  traceUrl,
  isLive,
}: {
  header: RunHeader;
  steps: RunStep[];
  siblings?: RunSibling[];
  selectedStepId: number | null;
  onSelect: (id: number) => void;
  onReplay?: (stepIdx: number) => void;
  replayingIdx?: number | null;
  stepUrl?: (step: RunStep) => string | null;
  traceUrl?: string | null;
  isLive?: boolean;
}) {
  const t0 = new Date(header.createdAt).getTime();
  // Window end tracks the latest of: the run's last event, the newest step, or
  // (for a live run) "now" — so an in-flight final step still gets a bar.
  const lastStep = steps[steps.length - 1];
  const lastStepMs = lastStep ? new Date(lastStep.createdAt).getTime() : t0;
  const runActive = header.status === "running" || header.status === "awaiting_human";
  const nowMs = runActive ? Date.now() : 0;
  const tEnd = Math.max(t0 + 1, new Date(header.lastEventAt).getTime(), lastStepMs, nowMs);
  const totalMs = tEnd - t0;

  const { turns, geo } = React.useMemo(() => buildTurns(steps, t0, tEnd), [steps, t0, tEnd]);
  const cost = React.useMemo(
    () => buildCostCurve(steps, t0, tEnd, header.budgetCents),
    [steps, t0, tEnd, header.budgetCents],
  );

  // Expansion is keyed per turn. Default: everything collapsed for a scannable
  // overview. The turn owning the selected step auto-opens (see effect) so a
  // selection driven by the live tail or the parent reveals its detail.
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const turnOfSelected = React.useMemo(
    () => turns.find((t) => t.steps.some((s) => s.id === selectedStepId))?.key ?? null,
    [turns, selectedStepId],
  );

  // Open the selected step's turn only when the selection MOVES to a new turn,
  // so a manual collapse of the already-selected turn isn't undone on the next
  // render.
  const prevSelectedTurn = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (turnOfSelected && turnOfSelected !== prevSelectedTurn.current) {
      setExpanded((prev) => {
        if (prev.has(turnOfSelected)) return prev;
        const next = new Set(prev);
        next.add(turnOfSelected);
        return next;
      });
    }
    prevSelectedTurn.current = turnOfSelected;
  }, [turnOfSelected]);

  const isExpanded = (turn: Turn) => expanded.has(turn.key);

  const toggle = (turn: Turn) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(turn.key)) next.delete(turn.key);
      else next.add(turn.key);
      return next;
    });
  };

  const expandAll = () => setExpanded(new Set(turns.map((t) => t.key)));
  const collapseAll = () => setExpanded(new Set());

  const ticks = [0, 0.25, 0.5, 0.75, 1];

  if (steps.length === 0) {
    return (
      <div className="text-muted-foreground flex h-64 flex-col items-center justify-center gap-2 text-center text-sm">
        <Brain className="h-5 w-5" />
        No steps recorded yet. They&apos;ll stream in as the engine runs.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Sticky axis + cost overlay. Pins to the top of the scroll area so the
          ruler and the budget ceiling stay in view while turns scroll. */}
      <div className="bg-card sticky top-0 z-10 border-b">
        {/* Toolbar: legend + expand controls. */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2 pt-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {(["think", "tool_call", "tool_result"] as RunStepKind[]).map((k) => (
              <span
                key={k}
                className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]"
              >
                <span className={cn("h-2 w-2 rounded-[2px]", KIND_VISUAL[k].bar)} />
                {KIND_VISUAL[k].label}
              </span>
            ))}
            {cost ? (
              <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]">
                <span className="bg-chart-2/70 h-2 w-2 rounded-[2px]" />
                spend
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={expandAll}
              aria-label="Expand all turns"
            >
              <ChevronsUpDown className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={collapseAll}
              aria-label="Collapse all turns"
            >
              <ChevronsDownUp className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Ruler. */}
        <div className={cn(GRID, "px-3 pb-1")}>
          <div className="text-muted-foreground self-end text-[10px] uppercase tracking-wide">
            timeline
          </div>
          <div className="relative h-4">
            {ticks.map((f) => (
              <div
                key={f}
                className="text-muted-foreground absolute bottom-0 -translate-x-1/2 whitespace-nowrap text-[10px] tabular-nums first:translate-x-0 last:-translate-x-full"
                style={{ left: `${f * 100}%` }}
              >
                {fmtDuration(f * totalMs)}
              </div>
            ))}
          </div>
        </div>

        {/* Cost overlay — cumulative spend vs the budget ceiling, on the same
            x-axis as the bars below. */}
        {cost ? (
          <div className={cn(GRID, "px-3 pb-2")}>
            <div className="flex flex-col justify-center">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wide">
                spend
              </span>
              <span className="text-foreground text-xs font-medium tabular-nums">
                {fmtCents(cost.spent)}
                <span className="text-muted-foreground font-normal">
                  {" / "}
                  {header.budgetCents > 0 ? fmtCents(header.budgetCents) : "no cap"}
                </span>
              </span>
            </div>
            <div className="relative h-12">
              {/* Budget ceiling — top edge is the cap when one is set. */}
              <div
                className="border-destructive/40 absolute inset-x-0 top-0 border-t border-dashed"
                aria-hidden
              />
              <svg
                viewBox="0 0 100 1"
                preserveAspectRatio="none"
                className="h-full w-full overflow-visible"
                aria-hidden
              >
                <polygon points={cost.area} className="fill-chart-2/15" />
                <polyline
                  points={cost.points}
                  className="stroke-chart-2 fill-none"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-muted-foreground bg-card/80 absolute right-0 top-0 -translate-y-0 px-1 text-[9px] uppercase leading-tight">
                {header.budgetCents > 0 ? "ceiling" : `peak ${fmtCents(cost.yScaleCents)}`}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {/* Turn rows. A single gridline overlay keeps the quarter ticks visible
          behind every lane so bar positions stay readable while scrolling. */}
      <div className="relative">
        <div className={cn(GRID, "pointer-events-none absolute inset-0")} aria-hidden>
          <div />
          <div className="relative">
            {ticks.slice(1, -1).map((f) => (
              <div
                key={f}
                className="bg-border/50 absolute inset-y-0 w-px"
                style={{ left: `${f * 100}%` }}
              />
            ))}
          </div>
        </div>

        <ul className="relative flex flex-col py-1">
          {turns.map((turn, ti) => {
            const open = isExpanded(turn);
            const anchor = turn.anchor;
            const anchorVisual = KIND_VISUAL[anchor.kind];
            const AnchorIcon = anchorVisual.Icon;
            const verdict = detectQaVerdict(anchor);
            const model = stepModel(anchor);
            const multi = turn.steps.length > 1;
            const isLastLive = runActive && ti === turns.length - 1;
            const lastTurnStepId = turn.steps[turn.steps.length - 1]?.id ?? -1;

            return (
              <li key={turn.key} className="px-3">
                {/* Turn header row. */}
                <div
                  className={cn(
                    "hover:bg-muted/30 group rounded-md transition-colors",
                    open && "bg-muted/20",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(anchor.id);
                      toggle(turn);
                    }}
                    aria-expanded={open}
                    className={cn(GRID, "w-full items-center py-1.5 text-left")}
                  >
                    {/* Label cell. */}
                    <div className="flex min-w-0 items-center gap-1.5 pr-1">
                      <ChevronRight
                        className={cn(
                          "text-muted-foreground h-3 w-3 shrink-0 transition-transform",
                          open && "rotate-90",
                        )}
                      />
                      <span
                        className={cn(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px]",
                          anchorVisual.chip,
                        )}
                      >
                        <AnchorIcon className="h-3 w-3" />
                      </span>
                      <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">
                        #{anchor.idx}
                      </span>
                      {multi ? (
                        <span className="text-muted-foreground bg-muted shrink-0 rounded px-1 text-[10px] tabular-nums">
                          {turn.steps.length}
                        </span>
                      ) : null}
                    </div>

                    {/* Lane cell — composite bar (one segment per member step)
                        + trailing meta. */}
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="relative h-5 flex-1">
                        {turn.steps.map((s) => {
                          const g = geo.get(s.id);
                          if (!g) return null;
                          const v = KIND_VISUAL[s.kind];
                          const sel = s.id === selectedStepId;
                          return (
                            <Tooltip key={s.id}>
                              <TooltipTrigger asChild>
                                <div
                                  className={cn(
                                    "absolute top-1/2 h-3 -translate-y-1/2 rounded-[3px]",
                                    v.bar,
                                    sel && "ring-foreground/60 ring-2",
                                    isLastLive && s.id === lastTurnStepId ? "animate-pulse" : null,
                                  )}
                                  style={{ left: `${g.startPct}%`, width: `${g.widthPct}%` }}
                                />
                              </TooltipTrigger>
                              <TooltipContent>
                                {v.label} · {fmtDuration(g.durationMs)}
                                {stepCost(s) > 0 ? ` · ${fmtCents(stepCost(s))}` : ""}
                              </TooltipContent>
                            </Tooltip>
                          );
                        })}
                      </div>
                      <div className="text-muted-foreground flex shrink-0 items-center gap-2 text-[10px] tabular-nums">
                        <span className="w-12 text-right">{fmtDuration(turn.durationMs)}</span>
                        {turn.cost > 0 ? (
                          <span className="w-10 text-right">{fmtCents(turn.cost)}</span>
                        ) : null}
                      </div>
                    </div>
                  </button>

                  {/* Collapsed preview line — the anchor's gist + badges. */}
                  {!open ? (
                    <div className={cn(GRID, "pb-1.5")}>
                      <div />
                      <div className="flex min-w-0 items-center gap-2">
                        <Badge tone={anchorVisual.tone}>{anchorVisual.label}</Badge>
                        {model ? (
                          <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                            {model}
                          </span>
                        ) : null}
                        {verdict === "reject" ? <Badge tone="warn">QA reject</Badge> : null}
                        {verdict === "approve" ? <Badge tone="ok">QA approve</Badge> : null}
                        <span className="text-muted-foreground truncate text-xs">
                          {stepPreview(anchor)}
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* Expanded — each member step as its own sub-row; the selected
                    one reveals inline detail + actions. */}
                {open ? (
                  <div className="border-border/60 mb-1 ml-2.5 border-l pl-3">
                    {turn.steps.map((s) => {
                      const g = geo.get(s.id);
                      if (!g) return null;
                      const v = KIND_VISUAL[s.kind];
                      const Icon = v.Icon;
                      const sel = s.id === selectedStepId;
                      const sVerdict = detectQaVerdict(s);
                      const sModel = stepModel(s);
                      return (
                        <div key={s.id}>
                          <button
                            type="button"
                            onClick={() => onSelect(s.id)}
                            className={cn(
                              "hover:bg-muted/40 w-full rounded-md py-1 text-left",
                              GRID,
                              "items-center",
                              sel && "bg-muted/50",
                            )}
                          >
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span
                                className={cn(
                                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]",
                                  v.chip,
                                )}
                              >
                                <Icon className="h-2.5 w-2.5" />
                              </span>
                              <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
                                #{s.idx}
                              </span>
                              <Badge tone={v.tone}>{v.label}</Badge>
                              {sVerdict === "reject" ? <Badge tone="warn">reject</Badge> : null}
                              {sVerdict === "approve" ? <Badge tone="ok">approve</Badge> : null}
                            </div>
                            <div className="flex min-w-0 items-center gap-2">
                              <div className="relative h-4 flex-1">
                                <div
                                  className={cn(
                                    "absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[3px]",
                                    v.bar,
                                    sel && "ring-foreground/60 ring-2",
                                  )}
                                  style={{ left: `${g.startPct}%`, width: `${g.widthPct}%` }}
                                />
                              </div>
                              <div className="text-muted-foreground flex shrink-0 items-center gap-2 text-[10px] tabular-nums">
                                {sModel ? (
                                  <span className="hidden font-mono sm:inline">{sModel}</span>
                                ) : null}
                                <span className="w-12 text-right">{fmtDuration(g.durationMs)}</span>
                                {stepCost(s) > 0 ? (
                                  <span className="w-10 text-right">{fmtCents(stepCost(s))}</span>
                                ) : null}
                              </div>
                            </div>
                          </button>

                          {sel ? (
                            <div className="bg-muted/20 mb-1.5 mt-0.5 overflow-hidden rounded-md border">
                              <div className="flex items-center justify-end gap-1 border-b px-2 py-1">
                                <StepActions
                                  step={s}
                                  stepUrl={stepUrl}
                                  traceUrl={traceUrl}
                                  onReplay={onReplay}
                                  replayingIdx={replayingIdx}
                                />
                              </div>
                              <StepDetail step={s} traceUrl={traceUrl ?? null} stepUrl={stepUrl} />
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Cohort lanes — fan-out siblings placed on the same axis by when they
          branched. RunInspector loads sibling id/status/role/createdAt but not
          their steps, and the constraint forbids new DB reads, so each sibling
          reads as a collapsed lane that links to its own full waterfall rather
          than an inlined sub-tree. */}
      {siblings.length > 0 ? (
        <div className="mt-1 border-t pt-2">
          <div className="text-muted-foreground flex items-center gap-1.5 px-3 pb-1 text-[10px] uppercase tracking-wide">
            <GitBranch className="h-3 w-3" />
            Cohort · {siblings.length} sibling{siblings.length === 1 ? "" : "s"}
          </div>
          <ul className="flex flex-col pb-1">
            {siblings.map((sib) => {
              const branchMs = new Date(sib.createdAt).getTime();
              const startPct = Math.min(100, Math.max(0, ((branchMs - t0) / totalMs) * 100));
              return (
                <li key={sib.id} className="px-3">
                  <Link
                    href={`/runs/${sib.id}`}
                    className={cn(GRID, "hover:bg-muted/30 items-center rounded-md py-1.5")}
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <GitBranch className="text-muted-foreground h-3 w-3 shrink-0" />
                      <span className="truncate text-xs">{sib.fanOutRole ?? "sibling"}</span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="relative h-5 flex-1">
                        {/* Branch marker on the shared axis. Siblings can start
                            outside this run's window; the marker clamps to the
                            edge so it never disappears. */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div
                              className="bg-chart-3/70 absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded-[2px]"
                              style={{ left: `${startPct}%` }}
                            />
                          </TooltipTrigger>
                          <TooltipContent>branched {relativeTime(sib.createdAt)}</TooltipContent>
                        </Tooltip>
                      </div>
                      <Badge tone={STATUS_TONE[sib.status]}>{sib.status}</Badge>
                      <ExternalLink className="text-muted-foreground h-3 w-3 shrink-0" />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="text-muted-foreground border-t px-3 py-2 text-[10px]">
        {turns.length} turn{turns.length === 1 ? "" : "s"} · {steps.length} step
        {steps.length === 1 ? "" : "s"} · {fmtDuration(totalMs)} total
        {isLive ? " · live" : ""}
      </div>
    </div>
  );
}

// Per-step action bar (Langfuse deep link + Replay-from-here), lifted verbatim
// from StepTree so the affordances survive the view swap.
function StepActions({
  step,
  stepUrl,
  traceUrl,
  onReplay,
  replayingIdx,
}: {
  step: RunStep;
  stepUrl?: (step: RunStep) => string | null;
  traceUrl?: string | null;
  onReplay?: (stepIdx: number) => void;
  replayingIdx?: number | null;
}) {
  const perStepUrl = stepUrl?.(step) ?? null;
  const linkHref = perStepUrl ?? traceUrl ?? null;
  return (
    <>
      {linkHref ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="ghost" size="icon-sm">
              <a
                href={linkHref}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Open in Langfuse"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {perStepUrl ? "Open observation in Langfuse" : "Open trace in Langfuse"}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {onReplay ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={replayingIdx === step.idx}
              onClick={(e) => {
                e.stopPropagation();
                onReplay(step.idx);
              }}
            >
              <Rewind className="h-3.5 w-3.5" />
              {replayingIdx === step.idx ? "Replaying…" : "Replay from here"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Clone the run and resume from this step</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
}
