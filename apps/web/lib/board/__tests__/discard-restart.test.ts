// "Discard & restart from dev" - the ordered body, and specifically the thing
// that broke live on 2026-08-01: an unresponsive Inngest made step 2's emit HANG
// rather than throw, so the `catch` never ran and steps 3 and 4 never executed.
// The operator held a "Discarding…" spinner indefinitely with the ticket
// untouched and no way to tell whether it had partially applied.
//
// The load-bearing assertion is the first one: with the emit hanging, the action
// must still RETURN, the ticket must still reach `backlog`, and the result must
// report that the wipe was not queued. Delete `withSendTimeout` from
// `runDiscardAndRestart` and that test does not merely fail - it never finishes,
// which is the defect reproduced.

import { describe, expect, it } from "vitest";
import { runDiscardAndRestart, type DiscardAndRestartEffects } from "@/lib/board/discard-restart";

/** The shape `inngest.send` takes on when the event endpoint accepts the
 *  connection and then answers nothing: a promise that never settles. */
function hangs(): Promise<never> {
  return new Promise<never>(() => {});
}

type Recorder = {
  calls: string[];
  effects: DiscardAndRestartEffects;
};

function makeEffects(
  build: (calls: string[]) => Partial<DiscardAndRestartEffects> = () => ({}),
): Recorder {
  const calls: string[] = [];
  const overrides = build(calls);
  const effects: DiscardAndRestartEffects = {
    discardPendingPushes: async () => {
      calls.push("discardPendingPushes");
      return { ok: true as const, count: 2 };
    },
    requestWorkspaceReset: async () => {
      calls.push("requestWorkspaceReset");
      return { emitted: true };
    },
    resetToBacklog: async () => {
      calls.push("resetToBacklog");
    },
    clearLandingStamp: async () => {
      calls.push("clearLandingStamp");
    },
    warn: () => {},
    // Short so the suite is fast. Production uses EVENT_SEND_TIMEOUT_MS.
    workspaceResetTimeoutMs: 25,
    ...overrides,
  };
  return { calls, effects };
}

const CTX = { ticketId: "11111111-1111-1111-1111-111111111111" };

describe("runDiscardAndRestart", () => {
  it("still resets the ticket when the cleanup emit HANGS (the reported defect)", async () => {
    const { calls, effects } = makeEffects((calls) => ({
      requestWorkspaceReset: () => {
        calls.push("requestWorkspaceReset");
        return hangs();
      },
    }));

    const started = Date.now();
    const result = await runDiscardAndRestart(effects, CTX);
    const elapsed = Date.now() - started;

    // 1. It returned at all - the whole complaint was that it never did.
    expect(result.ok).toBe(true);
    // 2. The ticket reached backlog: steps 3 and 4 were NOT skipped.
    expect(calls).toContain("resetToBacklog");
    expect(calls).toContain("clearLandingStamp");
    // 3. It reports that the wipe was not queued, rather than claiming success.
    expect(result.ok && result.workspaceReset).toBe("failed");
    // 4. And the pending-push discard still happened (step 1 precedes the emit).
    expect(result.ok && result.discardedPushes).toBe(2);
    // Bounded, not merely eventual.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("logs the expiry rather than swallowing it silently", async () => {
    const warnings: string[] = [];
    const { effects } = makeEffects(() => ({
      requestWorkspaceReset: () => hangs(),
      warn: (m: string) => warnings.push(m),
    }));
    await runDiscardAndRestart(effects, CTX);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(CTX.ticketId);
    expect(warnings[0]).toContain("workspace reset emit failed");
  });

  it("treats a THROWN emit error exactly as before - reset proceeds, outcome 'failed'", async () => {
    const { calls, effects } = makeEffects(() => ({
      requestWorkspaceReset: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8288");
      },
    }));
    const result = await runDiscardAndRestart(effects, CTX);
    expect(result.ok).toBe(true);
    expect(result.ok && result.workspaceReset).toBe("failed");
    expect(calls).toContain("resetToBacklog");
    expect(calls).toContain("clearLandingStamp");
  });

  it("happy path: reports 'queued' and does not wait out the timeout", async () => {
    const { calls, effects } = makeEffects(() => ({
      // A ceiling far longer than the test may take: proves the bound is raced,
      // not awaited.
      workspaceResetTimeoutMs: 30_000,
    }));
    const started = Date.now();
    const result = await runDiscardAndRestart(effects, CTX);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toEqual({
      ok: true,
      discarded: true,
      workspaceReset: "queued",
      discardedPushes: 2,
    });
    // Order matters: the wipe is requested BEFORE the ticket is reset, so the
    // runner is already draining while the ticket rests in backlog.
    expect(calls).toEqual([
      "discardPendingPushes",
      "requestWorkspaceReset",
      "resetToBacklog",
      "clearLandingStamp",
    ]);
  });

  it("distinguishes 'nothing to wipe' from 'wipe not queued'", async () => {
    // A ticket that never produced a workspace. The old boolean reported this
    // identically to a failed emit, which is why the UI could not tell the
    // operator which had happened.
    const { effects } = makeEffects(() => ({
      requestWorkspaceReset: async () => ({ emitted: false }),
    }));
    const result = await runDiscardAndRestart(effects, CTX);
    expect(result.ok && result.workspaceReset).toBe("not_needed");
  });

  it("a failed pending-push discard is FATAL - it must not wipe a workspace whose rows still point at it", async () => {
    const { calls, effects } = makeEffects(() => ({
      discardPendingPushes: async () => ({ ok: false as const, error: "permission denied" }),
    }));
    const result = await runDiscardAndRestart(effects, CTX);
    expect(result).toEqual({
      ok: false,
      error: "Failed to discard pending changes: permission denied",
    });
    expect(calls).not.toContain("requestWorkspaceReset");
    expect(calls).not.toContain("resetToBacklog");
  });

  it("a failed backlog reset is reported, and the landing stamp is left alone", async () => {
    const { calls, effects } = makeEffects(() => ({
      resetToBacklog: async () => {
        throw new Error("invalid ticket transition: done → backlog");
      },
    }));
    const result = await runDiscardAndRestart(effects, CTX);
    expect(result).toEqual({ ok: false, error: "invalid ticket transition: done → backlog" });
    expect(calls).not.toContain("clearLandingStamp");
  });

  it("a failed landing-stamp clear does not fail the action", async () => {
    const warnings: string[] = [];
    const { effects } = makeEffects(() => ({
      clearLandingStamp: async () => {
        throw new Error("update failed");
      },
      warn: (m: string) => warnings.push(m),
    }));
    const result = await runDiscardAndRestart(effects, CTX);
    expect(result.ok).toBe(true);
    expect(warnings.some((w) => w.includes("clearing landed_sha failed"))).toBe(true);
  });
});
