// Plan stage rail - the pure derivation behind the 4-stage spine (Phase 5 of
// the plan-component revamp, spec §1 "the stage spine"). The lifecycle exists
// today only as an internal enum swapped wholesale by `session.status`; the
// operator gets no map. This module turns that same, already-existing signal
// into an explicit "Describe · Refine · Build · Review" position so the rail
// can render where the operator is without any new state, fetch, or backend
// change.
//
// Extracted from the component (`.tsx` can't load under Vitest) so the 1:1
// status→step mapping and the terminal collapse are unit-testable, mirroring
// how Phases 3-4 extracted `density.ts` / `provenance.ts`.
//
// LOAD-BEARING INVARIANT: this is a PURE READ of `effectiveSession?.status`.
// The rail reflects status; it never drives it. Deriving a step must need
// nothing beyond the status enum (or `null` for "no session yet").

import type { PlanStatus } from "@/lib/plan/types";

/** The four ordered rail steps, mapped 1:1 to the real lifecycle. "Refine"
 *  deliberately folds BOTH clarifying Q&A and stack confirmation - the pinned
 *  Stack Strip is the stack's visible home, so it gets no separate rail dot. */
export type RailStep = "describe" | "refine" | "build" | "review";

/** The ordered spine. Index in this array is the "furthest-reached" ordinal
 *  the component uses to mark prior steps as reached. */
export const RAIL_STEPS: readonly { key: RailStep; label: string }[] = [
  { key: "describe", label: "Describe" },
  { key: "refine", label: "Refine" },
  { key: "build", label: "Build" },
  { key: "review", label: "Review" },
] as const;

/** A terminal session collapses the 4-dot rail to a single chip. */
export type RailTerminal = "committed" | "discarded";

export type RailState =
  | { kind: "steps"; current: RailStep; currentIndex: number }
  | { kind: "terminal"; terminal: RailTerminal; label: string };

const STEP_INDEX: Record<RailStep, number> = {
  describe: 0,
  refine: 1,
  build: 2,
  review: 3,
};

const TERMINAL_LABEL: Record<RailTerminal, string> = {
  committed: "Committed",
  discarded: "Discarded",
};

/**
 * Derive the rail's state from the effective session status. `null` = no
 * session row yet (the Describe stage). The `committed`/`discarded` terminals
 * collapse to a single chip instead of the 4-dot rail.
 */
export function deriveRailState(status: PlanStatus | null): RailState {
  switch (status) {
    case null:
      return { kind: "steps", current: "describe", currentIndex: STEP_INDEX.describe };
    case "discussing":
      return { kind: "steps", current: "refine", currentIndex: STEP_INDEX.refine };
    case "planning":
      return { kind: "steps", current: "build", currentIndex: STEP_INDEX.build };
    case "planned":
      return { kind: "steps", current: "review", currentIndex: STEP_INDEX.review };
    case "committed":
    case "discarded":
      return { kind: "terminal", terminal: status, label: TERMINAL_LABEL[status] };
  }
}
