// The console's classification rules.
//
// Every test here is a claim about what an operator is TOLD, and the ones that
// matter are the two directions of the same mistake: reporting live work as
// stalled (which sends someone to interrupt it) and reporting a stall as fine
// (which is the six-hour outage this whole feature family exists for).

import { describe, expect, it } from "vitest";
import {
  classifyTicketState,
  summarizeBoard,
  type ConsoleSnapshot,
  type ConsoleTicketFact,
} from "@/lib/supervisor/console-facts";
import { NO_DISPATCH_STALL } from "@/lib/engine/dispatch-rescue-policy";

const NOW = "2026-08-04T12:00:00.000Z";

function ticket(over: Partial<ConsoleTicketFact> = {}): ConsoleTicketFact {
  return {
    ticketId: "t1",
    key: "DevPilot-1",
    title: "a ticket",
    status: "in_progress",
    requestedRole: "engineer",
    updatedAtIso: "2026-08-04T09:00:00.000Z",
    blockers: [],
    blockersKnown: true,
    hasLiveRun: false,
    hasPendingDispatch: false,
    latestRunStatus: "failed",
    latestRunActivityIso: "2026-08-04T09:00:00.000Z",
    hasRunAwaitingHuman: false,
    notice: null,
    landing: null,
    unpushedBranches: [],
    retryCount: 0,
    gateRetryCount: 0,
    safetyCritical: false,
    automationPaused: false,
    orphan: null,
    ...over,
  };
}

function snapshot(
  tickets: ConsoleTicketFact[],
  over: Partial<ConsoleSnapshot> = {},
): ConsoleSnapshot {
  return {
    nowIso: NOW,
    tenantId: "ten",
    projectId: "proj",
    projectName: "scoursh",
    supervisorEnabled: true,
    automation: { project: "running", tenant: "running" },
    engine: { state: "alive", lastSeenIso: NOW, ageSeconds: 12 },
    dispatch: NO_DISPATCH_STALL,
    tickets,
    truncated: false,
    ...over,
  };
}

describe("classifyTicketState — a live run outranks every other signal", () => {
  it("reports a running ticket as machine-owned even when it also looks orphaned", () => {
    // The dangerous shape: every other field says stalled. Reporting this as
    // stalled would put an operator's finger on a button that interrupts work
    // in flight.
    const d = classifyTicketState(
      ticket({
        hasLiveRun: true,
        orphan: { recoverable: true, to: "input_required", reason: "no live run" },
        status: "in_progress",
      }),
    );
    expect(d.kind).toBe("working");
    expect(d.waitingOn).toBe("machine");
  });

  it("reports a run parked on a human as a HUMAN wait, never as a stall", () => {
    const d = classifyTicketState(ticket({ hasLiveRun: true, hasRunAwaitingHuman: true }));
    expect(d.waitingOn).toBe("human");
    expect(d.kind).toBe("awaiting_operator");
  });
});

describe("classifyTicketState — who is waiting", () => {
  it("an operator pause is a human wait", () => {
    expect(classifyTicketState(ticket({ status: "paused" })).waitingOn).toBe("human");
  });

  it("board automation paused is a human wait even in an agent-owned column", () => {
    const d = classifyTicketState(ticket({ status: "in_progress", automationPaused: true }));
    expect(d.kind).toBe("paused_by_operator");
    expect(d.waitingOn).toBe("human");
  });

  it("input_required is a human wait", () => {
    expect(classifyTicketState(ticket({ status: "input_required" })).waitingOn).toBe("human");
  });

  it("a queued dispatch is a machine wait, not a stall", () => {
    const d = classifyTicketState(ticket({ hasPendingDispatch: true }));
    expect(d.kind).toBe("queued_behind_wip");
    expect(d.waitingOn).toBe("machine");
  });

  it("blocked at a gate with no open dependency waits on a human", () => {
    const d = classifyTicketState(
      ticket({
        status: "blocked",
        notice: { author: "devpilot_qa_gate", createdAtIso: NOW, excerpt: "refused" },
      }),
    );
    expect(d.kind).toBe("blocked_at_gate");
    expect(d.waitingOn).toBe("human");
    expect(d.detail).toContain("devpilot_qa_gate");
  });
});

describe("classifyTicketState — dependencies use classifyBlocker's own verdict", () => {
  it("a landed blocker does not block", () => {
    const d = classifyTicketState(
      ticket({
        status: "backlog",
        blockers: [
          {
            key: "DevPilot-9",
            title: "parent",
            status: "done",
            landedSha: "abc123",
            landPending: false,
            openness: "closed",
          },
        ],
      }),
    );
    expect(d.kind).toBe("ready_to_start");
  });

  it("a done-but-unlanded blocker is reported as awaiting the land, not as blocked work", () => {
    // The two open kinds have different remedies - only this one is something a
    // human may override - so collapsing them would lose the distinction that
    // makes the answer actionable.
    const d = classifyTicketState(
      ticket({
        status: "backlog",
        blockers: [
          {
            key: "DevPilot-9",
            title: "parent",
            status: "done",
            landedSha: null,
            landPending: true,
            openness: "awaiting_land",
          },
        ],
      }),
    );
    expect(d.kind).toBe("awaiting_dependency_land");
    expect(d.waitingOn).toBe("machine");
  });

  it("an unfinished blocker is reported with its key and status", () => {
    const d = classifyTicketState(
      ticket({
        status: "backlog",
        blockers: [
          {
            key: "DevPilot-9",
            title: "parent",
            status: "in_progress",
            landedSha: null,
            landPending: false,
            openness: "working",
          },
        ],
      }),
    );
    expect(d.kind).toBe("blocked_by_dependency");
    expect(d.detail).toContain("DevPilot-9");
    expect(d.detail).toContain("in_progress");
  });
});

describe("classifyTicketState — the alarm cases", () => {
  it("a recoverable orphan is owned by NOBODY", () => {
    const d = classifyTicketState(
      ticket({
        orphan: { recoverable: true, to: "input_required", reason: "no live run since X" },
      }),
    );
    expect(d.kind).toBe("stalled");
    expect(d.waitingOn).toBe("nobody");
  });

  it("done-but-unlanded is owned by NOBODY", () => {
    const d = classifyTicketState(
      ticket({
        status: "done",
        landing: { kind: "not_landed", reason: "never_pushed", detail: "non-fast-forward" },
      }),
    );
    expect(d.kind).toBe("done_not_landed");
    expect(d.waitingOn).toBe("nobody");
  });

  it("done with nothing to land is settled, not an alarm", () => {
    const d = classifyTicketState(
      ticket({
        status: "done",
        landing: { kind: "nothing_to_land", detail: "", hadBranch: false },
      }),
    );
    expect(d.waitingOn).toBe("none");
  });
});

describe("classifyTicketState — a stood-down recovery is split by WHY", () => {
  it("within-grace is a machine wait: something may still be starting", () => {
    const d = classifyTicketState(
      ticket({ orphan: { recoverable: false, to: null, reason: "within-grace" } }),
    );
    expect(d.kind).toBe("settling");
    expect(d.waitingOn).toBe("machine");
  });

  it("latest-run-done hands over to the stuck-ticket sweeper, so it is still owned", () => {
    const d = classifyTicketState(
      ticket({ orphan: { recoverable: false, to: null, reason: "latest-run-done" } }),
    );
    expect(d.waitingOn).toBe("machine");
  });

  it("a recovery that CANNOT proceed is an alarm, not a wait", () => {
    // `already-recovered` means the reaper spoke and the transition kept
    // failing. Nothing owns the ticket AND nothing will pick it up.
    const d = classifyTicketState(
      ticket({ orphan: { recoverable: false, to: null, reason: "already-recovered" } }),
    );
    expect(d.kind).toBe("stalled");
    expect(d.waitingOn).toBe("nobody");
  });

  it("an UNRECOGNISED stand-down reason falls to the alarming branch", () => {
    // A reason this code does not know is not evidence that someone is handling
    // it. Defaulting the other way is how a new stand-down reason silently
    // becomes an invisible stall.
    const d = classifyTicketState(
      ticket({ orphan: { recoverable: false, to: null, reason: "some-future-reason" } }),
    );
    expect(d.waitingOn).toBe("nobody");
  });
});

describe("summarizeBoard", () => {
  it("counts each ticket into exactly one bucket and lists the unowned ones", () => {
    const s = snapshot([
      ticket({ ticketId: "a", key: "DevPilot-1", hasLiveRun: true }),
      ticket({ ticketId: "b", key: "DevPilot-2", status: "input_required" }),
      ticket({
        ticketId: "c",
        key: "DevPilot-3",
        orphan: { recoverable: true, to: "input_required", reason: "nothing running" },
      }),
    ]);
    const sum = summarizeBoard(s);
    expect(sum.total).toBe(3);
    expect(sum.byWaitingOn.machine).toBe(1);
    expect(sum.byWaitingOn.human).toBe(1);
    expect(sum.byWaitingOn.nobody).toBe(1);
    expect(sum.unowned.map((u) => u.key)).toEqual(["DevPilot-3"]);
  });

  it("the engine wedge outranks every board-level headline", () => {
    // While the crons are dead every other number is a consequence rather than
    // a cause, so leading with a ticket count would point the operator at the
    // wrong thing.
    const s = snapshot([ticket({ status: "input_required" })], {
      engine: { state: "wedged", lastSeenIso: "2026-08-04T11:00:00.000Z", ageSeconds: 3600 },
      automation: { project: "paused", tenant: "running" },
    });
    expect(summarizeBoard(s).headline).toContain("scheduled recovery has not run");
  });

  it("a workspace pause outranks a project pause", () => {
    const s = snapshot([ticket()], {
      automation: { project: "paused", tenant: "paused" },
    });
    expect(summarizeBoard(s).headline).toContain("whole workspace is paused");
  });

  it("names the unowned count when nothing else is wrong", () => {
    const s = snapshot([
      ticket({ orphan: { recoverable: true, to: "input_required", reason: "r" } }),
    ]);
    expect(summarizeBoard(s).headline).toContain("nobody working on them");
  });
});
