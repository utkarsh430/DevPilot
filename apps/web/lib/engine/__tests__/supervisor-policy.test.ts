// The project supervisor's decision core.
//
// Every assertion here is a property the 2026-08-03 incident violated, or a
// property whose violation would make the supervisor WORSE than the incident
// (a second actor fighting the reapers). Each is mutation-verified - the
// mutation that breaks it is named beside it.

import { describe, expect, it } from "vitest";
import {
  ENGINE_RECOVERY_STALE_SECONDS_DEFAULT,
  INDICTMENT_THRESHOLD_DEFAULT,
  INDICTMENT_WINDOW_SECONDS_DEFAULT,
  NON_INDICTABLE_CAUSES,
  SUPERVISOR_CAUSES,
  assessEngineRecovery,
  decideSupervisorMode,
  detectRepeatDefect,
  isVetoedByLiveRunner,
  planSupervision,
  renderIndictment,
  selectUnescalatedIndictments,
  type SupervisedDispatchGroup,
  type SupervisedTicket,
  type SupervisorSnapshot,
} from "@/lib/engine/supervisor-policy";

const NOW = "2026-08-03T18:00:00.000Z";

function iso(minutesAgo: number): string {
  return new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
}

/** A (tenant, agent) pair holding queue rows with NOTHING live - the incident's
 *  shape: "at WIP limit" and "zero runs executing", jointly impossible. */
function deadlockedGroup(over: Partial<SupervisedDispatchGroup> = {}): SupervisedDispatchGroup {
  return {
    tenantId: "tenant-a",
    agentId: "agent-engineer",
    wipLimit: 3,
    runningRuns: 0,
    waitingRuns: 0,
    pendingRows: 4,
    oldestPendingIso: iso(420), // seven hours, as observed
    allRowsSupervised: true,
    ...over,
  };
}

/** A ticket the board says is `in_progress` whose latest run ended `failed`,
 *  with nothing live and nothing queued. */
function stalledTicket(over: Partial<SupervisedTicket> = {}): SupervisedTicket {
  return {
    ticketId: "ticket-1",
    tenantId: "tenant-a",
    projectId: "project-a",
    runIds: ["run-dead-1"],
    evidence: {
      status: "in_progress",
      ticketUpdatedAtIso: iso(400),
      hasLiveRun: false,
      hasPendingDispatch: false,
      latestRunStatus: "failed",
      latestRunFanOutGroup: null,
      latestRunActivityIso: iso(400),
      automationPaused: false,
      lastRecoveryCommentIso: null,
      nowIso: NOW,
      graceSeconds: 1800,
    },
    ...over,
  };
}

function snapshot(over: Partial<SupervisorSnapshot> = {}): SupervisorSnapshot {
  return {
    // Default: the engine's own recovery is DEAD - no cron has stamped the
    // canary for two hours.
    liveness: assessEngineRecovery(iso(120), NOW, ENGINE_RECOVERY_STALE_SECONDS_DEFAULT),
    dispatchGroups: [deadlockedGroup()],
    stalledTickets: [stalledTicket()],
    // Default empty: the bookkeeping repair is the one thing here that is NOT
    // gated on liveness, so leaving it populated by default would quietly change
    // what every gate test below is measuring.
    unsettledLandedPushes: [],
    nowIso: NOW,
    dispatchGraceSeconds: 600,
    ...over,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Liveness - the gate everything else hangs off.
// ───────────────────────────────────────────────────────────────────────────

describe("assessEngineRecovery", () => {
  it("reports alive while the canary is fresh", () => {
    const l = assessEngineRecovery(iso(1), NOW, 300);
    expect(l.state).toBe("alive");
  });

  it("reports wedged once the canary is older than the stale window", () => {
    const l = assessEngineRecovery(iso(30), NOW, 300);
    expect(l.state).toBe("wedged");
  });

  // A NEVER-STAMPED canary is not evidence of a wedge. It is what a fresh
  // install, a not-yet-deployed canary, or a truncated table looks like, and
  // remediating on it would mean the supervisor's very first act on a brand-new
  // instance is to start moving tickets.
  it("reports unknown when the canary has never been stamped", () => {
    expect(assessEngineRecovery(null, NOW, 300).state).toBe("unknown");
  });

  it("reports unknown rather than wedged for an unparseable stamp", () => {
    expect(assessEngineRecovery("not-a-date", NOW, 300).state).toBe("unknown");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. THE NON-DUPLICATION RULE, both directions.
//
// A test covering only the wedged case would pass a supervisor that fights the
// reapers on a healthy board - which is strictly worse than the bug, because
// duplicate dispatch has already put two agents in one git workspace here.
// ───────────────────────────────────────────────────────────────────────────

describe("decideSupervisorMode", () => {
  it("OBSERVES when the engine's own recovery is alive", () => {
    const m = decideSupervisorMode(assessEngineRecovery(iso(1), NOW, 300));
    expect(m.mode).toBe("observe");
  });

  it("REMEDIATES only when the engine's own recovery is wedged", () => {
    const m = decideSupervisorMode(assessEngineRecovery(iso(30), NOW, 300));
    expect(m.mode).toBe("remediate");
  });

  // Fail-closed. "We cannot tell" must never authorise a second writer.
  it("OBSERVES when liveness is unknown", () => {
    const m = decideSupervisorMode(assessEngineRecovery(null, NOW, 300));
    expect(m.mode).toBe("observe");
  });
});

describe("planSupervision - the non-duplication rule end to end", () => {
  // MUTATION: drop the `if (mode === "remediate")` guard in planSupervision and
  // this goes red while the incident test below stays green.
  it("plans NO remediation on a healthy engine, however bad the board looks", () => {
    const plan = planSupervision(
      snapshot({ liveness: assessEngineRecovery(iso(1), NOW, 300) }),
      new Set<string>(),
    );
    expect(plan.mode).toBe("observe");
    // It still SEES everything - observing is not blindness.
    expect(plan.findings.map((f) => f.cause).sort()).toEqual(["board_deadlock", "stalled_ticket"]);
    expect(plan.remediations).toEqual([]);
  });

  it("plans no remediation while liveness is unknown", () => {
    const plan = planSupervision(
      snapshot({ liveness: assessEngineRecovery(null, NOW, 300) }),
      new Set<string>(),
    );
    expect(plan.remediations).toEqual([]);
  });

  // THE EXCEPTION, and it is an exception to a NON-DUPLICATION rule rather than
  // to a "never act" rule - see `SupervisorBookkeepingRepair`. A push-row repair
  // duplicates no cron (PR #156 deliberately refused a sweeper over
  // `pending_pushes`, so there has never been one to fight), moves nothing on
  // the board, and its defect only ever happens WHILE the engine is healthy.
  // Gating it would make it fire approximately never.
  //
  // Both halves are asserted on ONE pass, because either alone permits the
  // wrong implementation: the first is green for a supervisor that ignores the
  // gate entirely, the second for one that never repairs anything.
  it("repairs a stale push row on a healthy engine WITHOUT touching what the crons own", () => {
    const plan = planSupervision(
      snapshot({
        liveness: assessEngineRecovery(iso(1), NOW, 300),
        unsettledLandedPushes: [
          {
            tenantId: "tenant-1",
            projectId: "project-1",
            ticketId: "ticket-landed",
            pushId: "push-1",
            detail: "landed at abc123 with its push row still unsettled",
          },
        ],
      }),
      new Set<string>(),
    );
    expect(plan.mode).toBe("observe");
    // The structural property AGENTS.md records, unchanged: `remediations` is
    // written inside a single `if (mode === "remediate")` block, so it is still
    // provably empty here.
    expect(plan.remediations).toEqual([]);
    expect(plan.bookkeepingRepairs).toHaveLength(1);
    expect(plan.bookkeepingRepairs[0]).toMatchObject({
      cause: "landed_push_unsettled",
      action: "settle_landed_push",
      ticketId: "ticket-landed",
      pushId: "push-1",
    });
    // Reported, and NOT as advisory - it is acted on, so calling it "seen but
    // not acted on" would be false.
    const finding = plan.findings.find((f) => f.cause === "landed_push_unsettled");
    expect(finding?.advisory).toBe(false);
  });

  it("plans no push-row repair when there is nothing stale to repair", () => {
    const plan = planSupervision(
      snapshot({ liveness: assessEngineRecovery(iso(1), NOW, 300) }),
      new Set<string>(),
    );
    expect(plan.bookkeepingRepairs).toEqual([]);
    expect(plan.findings.some((f) => f.cause === "landed_push_unsettled")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. THE INCIDENT (2026-08-03), reproduced.
//
// Inngest wedged; every cron dead. Five tickets in flight, zero runs executing,
// tickets queued behind them for seven hours, the board reporting "at WIP
// limit" throughout. Found by a human looking at it.
// ───────────────────────────────────────────────────────────────────────────

describe("planSupervision - the 2026-08-03 incident", () => {
  it("detects AND remediates a board deadlock when the crons are dead", () => {
    const plan = planSupervision(snapshot(), new Set<string>());

    expect(plan.mode).toBe("remediate");

    const deadlock = plan.findings.find((f) => f.cause === "board_deadlock");
    expect(deadlock).toBeDefined();
    // The finding has to state the impossibility, not the symptom: "at WIP
    // limit" alone is what sent an operator into the database by hand.
    expect(deadlock!.detail).toMatch(/nothing is running/i);

    const release = plan.remediations.find((r) => r.action === "release_dispatch_queue");
    expect(release).toBeDefined();
    expect(release).toMatchObject({ cause: "board_deadlock", tenantId: "tenant-a" });
    // Never more than the genuinely free capacity - the WIP limit still bites.
    expect(release && "slots" in release ? release.slots : null).toBe(3);
  });

  it("detects AND remediates a stalled ticket when the crons are dead", () => {
    const plan = planSupervision(snapshot(), new Set<string>());
    const recover = plan.remediations.find(
      (r): r is Extract<typeof r, { action: "recover_ticket" }> => r.action === "recover_ticket",
    );
    expect(recover).toBeDefined();
    expect(recover!.ticketId).toBe("ticket-1");
    expect(recover!.to).toBe("input_required");
  });

  it("reports the wedged engine itself as a finding, so it is on the record", () => {
    const plan = planSupervision(snapshot(), new Set<string>());
    expect(plan.findings.some((f) => f.cause === "engine_recovery_wedged")).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. The WIP limit is not weakened.
// ───────────────────────────────────────────────────────────────────────────

describe("planSupervision - capacity", () => {
  // MUTATION: remove the capacity branch from decideDispatchRescue's reuse and
  // this goes red. A busy agent is never "rescued", however old its queue.
  it("never releases for an agent whose live runs fill the cap", () => {
    const plan = planSupervision(
      snapshot({ dispatchGroups: [deadlockedGroup({ runningRuns: 3 })] }),
      new Set<string>(),
    );
    expect(plan.remediations.some((r) => r.action === "release_dispatch_queue")).toBe(false);
    // And it is not a deadlock at all - work is happening.
    expect(plan.findings.some((f) => f.cause === "board_deadlock")).toBe(false);
  });

  it("does not treat a queue held by runs awaiting a human as a deadlock", () => {
    const plan = planSupervision(
      snapshot({ dispatchGroups: [deadlockedGroup({ waitingRuns: 2 })] }),
      new Set<string>(),
    );
    expect(plan.findings.some((f) => f.cause === "board_deadlock")).toBe(false);
    expect(plan.remediations.some((r) => r.action === "release_dispatch_queue")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Per-project opt-in.
// ───────────────────────────────────────────────────────────────────────────

describe("planSupervision - opt-in", () => {
  it("detects but never releases a queue group spanning unsupervised projects", () => {
    const plan = planSupervision(
      snapshot({ dispatchGroups: [deadlockedGroup({ allRowsSupervised: false })] }),
      new Set<string>(),
    );
    // Still visible - the operator should know the board is deadlocked even
    // where we are not permitted to touch it.
    expect(plan.findings.some((f) => f.cause === "board_deadlock")).toBe(true);
    expect(plan.remediations.some((r) => r.action === "release_dispatch_queue")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. The runner's own evidence can only SUBTRACT.
//
// Run rows lied in BOTH directions on this board: runs marked `failed` whose
// agent processes were still working 56 minutes later, and runs marked
// `running` that were never claimed at all. The runner knows which jobs IT
// claimed. That knowledge is admitted only as a veto.
// ───────────────────────────────────────────────────────────────────────────

describe("isVetoedByLiveRunner", () => {
  it("vetoes when a runner is provably still executing one of the ticket's runs", () => {
    expect(isVetoedByLiveRunner(["run-a", "run-b"], new Set(["run-b"]))).toBe(true);
  });

  it("does not veto when the runner reports nothing about this ticket", () => {
    expect(isVetoedByLiveRunner(["run-a"], new Set(["run-z"]))).toBe(false);
  });
});

describe("planSupervision - runner veto", () => {
  // The 56-minute case: the DB says the run failed, the process is alive.
  // MUTATION: drop the veto and this goes red - the supervisor recovers a
  // ticket out from under a working agent.
  it("does not recover a ticket whose run a runner is still executing", () => {
    const plan = planSupervision(snapshot(), new Set(["run-dead-1"]));
    expect(plan.remediations.some((r) => r.action === "recover_ticket")).toBe(false);
    const vetoed = plan.findings.find((f) => f.cause === "stalled_ticket");
    expect(vetoed?.detail).toMatch(/runner/i);
  });

  // The asymmetry, stated as a test: a runner's report is never an argument FOR
  // acting. An empty report must not turn a stand-down into a remediation.
  it("an empty runner report never creates a remediation the policy refused", () => {
    const live = stalledTicket({
      evidence: { ...stalledTicket().evidence, hasLiveRun: true },
    });
    const plan = planSupervision(snapshot({ stalledTickets: [live] }), new Set<string>());
    expect(plan.remediations.some((r) => r.action === "recover_ticket")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 7. THE INDICTMENT.
//
// An operator hand-swept stalled tickets ~six times in one day. Every sweep
// worked. Every sweep also hid a WIP-slot leak, which stayed invisible for
// hours precisely because its symptoms kept being cleared. A fix that keeps
// firing for the same reason is a bug report, not routine maintenance.
// ───────────────────────────────────────────────────────────────────────────

describe("detectRepeatDefect", () => {
  const entries = (cause: string, n: number, spreadMinutes = 100) =>
    Array.from({ length: n }, (_, i) => ({
      cause: cause as never,
      createdAtIso: iso(Math.round((spreadMinutes * i) / Math.max(1, n - 1))),
    }));

  it("does not indict below the threshold", () => {
    const found = detectRepeatDefect(entries("stalled_ticket", 3), NOW, 7200, 5);
    expect(found).toEqual([]);
  });

  it("indicts a cause that has been remediated repeatedly in the window", () => {
    const found = detectRepeatDefect(entries("stalled_ticket", 14), NOW, 7200, 5);
    expect(found).toHaveLength(1);
    expect(found[0]!.cause).toBe("stalled_ticket");
    expect(found[0]!.count).toBe(14);
  });

  // MUTATION: count all entries together instead of grouping by cause and this
  // goes red. Two unrelated one-offs are not a defect; reporting them as one
  // is the false alarm that teaches an operator to ignore the real one.
  it("does NOT aggregate distinct causes into a false alarm", () => {
    const mixed = [...entries("stalled_ticket", 3), ...entries("board_deadlock", 3)];
    expect(detectRepeatDefect(mixed, NOW, 7200, 5)).toEqual([]);
  });

  it("indicts each qualifying cause separately", () => {
    const mixed = [...entries("stalled_ticket", 6), ...entries("board_deadlock", 7)];
    const found = detectRepeatDefect(mixed, NOW, 7200, 5);
    expect(found.map((f) => f.cause).sort()).toEqual(["board_deadlock", "stalled_ticket"]);
  });

  it("ignores entries older than the window", () => {
    const old = Array.from({ length: 20 }, () => ({
      cause: "stalled_ticket" as never,
      createdAtIso: iso(60 * 24),
    }));
    expect(detectRepeatDefect(old, NOW, 7200, 5)).toEqual([]);
  });

  it("ignores entries with an unparseable timestamp rather than counting them", () => {
    const bad = Array.from({ length: 20 }, () => ({
      cause: "stalled_ticket" as never,
      createdAtIso: "nonsense",
    }));
    expect(detectRepeatDefect(bad, NOW, 7200, 5)).toEqual([]);
  });

  // ── OPERATOR COMMANDS ARE NOT A DEFECT ──────────────────────────────────
  // The supervisor console can now be COMMANDED (dispatch, move, file, run a
  // team), and every such command writes a ledger row so an operator driving a
  // board by hand stays counted - the whole reason this ledger exists. But an
  // ordinary dispatch is not evidence of anything being broken, so counting it
  // toward a suspected defect would accuse a healthy board of a defect for the
  // crime of being used - the exact false alarm the grouping rule above exists
  // to prevent, arriving by a different door.
  //
  // A commanded REMEDIATION is unaffected and still records `board_deadlock` /
  // `stalled_ticket`, which is why the control below matters as much as the
  // assertion.
  it("never indicts `operator_command`, however many there are", () => {
    expect(detectRepeatDefect(entries("operator_command", 50), NOW, 7200, 5)).toEqual([]);
  });

  it("CONTROL: a commanded REMEDIATION still counts, under the defect cause", () => {
    const found = detectRepeatDefect(
      [...entries("operator_command", 50), ...entries("stalled_ticket", 6)],
      NOW,
      7200,
      5,
    );
    expect(found.map((f) => f.cause)).toEqual(["stalled_ticket"]);
    expect(found[0]!.count).toBe(6);
  });

  it("the exemption is a DENYLIST, so a new defect cause is indicted by default", () => {
    // The two errors are not symmetric: a cause wrongly exempted is a silent
    // defect, a cause wrongly counted is a visible false alarm. So membership
    // has to be argued FOR, never inherited.
    expect([...NON_INDICTABLE_CAUSES]).toEqual(["operator_command"]);
    for (const cause of SUPERVISOR_CAUSES) {
      if (cause === "operator_command") continue;
      expect(detectRepeatDefect(entries(cause, 6), NOW, 7200, 5), cause).toHaveLength(1);
    }
  });
});

// ── STATE vs EVENT ────────────────────────────────────────────────────────
//
// `detectRepeatDefect` is a live STATUS and must keep saying yes while it is
// true. `selectUnescalatedIndictments` is an EVENT and must not repeat itself -
// without that split the supervisor posts the same accusation to the same ticket
// once a minute forever, which is the alarm-into-wallpaper failure this whole
// feature exists to prevent.

describe("selectUnescalatedIndictments", () => {
  const entry = (minutesAgo: number, escalated: boolean) => ({
    cause: "stalled_ticket" as never,
    createdAtIso: iso(minutesAgo),
    escalatedAtIso: escalated ? iso(minutesAgo) : null,
  });

  it("fires once the un-escalated rows reach the threshold", () => {
    const rows = Array.from({ length: 5 }, (_, i) => entry(i * 5, false));
    expect(selectUnescalatedIndictments(rows, NOW, 7200, 5)).toHaveLength(1);
  });

  // MUTATION: drop the `escalatedAtIso` filter and this goes red - the same
  // accusation would be re-posted on every pass, forever.
  it("stays SILENT when every qualifying row has already been escalated", () => {
    const rows = Array.from({ length: 14 }, (_, i) => entry(i * 5, true));
    expect(selectUnescalatedIndictments(rows, NOW, 7200, 5)).toEqual([]);
    // …while the STATE function still reports the condition, because it is
    // still true and a status that went quiet would claim a recovery.
    expect(detectRepeatDefect(rows, NOW, 7200, 5)).toHaveLength(1);
  });

  it("does not fire again until enough NEW rows accumulate", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => entry(60 + i, true)),
      ...Array.from({ length: 4 }, (_, i) => entry(i, false)),
    ];
    expect(selectUnescalatedIndictments(rows, NOW, 7200, 5)).toEqual([]);
    expect(selectUnescalatedIndictments([...rows, entry(0, false)], NOW, 7200, 5)).toHaveLength(1);
  });

  // The count an operator needs is how many times this has happened, not how
  // many times since we last mentioned it.
  it("reports the FULL window count, not just the un-escalated ones", () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => entry(60 + i, true)),
      ...Array.from({ length: 5 }, (_, i) => entry(i, false)),
    ];
    const [ind] = selectUnescalatedIndictments(rows, NOW, 7200, 5);
    expect(ind!.count).toBe(14);
  });

  it("still refuses to aggregate distinct causes", () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => entry(i, false)),
      ...Array.from({ length: 3 }, (_, i) => ({
        cause: "board_deadlock" as never,
        createdAtIso: iso(i),
        escalatedAtIso: null,
      })),
    ];
    expect(selectUnescalatedIndictments(rows, NOW, 7200, 5)).toEqual([]);
  });
});

describe("renderIndictment", () => {
  it("names the cause and the count, and calls it a suspected defect", () => {
    const found = detectRepeatDefect(
      Array.from({ length: 14 }, (_, i) => ({
        cause: "stalled_ticket" as never,
        createdAtIso: iso(i * 8),
      })),
      NOW,
      INDICTMENT_WINDOW_SECONDS_DEFAULT,
      INDICTMENT_THRESHOLD_DEFAULT,
    );
    expect(found).toHaveLength(1);
    const text = renderIndictment(found[0]!);
    expect(text).toMatch(/14/);
    expect(text).toMatch(/stalled_ticket/);
    expect(text).toMatch(/defect/i);
    // The distinction the whole feature turns on must be in the words.
    expect(text).toMatch(/not routine maintenance|repeatedly|underlying/i);
  });
});
