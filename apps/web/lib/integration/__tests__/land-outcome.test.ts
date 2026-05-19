import { describe, expect, it } from "vitest";
import {
  buildNothingToLandComment,
  buildNothingToLandMetadata,
  decideConflictResolution,
  decideLandAttempt,
  decideMergerRelease,
  classifyPullRequestFailure,
  NOTHING_TO_LAND_AUTHOR_ID,
  NOTHING_TO_LAND_METADATA_KIND,
} from "@/lib/integration/land-outcome";

const SOURCE = "55555555-5555-4555-8555-555555555555";

describe("decideMergerRelease", () => {
  it("releases the source push when the merger completed successfully", () => {
    expect(
      decideMergerRelease({
        requestedRole: "release_engineer",
        parentTicketId: SOURCE,
        status: "done",
      }),
    ).toEqual({ action: "release_source", sourceTicketId: SOURCE });
  });

  // THE FAIL-SAFE DIRECTION. A merger that did not reach `done` has not fixed
  // anything; re-queuing its source would re-attempt a landing nobody repaired,
  // and (before the split in this module) would have been taken as licence to
  // clear the conflict flag too.
  it("holds the source push for a merger that failed or was abandoned", () => {
    for (const status of ["failed", "blocked", "cancelled", "in_progress", null]) {
      const d = decideMergerRelease({
        requestedRole: "release_engineer",
        parentTicketId: SOURCE,
        status,
      });
      expect(d.action).toBe("hold");
    }
  });

  it("leaves an ordinary ticket alone — it lands itself, not a parent", () => {
    expect(
      decideMergerRelease({ requestedRole: "engineer", parentTicketId: SOURCE, status: "done" }),
    ).toEqual({ action: "not_a_merger" });
    // A release_engineer with no parent is a normal release ticket, not a merger.
    expect(
      decideMergerRelease({
        requestedRole: "release_engineer",
        parentTicketId: null,
        status: "done",
      }),
    ).toEqual({ action: "not_a_merger" });
  });
});

// ─── Defect 1 — a resolved conflict is marked resolved, and ONLY on proof ───

describe("decideConflictResolution", () => {
  it("clears the conflict when the rebase succeeded and we hold the replayed sha", () => {
    const d = decideConflictResolution({
      conflictState: "conflict",
      rebaseSucceeded: true,
      headSha: "deadbee",
    });
    expect(d).toEqual({ action: "resolve", rebasedOntoSha: "deadbee" });
  });

  // THE FAIL-SAFE DIRECTION. A merger that failed or was abandoned leaves the
  // branch still conflicting, so the rebase fails again. Clearing the flag here
  // would declare a branch nobody fixed safe to land.
  it("does NOT clear the conflict when the rebase did not succeed", () => {
    const d = decideConflictResolution({
      conflictState: "conflict",
      rebaseSucceeded: false,
      headSha: "deadbee",
    });
    expect(d).toEqual({ action: "leave", reason: "rebase-did-not-succeed" });
  });

  // Indeterminate: the branch was landed from the remote with no workspace to
  // inspect. A successful *push* is not evidence the conflict was resolved.
  it("does NOT clear the conflict without a post-rebase head sha", () => {
    for (const headSha of [null, "", "   "]) {
      expect(
        decideConflictResolution({ conflictState: "conflict", rebaseSucceeded: true, headSha }),
      ).toEqual({ action: "leave", reason: "no-post-rebase-head-sha" });
    }
  });

  it("leaves every non-conflict state alone rather than overwriting it", () => {
    for (const conflictState of [null, "clean", "rebased", "resolved"]) {
      expect(
        decideConflictResolution({ conflictState, rebaseSucceeded: true, headSha: "abc123" }),
      ).toEqual({ action: "leave", reason: "no-conflict-recorded" });
    }
  });
});

// ─── Defect 2 — "nothing to land" is a success, not a 422 ──────────────────

describe("decideLandAttempt", () => {
  it("records nothing-to-land for a zero-commits-ahead branch", () => {
    const d = decideLandAttempt({ commitsAhead: 0 });
    expect(d.action).toBe("nothing_to_land");
  });

  it("opens a pull request when there is work ahead of the base", () => {
    for (const commitsAhead of [1, 6, 400]) {
      expect(decideLandAttempt({ commitsAhead })).toEqual({ action: "open_pull_request" });
    }
  });

  // An uncountable branch is NOT zero. Inferring it would silently skip a real
  // landing — strictly worse than the 422 this replaces.
  it("falls through to a pull request on an indeterminate count", () => {
    expect(decideLandAttempt({ commitsAhead: null })).toEqual({ action: "open_pull_request" });
  });
});

describe("the nothing-to-land record", () => {
  it("is structured so a consumer can read the outcome rather than recompute it", () => {
    expect(
      buildNothingToLandMetadata({
        branch: "devpilot/qa-pass",
        base: "dev",
        outcome: "no_commits",
      }),
    ).toEqual({
      kind: NOTHING_TO_LAND_METADATA_KIND,
      branch: "devpilot/qa-pass",
      base: "dev",
      commits_ahead: 0,
      outcome: "no_commits",
    });
  });

  it("states plainly that this is a success", () => {
    const body = buildNothingToLandComment({
      branch: "devpilot/qa-pass",
      base: "dev",
      outcome: "no_commits",
    });
    expect(body).toContain("Nothing to land");
    expect(body).toContain("successful outcome, not a failure");
    expect(body).toContain("No pull request was opened");
  });

  // ALREADY-ON-BASE IS A DIFFERENT FACT AND MUST READ AS ONE. Measured on
  // `scoursh`: #69/#76/#77 shipped through pull requests #39/#42/#44 and were
  // then found `done` with `landed_sha IS NULL` and no queue row. Telling that
  // operator the ticket "completed without changing any files" would be false
  // about work that is sitting on `dev` right now.
  it("distinguishes 'already shipped' from 'changed nothing'", () => {
    const shipped = buildNothingToLandComment({
      branch: "devpilot/build-the-thing",
      base: "dev",
      outcome: "already_on_base",
    });
    expect(shipped).toContain("already on `dev`");
    expect(shipped).toContain("successful outcome, not a failure");
    // …and it explains the squash merge, which is WHY the branch still looks
    // unmerged and why an operator would otherwise doubt the record.
    expect(shipped).toContain("squash merge");
    expect(shipped).toContain("nothing was force-pushed");
    // The no-commits wording must not leak into it - that is the false claim.
    expect(shipped).not.toContain("without changing any files");

    expect(
      buildNothingToLandMetadata({
        branch: "devpilot/build-the-thing",
        base: "dev",
        outcome: "already_on_base",
      }),
    ).toMatchObject({ kind: NOTHING_TO_LAND_METADATA_KIND, outcome: "already_on_base" });
  });

  // The reconciler string-matches `devpilot_move_ticket` as "an agent rendered a
  // verdict". A notice must never borrow it.
  it("uses its own author id, never devpilot_move_ticket", () => {
    expect(NOTHING_TO_LAND_AUTHOR_ID).toBe("devpilot_nothing_to_land");
    expect(NOTHING_TO_LAND_AUTHOR_ID).not.toBe("devpilot_move_ticket");
  });
});

// ─── Defect 3 — the PR-creation 422 fallback that could never fire ─────────
//
// THE LIVE EVIDENCE. DevPilot-7 ("End-to-end QA pass") is a verification ticket:
// it reviewed the work and wrote no code, so its branch sat at the exact commit
// already on `dev`. GitHub refused the pull request, the worker recorded
// `GitHub 422 on /repos/utkarsh430/todo-app/pulls: Validation Failed`, burned all
// three attempts, and the board showed a red "Not landed — land failed" card for
// a ticket that was entirely healthy.
//
// The old fallback tested `/no commits between/i` against `githubMessage` — the
// TOP-LEVEL field, which for any validation failure is the literal string
// "Validation Failed". The reason lives one level down in `errors[]`. The first
// test below is the exact GitHub response shape and FAILS against the old rule.

const NO_COMMITS_422: Parameters<typeof classifyPullRequestFailure>[0] = {
  status: 422,
  githubMessage: "Validation Failed",
  githubErrors: [
    {
      resource: "PullRequest",
      code: "custom",
      message: "No commits between dev and devpilot/end-to-end-qa-pass",
    },
  ] as never,
  fallbackMessage: "GitHub 422 on /repos/utkarsh430/todo-app/pulls: Validation Failed",
};

describe("classifyPullRequestFailure", () => {
  it("reads `no commits between` out of errors[], where GitHub actually puts it", () => {
    expect(classifyPullRequestFailure(NO_COMMITS_422)).toEqual({
      kind: "nothing_to_land",
      reason: "No commits between dev and devpilot/end-to-end-qa-pass",
    });
  });

  // The regression guard for the exact defect: matching the top-level message
  // alone sees only "Validation Failed" and classifies this as an error.
  it("would NOT have matched on the top-level message alone", () => {
    expect(/no commits between/i.test(NO_COMMITS_422.githubMessage!)).toBe(false);
  });

  it("still matches when GitHub puts the reason in the top-level message", () => {
    expect(
      classifyPullRequestFailure({
        status: 422,
        githubMessage: "No commits between dev and devpilot/x",
        githubErrors: null,
        fallbackMessage: "GitHub 422 on /repos/o/r/pulls: No commits between dev and devpilot/x",
      }).kind,
    ).toBe("nothing_to_land");
  });

  // ─── real failures stay failures ────────────────────────────────────────
  //
  // The whole risk of this change is softening a genuine failure into a healthy
  // outcome. Every 422 that is NOT "no commits between" must remain an error —
  // and gain a readable cause, which is the `explainPushFailure` standard.

  it("keeps a DIFFERENT 422 an error, and names the buried cause", () => {
    const failure = classifyPullRequestFailure({
      status: 422,
      githubMessage: "Validation Failed",
      githubErrors: [
        {
          resource: "PullRequest",
          field: "base",
          code: "custom",
          message: "A pull request already exists for utkarsh430:devpilot/x.",
        },
      ] as never,
      fallbackMessage: "GitHub 422 on /repos/o/r/pulls: Validation Failed",
    });
    expect(failure.kind).toBe("error");
    if (failure.kind !== "error") throw new Error("unreachable");
    expect(failure.explanation).toContain("A pull request already exists");
    expect(failure.explanation).toContain("base:");
    // The raw text is retained — the operator can still see what GitHub sent.
    expect(failure.explanation).toContain("GitHub 422 on /repos/o/r/pulls");
  });

  it("says something useful even for a 422 carrying no errors[] at all", () => {
    const failure = classifyPullRequestFailure({
      status: 422,
      githubMessage: "Validation Failed",
      githubErrors: null,
      fallbackMessage: "GitHub 422 on /repos/o/r/pulls: Validation Failed",
    });
    expect(failure.kind).toBe("error");
    if (failure.kind !== "error") throw new Error("unreachable");
    expect(failure.explanation).toContain("not a transient");
  });

  it("passes a non-422 through verbatim — its own message is already the account", () => {
    for (const status of [404, 403, 500, 0]) {
      const failure = classifyPullRequestFailure({
        status,
        githubMessage: "Not Found",
        githubErrors: null,
        fallbackMessage: `GitHub ${status} on /repos/o/r/pulls: Not Found`,
      });
      expect(failure).toEqual({
        kind: "error",
        explanation: `GitHub ${status} on /repos/o/r/pulls: Not Found`,
      });
    }
  });

  it("handles a non-GitHub throw without inventing a cause", () => {
    expect(
      classifyPullRequestFailure({
        status: null,
        githubMessage: null,
        githubErrors: null,
        fallbackMessage: "socket hang up",
      }),
    ).toEqual({ kind: "error", explanation: "socket hang up" });
  });
});
