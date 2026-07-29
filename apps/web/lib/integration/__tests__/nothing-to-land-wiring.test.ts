// The wiring half of "a ticket that produced no code says so".
//
// WHY A SOURCE SCAN AND NOT A BEHAVIOURAL DRIVE. `lib/engine/land-worker.ts`
// pulls in `supabaseService` and the Inngest client, both of which reach
// `server-only`, so the module throws on import under Vitest — the same reason
// `authoring-write-scope.test.ts` and `operator-gate-wiring.test.ts` scan source.
// That is precisely the gap the defect lived in: the pure `decideLandAttempt`
// rule was correct and tested from the day it shipped, and the ORDER it sat in
// relative to the GitHub call, plus the fallback behind it, were covered by
// nothing at all.
//
// Each assertion below is a claim about the worker that the pure tests cannot
// make, and every one is mutation-verified: reordering the detection past the
// request, or widening a reaper's status set, turns a test here red.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveLandingState, landingCardTreatment } from "@/lib/integration/landing-state";

const ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const WORKER = read("lib/engine/land-worker.ts");
const RESCUE_REAPER = read("lib/engine/land-rescue-reaper.ts");

/** Index of the first occurrence, or -1. Used to compare ORDER in the source. */
const at = (haystack: string, needle: string) => haystack.indexOf(needle);

describe("nothing-to-land costs no GitHub call and no retry", () => {
  // THE PRIMARY PROPERTY. A branch level with its base is knowable from the
  // workspace alone. DevPilot-7 instead spent a request per attempt on a 422 that
  // was never going to succeed, three times.
  it("decides BEFORE any pull-request request is made", () => {
    const decide = at(WORKER, "decideLandAttempt({ commitsAhead: prep.commitsAhead })");
    const findPr = at(WORKER, "findOpenPullRequest(");
    const createPr = at(WORKER, "createPullRequest(");
    expect(decide).toBeGreaterThan(-1);
    expect(findPr).toBeGreaterThan(-1);
    expect(createPr).toBeGreaterThan(-1);
    expect(decide).toBeLessThan(findPr);
    expect(decide).toBeLessThan(createPr);
  });

  it("returns out of the landing path instead of falling through to the merge", () => {
    // The branch now carries a second outcome (`already_on_base`), so the early
    // return is a block rather than a one-liner - but it is still an early
    // RETURN, and still above the merge step, which is the property that
    // matters: the squash-merge request is unreachable for this outcome.
    expect(WORKER).toContain('if (attempt.action === "nothing_to_land") {');
    expect(at(WORKER, 'if (attempt.action === "nothing_to_land") {')).toBeLessThan(
      at(WORKER, 'step.run("squash-merge"'),
    );
    expect(at(WORKER, "return closeNothingToLand(")).toBeLessThan(
      at(WORKER, 'step.run("squash-merge"'),
    );
  });

  // TERMINAL, NOT FAILED. `stampLanded` writes `status='landed'`, which the
  // queue's own CHECK constrains to carry a `merge_sha` — so the row is settled,
  // and `attempts` (bumped only by a CLAIM) can never advance again because
  // nothing re-claims a terminal row.
  it("closes the row terminally through stampLanded, never through a failure path", () => {
    const closure = WORKER.slice(
      at(WORKER, "const closeNothingToLand"),
      at(WORKER, "const attempt = decideLandAttempt"),
    );
    expect(closure).toContain(
      "stampLanded({ queueId, ticketId, tenantId, pendingPushId: push.id, sha: baseSha })",
    );
    expect(closure).not.toContain('to: "failed"');
    expect(closure).not.toContain("NonRetriableError");
    expect(closure).not.toContain("throw new Error(prep");
  });

  // The fallback converges on the SAME closure. Two copies would be two places
  // to disagree about what this outcome does to the ticket.
  it("routes the after-the-fact 422 detection into the same closure", () => {
    expect(WORKER).toContain('if (merge.kind === "nothing_to_land") return closeNothingToLand(');
    expect(WORKER).toContain("classifyPullRequestFailure(toGithubFailureShape(err))");
  });
});

describe("no reaper picks up a settled nothing-to-land row", () => {
  // NON-OVERLAP BY CONSTRUCTION, the same property the orphan reaper and the
  // stuck-ticket sweeper hold. Both crons address IN-FLIGHT or UNCLAIMED rows;
  // `landed` is neither, so a settled row is outside both scopes with no
  // special-casing anywhere.
  it("the integration-queue reaper scans only in-flight rows", () => {
    expect(WORKER).toContain('.in("status", ["landing", "awaiting_merge_resolution"])');
    // Mutation guard: if a reaper ever queries a terminal status, say so here.
    for (const terminal of ['"landed"', '"cancelled"', '"failed"']) {
      expect(WORKER).not.toContain(`.in("status", [${terminal}`);
      expect(WORKER).not.toContain(`.eq("status", ${terminal})`);
    }
  });

  it("the land-rescue reaper scans only never-claimed pending rows", () => {
    for (const terminal of ['"landed"', '"cancelled"', '"failed"']) {
      expect(RESCUE_REAPER).not.toContain(`.eq("status", ${terminal})`);
      expect(RESCUE_REAPER).not.toContain(`.in("status", [${terminal}`);
    }
    expect(RESCUE_REAPER).toContain('.eq("status", "pending")');
  });
});

describe("a real land failure is still loud", () => {
  // The risk of this whole change is softening genuine failures. `failed` still
  // renders as a warning with the recorder's own text, and the label still reads
  // as an error.
  it("renders a failed land as a warning, with its reason", () => {
    const state = deriveLandingState({
      landedSha: null,
      push: {
        pushedAt: "2026-07-15T00:00:00Z",
        conflictState: "clean",
        unpushedCount: 0,
        branch: "devpilot/x",
      },
      queue: {
        status: "failed",
        lastError:
          "GitHub refused to open the pull request (422): base: A pull request already exists",
        claimedAt: "2026-07-15T00:00:00Z",
      },
      nothingToLandNotice: null,
    });
    expect(state.kind).toBe("not_landed");
    if (state.kind !== "not_landed") throw new Error("unreachable");
    expect(state.reason).toBe("integration_failed");
    expect(state.detail).toContain("already exists");
    expect(landingCardTreatment(state, "done")).toBe("warn");
  });

  // …and the healthy outcome is neutral, on the same board, for the same ticket
  // status. This pair is the whole point: two different facts, two treatments.
  it("renders the nothing-to-land outcome as neutral information", () => {
    const state = deriveLandingState({
      landedSha: "c921359c921359c921359c921359c921359c9213",
      push: {
        pushedAt: "2026-07-15T00:00:00Z",
        conflictState: "clean",
        unpushedCount: 0,
        branch: "devpilot/x",
      },
      queue: { status: "landed", lastError: null, claimedAt: "2026-07-15T00:00:00Z" },
      nothingToLandNotice: { branch: "devpilot/x", base: "dev" },
    });
    expect(state.kind).toBe("nothing_to_land");
    expect(landingCardTreatment(state, "done")).toBe("info");
  });
});
