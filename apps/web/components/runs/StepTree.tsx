"use client";

import * as React from "react";
import {
  Brain,
  ChevronRight,
  ExternalLink,
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
import type { RunStep, RunStepKind } from "@/lib/runs/queries";
import { StepDetail } from "@/components/runs/StepDetail";

type Tone = "default" | "info" | "warn" | "ok" | "danger" | "muted" | "violet";

const KIND_META: Record<
  RunStepKind,
  { tone: Tone; label: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  think: { tone: "info", label: "think", Icon: Brain },
  tool_call: { tone: "violet", label: "tool", Icon: Wrench },
  tool_result: { tone: "muted", label: "result", Icon: Reply },
  human_wait: { tone: "warn", label: "human wait", Icon: Pause },
  system: { tone: "danger", label: "system", Icon: Settings2 },
  // "Take the wheel" — operator-typed turn during an interactive takeover.
  human: { tone: "ok", label: "you", Icon: Hand },
};

function shortText(s: unknown, n = 120): string {
  if (typeof s !== "string") return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function detectQaRejection(step: RunStep): boolean {
  if (step.kind !== "think") return false;
  const text = step.payload.text;
  if (typeof text !== "string") return false;
  return /DECISION:\s*REJECT/i.test(text);
}

function detectQaApproval(step: RunStep): boolean {
  if (step.kind !== "think") return false;
  const text = step.payload.text;
  if (typeof text !== "string") return false;
  return /DECISION:\s*APPROVE/i.test(text);
}

export function StepTree({
  steps,
  selectedStepId,
  onSelect,
  onReplay,
  replayingIdx,
  stepUrl,
  traceUrl,
}: {
  steps: RunStep[];
  selectedStepId: number | null;
  onSelect: (id: number) => void;
  /**
   * Phase 1 / M13 — fires when the operator clicks "Replay from here" on a
   * step. The Inspector wires this to POST `/api/runs/[id]/replay`. Omit to
   * hide the button entirely (e.g. on a still-running run).
   */
  onReplay?: (stepIdx: number) => void;
  /** Step idx currently being submitted as a replay — disables that button. */
  replayingIdx?: number | null;
  /** Per-step Langfuse deep link resolver. Null → fall back to run trace url. */
  stepUrl?: (step: RunStep) => string | null;
  traceUrl?: string | null;
}) {
  if (steps.length === 0) {
    return (
      <div className="text-muted-foreground flex h-64 flex-col items-center justify-center gap-2 text-center text-sm">
        <Brain className="h-5 w-5" />
        No steps recorded yet. They&apos;ll stream in as the engine runs.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {steps.map((step, i) => {
        const isSelected = step.id === selectedStepId;
        const prev = i > 0 ? steps[i - 1] : null;
        const gapMs = prev
          ? new Date(step.createdAt).getTime() - new Date(prev.createdAt).getTime()
          : 0;
        const rejection = detectQaRejection(step);
        const approval = detectQaApproval(step);
        const cost =
          typeof step.payload.cost_cents === "number" ? (step.payload.cost_cents as number) : 0;
        const model =
          typeof step.payload.model === "string" ? (step.payload.model as string) : null;
        const previewSource =
          step.kind === "system"
            ? step.payload.failed_reason
            : step.kind === "think" || step.kind === "human"
              ? step.payload.text
              : JSON.stringify(step.payload);

        const meta = KIND_META[step.kind];
        const Icon = meta.Icon;
        const perStepUrl = stepUrl?.(step) ?? null;
        const linkHref = perStepUrl ?? traceUrl ?? null;

        return (
          <li
            key={step.id}
            className={cn(
              "bg-card overflow-hidden rounded-lg border transition-colors",
              isSelected ? "border-foreground/30" : "hover:border-foreground/15",
              rejection ? "border-warning/40" : null,
              step.kind === "system" ? "border-destructive/30" : null,
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(step.id)}
              className="w-full px-4 py-3 text-left"
              aria-expanded={isSelected}
            >
              <div className="flex items-start gap-3">
                {/* Kind icon column. */}
                <div
                  className={cn(
                    "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                    step.kind === "think" && "bg-chart-1/15 text-chart-1",
                    step.kind === "tool_call" && "bg-chart-4/15 text-chart-4",
                    step.kind === "tool_result" && "bg-muted text-muted-foreground",
                    step.kind === "human_wait" && "bg-warning/15 text-warning",
                    step.kind === "human" && "bg-success/15 text-success",
                    step.kind === "system" && "bg-destructive/15 text-destructive",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-muted-foreground font-mono">#{step.idx}</span>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      {model ? (
                        <span className="text-muted-foreground font-mono text-[11px]">{model}</span>
                      ) : null}
                      {rejection ? <Badge tone="warn">QA reject</Badge> : null}
                      {approval ? <Badge tone="ok">QA approve</Badge> : null}
                    </div>
                    <div className="text-muted-foreground flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-wide">
                      {gapMs > 0 ? <span>+{fmtDuration(gapMs)}</span> : null}
                      {cost > 0 ? <span>{fmtCents(cost)}</span> : null}
                      <span>{relativeTime(step.createdAt)}</span>
                      <ChevronRight
                        className={cn(
                          "h-3.5 w-3.5 transition-transform",
                          isSelected ? "rotate-90" : null,
                        )}
                      />
                    </div>
                  </div>
                  {previewSource ? (
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      {shortText(previewSource)}
                    </p>
                  ) : null}
                </div>
              </div>
            </button>

            {/* Inline detail + per-step actions. */}
            {isSelected ? (
              <div className="bg-muted/20 border-t">
                <div className="flex items-center justify-end gap-1 border-b px-3 py-1.5">
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
                </div>
                <StepDetail step={step} traceUrl={traceUrl ?? null} stepUrl={stepUrl} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
