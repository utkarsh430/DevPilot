// Landing visibility — the derivation, driven from the five REAL cases the
// incident produced. Row shapes below mirror what was actually in the operator's
// database on his Todo App, not invented fixtures, because the whole failure was
// that plausible-looking data rendered as success.

import { describe, expect, it } from "vitest";
import {
  deriveLandingState,
  landingCardTreatment,
  landingStateDetail,
  landingStateLabel,
  type LandingEvidence,
} from "@/lib/integration/landing-state";

/** A ticket with no branch, no queue row, no sha. Every case overrides. */
const NONE: LandingEvidence = {
  landedSha: null,
  push: null,
  queue: null,
  nothingToLandNotice: null,
};

describe("deriveLandingState — the five real cases", () => {
  it("DevPilot-8: conflict unresolved, branch never on the remote, queue row never claimed", () => {
    // 6 commits ahead of dev, branch not on GitHub, pushed_at NULL,
    // conflict_state='conflict', integration_queue row pending since 09:35 and
    // never claimed.
    const state = deriveLandingState({
      landedSha: null,
      nothingToLandNotice: null,
      push: {
        pushedAt: null,
        conflictState: "conflict",
        unpushedCount: 6,
        branch: "devpilot/ci-deploy-observability",
      },
      queue: { status: "pending", lastError: null, claimedAt: null },
    });

    expect(state.kind).toBe("not_landed");
    // The conflict is the CAUSE; "stuck in queue" would be the symptom. If this
    // flips, an operator is sent to the queue instead of to the conflict.
    expect(state).toMatchObject({ reason: "conflict_unresolved" });
    expect(landingStateDetail(state)).toContain("devpilot/ci-deploy-observability");
  });

  it("DevPilot-9: push rejected by GitHub, integration_queue failed with the reason", () => {
    const state = deriveLandingState({
      landedSha: null,
      nothingToLandNotice: null,
      push: {
        pushedAt: null,
        conflictState: "clean",
        unpushedCount: 3,
        branch: "devpilot/ci-workflow",
      },
      queue: {
        status: "failed",
        lastError:
          "refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope",
        claimedAt: "2026-07-19T09:36:00Z",
      },
    });

    expect(state).toMatchObject({ kind: "not_landed", reason: "integration_failed" });
    // The recorded error IS the reason — surfacing "not landed" without it is
    // the defect this feature exists to fix.
    expect(landingStateDetail(state)).toContain("workflow` scope");
  });

  it("DevPilot-7 (post-#137): the worker's own record says nothing to land, sha notwithstanding", () => {
    // #137 detects the zero-commits-ahead branch before opening the PR, writes
    // the notice, AND stamps `landed_sha` with the base tip (so `builds_on`
    // dependents aren't wedged behind a ticket with nothing to merge). Both
    // facts are now present, and only the notice distinguishes this from a real
    // landing — which is why it is checked first.
    const state = deriveLandingState({
      landedSha: "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
      nothingToLandNotice: { branch: "devpilot/review-only", base: "dev" },
      push: {
        pushedAt: "2026-07-19T09:40:00Z",
        conflictState: "clean",
        unpushedCount: 0,
        branch: "devpilot/review-only",
      },
      queue: { status: "landed", lastError: null, claimedAt: "2026-07-19T09:39:00Z" },
    });

    expect(state).toMatchObject({ kind: "nothing_to_land", hadBranch: true });
    expect(landingStateDetail(state)).toContain("devpilot/review-only");
    expect(landingStateDetail(state)).toContain("dev");
    expect(landingCardTreatment(state, "done")).toBe("info");
    // Never a warning: it was correctly Done.
    expect(landingCardTreatment(state, "done")).not.toBe("warn");
  });

  it("DevPilot-7 (pre-#137 rows): still derived as nothing to land with no notice", () => {
    // Historical rows carry no notice. The inference must keep covering them, or
    // the feature regresses on exactly the tickets that motivated it.
    const state = deriveLandingState({
      ...NONE,
      push: {
        pushedAt: null,
        conflictState: "clean",
        unpushedCount: 0,
        branch: "devpilot/review-only",
      },
    });
    expect(state).toMatchObject({ kind: "nothing_to_land", hadBranch: true });
    expect(landingCardTreatment(state, "done")).toBe("info");
  });

  it("DevPilot-3: spec-only ticket, no workspace at all — silent", () => {
    const state = deriveLandingState(NONE);
    expect(state).toMatchObject({ kind: "nothing_to_land", hadBranch: false });
    // The ~48 non-code roles all look like this. A chip on every one of them
    // would be the noise that makes the amber chip unreadable.
    expect(landingCardTreatment(state, "done")).toBe("none");
  });

  it("DevPilot-10/6/5/4/2: landed correctly — no chip, no warning", () => {
    const state = deriveLandingState({
      ...NONE,
      landedSha: "9f2c1ab7de4455aa10bb2233cc4455dd66778899",
      nothingToLandNotice: null,
    });
    expect(state).toMatchObject({ kind: "landed" });
    expect(landingCardTreatment(state, "done")).toBe("none");
    expect(landingStateDetail(state)).toContain("9f2c1ab7de44");
  });
});

describe("a healthy landed ticket never gets a warning treatment", () => {
  // The one regression that would make this feature worse than nothing: crying
  // wolf on the majority. A landed sha outranks EVERY other record, including
  // records that on their own would read as stranded.
  const hostile: Array<[string, LandingEvidence]> = [
    [
      "landed despite a stale conflict flag",
      {
        landedSha: "abc1234",
        nothingToLandNotice: null,
        push: { pushedAt: null, conflictState: "conflict", unpushedCount: 4, branch: "devpilot/x" },
        queue: { status: "failed", lastError: "boom", claimedAt: null },
      },
    ],
    [
      "landed despite an unclaimed queue row",
      {
        landedSha: "abc1234",
        nothingToLandNotice: null,
        push: null,
        queue: { status: "pending", lastError: null, claimedAt: null },
      },
    ],
    [
      "landed with unpushed commits still recorded",
      {
        landedSha: "abc1234",
        nothingToLandNotice: null,
        push: { pushedAt: null, conflictState: "clean", unpushedCount: 9, branch: "devpilot/x" },
        queue: null,
      },
    ],
  ];

  for (const [name, evidence] of hostile) {
    it(name, () => {
      const state = deriveLandingState(evidence);
      expect(state.kind).toBe("landed");
      for (const status of ["done", "failed", "in_progress"]) {
        expect(landingCardTreatment(state, status)).toBe("none");
      }
    });
  }
});

describe("a stranded ticket surfaces its REASON, not just its state", () => {
  const cases: Array<[string, LandingEvidence, string, string]> = [
    [
      "conflict",
      {
        ...NONE,
        push: { pushedAt: null, conflictState: "conflict", unpushedCount: 2, branch: "devpilot/a" },
      },
      "conflict_unresolved",
      "conflict",
    ],
    [
      "a branch that was never pushed and never enqueued",
      {
        ...NONE,
        push: { pushedAt: null, conflictState: "clean", unpushedCount: 6, branch: "devpilot/b" },
      },
      "never_pushed",
      "never reached the remote and was never queued to land",
    ],
    [
      "integration failed",
      { ...NONE, queue: { status: "failed", lastError: "merge blew up", claimedAt: null } },
      "integration_failed",
      "merge blew up",
    ],
    [
      "queued and never claimed",
      { ...NONE, queue: { status: "pending", lastError: null, claimedAt: null } },
      "queued_never_claimed",
      "no worker has ever claimed it",
    ],
    [
      "parked awaiting a merger ticket",
      {
        ...NONE,
        queue: { status: "awaiting_merge_resolution", lastError: null, claimedAt: "2026-07-19Z" },
      },
      "awaiting_merge_resolution",
      "merger ticket",
    ],
    [
      "pushed but never enqueued",
      {
        ...NONE,
        push: {
          pushedAt: "2026-07-19T09:00:00Z",
          conflictState: "clean",
          unpushedCount: 2,
          branch: "devpilot/c",
        },
      },
      "unrecorded",
      "never queued to land",
    ],
  ];

  for (const [name, evidence, reason, detailNeedle] of cases) {
    it(`${name} → ${reason}, with a detail that says why`, () => {
      const state = deriveLandingState(evidence);
      expect(state).toMatchObject({ kind: "not_landed", reason });
      expect(landingStateDetail(state)).toContain(detailNeedle);
      // The label alone must already narrow it down — the card shows the label
      // in bold and the detail beside it, and "Not landed" on its own is the
      // string that sent someone to the database.
      expect(landingStateLabel(state).length).toBeGreaterThan(0);
      expect(landingCardTreatment(state, "done")).toBe("warn");
    });
  }
});

describe("never_pushed says only what is known", () => {
  const evidence = {
    ...NONE,
    push: { pushedAt: null, conflictState: "clean", unpushedCount: 49, branch: "devpilot/b" },
  };

  // THE REGRESSION. This case rendered as "Not landed — push failed" /
  // "49 commits on devpilot/b never reached GitHub" for a branch on which no push
  // was ever attempted and which held one real commit. Both halves sent a reader
  // hunting for something that had not happened, so both are asserted as
  // ABSENCES — a test that only checked the new reason id would stay green
  // against the copy that caused the incident.
  it("never says a push failed or was rejected", () => {
    const state = deriveLandingState(evidence);
    const text = `${landingStateLabel(state)} ${landingStateDetail(state)}`.toLowerCase();
    expect(text).not.toContain("push failed");
    expect(text).not.toContain("rejected");
    expect(text).not.toContain("never reached github");
  });

  it("keeps the count but qualifies what it counts", () => {
    const detail = landingStateDetail(deriveLandingState(evidence));
    // Kept: it is the only quantity we hold, and a large one is worth a look.
    expect(detail).toContain("49 commits");
    // Qualified: `unpushed_count` falls back to every commit reachable from HEAD
    // when `origin/<branch>` is absent, and nothing records which arm ran.
    expect(detail).toMatch(/likely the whole branch/i);
  });

  it("names both facts it actually holds — unpushed AND unqueued", () => {
    const state = deriveLandingState(evidence);
    // The LABEL carries "never pushed"; the DETAIL carries the specifics without
    // repeating it, because the card draws `<label> · <detail>` and a stutter
    // there is what a reader notices instead of the reason.
    expect(landingStateLabel(state)).toContain("never pushed");
    const detail = (state as { detail: string }).detail;
    expect(detail).not.toContain("never pushed");
    expect(detail).toContain("never reached the remote");
    expect(detail).toContain("never queued to land");
    // …and renders as plain text: the card draws it directly, not as markdown.
    expect(detail).not.toContain("`");
  });

  it("still warns — this is a real stranding, only mislabelled before", () => {
    expect(landingCardTreatment(deriveLandingState(evidence), "done")).toBe("warn");
  });
});

describe("#137's notice outranks the sha (the third outcome survives)", () => {
  it("a landed sha alongside the notice still reads as nothing to land", () => {
    // The regression this pins: #137 stamps `landed_sha` for a nothing-to-land
    // ticket, so ordering the sha first would collapse three outcomes into two
    // and DevPilot-7 would render with no chip at all.
    const state = deriveLandingState({
      ...NONE,
      landedSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      nothingToLandNotice: { branch: "devpilot/qa-pass", base: "dev" },
    });
    expect(state.kind).toBe("nothing_to_land");
    expect(landingCardTreatment(state, "done")).toBe("info");
    expect(landingCardTreatment(state, "done")).not.toBe("none");
  });

  it("the notice outranks every stranded signal too — it is a proven outcome", () => {
    // The worker proved zero commits ahead BEFORE opening the PR. A stale
    // conflict flag or a leftover failed queue row cannot make that untrue, and
    // warning here would be crying wolf on a ticket that is genuinely fine.
    const state = deriveLandingState({
      landedSha: null,
      nothingToLandNotice: { branch: "devpilot/qa-pass", base: "dev" },
      push: { pushedAt: null, conflictState: "conflict", unpushedCount: 4, branch: "devpilot/x" },
      queue: { status: "failed", lastError: "old failure", claimedAt: null },
    });
    expect(state.kind).toBe("nothing_to_land");
    expect(landingCardTreatment(state, "done")).toBe("info");
  });

  it("degrades to a readable detail when the notice metadata is incomplete", () => {
    const state = deriveLandingState({
      ...NONE,
      nothingToLandNotice: { branch: null, base: null },
    });
    expect(state.kind).toBe("nothing_to_land");
    expect(landingStateDetail(state)).toContain("no commits to merge");
  });
});

describe("prefer the record over the inference", () => {
  it("a cancelled queue row is read as 'nothing to land', not recomputed", () => {
    // The land POLICY's own cancel ("ticket has no branch with work to land")
    // fires before any worker runs, so it writes no #137 notice and this path is
    // what covers it. Note the push row here has SIX unpushed commits —
    // inference alone would call this stranded. The record wins.
    const state = deriveLandingState({
      landedSha: null,
      nothingToLandNotice: null,
      push: { pushedAt: null, conflictState: "clean", unpushedCount: 6, branch: "devpilot/d" },
      queue: {
        status: "cancelled",
        lastError: "ticket has no branch with work to land",
        claimedAt: null,
      },
    });
    expect(state).toMatchObject({ kind: "nothing_to_land", hadBranch: true });
    expect(landingStateDetail(state)).toContain("no branch with work to land");
  });

  it("without a record, 'nothing to land' is inferred from zero commits ahead", () => {
    const state = deriveLandingState({
      ...NONE,
      push: { pushedAt: null, conflictState: "clean", unpushedCount: 0, branch: "devpilot/e" },
    });
    expect(state.kind).toBe("nothing_to_land");
  });
});

describe("the next unforeseen failure is visible, not silent", () => {
  it("an unrecognised queue status never reads as landed", () => {
    const state = deriveLandingState({
      ...NONE,
      queue: { status: "some_status_added_later", lastError: null, claimedAt: null },
    });
    expect(state).toMatchObject({ kind: "not_landed", reason: "unrecorded" });
    expect(landingStateDetail(state)).toContain("some_status_added_later");
    expect(landingCardTreatment(state, "done")).toBe("warn");
  });

  it("a queue row marked landed with no sha on the ticket is reported, not trusted", () => {
    // The silent half-land the crash-safe stamp exists to prevent. If it ever
    // occurs, the board must say so rather than render it as success.
    const state = deriveLandingState({
      ...NONE,
      queue: { status: "landed", lastError: null, claimedAt: "2026-07-19Z" },
    });
    expect(state).toMatchObject({ kind: "not_landed", reason: "unrecorded" });
    expect(landingStateDetail(state)).toContain("no landed commit");
  });
});

describe("landingCardTreatment — only settled tickets are judged", () => {
  const stranded = deriveLandingState({
    ...NONE,
    queue: { status: "failed", lastError: "x", claimedAt: null },
  });

  it("says nothing about a ticket that is still working", () => {
    for (const status of ["backlog", "ready", "assigned", "in_progress", "in_review", "blocked"]) {
      expect(landingCardTreatment(stranded, status)).toBe("none");
    }
  });

  it("warns on both settled statuses", () => {
    expect(landingCardTreatment(stranded, "done")).toBe("warn");
    expect(landingCardTreatment(stranded, "failed")).toBe("warn");
  });
});

describe("detail bounding", () => {
  it("truncates a runaway last_error rather than rendering it whole", () => {
    const state = deriveLandingState({
      ...NONE,
      queue: { status: "failed", lastError: "x".repeat(5_000), claimedAt: null },
    });
    expect(state.kind).toBe("not_landed");
    if (state.kind !== "not_landed") return;
    expect(state.detail.length).toBeLessThanOrEqual(240);
    expect(state.detail.endsWith("…")).toBe(true);
  });

  it("falls back to a real sentence when last_error is blank", () => {
    const state = deriveLandingState({
      ...NONE,
      queue: { status: "failed", lastError: "   ", claimedAt: null },
    });
    expect(landingStateDetail(state)).toContain("recorded a failure");
  });
});
