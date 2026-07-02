// THE LANDING A MERGER CAN NEVER GET - the decision core for a finished merger
// ticket that will sit `done` + `landed_sha IS NULL` forever. PURE (no IO), like
// its siblings `land-policy.ts`, `land-rescue-policy.ts` and
// `unqueued-land-policy.ts`.
//
// ── THE DEFECT: 26 OF 30 "STRANDED" TICKETS WERE BEHAVING AS DESIGNED ───────
// Measured on project `scoursh` (2026-08-04). Thirty tickets read `done` with
// their commits not on the integration branch. Exactly ONE (#42) was genuinely
// owed a landing. Three (#2, #14, #16) had no branch and were correctly done.
// The other TWENTY-SIX were auto-spawned MERGERS - "Resolve merge conflict: …" -
// and not one of them could ever land, by construction.
//
// A merger is a `release_engineer` ticket carrying a `parent_ticket_id`. It
// resolves its conflict IN THE SOURCE TICKET'S WORKSPACE, ON THE SOURCE
// TICKET'S BRANCH. It has no branch of its own, so there has never been
// anything for it to merge. `enqueueForLanding` encodes that correctly by
// redirecting a finished merger to its SOURCE, and `decideUnqueuedLandRescue`
// encodes it correctly by standing down:
//
//   if (candidate.isMerger) return { action: "none", reason: "merger-redirects-to-source" };
//
// BOTH OF THOSE ARE RIGHT AND NEITHER IS TOUCHED. Enqueueing a merger would be
// meaningless, and this module does not do it. The defect is narrower and
// entirely about the RECORD: nothing ever wrote down the outcome. So the merger
// sat at `done` + `landed_sha IS NULL` permanently, and every surface that asks
// "did this land?" answered no - indistinguishable from work that was genuinely
// lost. A list on which 26 of 30 entries are false is not a list anyone reads,
// which is how #42 went unnoticed.
//
// ── THE OUTCOME ALREADY EXISTS; MERGERS SIMPLY NEVER REACHED IT ─────────────
// `nothing_to_land` (PR #137) is the terminal state for exactly this shape: a
// ticket that finished correctly with nothing of its own to merge. It closes the
// ticket truthfully, stamps a sha so `builds_on` dependents are RELEASED rather
// than wedged behind a blocker that can never close, and renders NEUTRALLY on
// the board rather than as a warning. A merger is the same shape reached by a
// different route, so it gets the same outcome - a third
// `NothingToLandOutcome`, `merger_no_branch`, differing only in the sentence.
//
// ── WHICH SHA, AND THE ALTERNATIVE THAT WAS REJECTED ────────────────────────
// The rule is `closeNothingToLand`'s: a ticket with nothing of its own is
// recorded against a commit ON THE INTEGRATION BRANCH that vacuously contains
// its (empty) contribution. The claim is NOT "this ticket's commits are that
// sha" - it is "there is nothing of this ticket's outstanding, and here is the
// integration-branch commit it is settled against". The notice says so in words.
//
// The WITNESS chosen is the SOURCE TICKET'S OWN `landed_sha`, and the rejected
// alternative is the live integration tip that `closeNothingToLand` reads from
// GitHub. Three reasons, and the first is decisive:
//
//   (1) THE LIVE TIP IS ACTIVELY MISLEADING HERE. Closing a backlog of 26
//       mergers against it would stamp all 26 with the SAME sha - whatever dev
//       happens to be at today - a commit made long after every one of them
//       finished and related to none of them. The source's `landed_sha` gives
//       each merger the integration-branch commit its own resolution actually
//       shipped in. Same kind of claim, a witness that is not arbitrary.
//   (2) IT MAKES THE "SOURCE IS SETTLED" REQUIREMENT STRUCTURAL. A merger whose
//       source has not landed is still mid-flight and must not be closed. With
//       the source's sha AS the witness, there is nothing to stamp until the
//       source has settled - one guard, unfakeable, no clock and no second
//       opinion about what settled means.
//   (3) NO NETWORK IN A REPAIR CRON. `closeNothingToLand` runs inside `landOne`,
//       which has already resolved a project, an owner and a GitHub token. This
//       sweep has none of them, and a bookkeeping repair that fails closed on a
//       stale token would retry 26 tickets every five minutes forever.
//
// The `'backfill'` sentinel is REFUSED as a witness. AGENTS.md is explicit that
// it is a guess an old migration recorded rather than a landing; propagating it
// onto a second ticket would launder that guess into a fresh-looking record.
//
// ── DISJOINT FROM THE UNQUEUED SWEEP BY CONSTRUCTION ────────────────────────
// Both scan `done` + unlanded tickets, so the ROWS overlap - but the ACTIONS
// cannot. `decideUnqueuedLandRescue` returns `none` for every merger,
// unconditionally, as its second clause; `decideMergerOutcome` returns `none`
// for every non-merger, unconditionally, as its first. Both derive `isMerger`
// from the SAME `decideMergerRelease`, so the two can never disagree about what
// a merger is. That is a stronger guarantee than the "two crons must not touch
// one row" convention AGENTS.md warns about, and it is pinned by a test in both
// directions rather than argued.

/** How long a merger must have sat `done` before the sweep will close it.
 *  The source having settled is the real gate; this only keeps the sweep from
 *  acting on a ticket that changed a moment ago. */
export const MERGER_OUTCOME_GRACE_SECONDS_DEFAULT = 15 * 60;

/** The cadence the cron runs at. Exported so the grace/period relationship is a
 *  TEST rather than a comment, exactly as the sibling sweeps do it. */
export const MERGER_OUTCOME_CRON_PERIOD_SECONDS = 5 * 60;

/** `tickets.landed_sha` value written by migration `20260715000000` §6 for
 *  tickets whose real landing sha was unknowable retroactively. It names no
 *  commit, so it can never be a witness. Duplicated from `land-policy.ts` rather
 *  than imported because that module reaches the queue's server-only surface;
 *  a test pins the two to the same string. */
export const LANDED_SHA_BACKFILL_SENTINEL = "backfill";

export type MergerOutcomeCandidate = {
  ticketId: string;
  /**
   * Is this an auto-spawned merger? Taken from `decideMergerRelease` - the
   * seam's OWN rule - never re-derived, so this sweep and `enqueueForLanding`
   * cannot disagree about which tickets are mergers.
   */
  isMerger: boolean;
  /** `tickets.parent_ticket_id` - the SOURCE whose conflict this resolved. */
  sourceTicketId: string | null;
  /** The merger's own status. */
  status: string | null;
  /** The merger's own `landed_sha`. Non-null means already closed. */
  landedSha: string | null;
  /** `tickets.updated_at` - the grace anchor. */
  updatedAtIso: string | null;
  /** `projects.auto_land_enabled`. Mirrors `decideLandable`; not bypassed. */
  autoLandEnabled: boolean;
  /** The instance kill switch (`DEVPILOT_AUTO_LAND_ENABLED`). */
  instanceAutoLandEnabled: boolean;
  /**
   * Does an `integration_queue` row exist for the MERGER in any status?
   * Callers that cannot determine this MUST pass `true`: a row means some other
   * part of the landing layer owns this ticket, and stamping underneath it is
   * the two-writer problem.
   */
  hasQueueRow: boolean;
  /**
   * The SOURCE ticket's `landed_sha`. This is both the settledness gate and the
   * witness that gets stamped - see the header. `null` means the source's
   * landing has not concluded and the merger is still mid-flight.
   */
  sourceLandedSha: string | null;
};

export type MergerOutcomeDecision =
  /** Record the terminal `nothing_to_land` outcome against `sha`. */
  | { action: "close"; sha: string; reason: string }
  /** Leave it alone, with the clause that said so. */
  | { action: "none"; reason: string };

/**
 * Has this merger's work concluded, such that its landing outcome can be
 * recorded?
 *
 * ORDER IS THE DESIGN. `isMerger` is first and unconditional - it is what makes
 * this sweep's action scope disjoint from the unqueued sweep's, and putting any
 * clause above it would make that a matter of reading the code rather than a
 * property of it. The two opt-ins follow (a project that opted out of the
 * landing pipeline must not have its tickets stamped by it), then the facts
 * about the merger, then the source, then - last - the clock, so a ticket that
 * is ineligible for a structural reason is reported by that reason rather than
 * by "too soon", which would read as "it will happen shortly" and be false.
 */
export function decideMergerOutcome(
  candidate: MergerOutcomeCandidate,
  nowIso: string,
  graceSeconds: number,
): MergerOutcomeDecision {
  // (a) THE DISJOINTNESS CLAUSE. A non-merger is the unqueued sweep's business,
  //     and this sweep must be provably incapable of touching one.
  if (!candidate.isMerger) return { action: "none", reason: "not-a-merger" };

  // (b) The instance kill switch, then the project opt-in. A merger only exists
  //     because the land worker spawned it, so a project with auto-land off has
  //     none - but stamping `landed_sha` releases dependents, and doing that in
  //     a project that opted out of the landing pipeline is not this sweep's
  //     call to make.
  if (!candidate.instanceAutoLandEnabled) {
    return { action: "none", reason: "auto-land-kill-switch" };
  }
  if (!candidate.autoLandEnabled) {
    return { action: "none", reason: "auto-land-disabled-for-project" };
  }

  // (c) Only a FINISHED merger has an outcome. One still working, parked, or
  //     failed may yet resolve its conflict - or be replaced - and recording a
  //     terminal outcome over it would close a ticket that is still in play.
  if (candidate.status !== "done") {
    return { action: "none", reason: `merger-not-done:${candidate.status ?? "missing"}` };
  }

  // (d) Idempotency. Nothing to do, and re-stamping would fight whoever won.
  if (candidate.landedSha) return { action: "none", reason: "already-closed" };

  // (e) A queue row means the landing layer already owns this ticket - the
  //     rescue sweep, the in-flight reaper, or a terminal decision somebody
  //     already reached. Fail closed; this sweep exists for the tickets with no
  //     row at all.
  if (candidate.hasQueueRow) return { action: "none", reason: "has-queue-row" };

  // (f) A merger with no parent is not something this sweep can reason about:
  //     the source is where the outcome comes from. Unreachable while `isMerger`
  //     is derived from `decideMergerRelease` (which requires a parent), and
  //     checked anyway because the witness below depends on it.
  if (!candidate.sourceTicketId) return { action: "none", reason: "no-source-ticket" };

  // (g) THE SETTLEDNESS GATE AND THE WITNESS, IN ONE. A merger whose source has
  //     not landed is still mid-flight: its fix may yet be re-attempted, or a
  //     second merger spawned. With the source's sha as the witness there is
  //     simply nothing to stamp until then.
  const sourceSha = (candidate.sourceLandedSha ?? "").trim();
  if (sourceSha.length === 0) {
    return { action: "none", reason: "source-not-settled" };
  }
  // The sentinel names no commit. Refuse rather than launder a migration's guess
  // into a second, fresher-looking record.
  if (sourceSha === LANDED_SHA_BACKFILL_SENTINEL) {
    return { action: "none", reason: "source-landing-unproven" };
  }

  // (h) The clock, last. Unparseable timestamps fail CLOSED.
  const idleMs = idleMsOf(candidate.updatedAtIso, nowIso);
  if (idleMs === null) return { action: "none", reason: "indeterminate-idle-time" };
  if (idleMs < graceSeconds * 1000) return { action: "none", reason: "within-grace" };

  return {
    action: "close",
    sha: sourceSha,
    reason: `merger finished and its source landed as ${sourceSha.slice(0, 12)}`,
  };
}

function idleMsOf(updatedAtIso: string | null, nowIso: string): number | null {
  if (!updatedAtIso) return null;
  const then = Date.parse(updatedAtIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  return Math.max(0, now - then);
}
