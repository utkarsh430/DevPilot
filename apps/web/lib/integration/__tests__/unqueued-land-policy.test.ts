// The unqueued-land selection rule.
//
// Every clause here is a REFUSAL that matters more than the acceptance: the
// sweep hands tickets to a worker that is serialized one-at-a-time per project
// and that merges branches into the integration branch, so a wrong `enqueue` is
// far more expensive than a missed one. The tests are therefore written as
// "these do NOT get enqueued, and here is the one that does", and every guard
// was mutation-verified by deleting the clause it covers.

import { describe, expect, it } from "vitest";
import {
  decideUnqueuedLandRescue,
  UNQUEUED_LAND_CRON_PERIOD_SECONDS,
  UNQUEUED_LAND_GRACE_SECONDS_DEFAULT,
  type UnqueuedLandCandidate,
} from "@/lib/integration/unqueued-land-policy";

const NOW = "2026-08-03T12:00:00.000Z";
/** Well past the 15-minute grace. */
const LONG_AGO = "2026-08-03T09:00:00.000Z";
const GRACE = UNQUEUED_LAND_GRACE_SECONDS_DEFAULT;

/** The shape of a genuinely stranded ticket - #69/#76/#77 on `scoursh`. */
function stranded(over: Partial<UnqueuedLandCandidate> = {}): UnqueuedLandCandidate {
  return {
    ticketId: "t-69",
    isMerger: false,
    status: "done",
    landedSha: null,
    updatedAtIso: LONG_AGO,
    autoLandEnabled: true,
    instanceAutoLandEnabled: true,
    hasQueueRow: false,
    hasBranch: true,
    dependencyDeferred: false,
    ...over,
  };
}

const decide = (c: UnqueuedLandCandidate) => decideUnqueuedLandRescue(c, NOW, GRACE);

describe("the ticket the whole sweep exists for", () => {
  it("enqueues a done, unlanded, branch-bearing ticket with no queue row", () => {
    const d = decide(stranded());
    expect(d.action).toBe("enqueue");
    expect(d.reason).toContain("no integration_queue row");
  });
});

describe("a landing decision that already exists is never re-litigated", () => {
  // THE SHARPEST CLAUSE. The partial unique index on integration_queue(ticket_id)
  // covers only pending/landing/awaiting_merge_resolution, so an insert for a
  // ticket carrying a terminal row SUCCEEDS and mints a fresh pending row.
  // Without this the sweep would re-enqueue the two `failed` rows measured on
  // `scoursh` every five minutes, forever.
  it.each([
    ["pending - landRescueReaper's", "pending"],
    ["landing - integrationQueueReaper's", "landing"],
    ["awaiting_merge_resolution - a merger owns it", "awaiting_merge_resolution"],
    ["failed - a verdict a human re-drives", "failed"],
    ["cancelled - 'nothing to land', and it must stay that way", "cancelled"],
    ["landed - settled", "landed"],
  ])("stands down when a %s row exists", (_label, _status) => {
    expect(decide(stranded({ hasQueueRow: true }))).toEqual({
      action: "none",
      reason: "already-queued",
    });
  });
});

describe("a merger is never the thing that lands", () => {
  // A merger (`release_engineer` + `parent_ticket_id`) has no branch of its own;
  // `enqueueForLanding` redirects it to its SOURCE. Evaluating one here would
  // call the seam every tick to re-derive that redirect, and the source is in
  // the same scan on its own merits.
  it("stands down on a merger", () => {
    expect(decide(stranded({ isMerger: true }))).toEqual({
      action: "none",
      reason: "merger-redirects-to-source",
    });
  });

  // …and the source it points at is still enqueued, so nothing is lost.
  it("still enqueues the source ticket itself", () => {
    expect(decide(stranded({ ticketId: "t-source", isMerger: false })).action).toBe("enqueue");
  });
});

describe("the majority case: nothing to land", () => {
  // 19 of the 70 done tickets on `scoursh` produced no branch at all - review
  // and spec work, the ~48 non-code roles. Enqueueing those would spend a
  // project's ONLY land lane on work that does not exist.
  it("never enqueues a ticket with no branch", () => {
    expect(decide(stranded({ hasBranch: false }))).toEqual({
      action: "none",
      reason: "no-branch",
    });
  });
});

describe("the opt-ins are mirrored, never bypassed", () => {
  it("stands down when the instance kill switch is off", () => {
    expect(decide(stranded({ instanceAutoLandEnabled: false }))).toEqual({
      action: "none",
      reason: "auto-land-kill-switch",
    });
  });

  it("stands down when the project did not opt in", () => {
    expect(decide(stranded({ autoLandEnabled: false }))).toEqual({
      action: "none",
      reason: "auto-land-disabled-for-project",
    });
  });

  // The kill switch outranks the project flag, so an instance-wide stop is
  // reported as itself rather than as 51 per-project refusals.
  it("reports the kill switch even when the project also opted out", () => {
    expect(decide(stranded({ instanceAutoLandEnabled: false, autoLandEnabled: false }))).toEqual({
      action: "none",
      reason: "auto-land-kill-switch",
    });
  });
});

describe("only an approved verdict is landed", () => {
  it.each(["in_progress", "in_review", "blocked", "input_required", "failed", "backlog"])(
    "stands down on a %s ticket",
    (status) => {
      expect(decide(stranded({ status }))).toEqual({
        action: "none",
        reason: `not-done:${status}`,
      });
    },
  );

  it("reports a missing status rather than treating it as done", () => {
    expect(decide(stranded({ status: null }))).toEqual({
      action: "none",
      reason: "not-done:missing",
    });
  });
});

describe("an existing landing is never re-landed", () => {
  it("stands down on a real sha", () => {
    expect(decide(stranded({ landedSha: "c921359c921359c921359c921359c921359c9213" }))).toEqual({
      action: "none",
      reason: "already-landed",
    });
  });

  // The `'backfill'` sentinel is a GUESS an old migration recorded, not a
  // landing - but adjudicating it is what `decideLandedShaGate`'s `force` path
  // exists for, and `force` is reachable only from the operator's own "Land
  // now". A cron must not make that call on 35 tickets' behalf.
  it("stands down on the 'backfill' sentinel too", () => {
    expect(decide(stranded({ landedSha: "backfill" }))).toEqual({
      action: "none",
      reason: "already-landed",
    });
  });
});

describe("a dependency-deferred child is neither enqueued nor failed", () => {
  it("stands down while a builds_on parent has not landed", () => {
    expect(decide(stranded({ dependencyDeferred: true }))).toEqual({
      action: "none",
      reason: "dependency-deferred",
    });
  });

  // It is not stranded by that: the sweep runs every five minutes, so the tick
  // after the parent lands is the one that acts.
  it("acts on the same ticket once the dependency clears", () => {
    expect(decide(stranded({ dependencyDeferred: false })).action).toBe("enqueue");
  });
});

describe("the grace window", () => {
  const at = (msAgo: number) => new Date(Date.parse(NOW) - msAgo).toISOString();

  it("leaves a ticket that just reached done to its own inline enqueue", () => {
    expect(decide(stranded({ updatedAtIso: at(60_000) }))).toEqual({
      action: "none",
      reason: "within-grace",
    });
  });

  it("holds off until the grace has fully elapsed, then acts", () => {
    expect(decide(stranded({ updatedAtIso: at(GRACE * 1000 - 1000) })).action).toBe("none");
    expect(decide(stranded({ updatedAtIso: at(GRACE * 1000 + 1000) })).action).toBe("enqueue");
  });

  it("fails closed on an unparseable or missing timestamp", () => {
    expect(decide(stranded({ updatedAtIso: "not-a-date" }))).toEqual({
      action: "none",
      reason: "indeterminate-idle-time",
    });
    expect(decide(stranded({ updatedAtIso: null }))).toEqual({
      action: "none",
      reason: "indeterminate-idle-time",
    });
  });

  // THE PINNED RELATIONSHIP, the same shape as `orphanTicketReaper`'s grace
  // against the stale-run threshold plus its cron. Drop below the cron period
  // and the sweep starts racing a ticket's own inline enqueue - and the async
  // `pending_push.upserted` enqueue behind it, which can sit in an Inngest
  // backlog. Two periods of margin.
  it("the default grace clears the cron period with room for the async enqueue", () => {
    expect(UNQUEUED_LAND_GRACE_SECONDS_DEFAULT).toBeGreaterThan(
      UNQUEUED_LAND_CRON_PERIOD_SECONDS * 2,
    );
  });
});

describe("clause ORDER - a structural refusal is reported as itself", () => {
  // A ticket that is ineligible for a structural reason must not be reported as
  // "within-grace", which reads as "it will happen shortly" and is false.
  it("reports no-branch, not within-grace, for a fresh branchless ticket", () => {
    expect(decide(stranded({ hasBranch: false, updatedAtIso: NOW }))).toEqual({
      action: "none",
      reason: "no-branch",
    });
  });

  it("reports already-queued ahead of every other clause", () => {
    expect(
      decide(
        stranded({
          hasQueueRow: true,
          hasBranch: false,
          status: "blocked",
          autoLandEnabled: false,
          instanceAutoLandEnabled: false,
          updatedAtIso: NOW,
        }),
      ),
    ).toEqual({ action: "none", reason: "already-queued" });
  });
});
