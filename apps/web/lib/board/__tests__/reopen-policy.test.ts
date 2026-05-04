// Pure coverage for the "Restart from dev" / "Discard & restart" reopen policy:
//   • the FSM reset edges exist (done/in_progress/blocked/input_required →
//     backlog) and `done` is otherwise terminal;
//   • the reopen/reset gate allows ONLY a human to RESET a ticket to `backlog`
//     from an operator-only source (agents/system refused), while leaving the
//     agent-facing out-edges of those states untouched;
//   • the safe restart decision composes the SACRED data-loss guard — it returns
//     `reopen` ONLY when no unpushed work is at risk, and `refuse_unpushed`
//     (never a wipe) otherwise;
//   • the deliberate discard decision is status-gated only (a non-done, in-flight
//     ticket) and deliberately NEVER refuses on unpushed work.

import { describe, it, expect } from "vitest";
import { canTransition, ALLOWED_TRANSITIONS } from "@/lib/board/state";
import {
  decideReopenGate,
  decideRestartFromDev,
  decideDiscardAndRestart,
} from "@/lib/board/reopen-policy";
import type { PendingPushLike } from "@/lib/workspace/unpushed-work";

function push(over: Partial<PendingPushLike>): PendingPushLike {
  return {
    id: "pp-1",
    branch: "devpilot/thing",
    workspace_path: "/ws/t1",
    pushed_at: null,
    unpushed_count: 2,
    ...over,
  };
}

describe("FSM — the reopen / reset edges", () => {
  it("done → backlog is legal (the reopen edge)", () => {
    expect(canTransition("done", "backlog")).toBe(true);
  });
  it("backlog is the ONLY edge out of done", () => {
    expect(ALLOWED_TRANSITIONS.done).toEqual(["backlog"]);
  });
  it("paused → backlog is (still) legal", () => {
    expect(canTransition("paused", "backlog")).toBe(true);
  });
  it("the new discard reset edges are legal (in_progress/blocked/input_required → backlog)", () => {
    expect(canTransition("in_progress", "backlog")).toBe(true);
    expect(canTransition("blocked", "backlog")).toBe(true);
    expect(canTransition("input_required", "backlog")).toBe(true);
  });
  it("the discard reset edges do not disturb the states' existing out-edges", () => {
    // in_progress keeps its agent-facing out-edges
    expect(canTransition("in_progress", "in_review")).toBe(true);
    expect(canTransition("in_progress", "done")).toBe(true);
    // blocked keeps its recovery edges
    expect(canTransition("blocked", "in_progress")).toBe(true);
    expect(canTransition("blocked", "done")).toBe(true);
    // input_required keeps its resume edge
    expect(canTransition("input_required", "in_progress")).toBe(true);
  });
  it("done still cannot reach any non-backlog state directly", () => {
    expect(canTransition("done", "in_progress")).toBe(false);
    expect(canTransition("done", "ready")).toBe(false);
    expect(canTransition("done", "in_review")).toBe(false);
  });
});

describe("decideReopenGate — resetting to backlog is human-only", () => {
  it("allows a human to reset done → backlog (the reopen)", () => {
    expect(decideReopenGate({ from: "done", to: "backlog", actor: "human" })).toEqual({
      allow: true,
    });
  });
  it("refuses an agent resetting done → backlog", () => {
    const d = decideReopenGate({ from: "done", to: "backlog", actor: "agent" });
    expect(d.allow).toBe(false);
  });
  it("refuses the system/engine resetting done → backlog", () => {
    const d = decideReopenGate({ from: "done", to: "backlog", actor: "system" });
    expect(d.allow).toBe(false);
  });

  it("allows a human to reset the discard sources → backlog", () => {
    for (const from of ["in_progress", "blocked", "input_required"] as const) {
      expect(decideReopenGate({ from, to: "backlog", actor: "human" })).toEqual({ allow: true });
    }
  });
  it("REFUSES an agent/system resetting the discard sources → backlog", () => {
    for (const from of ["in_progress", "blocked", "input_required"] as const) {
      expect(decideReopenGate({ from, to: "backlog", actor: "agent" }).allow).toBe(false);
      expect(decideReopenGate({ from, to: "backlog", actor: "system" }).allow).toBe(false);
    }
  });

  it("does NOT touch the agent-facing out-edges of those states (only → backlog is gated)", () => {
    // An agent moving in_progress → in_review must not be caught by this gate.
    expect(decideReopenGate({ from: "in_progress", to: "in_review", actor: "agent" })).toEqual({
      allow: true,
    });
    expect(decideReopenGate({ from: "blocked", to: "in_progress", actor: "system" })).toEqual({
      allow: true,
    });
    expect(decideReopenGate({ from: "input_required", to: "in_progress", actor: "agent" })).toEqual(
      { allow: true },
    );
  });

  it("does NOT newly restrict the pre-existing paused → backlog edge", () => {
    // `paused` is deliberately absent from the human-only source set, so its
    // long-standing any-actor → backlog edge is untouched.
    expect(decideReopenGate({ from: "paused", to: "backlog", actor: "agent" })).toEqual({
      allow: true,
    });
    expect(decideReopenGate({ from: "ready", to: "backlog", actor: "system" })).toEqual({
      allow: true,
    });
  });
});

describe("decideRestartFromDev — the data-loss guard is load-bearing", () => {
  it("reopens a done ticket with no pending pushes", () => {
    expect(decideRestartFromDev({ status: "done", pendingPushes: [] })).toEqual({
      action: "reopen",
    });
  });

  it("reopens a done ticket whose work is all pushed", () => {
    expect(
      decideRestartFromDev({
        status: "done",
        pendingPushes: [push({ pushed_at: "2026-07-15T00:00:00Z" })],
      }),
    ).toEqual({ action: "reopen" });
  });

  it("reopens a paused ticket with nothing unpushed", () => {
    expect(decideRestartFromDev({ status: "paused", pendingPushes: [] })).toEqual({
      action: "reopen",
    });
  });

  it("REFUSES when a done ticket holds unpushed commits — never a wipe", () => {
    const d = decideRestartFromDev({
      status: "done",
      pendingPushes: [push({ pushed_at: null })],
    });
    expect(d.action).toBe("refuse_unpushed");
    if (d.action === "refuse_unpushed") {
      expect(d.holding).toHaveLength(1);
      expect(d.holding[0]?.branch).toBe("devpilot/thing");
    }
  });

  it("REFUSES a paused ticket with unpushed work too", () => {
    const d = decideRestartFromDev({
      status: "paused",
      pendingPushes: [push({ pushed_at: null })],
    });
    expect(d.action).toBe("refuse_unpushed");
  });

  it("refuses on the unpushed row even when another row is pushed", () => {
    const d = decideRestartFromDev({
      status: "done",
      pendingPushes: [
        push({ id: "a", branch: "devpilot/pushed", pushed_at: "2026-07-15T00:00:00Z" }),
        push({ id: "b", branch: "devpilot/local", pushed_at: null }),
      ],
    });
    expect(d.action).toBe("refuse_unpushed");
    if (d.action === "refuse_unpushed") {
      expect(d.holding.map((h) => h.branch)).toEqual(["devpilot/local"]);
    }
  });

  it("rejects a non-restartable status (never touches the workspace)", () => {
    const d = decideRestartFromDev({
      status: "in_progress",
      pendingPushes: [push({ pushed_at: null })],
    });
    expect(d.action).toBe("reject_status");
  });
});

describe("decideDiscardAndRestart — the deliberate throw-away", () => {
  it("proceeds for every discardable status", () => {
    for (const status of ["in_progress", "paused", "blocked", "input_required"] as const) {
      expect(decideDiscardAndRestart({ status })).toEqual({ action: "discard_reset" });
    }
  });

  it("proceeds EVEN with unpushed work — the discard is the whole point", () => {
    // The pure decision takes no pending_pushes at all: unlike the safe restart,
    // it deliberately does not consult the data-loss guard. This is what proves
    // the discard is a status-gated override, not a weakening of the reaper guard
    // (which is exercised separately and stays intact).
    expect(decideDiscardAndRestart({ status: "in_progress" })).toEqual({ action: "discard_reset" });
  });

  it("rejects a done ticket (its recovery is safe restart / land, not discard)", () => {
    const d = decideDiscardAndRestart({ status: "done" });
    expect(d.action).toBe("reject_status");
  });

  it("rejects other non-discardable statuses", () => {
    for (const status of ["backlog", "ready", "assigned", "in_review", "failed"] as const) {
      expect(decideDiscardAndRestart({ status }).action).toBe("reject_status");
    }
  });
});
