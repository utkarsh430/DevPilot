// The pure half of the orphaned-ticket reaper.
//
// The decisions worth pinning here are the STAND-DOWNS, not the recovery: the
// one way this feature could do real damage is by reaping a ticket whose work
// is still in flight, so every guard gets a test, and the near-race (a run or a
// dispatch that exists but has barely started) gets two.

import { describe, it, expect } from "vitest";
import {
  decideOrphanRecovery,
  orphanIdleSinceIso,
  renderOrphanRecoveryComment,
  ORPHAN_GRACE_SECONDS_DEFAULT,
  ORPHANABLE_TICKET_STATUSES,
  LIVE_RUN_STATUSES,
  type OrphanEvidence,
} from "@/lib/engine/orphan-ticket-policy";

const NOW = "2026-07-19T12:00:00.000Z";
const LONG_AGO = "2026-07-19T10:00:00.000Z"; // 2h - well past the 30m grace
const JUST_NOW = "2026-07-19T11:59:00.000Z"; // 1m

/** A genuinely orphaned in_progress ticket: nothing live, nothing queued, the
 *  last run failed two hours ago. Each test perturbs ONE field. */
function orphan(over: Partial<OrphanEvidence> = {}): OrphanEvidence {
  return {
    status: "in_progress",
    ticketUpdatedAtIso: LONG_AGO,
    hasLiveRun: false,
    hasPendingDispatch: false,
    latestRunStatus: "failed",
    latestRunFanOutGroup: null,
    latestRunActivityIso: LONG_AGO,
    automationPaused: false,
    lastRecoveryCommentIso: null,
    nowIso: NOW,
    graceSeconds: ORPHAN_GRACE_SECONDS_DEFAULT,
    ...over,
  };
}

describe("decideOrphanRecovery - the baseline it exists for", () => {
  it("recovers the incident: in_progress, no live run, nothing queued", () => {
    const d = decideOrphanRecovery(orphan());
    expect(d.action).toBe("recover");
    // input_required is the ONLY status whose human reply re-dispatches
    // (postCommentAction), which is the whole point of the recovery.
    expect(d).toMatchObject({ to: "input_required" });
  });

  it("recovers a ticket that has no runs at all (the dispatch never landed)", () => {
    const d = decideOrphanRecovery(orphan({ latestRunStatus: null, latestRunActivityIso: null }));
    expect(d).toMatchObject({ action: "recover", to: "input_required" });
  });

  it("parks a stranded in_review to blocked, since in_review→input_required is illegal", () => {
    const d = decideOrphanRecovery(orphan({ status: "in_review" }));
    expect(d).toMatchObject({ action: "recover", to: "blocked" });
  });
});

describe("decideOrphanRecovery - never touch live work", () => {
  it("stands down when a run is live", () => {
    expect(decideOrphanRecovery(orphan({ hasLiveRun: true }))).toEqual({
      action: "none",
      reason: "live-run",
    });
  });

  it("stands down when a dispatch is queued", () => {
    expect(decideOrphanRecovery(orphan({ hasPendingDispatch: true }))).toEqual({
      action: "none",
      reason: "pending-dispatch",
    });
  });

  it("the live-run guard outranks EVERY other signal, including a maximally stale ticket", () => {
    // Belt-and-braces: even with every other field screaming "orphan", a live
    // run wins. This is the assertion that must never be deleted.
    const d = decideOrphanRecovery(
      orphan({
        hasLiveRun: true,
        hasPendingDispatch: true,
        ticketUpdatedAtIso: "2020-01-01T00:00:00.000Z",
        latestRunActivityIso: "2020-01-01T00:00:00.000Z",
      }),
    );
    expect(d.action).toBe("none");
  });

  it("treats awaiting_human as live - a multi-day human wait is not an orphan", () => {
    // The reaper reads liveness from LIVE_RUN_STATUSES; pin the membership so a
    // future 'tidy' that drops awaiting_human fails here rather than in prod.
    expect(LIVE_RUN_STATUSES).toContain("awaiting_human");
    expect(LIVE_RUN_STATUSES).toContain("running");
  });
});

describe("decideOrphanRecovery - the grace window", () => {
  it("does not reap a ticket that just moved (the dispatch→run write race)", () => {
    const d = decideOrphanRecovery(
      orphan({ ticketUpdatedAtIso: JUST_NOW, latestRunActivityIso: null }),
    );
    expect(d).toEqual({ action: "none", reason: "within-grace" });
  });

  it("does not reap when the run failed moments ago, even on an old ticket", () => {
    // The near-race that matters most: the stale-run reaper has just failed a
    // wedged run and the completion machinery is still settling. The clock is
    // max(ticket, run), so a fresh run event restarts the whole window.
    const d = decideOrphanRecovery(
      orphan({ ticketUpdatedAtIso: LONG_AGO, latestRunActivityIso: JUST_NOW }),
    );
    expect(d).toEqual({ action: "none", reason: "within-grace" });
  });

  it("holds off until the grace has fully elapsed, then acts", () => {
    const at = (msAgo: number) => new Date(Date.parse(NOW) - msAgo).toISOString();
    const graceMs = ORPHAN_GRACE_SECONDS_DEFAULT * 1000;
    const justInside = orphan({
      ticketUpdatedAtIso: at(graceMs - 1000),
      latestRunActivityIso: at(graceMs - 1000),
    });
    const justOutside = orphan({
      ticketUpdatedAtIso: at(graceMs + 1000),
      latestRunActivityIso: at(graceMs + 1000),
    });
    expect(decideOrphanRecovery(justInside).action).toBe("none");
    expect(decideOrphanRecovery(justOutside).action).toBe("recover");
  });

  it("does nothing when the timestamps are unparseable (fail closed)", () => {
    const d = decideOrphanRecovery(
      orphan({ ticketUpdatedAtIso: "not-a-date", latestRunActivityIso: null }),
    );
    expect(d).toEqual({ action: "none", reason: "indeterminate-idle-time" });
  });

  it("the default grace clears the stale-run reaper's own 15-minute threshold", () => {
    // If this ever drops below the stale-run threshold + its cron period, the
    // two reapers race and a ticket can be recovered while its run is still
    // being failed. 15m + 5m cron + margin.
    expect(ORPHAN_GRACE_SECONDS_DEFAULT).toBeGreaterThan((15 + 5) * 60);
  });
});

describe("decideOrphanRecovery - non-overlap and stand-downs", () => {
  it("hands a done latest run to the stuck-ticket sweeper", () => {
    // The two crons must never both act on one ticket. `done` is the sweeper's
    // entire domain; this is the seam between them.
    expect(decideOrphanRecovery(orphan({ latestRunStatus: "done" }))).toEqual({
      action: "none",
      reason: "latest-run-done",
    });
  });

  it("leaves a fan-out cohort to the aggregator", () => {
    expect(decideOrphanRecovery(orphan({ latestRunFanOutGroup: "g1" }))).toEqual({
      action: "none",
      reason: "fan-out-cohort",
    });
  });

  it("respects an automation pause - a board pause looks exactly like an orphan", () => {
    // pauseTicket/board-pause cancel the run and deliberately leave the ticket
    // in place. Reaping that would fight the operator's own off switch.
    expect(decideOrphanRecovery(orphan({ automationPaused: true }))).toEqual({
      action: "none",
      reason: "automation-paused",
    });
  });

  it("does not repeat itself when it has already spoken about this stall", () => {
    expect(
      decideOrphanRecovery(orphan({ lastRecoveryCommentIso: "2026-07-19T11:30:00.000Z" })),
    ).toEqual({ action: "none", reason: "already-recovered" });
  });

  it("speaks again when the stall is NEWER than the last recovery comment", () => {
    // A recovered ticket that a human revived, and which stranded a second
    // time, is a fresh orphan - not a duplicate.
    const d = decideOrphanRecovery(orphan({ lastRecoveryCommentIso: "2026-07-19T09:00:00.000Z" }));
    expect(d.action).toBe("recover");
  });
});

describe("orphanIdleSinceIso", () => {
  it("takes the later of the ticket touch and the last run event", () => {
    expect(
      orphanIdleSinceIso({ ticketUpdatedAtIso: LONG_AGO, latestRunActivityIso: JUST_NOW }),
    ).toBe(JUST_NOW);
    expect(
      orphanIdleSinceIso({ ticketUpdatedAtIso: JUST_NOW, latestRunActivityIso: LONG_AGO }),
    ).toBe(JUST_NOW);
  });

  it("falls back to the ticket when there are no runs", () => {
    expect(orphanIdleSinceIso({ ticketUpdatedAtIso: LONG_AGO, latestRunActivityIso: null })).toBe(
      LONG_AGO,
    );
  });
});

describe("scope", () => {
  it("covers only the agent-owned states with a legal recovery edge", () => {
    // `assigned` is deliberately absent: its out-edges are ready/in_progress/
    // paused/failed, so there is no waiting-for-human state to recover it to.
    expect([...ORPHANABLE_TICKET_STATUSES]).toEqual(["in_progress", "in_review"]);
  });
});

describe("renderOrphanRecoveryComment", () => {
  it("names what is known and admits what is not, when the run recorded no reason", () => {
    const body = renderOrphanRecoveryComment({
      to: "input_required",
      fromStatus: "in_progress",
      idleSinceIso: LONG_AGO,
      graceSeconds: ORPHAN_GRACE_SECONDS_DEFAULT,
      latestRunStatus: "failed",
      latestRunStatusReason: null,
    });
    expect(body).toContain("no live run");
    expect(body).toContain(LONG_AGO);
    expect(body).toContain("`failed`");
    expect(body).toContain("30 minutes");
    // The point of the comment: tell the operator how to actually resume.
    expect(body).toContain("Input required");
    // Bias toward the true state, even when the truth is "we do not know" -
    // this is the control that matters: a reason must never be invented.
    expect(body).toContain("We do not know why the work stopped");
  });

  it("quotes the recorded failure reason instead of pretending it is unknown", () => {
    const body = renderOrphanRecoveryComment({
      to: "input_required",
      fromStatus: "in_progress",
      idleSinceIso: LONG_AGO,
      graceSeconds: ORPHAN_GRACE_SECONDS_DEFAULT,
      latestRunStatus: "failed",
      latestRunStatusReason: "step-timeout:local-cc step 3 timed out after 3600000",
    });
    expect(body).toContain("`failed`");
    expect(body).toContain("step-timeout:local-cc step 3 timed out after 3600000");
    // A known reason must never be presented alongside the "we do not know"
    // disclaimer - that would contradict the sentence right above it.
    expect(body).not.toContain("We do not know why the work stopped");
  });

  it("treats an empty-string reason the same as no reason at all", () => {
    const body = renderOrphanRecoveryComment({
      to: "input_required",
      fromStatus: "in_progress",
      idleSinceIso: LONG_AGO,
      graceSeconds: ORPHAN_GRACE_SECONDS_DEFAULT,
      latestRunStatus: "failed",
      latestRunStatusReason: "   ",
    });
    expect(body).toContain("We do not know why the work stopped");
  });

  it("says plainly when there were no runs at all, regardless of a stray reason", () => {
    const body = renderOrphanRecoveryComment({
      to: "input_required",
      fromStatus: "in_progress",
      idleSinceIso: LONG_AGO,
      graceSeconds: ORPHAN_GRACE_SECONDS_DEFAULT,
      latestRunStatus: null,
      latestRunStatusReason: null,
    });
    expect(body).toContain("no runs at all");
  });

  it("explains the reversibility of the blocked park", () => {
    const body = renderOrphanRecoveryComment({
      to: "blocked",
      fromStatus: "in_review",
      idleSinceIso: LONG_AGO,
      graceSeconds: ORPHAN_GRACE_SECONDS_DEFAULT,
      latestRunStatus: "failed",
      latestRunStatusReason: null,
    });
    expect(body).toContain("Blocked");
    expect(body).toContain("reversible");
  });
});
