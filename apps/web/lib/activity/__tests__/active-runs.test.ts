// Rules for the ambient agent-activity indicator.
//
// The headline risk this suite defends is the MISLEADING COUNT: a badge saying
// "3 working" that silently includes a run parked on a human decision, or a
// two-second platform one-shot, tells the operator the machine is busy when it
// is stalled or idle. Every exclusion therefore gets its own test, and the
// "never summed" property is asserted directly rather than inferred.

import { describe, it, expect } from "vitest";
import {
  isWorkingRun,
  isWaitingOnHuman,
  isTrackedRun,
  summarizeActivity,
  formatRole,
  formatElapsed,
  runHref,
  WORKING_RUN_STATUSES,
  WAITING_RUN_STATUSES,
  type ActivityRun,
} from "../active-runs";

const TENANT = "11111111-1111-1111-1111-111111111111";

function run(over: Partial<ActivityRun> = {}): ActivityRun {
  return {
    id: "run-1",
    tenantId: TENANT,
    status: "running",
    runnerKind: "local-cc",
    agentId: "agent-1",
    ticketId: "ticket-1",
    parentRunId: null,
    fanOutRole: null,
    role: "engineer",
    ticketTitle: "Add the thing",
    ticketNumber: 7,
    projectId: "proj-1",
    projectName: "DevPilot",
    startedAt: "2026-07-19T10:00:00.000Z",
    lastEventAt: "2026-07-19T10:01:00.000Z",
    ...over,
  };
}

describe("what counts as working", () => {
  it("a dispatched run mid-execution is working", () => {
    expect(isWorkingRun(run({ status: "running" }))).toBe(true);
  });

  it("produces the active state for a tenant with a run in flight", () => {
    const s = summarizeActivity([run()]);
    expect(s.idle).toBe(false);
    expect(s.workingCount).toBe(1);
  });

  it("produces the quiet state for an idle tenant", () => {
    const s = summarizeActivity([]);
    expect(s.idle).toBe(true);
    expect(s.workingCount).toBe(0);
    expect(s.waitingCount).toBe(0);
  });

  it("treats a tenant whose every run is terminal as idle", () => {
    const s = summarizeActivity([
      run({ id: "a", status: "done" }),
      run({ id: "b", status: "failed" }),
      run({ id: "c", status: "cancelled" }),
    ]);
    expect(s.idle).toBe(true);
    expect(s.workingCount).toBe(0);
  });

  it("only 'running' is in the working vocabulary", () => {
    expect([...WORKING_RUN_STATUSES]).toEqual(["running"]);
    expect([...WAITING_RUN_STATUSES]).toEqual(["awaiting_human"]);
  });
});

describe("exclusions — the misleading-count failure", () => {
  it("a run awaiting a human is NOT working", () => {
    const parked = run({ status: "awaiting_human" });
    expect(isWorkingRun(parked)).toBe(false);
    expect(isWaitingOnHuman(parked)).toBe(true);
  });

  it("awaiting_human is never summed into the working count", () => {
    const s = summarizeActivity([
      run({ id: "live", status: "running" }),
      run({ id: "parked-a", status: "awaiting_human" }),
      run({ id: "parked-b", status: "awaiting_human" }),
    ]);
    // The badge number is 1, not 3. This is the whole point.
    expect(s.workingCount).toBe(1);
    expect(s.waitingCount).toBe(2);
    expect(s.working.map((r) => r.id)).toEqual(["live"]);
    expect(s.waiting.map((r) => r.id).sort()).toEqual(["parked-a", "parked-b"]);
  });

  it("a tenant with ONLY parked runs reports zero working", () => {
    const s = summarizeActivity([
      run({ id: "p1", status: "awaiting_human" }),
      run({ id: "p2", status: "awaiting_human" }),
    ]);
    expect(s.workingCount).toBe(0);
    // Not idle — there IS something to say, it is just not "working".
    expect(s.idle).toBe(false);
  });

  it("a synthetic platform one-shot is NOT working", () => {
    // The `invokeLocalCcOneShot` signature: local-cc, no agent, no ticket,
    // no fan-out role, no parent. Dep suggestion, lesson extraction, etc.
    const oneShot = run({
      status: "running",
      runnerKind: "local-cc",
      agentId: null,
      ticketId: null,
      fanOutRole: null,
      parentRunId: null,
      role: null,
    });
    expect(isWorkingRun(oneShot)).toBe(false);
    expect(isTrackedRun(oneShot)).toBe(false);
    expect(summarizeActivity([oneShot]).idle).toBe(true);
  });

  it("a supervisor child is real work despite having no ticket or agent", () => {
    // `parent_run_id` is the ONLY thing distinguishing it from a one-shot —
    // the same clause that is load-bearing in isSyntheticPlatformRun.
    const child = run({
      status: "running",
      runnerKind: "local-cc",
      agentId: null,
      ticketId: null,
      fanOutRole: null,
      parentRunId: "parent-run",
    });
    expect(isWorkingRun(child)).toBe(true);
  });

  it("a fan-out sibling is real work despite carrying no agent_id", () => {
    const sibling = run({
      status: "running",
      agentId: null,
      fanOutRole: "qa",
      parentRunId: null,
    });
    expect(isWorkingRun(sibling)).toBe(true);
  });

  it("an api-runner run with no ticket is real work", () => {
    // The synthetic predicate requires runner_kind='local-cc'; an API-path run
    // must never be swept up by it.
    const apiRun = run({
      status: "running",
      runnerKind: "api",
      agentId: null,
      ticketId: null,
      fanOutRole: null,
      parentRunId: null,
    });
    expect(isWorkingRun(apiRun)).toBe(true);
  });

  it("a queued-but-unclaimed ticket contributes nothing, because it has no run", () => {
    // Documenting the deliberate omission: this surface reads `runs` only.
    // Until a runner claims a dispatch there is no row here at all, so an
    // empty input is the correct — and only — representation of a queue.
    expect(summarizeActivity([]).workingCount).toBe(0);
  });
});

describe("summary shape", () => {
  it("sorts oldest-first so the longest-running work reads first", () => {
    const s = summarizeActivity([
      run({ id: "new", startedAt: "2026-07-19T10:30:00.000Z" }),
      run({ id: "old", startedAt: "2026-07-19T09:00:00.000Z" }),
      run({ id: "mid", startedAt: "2026-07-19T10:00:00.000Z" }),
    ]);
    expect(s.working.map((r) => r.id)).toEqual(["old", "mid", "new"]);
  });

  it("counts distinct projects across both buckets", () => {
    const s = summarizeActivity([
      run({ id: "a", projectId: "p1" }),
      run({ id: "b", projectId: "p1" }),
      run({ id: "c", projectId: "p2" }),
      run({ id: "d", projectId: "p3", status: "awaiting_human" }),
    ]);
    expect(s.projectCount).toBe(3);
  });

  it("tolerates a project-less run without inventing a project", () => {
    const s = summarizeActivity([run({ id: "a", projectId: null })]);
    expect(s.projectCount).toBe(0);
    expect(s.workingCount).toBe(1);
  });
});

describe("presentation helpers", () => {
  it("humanises a role slug and falls back rather than rendering blank", () => {
    expect(formatRole("frontend_engineer")).toBe("Frontend engineer");
    expect(formatRole(null)).toBe("Agent");
    expect(formatRole("   ")).toBe("Agent");
  });

  it("formats elapsed time at ambient granularity", () => {
    const t0 = new Date("2026-07-19T10:00:00.000Z").getTime();
    expect(formatElapsed("2026-07-19T10:00:00.000Z", t0 + 5_000)).toBe("just now");
    expect(formatElapsed("2026-07-19T10:00:00.000Z", t0 + 4 * 60_000)).toBe("4m");
    expect(formatElapsed("2026-07-19T10:00:00.000Z", t0 + 60 * 60_000)).toBe("1h");
    expect(formatElapsed("2026-07-19T10:00:00.000Z", t0 + 72 * 60_000)).toBe("1h 12m");
  });

  it("returns an empty label for an unparseable timestamp rather than NaN", () => {
    expect(formatElapsed("not-a-date", Date.now())).toBe("");
  });

  it("deep-links into the existing run view", () => {
    expect(runHref(run({ id: "abc" }))).toBe("/runs/abc");
  });
});
