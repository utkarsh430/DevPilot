// What an operator may command, and - more importantly - what they may not.
//
// The claims here are the ones the console's safety argument rests on: the
// offer is derived from the primitives' own policies, so it never contains an
// action the primitive would refuse; and an id that is not on the derived list
// resolves to nothing, which is what makes a forged id and a hallucinated id
// the same harmless thing.

import { describe, expect, it } from "vitest";
import {
  CONSOLE_ACTION_KINDS,
  deriveAvailableActions,
  describeActionOutcome,
  findConsoleAction,
} from "@/lib/supervisor/console-actions";
import type { DispatchQueueGroup } from "@/lib/engine/dispatch-rescue-policy";
import { NO_DISPATCH_STALL } from "@/lib/engine/dispatch-rescue-policy";
import type { ConsoleSnapshot, ConsoleTicketFact } from "@/lib/supervisor/console-facts";

const NOW = "2026-08-04T12:00:00.000Z";
const GRACE = 600;

function ticket(over: Partial<ConsoleTicketFact> = {}): ConsoleTicketFact {
  return {
    ticketId: "t1",
    key: "DevPilot-27",
    title: "a ticket",
    status: "in_progress",
    requestedRole: null,
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

function snapshot(tickets: ConsoleTicketFact[]): ConsoleSnapshot {
  return {
    nowIso: NOW,
    tenantId: "ten",
    projectId: "proj",
    projectName: "scoursh",
    supervisorEnabled: true,
    automation: { project: "running", tenant: "running" },
    engine: { state: "alive", lastSeenIso: NOW, ageSeconds: 5 },
    dispatch: NO_DISPATCH_STALL,
    tickets,
    truncated: false,
  };
}

function group(over: Partial<DispatchQueueGroup> = {}): DispatchQueueGroup {
  return {
    tenantId: "ten",
    agentId: "agent-eng",
    wipLimit: 3,
    runningRuns: 0,
    waitingRuns: 0,
    pendingRows: 2,
    oldestPendingIso: "2026-08-04T11:00:00.000Z", // an hour old — past grace
    ...over,
  };
}

describe("the vocabulary is closed", () => {
  it("has exactly the two remediations the autonomous supervisor already owns", () => {
    // Growing this list is how the console acquires a capability nobody argued
    // for. A new member needs its own safety story, not a line here.
    expect([...CONSOLE_ACTION_KINDS]).toEqual(["release_dispatch_queue", "recover_stalled_ticket"]);
  });
});

describe("deriveAvailableActions — the offer is the primitive's own policy", () => {
  it("offers a stalled ticket only when the reaper's policy said recover", () => {
    const yes = deriveAvailableActions(
      snapshot([
        ticket({ orphan: { recoverable: true, to: "input_required", reason: "nothing running" } }),
      ]),
      [],
      GRACE,
    );
    expect(yes.map((a) => a.kind)).toEqual(["recover_stalled_ticket"]);
    expect(yes[0]!.ticketId).toBe("t1");

    const no = deriveAvailableActions(
      snapshot([ticket({ orphan: { recoverable: false, to: null, reason: "within-grace" } })]),
      [],
      GRACE,
    );
    expect(no).toEqual([]);
  });

  it("offers nothing for a ticket with no orphan verdict at all", () => {
    expect(deriveAvailableActions(snapshot([ticket({ orphan: null })]), [], GRACE)).toEqual([]);
  });

  it("offers a queue release only when the rescue policy would release", () => {
    const yes = deriveAvailableActions(snapshot([]), [group()], GRACE);
    expect(yes.map((a) => a.kind)).toEqual(["release_dispatch_queue"]);
    expect(yes[0]!.slots).toBe(2);
  });

  it("offers NOTHING for an agent that is genuinely at its WIP limit", () => {
    // This is the branch that keeps the console from becoming "stop counting".
    // A busy agent's queue is doing exactly what it should.
    const atCap = deriveAvailableActions(
      snapshot([]),
      [group({ runningRuns: 3, wipLimit: 3 })],
      GRACE,
    );
    expect(atCap).toEqual([]);
  });

  it("offers NOTHING for a queue younger than the grace", () => {
    const fresh = deriveAvailableActions(
      snapshot([]),
      [group({ oldestPendingIso: "2026-08-04T11:59:00.000Z" })],
      GRACE,
    );
    expect(fresh).toEqual([]);
  });

  it("says in the consequence that a recovery does NOT re-run the work", () => {
    // An operator must be able to decline from the description alone, and
    // "unstick" reads like "try again" unless we say otherwise.
    const [a] = deriveAvailableActions(
      snapshot([ticket({ orphan: { recoverable: true, to: "input_required", reason: "r" } })]),
      [],
      GRACE,
    );
    expect(a!.consequence).toContain("does NOT re-run");
    expect(a!.consequence).toContain("Input required");
  });
});

describe("findConsoleAction — an id off the list resolves to nothing", () => {
  const available = deriveAvailableActions(
    snapshot([ticket({ orphan: { recoverable: true, to: "input_required", reason: "r" } })]),
    [group()],
    GRACE,
  );

  it("resolves an id that is on the list", () => {
    expect(findConsoleAction(available, "recover_stalled_ticket:t1")?.ticketId).toBe("t1");
  });

  it("refuses an id for a ticket that is NOT on the list", () => {
    // The forgery case, and the injected-model case: both reduce to naming a
    // target the board does not currently offer.
    expect(
      findConsoleAction(available, "recover_stalled_ticket:some-other-ticket"),
    ).toBeUndefined();
  });

  it("refuses a non-string, an empty string and an absurdly long one", () => {
    expect(findConsoleAction(available, 42)).toBeUndefined();
    expect(findConsoleAction(available, "")).toBeUndefined();
    expect(findConsoleAction(available, "x".repeat(500))).toBeUndefined();
  });
});

describe("describeActionOutcome — a refusal is explained, never worked around", () => {
  it("explains an at-capacity refusal as the WIP limit doing its job", () => {
    const s = describeActionOutcome("release_dispatch_queue", "at-capacity:3/3");
    expect(s).toContain("3/3");
    expect(s).toContain("doing exactly what it should");
  });

  it("explains a within-grace recovery refusal by naming the race it protects", () => {
    const s = describeActionOutcome("recover_stalled_ticket", "skip:within-grace");
    expect(s).toContain("not written at the same instant");
  });

  it("explains a live-run refusal as the guard working, not as a failure", () => {
    const s = describeActionOutcome("recover_stalled_ticket", "skip:live-run");
    expect(s).toContain("guard working");
  });

  it("still says something useful for a reason it does not recognise", () => {
    expect(describeActionOutcome("recover_stalled_ticket", "skip:brand-new")).toContain(
      "brand-new",
    );
  });
});

// `describeRefusedCapability` moved to `console-commands.ts` when the command
// vocabulary landed - its old wording ("I can only do two things to this
// board") became false the moment the console could do more. It is asserted in
// `console-commands.test.ts`, against the boundary that is actually current.
