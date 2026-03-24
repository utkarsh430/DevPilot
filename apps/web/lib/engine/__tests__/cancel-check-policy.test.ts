// Coverage for the board-pause-doesn't-stop-the-run bug.
//
// Before the fix, the run loop's per-iteration check-cancel step read ONLY
// `runs.status==='cancelled'` (the per-ticket pause primitive). A board /
// workspace automation pause wrote `projects.automation_state='paused'`, which
// gated new dispatch but never reached the already-running ticket — so the
// live run burned to completion. `decideCancelCheck` is the pure policy that
// makes the loop also honor effective automation pause and halt cleanly at the
// next boundary; `isResumeDispatchable` pins that the halted (in_progress)
// ticket is re-dispatched on resume.

import { describe, expect, it } from "vitest";
import {
  decideCancelCheck,
  isResumeDispatchable,
  RESUME_DISPATCHABLE_STATUSES,
  type PauseState,
} from "@/lib/engine/cancel-check-policy";

const RUNNING = "running";
const NOT_PAUSED: PauseState = { paused: false };

describe("decideCancelCheck — per-ticket cancel path (unchanged)", () => {
  it("halts a run already flipped to 'cancelled' (pauseTicket / watchdog)", () => {
    expect(
      decideCancelCheck({ runStatus: "cancelled", hasTicket: true, pause: NOT_PAUSED }),
    ).toEqual({ halt: "cancelled" });
  });

  it("'cancelled' wins even when automation is ALSO paused (already terminal, no second write)", () => {
    expect(
      decideCancelCheck({
        runStatus: "cancelled",
        hasTicket: true,
        pause: { paused: true, scope: "project" },
      }),
    ).toEqual({ halt: "cancelled" });
  });
});

describe("decideCancelCheck — board/workspace automation pause (the fix)", () => {
  it("halts an in-flight ticket-bound run when the PROJECT is paused", () => {
    expect(
      decideCancelCheck({
        runStatus: RUNNING,
        hasTicket: true,
        pause: { paused: true, scope: "project" },
      }),
    ).toEqual({ halt: "automation-paused", scope: "project" });
  });

  it("halts an in-flight ticket-bound run when the WORKSPACE (tenant) is paused", () => {
    expect(
      decideCancelCheck({
        runStatus: RUNNING,
        hasTicket: true,
        pause: { paused: true, scope: "tenant" },
      }),
    ).toEqual({ halt: "automation-paused", scope: "tenant" });
  });

  it("does NOT halt when nothing is paused (the run continues)", () => {
    expect(decideCancelCheck({ runStatus: RUNNING, hasTicket: true, pause: NOT_PAUSED })).toEqual({
      halt: false,
    });
  });
});

describe("decideCancelCheck — ticket-less runs are never automation-halted", () => {
  it("a ticket-less run (supervisor child / ticket-less replay) ignores automation pause", () => {
    // A ticket-less run has no project to pause; halting it on a tenant pause
    // would stop headless work the board pause was never meant to reach.
    expect(
      decideCancelCheck({
        runStatus: RUNNING,
        hasTicket: false,
        pause: { paused: true, scope: "tenant" },
      }),
    ).toEqual({ halt: false });
  });

  it("a ticket-less run STILL halts on an explicit cancel", () => {
    expect(
      decideCancelCheck({ runStatus: "cancelled", hasTicket: false, pause: NOT_PAUSED }),
    ).toEqual({ halt: "cancelled" });
  });
});

describe("decideCancelCheck — resumability shape", () => {
  it("an automation-paused halt is distinguishable from an explicit cancel", () => {
    // The run loop needs the distinction: 'cancelled' means the row is already
    // terminal (no second write); 'automation-paused' means the loop must flip
    // the row out of 'running' itself before exiting, so runAgentFailed skips
    // the supervision restart.
    const paused = decideCancelCheck({
      runStatus: RUNNING,
      hasTicket: true,
      pause: { paused: true, scope: "project" },
    });
    const cancelled = decideCancelCheck({
      runStatus: "cancelled",
      hasTicket: true,
      pause: NOT_PAUSED,
    });
    expect(paused.halt).toBe("automation-paused");
    expect(cancelled.halt).toBe("cancelled");
  });
});

describe("isResumeDispatchable — resume re-dispatch coverage", () => {
  it("in_progress IS re-dispatched — a board-halted ticket stays in_progress and must come back", () => {
    expect(isResumeDispatchable("in_progress")).toBe(true);
  });

  it("ready and in_review are re-dispatched (pause also skipped their new/awaiting work)", () => {
    expect(isResumeDispatchable("ready")).toBe(true);
    expect(isResumeDispatchable("in_review")).toBe(true);
  });

  it("terminal / held statuses are left alone on resume", () => {
    for (const s of ["done", "failed", "blocked", "input_required", "paused", "backlog"]) {
      expect(isResumeDispatchable(s)).toBe(false);
    }
  });

  it("the set stays in sync with the three working statuses", () => {
    expect([...RESUME_DISPATCHABLE_STATUSES].sort()).toEqual(
      ["in_progress", "in_review", "ready"].sort(),
    );
  });
});
