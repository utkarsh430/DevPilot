// Landing VISIBILITY — the derived "where did this ticket's code actually end
// up?" state that the board renders beside the ticket's status. PURE (no IO).
//
// THE DEFECT THIS EXISTS FOR
// ──────────────────────────
// A ticket reaches Done when QA approves. Landing happens afterwards, in the
// integration worker, and it can fail in at least four independent ways — a
// rebase conflict nobody resolved, a push GitHub rejected, a land the worker
// recorded as failed, or a queue row that was enqueued and never claimed. Every
// one of those failures IS recorded: `pending_pushes.conflict_state`,
// `pending_pushes.pushed_at`, `integration_queue.status`, `.last_error`. On a
// real project five Done tickets sat with their commits stranded — three of
// them on branches that had never reached GitHub at all — and the operator
// found out by reading the database by hand. The system knew. The board did not
// say. That is what this module fixes, and it fixes it generally: an
// unrecognised failure still lands in `not_landed` with whatever the recorder
// wrote, rather than looking identical to success.
//
// NOT A NEW SOURCE OF TRUTH
// ─────────────────────────
// This reads records that already exist and reconciles them. It adds no column,
// no status and no writer. Deliberately: another place that can disagree with
// the existing ones is how this problem gets worse, not better.
// Everything here is a READ — this module observes, it never lands, retries or
// pushes anything.
//
// "NOTHING TO LAND" IS A HEALTHY OUTCOME, NOT A DEGRADED ONE
// ──────────────────────────────────────────────────────────
// Most tickets produce no commits: the ~48 non-code roles, spec-only work, a
// reviewer that read and approved without changing anything. Rendering those as
// a warning would train the operator to ignore the warning — which is exactly
// the failure mode we are trying to end. So `nothing_to_land` is its own kind
// with its own neutral treatment, distinct from BOTH landed and not-landed.
//
// PREFER THE RECORD OVER THE INFERENCE — AND THE RECORD NOW OUTRANKS THE SHA
// ─────────────────────────────────────────────────────────────────────────
// PR #137 made "nothing to land" an explicitly recorded SUCCESS: the land worker
// detects a zero-commits-ahead branch before opening the pull request and writes
// a system comment under its own author `devpilot_nothing_to_land` carrying
// `metadata.kind = 'nothing_to_land'`. Its module header names this board card
// as the intended consumer — read the outcome, do not recompute it.
//
// That record must outrank `landed_sha`, and the reason is subtle enough to be
// worth stating: #137 also STAMPS `landed_sha` in this case, deliberately, using
// the base tip — because everything downstream (`builds_on` re-root, dependent
// promotion) gates on LANDED, and a review-only ticket that never stamped one
// would wedge every dependent forever. So post-#137 the sha is present for BOTH
// outcomes and can no longer distinguish them. "This ticket's commits merged
// into dev" and "this ticket had no commits, so the base tip is vacuously its
// landing" are different facts about the work, and the operator asked for them
// to be visually distinct. Ordering the notice first is what keeps them so —
// without it, DevPilot-7 renders as `landed` and the third outcome disappears.
//
// The read requires ALL THREE of `author_type='system'`, the author id, and the
// metadata kind. That combination is unforgeable by an agent: the only
// agent-facing comment route (`/api/runners/tools/comment`) hardcodes
// `author_type: "agent"`, writes no metadata at all, and gates its author id
// through a role-slug regex. Requiring `system` is the load-bearing clause.
//
// The `cancelled` queue path below is retained and is NOT redundant: it covers
// the land POLICY's own "ticket has no branch with work to land" cancel, which
// happens before any worker runs and so writes no notice.
//
// EVERY REASON MUST NAME A FACT WE HOLD, NOT ONE WE INFER
// ──────────────────────────────────────────────────────
// A wrong reason is worse than no reason, because the reader acts on it. This
// module shipped with `push_rejected` ("Not landed — push failed") on a branch
// where no push had ever been ATTEMPTED, and with a commit count taken verbatim
// from a field whose two producing arms mean different things. Both sent a
// reader after failures that had not happened. When a name and the evidence
// disagree, rename the reason — see `never_pushed` and `describeNeverPushed`.

/** `integration_queue.status`. Mirrors the CHECK in 20260715000000. */
export type IntegrationQueueStatus =
  | "pending"
  | "landing"
  | "awaiting_merge_resolution"
  | "landed"
  | "failed"
  | "cancelled";

/** `pending_pushes.conflict_state`. Mirrors the CHECK in 20260607040000. */
export type PushConflictState = "clean" | "rebased" | "conflict" | "resolved";

/** The records this derivation reconciles. Every field is nullable because
 *  every one of them is legitimately absent for some ticket. */
export type LandingEvidence = {
  /** `tickets.landed_sha` — set iff the work is on the integration branch. */
  landedSha: string | null;
  /** The most recent `pending_pushes` row for the ticket, or null when the
   *  ticket never produced a workspace/branch at all. */
  push: {
    /** Non-null once the branch reached the remote. */
    pushedAt: string | null;
    conflictState: PushConflictState | string | null;
    /** Commits on the branch not yet on the remote. `0` with `pushedAt` null
     *  is the genuine "the branch has nothing on it" case. */
    unpushedCount: number | null;
    branch: string | null;
  } | null;
  /** The most recent `integration_queue` row, or null when the ticket was
   *  never enqueued (auto-land off, or no branch to land). */
  queue: {
    status: IntegrationQueueStatus | string;
    lastError: string | null;
    claimedAt: string | null;
  } | null;
  /** PR #137's explicit "nothing to land" record — the system comment under
   *  `devpilot_nothing_to_land` with `metadata.kind='nothing_to_land'`. Present
   *  iff the land worker proved the branch was zero commits ahead. Outranks
   *  `landedSha`, which #137 also stamps for this case (see the header). */
  nothingToLandNotice: { branch: string | null; base: string | null } | null;
};

/** Why a ticket's work is not on the integration branch. The whole value of
 *  this feature is in this field: "not landed" alone sends someone hunting. */
export type NotLandedReason =
  /** A rebase conflicted and nobody has resolved it. */
  | "conflict_unresolved"
  /**
   * The branch never reached GitHub AND was never enqueued to land.
   *
   * NAMED FOR WHAT IS KNOWN, WHICH THE OLD NAME WAS NOT. This was
   * `push_rejected`, rendered as "Not landed — push failed" — for a branch on
   * which no push was ever ATTEMPTED, let alone rejected. It sent a reader
   * hunting through queue rows and GitHub for a failure that had not happened.
   * The two facts we actually hold here are `pushed_at IS NULL` and "no
   * `integration_queue` row", and neither of them is a rejection. A genuine
   * push rejection is recorded elsewhere and reads as `integration_failed`
   * with the worker's own `last_error` (see `explainPushFailure`).
   */
  | "never_pushed"
  /** The land worker recorded a failure. `detail` carries its `last_error`. */
  | "integration_failed"
  /** A queue row was enqueued and no worker ever claimed it. */
  | "queued_never_claimed"
  /** Claimed, in flight right now. Transient and expected. */
  | "landing_in_progress"
  /** Parked: a merger ticket owns resolving the conflict. */
  | "awaiting_merge_resolution"
  /** The ticket carries commits and no landing record explains where they went. */
  | "unrecorded";

export type LandingState =
  | { kind: "landed"; sha: string }
  | { kind: "nothing_to_land"; detail: string; /** Was there ever a branch? */ hadBranch: boolean }
  | { kind: "not_landed"; reason: NotLandedReason; detail: string };

/** Queue statuses that mean the worker itself concluded nothing was owed.
 *  `cancelled` is the terminal non-failure state the land policy already writes
 *  (`decideLandable` → `{action:"cancel"}` for a ticket with no branch, or a
 *  verdict withdrawn after enqueue) — reached BEFORE any worker runs, so it
 *  writes no #137 notice and this path is what covers it. If the landing path
 *  grows another terminal non-failure status, add it here rather than
 *  inferring. */
const NOTHING_OWED_QUEUE_STATUSES = new Set<string>(["cancelled"]);

/**
 * Copy for `never_pushed` — and the count is QUALIFIED rather than asserted.
 *
 * `pending_pushes.unpushed_count` is written from `getUnpushedCommits`, which
 * has two arms and records WHICH ONE produced the number nowhere: normally it is
 * `git log origin/<branch>..HEAD`, but when `origin/<branch>` does not exist it
 * falls back to `git log HEAD` and counts EVERY commit reachable from the tip.
 * We reach this branch precisely because `pushed_at IS NULL` — i.e. DevPilot has
 * no record of this branch ever reaching the remote, which is the condition
 * under which the fallback fires — so the number in front of us is most likely
 * the whole branch and cannot be reported as "commits that never reached
 * GitHub". On the measured board that produced "49 commits never reached
 * GitHub" for a branch carrying one real commit.
 *
 * The count is kept because it is still the only quantity we have, and a branch
 * with a large one is still worth a look. It is just labelled as what it is.
 *
 * PLAIN TEXT, no backticks: `TicketCard` renders this detail directly into the
 * warn band (deliberately — a reason in a tooltip is a reason nobody reads), so
 * markdown punctuation would show up literally.
 *
 * It also does not repeat the label's own words. The card draws
 * `<label> · <detail>`, so "Not landed — never pushed · … was never pushed and …"
 * reads as a stutter; the label owns "never pushed" and this owns the specifics.
 */
function describeNeverPushed(branch: string | null, ahead: number): string {
  const commits = `${ahead} commit${ahead === 1 ? "" : "s"}`;
  const where = branch ?? "its branch";
  return (
    `${where} never reached the remote and was never queued to land — ${commits} on it, ` +
    `though with nothing to compare against that is likely the whole branch.`
  );
}

function trimDetail(s: string | null | undefined, fallback: string): string {
  const t = (s ?? "").trim();
  if (!t) return fallback;
  // The queue's `last_error` is operator-facing text written by the worker and
  // can be a whole GitHub response body. Bound it so a card/tooltip stays
  // readable; the full text is on the queue row for anyone who needs it.
  return t.length > 240 ? `${t.slice(0, 239)}…` : t;
}

/**
 * Reconcile the three records into one landing state.
 *
 * ORDER IS THE DESIGN. Each branch below answers a question the branch after it
 * cannot, so moving one changes which reason an operator is shown:
 *
 *  1. #137's nothing-to-land notice    → nothing_to_land. FIRST, because #137
 *     stamps `landed_sha` for this case too, so the sha can no longer tell the
 *     two apart and only the notice can. See the header.
 *  2. `landed_sha` set                 → landed. Otherwise the stamp is the
 *     truth; it is written only after the dev ref is read back.
 *  3. The queue said nothing was owed  → nothing_to_land. Record over inference.
 *  4. An unresolved conflict           → conflict_unresolved. Checked BEFORE the
 *     queue's own status because a conflicted branch is *why* its queue row is
 *     stuck; reporting "queued, never claimed" there would name the symptom and
 *     hide the cause.
 *  5. The queue's status               → the worker's own account of itself.
 *  6. The push record                  → covers a branch that never got enqueued.
 *  7. Nothing anywhere                 → nothing_to_land, no branch.
 */
export function deriveLandingState(evidence: LandingEvidence): LandingState {
  const { landedSha, push, queue, nothingToLandNotice } = evidence;

  // 1. #137's explicit record. Outranks the sha, which #137 also stamps here.
  if (nothingToLandNotice) {
    const { branch, base } = nothingToLandNotice;
    return {
      kind: "nothing_to_land",
      detail:
        branch && base
          ? `${branch} was zero commits ahead of ${base}`
          : "the land worker found no commits to merge",
      hadBranch: true,
    };
  }

  // 2. Landed.
  if (typeof landedSha === "string" && landedSha.trim() !== "") {
    return { kind: "landed", sha: landedSha };
  }

  // 3. The queue's own cancel record beats the inference.
  if (queue && NOTHING_OWED_QUEUE_STATUSES.has(queue.status)) {
    return {
      kind: "nothing_to_land",
      detail: trimDetail(queue.lastError, "the integration worker found nothing to land"),
      hadBranch: push !== null,
    };
  }

  // 4. An unresolved conflict is the cause; anything else would be the symptom.
  if (push && push.conflictState === "conflict") {
    return {
      kind: "not_landed",
      reason: "conflict_unresolved",
      detail: push.branch
        ? `merge conflict on ${push.branch} is unresolved`
        : "a merge conflict is unresolved",
    };
  }

  // 5. What the worker says about itself.
  if (queue) {
    switch (queue.status) {
      case "failed":
        return {
          kind: "not_landed",
          reason: "integration_failed",
          detail: trimDetail(queue.lastError, "the integration worker recorded a failure"),
        };
      case "awaiting_merge_resolution":
        return {
          kind: "not_landed",
          reason: "awaiting_merge_resolution",
          detail: trimDetail(
            queue.lastError,
            "parked: a merger ticket owns resolving this before it can land",
          ),
        };
      case "landing":
        return {
          kind: "not_landed",
          reason: "landing_in_progress",
          detail: "a worker is landing this now",
        };
      case "pending":
        return queue.claimedAt === null
          ? {
              kind: "not_landed",
              reason: "queued_never_claimed",
              detail: "queued to land, but no worker has ever claimed it",
            }
          : {
              kind: "not_landed",
              reason: "landing_in_progress",
              detail: "re-queued to land after an earlier attempt",
            };
      case "landed":
        // The queue says landed and the ticket carries no sha. That is the
        // half-land the crash-safe stamp exists to prevent, so if we ever see
        // it, say so rather than rendering it as success.
        return {
          kind: "not_landed",
          reason: "unrecorded",
          detail: "the queue records a landing but the ticket carries no landed commit",
        };
      default:
        // An unrecognised status must never read as landed. This is the branch
        // that makes the NEXT unforeseen failure visible instead of silent.
        return {
          kind: "not_landed",
          reason: "unrecorded",
          detail: trimDetail(queue.lastError, `integration queue status: ${queue.status}`),
        };
    }
  }

  // 6. A branch with commits that was never enqueued.
  if (push) {
    const ahead = push.unpushedCount ?? 0;
    if (push.pushedAt === null && ahead > 0) {
      return {
        kind: "not_landed",
        reason: "never_pushed",
        detail: describeNeverPushed(push.branch, ahead),
      };
    }
    if (ahead === 0) {
      return {
        kind: "nothing_to_land",
        detail: push.branch
          ? `${push.branch} has no commits ahead of the integration branch`
          : "no commits ahead of the integration branch",
        hadBranch: true,
      };
    }
    // Pushed, has commits, no queue row and no sha: the work is on GitHub but
    // nothing is on its way to land it.
    return {
      kind: "not_landed",
      reason: "unrecorded",
      detail: push.branch
        ? `${push.branch} is pushed but was never queued to land`
        : "the branch is pushed but was never queued to land",
    };
  }

  // 7. No branch, no queue, no sha — a spec-only or non-code ticket.
  return {
    kind: "nothing_to_land",
    detail: "this ticket produced no branch",
    hadBranch: false,
  };
}

// ─── what the board does with it ───────────────────────────────────────────

/**
 * How (and whether) a card should surface the landing state.
 *
 *   `warn`   — stranded work. Always surfaced; this is the whole point.
 *   `info`   — "nothing to land" on a ticket that DID have a branch. Neutral,
 *              never a warning: DevPilot-7 reviewed rather than changed and was
 *              correctly Done. Surfaced because a ticket that produced a branch
 *              and landed nothing is worth one line of explanation.
 *   `none`   — the boring majority: landed, or a ticket that never had a branch,
 *              or a ticket that has not finished yet.
 *
 * WHY NOT A BADGE ON EVERY CARD. A landed ticket needs no chip — Done already
 * says it, and a green badge on every healthy card is noise that makes the amber
 * one harder to see. Landing state is only meaningful once the work is finished,
 * so an in-flight ticket gets nothing either: it is not stranded, it is running.
 */
export type LandingCardTreatment = "warn" | "info" | "none";

/** Statuses where landing has had its chance to happen. Before this the ticket
 *  is still working and an unlanded branch is expected, not stranded. */
const SETTLED_STATUSES = new Set<string>(["done", "failed"]);

export function landingCardTreatment(
  state: LandingState,
  ticketStatus: string,
): LandingCardTreatment {
  if (!SETTLED_STATUSES.has(ticketStatus)) return "none";
  if (state.kind === "landed") return "none";
  if (state.kind === "nothing_to_land") return state.hadBranch ? "info" : "none";
  return "warn";
}

/** Short label for the card chip. The reason, not just the state. */
export function landingStateLabel(state: LandingState): string {
  switch (state.kind) {
    case "landed":
      return "Landed";
    case "nothing_to_land":
      return "Nothing to land";
    case "not_landed":
      return NOT_LANDED_LABELS[state.reason];
  }
}

const NOT_LANDED_LABELS: Record<NotLandedReason, string> = {
  conflict_unresolved: "Not landed — conflict",
  // NOT "push failed": nothing pushed, so nothing was rejected. See the
  // `never_pushed` doc comment on `NotLandedReason`.
  never_pushed: "Not landed — never pushed",
  integration_failed: "Not landed — land failed",
  queued_never_claimed: "Not landed — stuck in queue",
  landing_in_progress: "Landing…",
  awaiting_merge_resolution: "Not landed — awaiting merge",
  unrecorded: "Not landed",
};

/** Full sentence for the tooltip / drawer. Always carries the reason detail. */
export function landingStateDetail(state: LandingState): string {
  switch (state.kind) {
    case "landed":
      return `Landed on the integration branch as ${state.sha.slice(0, 12)}`;
    case "nothing_to_land":
      return `Nothing to land — ${state.detail}`;
    case "not_landed":
      return `${landingStateLabel(state)}: ${state.detail}`;
  }
}
