// WI-4 — the land worker's decision core. PURE (no IO), so the rules that make
// landing safe are unit-testable without an engine, a git remote, or a DB.
//
// Three decisions live here:
//
//   • decideLandable   — may this queue row be landed at all, or must it be
//                        cancelled?
//   • resolveLandedSha — what sha do we stamp? (The crash-safety hinge.)
//   • decideReap       — what does the reaper do with a row a worker may have
//                        died holding?

import type { TicketStatus } from "@/lib/board/state";

/**
 * THE serialization config for the land worker (`landTicketFn`).
 *
 * Lives here, in a pure module, so it can be asserted on: it is the single
 * property the whole design rests on, and it is otherwise buried in an Inngest
 * function definition that Vitest cannot even load.
 *
 *   limit: 1  — one land per project at a time. Two workers rebasing onto the
 *               same dev tip would each verify a tip the other is about to move.
 *   key       — the PROJECT. It must resolve to a non-null value: Inngest
 *               serializes per distinct key, and an `undefined` key silently
 *               serializes NOTHING. That is exactly why the land cadence is not
 *               driven off `agent/run.completed` (which carries no project at
 *               all) and why `integration_queue.project_id` is NOT NULL.
 *
 * The SQL claim (FOR UPDATE SKIP LOCKED) does NOT provide this: it is a
 * single-ROW claim, so concurrent callers get DIFFERENT rows and both proceed.
 */
export const LAND_SERIALIZATION = {
  limit: 1,
  key: "event.data.projectId",
} as const;

/**
 * Refuse to run a land whose event cannot be serialized. A missing projectId
 * would have already resolved the concurrency key to `undefined` by the time we
 * get here — meaning this invocation is running with NO mutual exclusion at all —
 * so the only safe thing to do is not land.
 */
export function assertSerializableLandEvent(data: {
  tenantId?: string | null;
  projectId?: string | null;
}): { tenantId: string; projectId: string } {
  if (!data.tenantId || !data.projectId) {
    throw new Error(
      "integration/land-needed requires a non-null tenantId + projectId: projectId is the " +
        "concurrency key that serializes landing, and an undefined key serializes nothing",
    );
  }
  return { tenantId: data.tenantId, projectId: data.projectId };
}

/** How many times a row may be claimed before we stop retrying it for good.
 *  A land that fails deterministically (a branch that no longer exists, a repo
 *  we lost access to) must not spin the pump forever. */
export const MAX_LAND_ATTEMPTS = 3;

/**
 * The `landed_sha` value the `integration_queue` migration
 * (`20260715000000_integration_queue.sql`) stamps on every ticket that was
 * ALREADY `done` when it ran, so those historical tickets never auto-enqueue.
 * It is deliberately NOT a resolvable object name (`isResolvableSha` rejects it),
 * and everything treats `landed_sha` as an opaque "is it set" flag — so a
 * backfilled ticket reads as "already landed" and `enqueueForLanding`
 * short-circuits on it forever. An EXPLICIT operator "Land now" is the one path
 * allowed to see through the sentinel (see `decideLandedShaGate`).
 */
export const LANDED_SHA_BACKFILL_SENTINEL = "backfill";

export type LandedShaGate =
  /** The ticket is genuinely landed (a real sha), or it carries the backfill
   *  sentinel and the caller is NOT the explicit operator path — treat as
   *  already landed and do not enqueue. */
  | { action: "already_landed" }
  /** The ticket carries ONLY the backfill sentinel and this is an explicit
   *  operator "Land now": the sentinel was never a real landing, so clear it and
   *  let the pipeline land the work for real (and stamp the true sha). */
  | { action: "clear_sentinel_and_land" }
  /** Nothing owed on `landed_sha` — proceed with the normal landability checks. */
  | { action: "proceed" };

/**
 * Decide what an enqueue attempt should do about the ticket's `landed_sha`.
 *
 * This is the sentinel-bypass rule, kept pure so it is unit-testable and so the
 * ONE property that matters is impossible to get wrong by accident: the bypass
 * fires for the backfill sentinel AND ONLY under `force` (the explicit operator
 * action). A genuinely-landed ticket (a real sha) is NEVER re-landed, force or
 * not — its work is already on the integration branch and merging it again is
 * meaningless. The auto path always calls with `force:false`, so it can never
 * resurrect a backfilled ticket; only "Land now" can.
 */
export function decideLandedShaGate(args: {
  landedSha: string | null;
  /** True ONLY for the explicit operator "Land now" action. */
  force: boolean;
}): LandedShaGate {
  if (!args.landedSha) return { action: "proceed" };
  if (args.landedSha === LANDED_SHA_BACKFILL_SENTINEL && args.force) {
    return { action: "clear_sentinel_and_land" };
  }
  return { action: "already_landed" };
}

/** A `landing` row whose heartbeat is older than this is presumed abandoned —
 *  its worker died mid-merge. Comfortably longer than a real land (clone +
 *  fetch + rebase + squash-merge), so we never reap a worker that is simply
 *  slow. */
export const LAND_HEARTBEAT_TIMEOUT_MS = 15 * 60_000;

// ─── landable ──────────────────────────────────────────────────────────────

export type LandableInput = {
  /** Live ticket status, or null when the ticket is gone. */
  status: TicketStatus | null;
  /** Does the ticket have a branch with work on it (a pending_pushes row)? */
  hasBranch: boolean;
  /** Is the ticket already landed? */
  landedSha: string | null;
  /** Project opt-in (`projects.auto_land_enabled`) AND the instance kill switch,
   *  pre-ANDed by the caller. */
  autoLandEnabled: boolean;
  /** Does the project have somewhere to land TO (github owner/repo +
   *  integration branch)? */
  hasIntegrationTarget: boolean;
};

export type LandableDecision =
  | { action: "land" }
  | { action: "cancel"; reason: string }
  /** Already on dev. Not an error — a duplicate enqueue, or a replay after a
   *  successful merge. The row is closed out as landed, nothing is merged twice. */
  | { action: "already_landed" };

/**
 * The LANDABLE predicate.
 *
 * Note what is NOT used here: the dispatcher's TERMINAL_TICKET_STATES. That set
 * CONTAINS `done` (lib/engine/dispatcher.ts) because from the dispatcher's point
 * of view a done ticket is finished and must not be dispatched again. Reusing it
 * here would cancel exactly the tickets we exist to land — a done ticket is the
 * ONLY kind we land. The two predicates look alike and mean opposite things.
 *
 * Landing requires the work to be FINISHED (`done` — QA approved, safety gate
 * passed) and to EXIST (a branch). A ticket that was reverted to `in_progress`
 * or parked to `blocked` after being enqueued has had its verdict withdrawn: its
 * row is cancelled, and it is re-enqueued from scratch if it reaches done again.
 */
export function decideLandable(input: LandableInput): LandableDecision {
  if (input.landedSha) return { action: "already_landed" };
  if (input.status === null) return { action: "cancel", reason: "ticket no longer exists" };
  if (!input.autoLandEnabled) {
    return { action: "cancel", reason: "auto-land is disabled for this project" };
  }
  if (!input.hasIntegrationTarget) {
    return {
      action: "cancel",
      reason: "project has no GitHub repo + integration branch to land onto",
    };
  }
  if (input.status !== "done") {
    return {
      action: "cancel",
      reason: `ticket is ${input.status}, not done — its verdict was withdrawn after it was enqueued`,
    };
  }
  if (!input.hasBranch) {
    return { action: "cancel", reason: "ticket has no branch with work to land" };
  }
  return { action: "land" };
}

// ─── the crash-safe stamp ──────────────────────────────────────────────────

export type MergeObservation =
  /** The merge API returned a sha. */
  | { kind: "merged"; sha: string }
  /** GitHub said there was nothing to merge (204 from /merges). On a REPLAY
   *  after a successful merge this is what a crashed worker comes back to. */
  | { kind: "already_up_to_date" }
  /** GitHub refused to open the pull request because the branch carries no
   *  commits the base lacks — the SAME outcome `decideLandAttempt` proves
   *  locally, observed after the fact when the local count was indeterminate.
   *
   *  It is deliberately NOT folded into `already_up_to_date`. That kind means
   *  "your commits are already on the base", which stamps a landing and reads on
   *  the board as `landed`; this one means "there were never any commits", which
   *  is the third outcome the board renders neutrally. Collapsing them would put
   *  a review-only ticket back to being indistinguishable from one that shipped
   *  code — the exact confusion this path exists to end. It never reaches
   *  `resolveLandedSha`; the worker closes it out before the stamp. */
  | { kind: "nothing_to_land"; reason: string };

export type StampResolution =
  | { ok: true; sha: string; alreadyUpToDate: boolean }
  | { ok: false; reason: string };

/**
 * Resolve the sha to stamp as `tickets.landed_sha`.
 *
 * THIS IS THE CRASH-SAFETY HINGE, so it is worth being explicit about the bug it
 * exists to prevent:
 *
 * The worker merges the branch, then crashes before it can stamp. Inngest
 * replays the step. GitHub, asked to merge an already-merged branch, correctly
 * answers "already up to date" — and returns NO SHA (204 No Content; see
 * mergeBranches in lib/github/client.ts). A worker that stamped the merge API's
 * return value would write landed_sha = NULL while marking the queue row
 * `landed`: a silent half-land. The work IS on dev, but nothing on the ticket
 * says so, the row is terminal so no reaper revisits it, and under WI-5 every
 * dependent of that ticket is wedged out of `ready` forever, with the board
 * cheerfully showing the parent as done.
 *
 * So: the sha ALWAYS comes from reading the dev ref, never from the merge
 * response. "Already up to date" is not an absence of a sha — it means the sha
 * is on the ref, go and read it. The merge response is only ever a cross-check.
 *
 * And if the ref cannot be resolved, we refuse to stamp at all: the row stays
 * claimed, the reaper picks it up, and it is reconciled against dev later. A
 * failed stamp must never be recorded as a landing.
 */
export function resolveLandedSha(args: {
  observation: MergeObservation;
  /** Sha of the integration branch, read back from the ref AFTER the merge. */
  devRefSha: string | null;
}): StampResolution {
  const { observation, devRefSha } = args;
  if (!devRefSha) {
    return {
      ok: false,
      reason:
        "could not resolve the integration branch ref after the merge — refusing to stamp a landing without a sha",
    };
  }
  return {
    ok: true,
    sha: devRefSha,
    alreadyUpToDate: observation.kind === "already_up_to_date",
  };
}

// ─── the reaper ────────────────────────────────────────────────────────────

export type ReapInput = {
  status: "landing" | "awaiting_merge_resolution";
  /** Age of `heartbeat_at` (coalesced with claimed_at / enqueued_at by the
   *  caller) in ms. */
  heartbeatAgeMs: number;
  attempts: number;
  /** Did the branch's work turn out to already BE on dev? (Resolved by
   *  comparing the branch against the integration branch.) */
  landedOnDev: boolean;
  /** For a parked row: the status of the merger ticket that owns the fix.
   *  null when there is no merger, or it has been deleted. */
  mergerStatus: TicketStatus | null;
  timeoutMs?: number;
  maxAttempts?: number;
};

export type ReapDecision =
  /** The branch is already on dev — a worker landed it and died before
   *  stamping. Reconcile forward: stamp the sha, close the row `landed`. */
  | { action: "stamp_landed"; reason: string }
  /** The worker died without landing. Hand the row back to the queue. */
  | { action: "requeue"; reason: string }
  /** Out of attempts. Stop retrying; the operator takes it from here. */
  | { action: "fail"; reason: string }
  /** Nothing to do: a worker is alive and holding it, or a merger is
   *  legitimately still working on it. */
  | { action: "leave"; reason: string };

/**
 * What to do with a row that is `landing` or `awaiting_merge_resolution`.
 *
 * RECONCILE BEFORE RE-LANDING — the whole point. A worker that merged and then
 * died looks exactly like a worker that died before merging, and re-running the
 * land on the first one would try to merge a branch GitHub has already merged.
 * So the reaper's FIRST question is always "is the work already on dev?", and
 * only if the answer is no does it hand the row back.
 *
 * `awaiting_merge_resolution` is NOT reaped on a timeout: it is legitimately
 * parked for as long as its merger ticket takes (which can be hours, and there
 * is no heartbeat behind it — nothing is holding the row). It is re-pended when
 * the merger reaches a terminal state, or when the conflict turns out to have
 * been resolved out-of-band (someone pushed a fix and it landed). Timing it out
 * would spawn a second merger on top of a live one.
 */
export function decideReap(input: ReapInput): ReapDecision {
  const timeoutMs = input.timeoutMs ?? LAND_HEARTBEAT_TIMEOUT_MS;
  const maxAttempts = input.maxAttempts ?? MAX_LAND_ATTEMPTS;

  // Reconcile first, for both statuses. A landed branch is landed no matter
  // which state the row is parked in or how fresh its heartbeat is.
  if (input.landedOnDev) {
    return {
      action: "stamp_landed",
      reason: "branch is already contained in the integration branch — reconciled forward",
    };
  }

  if (input.status === "awaiting_merge_resolution") {
    // Parked on a merger. Only a merger that has STOPPED releases the row.
    if (input.mergerStatus === null) {
      return { action: "requeue", reason: "merger ticket is gone — retrying the land" };
    }
    if (input.mergerStatus === "done") {
      return { action: "requeue", reason: "merger resolved the conflict — retrying the land" };
    }
    if (input.mergerStatus === "failed") {
      return { action: "fail", reason: "merger ticket failed — the conflict needs a human" };
    }
    return { action: "leave", reason: `merger is ${input.mergerStatus}` };
  }

  // status === 'landing'
  if (input.heartbeatAgeMs < timeoutMs) {
    return { action: "leave", reason: "a worker is still holding this row" };
  }
  if (input.attempts >= maxAttempts) {
    return {
      action: "fail",
      reason: `land failed ${input.attempts} times (ceiling ${maxAttempts}) — needs a human`,
    };
  }
  return { action: "requeue", reason: "worker died mid-land — returning the row to the queue" };
}
