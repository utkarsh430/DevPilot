"use client";

// Plan stage rail (plan-component revamp Phase 5 - the lifecycle spine, spec
// §1). A thin, pinned "Describe · Refine · Build · Review" rail that makes the
// plan lifecycle legible: the operator sees where they are instead of the UI
// silently swapping whole modes.
//
// PURE INDICATOR - the LOAD-BEARING invariant. This component READS
// `effectiveSession?.status` (via `deriveRailState`) and DISPLAYS it. It never
// gates, disables, or reorders the composer, advisor, or any flow; it adds no
// state, fetch, or session mutation. It reflects status; it does not drive it.
// There is deliberately no click-to-jump navigation - a "furthest-reached"
// indicator only (a jump affordance would touch session state, out of scope).
//
// The four steps map 1:1 to the real lifecycle. "Refine" folds BOTH clarifying
// Q&A and stack confirmation - the pinned Stack Strip is the stack's visible
// home, so there is no separate stack rail dot. `committed`/`discarded` collapse
// the 4-dot rail to a single terminal chip.
//
// Styling stays restrained: existing brand tokens only, `--primary` reserved for
// the current-step marker; the sweeping type/token unification is Phase 6.

import * as React from "react";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { deriveRailState, RAIL_STEPS } from "@/lib/plan/stage-rail";
import type { PlanStatus } from "@/lib/plan/types";

export function PlanStageRail({ status }: { status: PlanStatus | null }) {
  const state = deriveRailState(status);

  if (state.kind === "terminal") {
    return (
      <div className="bg-card flex items-center border-b px-6 py-2">
        <Badge tone={state.terminal === "committed" ? "ok" : "muted"} className="text-[11px]">
          {state.terminal === "committed" ? <Check aria-hidden /> : null}
          {state.label}
        </Badge>
      </div>
    );
  }

  return (
    <nav aria-label="Plan progress" className="bg-card flex items-center border-b px-6 py-2">
      <ol className="flex min-w-0 flex-1 items-center gap-1.5">
        {RAIL_STEPS.map((step, i) => {
          const isCurrent = i === state.currentIndex;
          const isReached = i < state.currentIndex;
          return (
            <React.Fragment key={step.key}>
              {i > 0 ? (
                <li aria-hidden className="min-w-3 flex-1">
                  <span
                    className={cn(
                      "block h-px w-full",
                      isReached || isCurrent ? "bg-border" : "bg-border/50",
                    )}
                  />
                </li>
              ) : null}
              <li
                aria-current={isCurrent ? "step" : undefined}
                className="flex shrink-0 items-center gap-1.5"
              >
                <StepMarker isCurrent={isCurrent} isReached={isReached} />
                <span
                  className={cn(
                    "text-[11px] leading-none",
                    isCurrent
                      ? "text-foreground font-medium"
                      : isReached
                        ? "text-muted-foreground"
                        : "text-muted-foreground/60",
                  )}
                >
                  {step.label}
                </span>
              </li>
            </React.Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

function StepMarker({ isCurrent, isReached }: { isCurrent: boolean; isReached: boolean }) {
  if (isReached) {
    return (
      <span
        aria-hidden
        className="border-border bg-muted text-muted-foreground flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
      >
        <Check className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (isCurrent) {
    // The one place --primary appears in the rail: "you are here".
    return (
      <span
        aria-hidden
        className="ring-primary/20 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-2"
      >
        <span className="bg-primary h-2 w-2 rounded-full" />
      </span>
    );
  }
  return (
    <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center">
      <span className="border-border h-2 w-2 rounded-full border" />
    </span>
  );
}
