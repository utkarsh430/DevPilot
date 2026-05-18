// Pure decision core for two landing-path outcomes that were previously either
// never recorded or recorded as a failure.
//
// ─── (1) A resolved conflict must be MARKED resolved ────────────────────────
//
// When a rebase onto the integration branch conflicts, the land worker parks the
// queue row on `awaiting_merge_resolution` and spawns a `release_engineer`
// merger ticket that resolves the conflict in the SOURCE workspace. The merger
// then moves itself to `done` — and until this module existed, that was the end
// of it: `pending_pushes.conflict_state` stayed `'conflict'` and
// `rebased_onto_sha` stayed NULL forever. `stampResolved` existed in
// `lib/engine/conflict-audit.ts` with a doc comment describing exactly this call
// and ZERO call sites. The operator's record therefore said "conflicted" about a
// branch that was six commits ahead of `dev` with a clean tree.
//
// HOW SUCCESS IS ESTABLISHED — and it is deliberately NOT the merger's own
// status. A merger agent can move itself to `done` while having resolved
// nothing (the incident's merger did precisely that: it said in its own thread
// that the push "can now be retried by the operator" and then closed itself).
// Trusting `status='done'` would clear the conflict flag on an abandoned merger,
// and the next land would push a branch nobody fixed — the failure direction
// that does real damage.
//
// So the two halves are split by what each can actually prove:
//
//   • MERGER DONE  ⇒ re-queue the parked push (`enqueueForLanding`'s merger
//                    redirect). Cheap, reversible, asserts nothing about the
//                    tree — the worst case is one wasted rebase attempt that
//                    re-parks.
//   • REBASE CLEAN ⇒ clear the conflict and record `rebased_onto_sha`. The
//                    rebase succeeding against the LIVE integration tip is
//                    direct evidence that no conflict remains; nothing weaker is
//                    accepted, and a rebase that conflicts again re-parks with
//                    the flag untouched.
//
// `decideConflictResolution` is that second rule, and it refuses on every
// uncertain input rather than clearing optimistically.
//
// ─── (2) "Nothing to land" is a SUCCESS, not a 422 ─────────────────────────
//
// A reviewing role (QA, verifier) legitimately finishes a ticket having changed
// no files, so its branch is zero commits ahead of the integration branch. The
// land worker opened a pull request anyway and GitHub answered
// `422 Validation Failed`, which was recorded on the queue row's `last_error`.
// A correct outcome reported as a broken one: it pollutes the failure record and
// makes a healthy ticket indistinguishable from a genuinely stranded one.
//
// `decideLandAttempt` moves that check BEFORE the pull request. Note the
// `null` posture: an INDETERMINATE commit count (no workspace on this host, a
// git error) is NEVER inferred to zero — it falls through to the pull request
// exactly as today, so the only behaviour that changes is the case we can prove.
// Same fail-open reasoning as `decideQaGate`'s `commitsAhead === null`.

/** Author id for the ticket-visible "nothing to land" notice. NEVER
 *  `devpilot_move_ticket` — the ticket reconciler string-matches that value to
 *  mean "an agent rendered a verdict", and borrowing it here would fake one. */
export const NOTHING_TO_LAND_AUTHOR_ID = "devpilot_nothing_to_land";

/** `comments.metadata.kind` for the notice. The metadata column is jsonb and
 *  deliberately open-ended (see `addComment`), so a consumer — notably the board
 *  card that renders landing state — can READ this outcome rather than
 *  recompute it, with no migration. */
export const NOTHING_TO_LAND_METADATA_KIND = "nothing_to_land";

/**
 * WHY the branch carried nothing to merge - two genuinely different facts that
 * must not be reported with the same sentence.
 *
 *   `no_commits`      the ticket changed no files at all (a review pass, a spec
 *                     ticket, one of the ~48 non-code roles).
 *   `already_on_base` the work SHIPPED, through a pull request merged outside
 *                     this pipeline. Measured live on `scoursh`: three done
 *                     tickets whose content was already on `dev` via squash
 *                     merges, which rewrite the commits and so leave the branch
 *                     looking unmerged forever. Telling that operator the ticket
 *                     "completed without changing any files" would be false.
 *   `merger_no_branch` an auto-spawned MERGER. It resolved its conflict in the
 *                     SOURCE ticket's workspace on the SOURCE ticket's branch,
 *                     so it never had a branch of its own and there was never
 *                     anything for it to land. Measured live on `scoursh`: 26 of
 *                     the 30 tickets reported as stranded were this. Its outcome
 *                     is recorded by `mergerOutcomeReaper`, not by the land
 *                     worker - a merger never reaches this file, which is
 *                     precisely why nothing wrote it down for so long.
 */
export type NothingToLandOutcome = "no_commits" | "already_on_base" | "merger_no_branch";

export type MergerReleaseDecision =
  | { action: "release_source"; sourceTicketId: string }
  | { action: "not_a_merger" }
  | { action: "hold"; reason: string };

/**
 * Should this ticket's completion release the SOURCE push it was spawned to fix?
 *
 * A merger is a `release_engineer` ticket carrying a `parent_ticket_id` — it has
 * no branch of its own and can never land, so what it completes is its parent's
 * landing, not its own.
 *
 * `done` is the ONLY status that releases. This is the cheap, reversible half of
 * establishing success (see the module header): re-queuing costs at most one
 * wasted rebase attempt that re-parks, whereas a merger that ends `failed`,
 * `blocked` or `cancelled` has demonstrably not fixed the conflict and must
 * leave the parked row exactly where it is for the reaper to fail out.
 */
export function decideMergerRelease(input: {
  requestedRole: string | null;
  parentTicketId: string | null;
  status: string | null;
}): MergerReleaseDecision {
  const isMerger = input.requestedRole === "release_engineer" && Boolean(input.parentTicketId);
  if (!isMerger) return { action: "not_a_merger" };
  if (input.status !== "done") {
    return { action: "hold", reason: `merger is ${input.status ?? "unknown"}, not done` };
  }
  return { action: "release_source", sourceTicketId: input.parentTicketId as string };
}

export type ConflictResolutionDecision =
  | { action: "resolve"; rebasedOntoSha: string }
  | { action: "leave"; reason: string };

/**
 * Should the source push's conflict flag be cleared?
 *
 * Only on PROOF: the rebase onto the live integration tip succeeded AND we hold
 * the resulting head sha to record. Every other input leaves the flag alone.
 */
export function decideConflictResolution(input: {
  /** Current `pending_pushes.conflict_state`. */
  conflictState: string | null;
  /** Did the rebase-and-push step succeed against the live integration tip? */
  rebaseSucceeded: boolean;
  /** HEAD after the rebase. `null` when the branch was landed from the remote
   *  with no workspace to inspect — indeterminate, so not proof. */
  headSha: string | null;
}): ConflictResolutionDecision {
  if (!input.rebaseSucceeded) {
    return { action: "leave", reason: "rebase-did-not-succeed" };
  }
  if (input.conflictState !== "conflict") {
    // Nothing to clear. `clean`/`rebased`/`resolved`/null are already truthful,
    // and overwriting them would erase what the manual push path recorded.
    return { action: "leave", reason: "no-conflict-recorded" };
  }
  const sha = (input.headSha ?? "").trim();
  if (sha.length === 0) {
    // Refuse rather than clear-without-evidence: `rebased_onto_sha` is the
    // operator's only trace of WHAT was replayed, and a resolved state with no
    // sha is the same silent half-record the landed_sha stamp exists to prevent.
    return { action: "leave", reason: "no-post-rebase-head-sha" };
  }
  return { action: "resolve", rebasedOntoSha: sha };
}

export type LandAttemptDecision =
  | { action: "open_pull_request" }
  | { action: "nothing_to_land"; reason: string };

/**
 * Is there anything on this branch to land?
 *
 * `commitsAhead === 0` is the only path to `nothing_to_land`. `null` means we
 * could not count (no usable workspace, git error) and falls through to the
 * pull request — an indeterminate count is never inferred to zero, because that
 * would silently skip a real landing.
 */
export function decideLandAttempt(input: { commitsAhead: number | null }): LandAttemptDecision {
  if (input.commitsAhead === 0) {
    return { action: "nothing_to_land", reason: "branch is zero commits ahead of the base" };
  }
  return { action: "open_pull_request" };
}

// ─── (3) The PR-creation 422 fallback, and why it never fired ──────────────
//
// `decideLandAttempt` above is the PRIMARY detection: count the commits locally
// and never spend the API call. The catch around `createPullRequest` is the
// FALLBACK for the cases that check cannot cover — an indeterminate count (no
// workspace on this host, a git error), or a branch that was landed by some
// other route between the count and the request.
//
// That fallback was written to match `/no commits between/i` against
// `GithubApiError.githubMessage`, and it could never match. GitHub's 422 for
// this case answers:
//
//   { "message": "Validation Failed",
//     "errors": [ { "resource": "PullRequest", "code": "custom",
//                   "message": "No commits between dev and devpilot/…" } ] }
//
// `githubMessage` is the TOP-LEVEL field, so it is the literal string
// "Validation Failed" — the reason lives one level down, in `errors[]`. The
// recorded evidence says exactly this: DevPilot-7's queue row carried
// `GitHub 422 on /repos/…/pulls: Validation Failed` and nothing else, having
// burned all three attempts on a request that could never succeed. The class of
// bug is worth naming: `throwFromResponse` already CAPTURES `errors[]` (the repo
// create path reads it for the same reason — "the top-level message is usually
// generic"), and the land path simply did not look there.
//
// So this classifier reads the whole error, and gives every OTHER 422 shape the
// `explainPushFailure` treatment: a validation 422 has its real reasons in
// `errors[]`, so surfacing "Validation Failed" alone tells an operator nothing
// they can act on.

/** The parts of a `GithubApiError` this classifier reads. Structural rather
 *  than the class itself, so the rule stays pure and Vitest-loadable — the
 *  worker cannot be imported under test (transitive `server-only`). */
export type GithubFailureShape = {
  status: number | null;
  /** Top-level `message`. For a validation failure this is generic. */
  githubMessage: string | null;
  /** `errors[]`. For a 422 this is where the actual reason lives. */
  githubErrors?: ReadonlyArray<{ message?: string; field?: string; code?: string }> | null;
  /** `Error.message` fallback for a non-GitHub throw. */
  fallbackMessage: string;
};

export type PullRequestFailure =
  /** GitHub refused because base and head are identical — the same outcome
   *  `decideLandAttempt` detects locally, observed after the fact. */
  | { kind: "nothing_to_land"; reason: string }
  /** Anything else. `explanation` is operator-readable text for `last_error`. */
  | { kind: "error"; explanation: string };

const NO_COMMITS_RE = /no commits between/i;

/** Every human-readable string GitHub gave us, most-specific first. */
function failureMessages(err: GithubFailureShape): string[] {
  const out: string[] = [];
  for (const e of err.githubErrors ?? []) {
    const m = (e?.message ?? "").trim();
    if (m) out.push(m);
  }
  const top = (err.githubMessage ?? "").trim();
  if (top) out.push(top);
  const fallback = (err.fallbackMessage ?? "").trim();
  if (fallback) out.push(fallback);
  return out;
}

/**
 * Classify a failed `createPullRequest`.
 *
 * "No commits between" is matched across `errors[]` AND the top-level message
 * AND the raw `Error.message` — because only the FIRST of those actually carries
 * it, and reading just one is the bug this replaces.
 *
 * Everything else is an error, but a 422's `errors[]` entries are promoted into
 * the explanation: `Validation Failed` on its own is not a cause an operator can
 * act on, which is precisely the standard `explainPushFailure` sets for push
 * stderr. A non-422 is passed through verbatim — the worker's existing message
 * already names the status and the path.
 */
export function classifyPullRequestFailure(err: GithubFailureShape): PullRequestFailure {
  const messages = failureMessages(err);
  const noCommits = messages.find((m) => NO_COMMITS_RE.test(m));
  if (noCommits) {
    return { kind: "nothing_to_land", reason: noCommits };
  }

  if (err.status === 422) {
    const details = (err.githubErrors ?? [])
      .map((e) => {
        const m = (e?.message ?? "").trim();
        if (m) return e?.field ? `${e.field}: ${m}` : m;
        // A coded entry with no prose still names the field and the rule; that
        // is more than "Validation Failed" says.
        return [e?.field, e?.code].filter(Boolean).join(": ");
      })
      .filter((s) => s.length > 0);
    const cause =
      details.length > 0 ? details.join("; ") : "GitHub gave no reason beyond `Validation Failed`.";
    return {
      kind: "error",
      explanation:
        `GitHub refused to open the pull request (422): ${cause}\n\n` +
        `A 422 here is a rejection of the request itself, not a transient ` +
        `fault - retrying the same branch and base will be refused the same way. ` +
        `Common causes: the head branch has no commits the base lacks, the base ` +
        `or head branch no longer exists on the remote, or a pull request for ` +
        `this branch already exists.\n\n${err.fallbackMessage}`,
    };
  }

  return { kind: "error", explanation: err.fallbackMessage };
}

/** Ticket-visible body for the "nothing to land" notice.
 *
 *  `branch` is nullable for `merger_no_branch` ONLY - having no branch is the
 *  whole reason that outcome exists. The two land-worker outcomes always pass
 *  one and are unaffected. */
export function buildNothingToLandComment(args: {
  branch: string | null;
  base: string;
  outcome: NothingToLandOutcome;
  /** `merger_no_branch` only: the source ticket this merger was spawned to fix,
   *  as the operator-facing `DevPilot-<N>` key when we have one. */
  sourceRef?: string | null;
}): string {
  if (args.outcome === "merger_no_branch") {
    const source = args.sourceRef?.trim() || "the ticket it was spawned from";
    return (
      `Nothing to land: this is a merge-conflict resolution ticket. It resolved the ` +
      `conflict in ${source}'s workspace, on ${source}'s branch - it never had a branch ` +
      `of its own, so there was never anything for it to merge into \`${args.base}\`.\n\n` +
      `This is a successful outcome, not a failure. The work went out with ${source}'s ` +
      `own landing, and the commit recorded against this ticket is that landing - not a ` +
      `separate merge of its own. DevPilot has recorded it so the board stops reporting ` +
      `this ticket as stranded, and so any ticket waiting on it is released.`
    );
  }
  if (args.outcome === "already_on_base") {
    return (
      `Nothing to land: every change on \`${args.branch}\` is already on \`${args.base}\`, ` +
      `so merging it would change nothing.\n\n` +
      `This is a successful outcome, not a failure - the work shipped, most likely through ` +
      `a pull request merged outside this pipeline (a squash merge rewrites the commits, ` +
      `which is why the branch still looks unmerged). DevPilot has recorded the landing so ` +
      `the board and any dependent tickets agree with the repository. No pull request was ` +
      `opened and nothing was force-pushed.`
    );
  }
  return (
    `Nothing to land: \`${args.branch}\` is zero commits ahead of \`${args.base}\`, ` +
    `so there is no work to merge.\n\n` +
    `This is a successful outcome, not a failure — the ticket completed without ` +
    `changing any files (a review pass, for example). No pull request was opened.`
  );
}

/** Structured payload for the notice — the readable record of this outcome. */
export function buildNothingToLandMetadata(args: {
  branch: string | null;
  base: string;
  outcome: NothingToLandOutcome;
  /** `merger_no_branch` only — see `buildNothingToLandComment`. */
  sourceTicketId?: string | null;
}): Record<string, unknown> {
  return {
    kind: NOTHING_TO_LAND_METADATA_KIND,
    branch: args.branch,
    base: args.base,
    commits_ahead: 0,
    ...(args.sourceTicketId ? { source_ticket_id: args.sourceTicketId } : {}),
    // ADDITIVE. `deriveLandingState` keys on `kind` alone and is unaffected;
    // this only lets a reader tell "produced nothing" from "already shipped",
    // which the board renders identically (both are neutral, both landed) but
    // which are entirely different facts about the ticket.
    outcome: args.outcome,
  };
}
