"use client";

import * as React from "react";
import { groupArtifactsByStep, type RunArtifact } from "@/lib/runs/artifacts";

/**
 * A run's browser screenshots, made available to whichever component renders a
 * step — via context rather than props.
 *
 * `StepDetail` is rendered from two different places (`RunWaterfall` and
 * `StepTree`), neither of which has any other reason to know about artifacts.
 * Threading a map through both would put an unrelated prop on two large
 * components purely as a courier. Context keeps the evidence surface to the two
 * files that actually care about it.
 *
 * Keyed on `run_steps.idx`, which is unique per run — so a step index names
 * exactly one step and an image can never be shown under two of them.
 */
const RunArtifactsContext = React.createContext<Map<number, RunArtifact[]>>(new Map());

export function RunArtifactsProvider({
  artifacts,
  children,
}: {
  artifacts: readonly RunArtifact[];
  children: React.ReactNode;
}) {
  const byStep = React.useMemo(() => groupArtifactsByStep(artifacts), [artifacts]);
  return <RunArtifactsContext.Provider value={byStep}>{children}</RunArtifactsContext.Provider>;
}

/** The images captured during one step, in capture order. Empty when the step
 *  captured nothing — which is the overwhelmingly common case. */
export function useStepArtifacts(stepIdx: number): RunArtifact[] {
  const byStep = React.useContext(RunArtifactsContext);
  return byStep.get(stepIdx) ?? [];
}
