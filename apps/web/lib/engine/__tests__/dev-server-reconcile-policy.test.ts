// Regression coverage for the stranded dev-server bug: a `dev_server_sessions`
// row sits `status='starting'`, `runner_id=null`, `pid=null`, `port=null`
// forever because the runner that should spawn it died in the handoff window
// and the queue message was lost — no live runner ever claims it, and the UI
// spins on "Starting…" indefinitely.
//
// `decideDevServerReconcile` is the pure policy that closes that gap; these
// tests pin the exact prod shape reconciles, that a healthy starting→running
// transition is NOT disturbed, and that a session owned by a dead runner is
// failed-forward fast.

import { describe, expect, it } from "vitest";
import {
  decideDevServerReconcile,
  type DevServerReconcileRow,
} from "@/lib/engine/dev-server-reconcile-policy";

const NOW = Date.parse("2026-07-08T07:07:00.000Z");
const TIMEOUT_MS = 90_000; // matches DEVPILOT_DEV_SERVER_HEARTBEAT_TIMEOUT_SECONDS=90

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function row(overrides: Partial<DevServerReconcileRow>): DevServerReconcileRow {
  return {
    id: "sess-1",
    status: "starting",
    runner_id: null,
    last_heartbeat_at: iso(0),
    updated_at: iso(0),
    started_at: iso(0),
    ...overrides,
  };
}

function decide(r: DevServerReconcileRow, liveRunnerIds: string[] = [], nowMs = NOW) {
  return decideDevServerReconcile({
    row: r,
    liveRunnerIds: new Set(liveRunnerIds),
    nowMs,
    heartbeatTimeoutMs: TIMEOUT_MS,
  });
}

describe("decideDevServerReconcile — the stranded 'starting' session", () => {
  it("the exact prod shape (starting, runner_id=null, aged) is failed-forward", () => {
    // Session 4d4f0746…: 'starting' since 06:42Z, runner_id null, never
    // claimed. Its NOT-NULL last_heartbeat_at is frozen at insert (~25 min
    // ago), which is well past the timeout.
    const stranded = row({
      status: "starting",
      runner_id: null,
      last_heartbeat_at: iso(25 * 60_000),
      updated_at: iso(25 * 60_000),
      started_at: iso(25 * 60_000),
    });
    expect(decide(stranded)).toEqual({
      action: "fail",
      toStatus: "errored",
      reason: "orphaned-never-claimed",
    });
  });

  it("a session stuck in 'starting' just past the timeout resolves terminal", () => {
    // A stranded row freezes ALL of its timestamps at insert; age them
    // together so the freshest-signal coalesce still lands past the timeout.
    const justPast = row({
      last_heartbeat_at: iso(TIMEOUT_MS + 1_000),
      updated_at: iso(TIMEOUT_MS + 1_000),
      started_at: iso(TIMEOUT_MS + 1_000),
    });
    const d = decide(justPast);
    expect(d.action).toBe("fail");
  });

  it("does NOT disturb a healthy starting session a live runner is actively spawning", () => {
    // The runner posts an optimistic 'starting' heartbeat the instant it claims
    // the message and keeps heartbeating every ~3s through a long install, so
    // last_heartbeat_at stays fresh even before the port is up.
    const healthy = row({
      status: "starting",
      runner_id: "runner-a",
      last_heartbeat_at: iso(2_000),
    });
    expect(decide(healthy, ["runner-a"])).toEqual({
      action: "none",
      reason: "fresh",
    });
  });

  it("does NOT reap a just-created starting session inside the grace window (runner_id still null)", () => {
    // Between INSERT and the runner's first heartbeat there's a brief window
    // where runner_id is null and no real heartbeat has landed. The frozen
    // insert-time liveness is still within the timeout — leave it alone.
    const justCreated = row({
      runner_id: null,
      last_heartbeat_at: iso(3_000),
      updated_at: iso(3_000),
      started_at: iso(3_000),
    });
    expect(decide(justCreated)).toEqual({ action: "none", reason: "fresh" });
  });
});

describe("decideDevServerReconcile — runner liveness", () => {
  it("does NOT fail-forward a fresh-heartbeat session whose runner is absent from liveRunnerIds", () => {
    // The dev-server heartbeat (3s) is authoritative. A live runner's SEPARATE
    // registration heartbeat (15s/60s window) can blip out of liveRunnerIds
    // while it keeps heartbeating this actively-spawning session — reaping it
    // on the missing-runner signal alone would be a false positive.
    const owned = row({
      status: "running",
      runner_id: "runner-blipped",
      last_heartbeat_at: iso(2_000), // fresh — runner is clearly alive
    });
    expect(decide(owned, ["runner-live"])).toEqual({
      action: "none",
      reason: "fresh",
    });
  });

  it("fails-forward a STALE session owned by a dead runner with reason runner-disconnected", () => {
    // Runner claimed the session (runner_id set) then the process died: its
    // registration heartbeat is gone from liveRunnerIds AND its dev-server
    // heartbeat has aged past the timeout. Now it's genuinely stranded.
    const owned = row({
      status: "running",
      runner_id: "runner-dead",
      last_heartbeat_at: iso(TIMEOUT_MS + 5_000),
      updated_at: iso(TIMEOUT_MS + 5_000),
      started_at: iso(TIMEOUT_MS + 5_000),
    });
    expect(decide(owned, ["runner-live"])).toEqual({
      action: "fail",
      toStatus: "errored",
      reason: "runner-disconnected",
    });
  });

  it("leaves a running session owned by a live runner alone", () => {
    const owned = row({
      status: "running",
      runner_id: "runner-live",
      last_heartbeat_at: iso(2_000),
    });
    expect(decide(owned, ["runner-live"])).toEqual({
      action: "none",
      reason: "fresh",
    });
  });

  it("reaps a stale session owned by a live runner that stopped heartbeating (deep stall)", () => {
    const stalled = row({
      status: "running",
      runner_id: "runner-live",
      last_heartbeat_at: iso(TIMEOUT_MS + 30_000),
      updated_at: iso(TIMEOUT_MS + 30_000),
      started_at: iso(TIMEOUT_MS + 30_000),
    });
    expect(decide(stalled, ["runner-live"])).toEqual({
      action: "fail",
      toStatus: "errored",
      reason: "no-heartbeat",
    });
  });
});

describe("decideDevServerReconcile — recovery between scan and act", () => {
  // The reaper/watchdog judge staleness from a snapshot, then fail-forward in a
  // separate later step. `failForwardDevServerSession` re-checks the SAME
  // staleness bound atomically at write time (a `.lt(last_heartbeat_at, cutoff)`
  // CAS) so a session that got a fresh heartbeat in that gap is not wrongly
  // terminalized. These pin the shared bound the CAS keys on.
  it("a session whose heartbeat is fresh AT DECISION TIME is never failed-forward", () => {
    // Frozen orphan shape (runner_id null, ancient started/updated) but a
    // heartbeat that just landed — the recovered case. The freshest signal wins.
    const recovered = row({
      runner_id: null,
      started_at: iso(25 * 60_000),
      updated_at: iso(25 * 60_000),
      last_heartbeat_at: iso(1_000),
    });
    expect(decide(recovered)).toEqual({ action: "none", reason: "fresh" });
  });

  it("a heartbeat exactly at the timeout boundary still protects the row", () => {
    // nowMs - liveness === heartbeatTimeoutMs is NOT strictly greater, so it is
    // fresh — matching the `.lt` CAS boundary (a row exactly at the cutoff is
    // not `< cutoff` and so is left alone by both the policy and the write).
    const atBoundary = row({
      runner_id: "runner-x",
      last_heartbeat_at: iso(TIMEOUT_MS),
      updated_at: iso(TIMEOUT_MS),
      started_at: iso(TIMEOUT_MS),
    });
    expect(decide(atBoundary).action).toBe("none");
  });
});

describe("decideDevServerReconcile — status gating", () => {
  it.each(["stopped", "errored", "needs_env"])("never touches a %s session", (status) => {
    const r = row({ status, last_heartbeat_at: iso(60 * 60_000) });
    expect(decide(r).action).toBe("none");
  });

  it("reconciles a stalled 'building' session (runner died mid-build)", () => {
    // The reaper historically only scanned starting/running; a session that
    // reached 'building' then lost its runner would slip through. The policy
    // treats building as reconcilable.
    const building = row({
      status: "building",
      runner_id: null,
      last_heartbeat_at: iso(5 * 60_000),
      updated_at: iso(5 * 60_000),
      started_at: iso(5 * 60_000),
    });
    expect(decide(building).action).toBe("fail");
  });
});

describe("decideDevServerReconcile — degenerate timestamps", () => {
  it("fails-forward when no timestamp is parseable rather than leaving it immortal", () => {
    // runner_id is null here (never claimed), so the diagnostic reason reflects
    // the orphaned-handoff shape.
    const r = row({
      last_heartbeat_at: null,
      updated_at: null,
      started_at: null,
    });
    expect(decide(r)).toEqual({
      action: "fail",
      toStatus: "errored",
      reason: "orphaned-never-claimed",
    });
  });

  it("fails-forward with no-heartbeat when a live runner owns a session with no parseable timestamp", () => {
    const r = row({
      runner_id: "runner-live",
      last_heartbeat_at: null,
      updated_at: null,
      started_at: null,
    });
    expect(decide(r, ["runner-live"])).toEqual({
      action: "fail",
      toStatus: "errored",
      reason: "no-heartbeat",
    });
  });

  it("uses the freshest of the coalesced timestamps (a late heartbeat protects the row)", () => {
    // started_at/updated_at are ancient but a heartbeat landed recently — the
    // session is alive and must be left alone.
    const r = row({
      runner_id: null,
      started_at: iso(60 * 60_000),
      updated_at: iso(60 * 60_000),
      last_heartbeat_at: iso(4_000),
    });
    expect(decide(r)).toEqual({ action: "none", reason: "fresh" });
  });
});
