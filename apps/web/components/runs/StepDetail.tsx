"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { fmtCents } from "@/lib/runs/format";
import type { RunStep } from "@/lib/runs/queries";
import { useStepArtifacts } from "@/components/runs/RunArtifactsContext";
import { StepArtifacts } from "@/components/runs/StepArtifacts";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-muted-foreground mb-1 text-[11px] font-medium uppercase tracking-wide">
        {title}
      </h3>
      {children}
    </section>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-background text-foreground max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 font-mono text-[11px] leading-relaxed">
      {children}
    </pre>
  );
}

export function StepDetail({
  step,
  // traceUrl + stepUrl are now surfaced as buttons by the StepTree row header;
  // we still accept them for backwards-compat callers and forward-compat use.
  traceUrl: _traceUrl,
  stepUrl: _stepUrl,
}: {
  step: RunStep | null;
  traceUrl: string | null;
  stepUrl?: (step: RunStep) => string | null;
}) {
  // Hooks run before the null-step early return. `-1` is not a real step index
  // (they are non-negative), so it can never collide with a step's artifacts.
  const artifacts = useStepArtifacts(step?.idx ?? -1);

  if (!step) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-xs">
        Select a step to see its payload.
      </div>
    );
  }

  const p = step.payload as {
    prompt?: string;
    text?: string;
    model?: string;
    runner_kind?: string;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    cost_cents?: number;
    finish_reason?: string;
    failed_reason?: string;
    langfuse_observation_id?: string;
  };

  const isThink = step.kind === "think";
  const isSystem = step.kind === "system";

  return (
    <div className="flex flex-col gap-4 p-4">
      {isThink ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-[11px]">
          {p.runner_kind ? <Badge tone="muted">{p.runner_kind}</Badge> : null}
          {p.usage ? (
            <span>
              tokens: {p.usage.promptTokens ?? 0} in · {p.usage.completionTokens ?? 0} out ·{" "}
              {p.usage.totalTokens ?? 0} total
            </span>
          ) : null}
          <span>cost: {fmtCents(p.cost_cents)}</span>
          {/* The MODEL's finish_reason for this step — distinct from the RUN's
              status. A step can read "model finish: success" on a run that
              later FAILED in postprocess; the label makes that non-confusing. */}
          {p.finish_reason ? <span>model finish: {p.finish_reason}</span> : null}
        </div>
      ) : null}

      {isSystem && p.failed_reason ? (
        <Section title="Failure reason">
          <CodeBlock>{p.failed_reason}</CodeBlock>
        </Section>
      ) : null}

      {isThink && p.prompt ? (
        <Section title="Prompt">
          <CodeBlock>{p.prompt}</CodeBlock>
        </Section>
      ) : null}

      {isThink && p.text ? (
        <Section title="Output">
          <CodeBlock>{p.text}</CodeBlock>
        </Section>
      ) : null}

      {/* Visual evidence the agent captured while this step ran. Rendered here,
          beside the step's own prompt and output, rather than in a separate
          gallery: an image divorced from what the agent was doing when it took
          it is a picture, not evidence. */}
      <StepArtifacts artifacts={artifacts} />

      <Separator />

      <Section title="Raw payload">
        <CodeBlock>{JSON.stringify(step.payload, null, 2)}</CodeBlock>
      </Section>
    </div>
  );
}
