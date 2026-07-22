// Settling a `pending_pushes` row whose branch was PROVABLY delivered to the
// remote, on a ticket that never landed anything.
//
// ─── the row this exists for ───────────────────────────────────────────────
//
// One row survived PR #156's repair (`20260749000000`) and keeps the /changes
// badge at 1:
//
//   ticket       DevPilot-7 "End-to-end QA pass: auth, CRUD, RLS isolation, …"
//   status       done
//   landed_sha   NULL          <- #156 requires this to be NON-null
//   branch       devpilot/end-to-end-qa-pass-…
//   pushed_at    NULL          <- counted by the badge, holds the reap guard
//
// #156 settles on the justification "the work is ON the integration branch, so
// nothing is owed to any remote", and reads that fact off `tickets.landed_sha`.
// This ticket has no `landed_sha` because nothing ever landed for it: it was a
// review-only QA pass that wrote no code. #156's rule is right and its predicate
// must NOT be loosened to sweep this row in — that predicate is what keeps a
// genuinely-unpushed branch out of scope, and `pushed_at` non-null releases the
// data-loss reap guard (`decideWorkspaceReap`).
//
// ─── the justification used here, and why it is NOT "there are no commits" ──
//
// The obvious argument is "the branch is level with `dev`, so there is nothing
// to push". It is TRUE and it is UNUSABLE: establishing it requires resolving a
// git ref, and SQL cannot do that — the same wall `20260745000000` hit when it
// settled to `cancelled` rather than inventing a `landed_sha`. Worse, this
// row's own `unpushed_count` is 8, because `getUnpushedCommits` falls back to
// every commit reachable from HEAD when `origin/<branch>` is absent. Emptiness
// is exactly the fact we cannot establish from the database.
//
// So the justification is a DIFFERENT one, and it is stronger:
//
//     THE BRANCH REACHED `origin`. `pushed_at` records that a push happened;
//     we can prove one did.
//
// It is stronger because it does not depend on the branch being empty. Even if
// those 8 commits are real, they are on `origin/<branch>` — so releasing the
// reap guard destroys nothing. The data-loss constraint is satisfied by
// DELIVERY, not by ABSENCE.
//
// ─── the proof, entirely from data already in the database ─────────────────
//
// `landOne` (`lib/engine/land-worker.ts`) is strictly ordered. `rebaseAndPush`
// runs at step 6, BEFORE any pull-request call at step 8, and only one of its
// outcomes continues:
//
//   kind "conflict" -> returns early, row parks on awaiting_merge_resolution
//   kind "error"    -> `throw new Error(prep.error)` — the catch in the handler
//                      writes that message VERBATIM to `last_error`
//   kind "ok"       -> falls through to `createPullRequest`
//
// `kind: "ok"` is reachable two ways, and the second is excluded by the very
// column being settled:
//
//   A. the workspace is unusable AND `args.pushedAt` is non-null — "already on
//      the remote, land it from there". Our row has `pushed_at IS NULL`, so
//      this branch cannot have been taken; with a null `pushedAt` the same
//      condition returns `kind: "error"` reading "workspace is unusable (…)
//      and the branch was never pushed".
//   B. a real workspace, where `git push --set-upstream origin <branch>`
//      RAN AND SUCCEEDED — any non-zero exit throws, and the outer catch
//      returns `kind: "error"`.
//
// Therefore: a `pending_pushes` row with `pushed_at IS NULL`, whose queue row
// records a failure raised at the PULL-REQUEST step, proves path B ran and the
// push succeeded. The branch is on `origin`. `pushed_at` stayed NULL only
// because the settle lived on the `stampLanded` paths and this row never
// reached one — which is precisely the leak this family of fixes is about.
//
// ─── reading "the failure came from the pull-request step" off the row ─────
//
// `20260745000000` already adjudicated exactly this population. It rewrote
// `last_error` to text beginning `nothing to land: ` and moved the row to
// `cancelled`, and it did so ONLY for rows satisfying, conjunctively:
//
//   status = 'failed'
//   last_error LIKE 'GitHub 422 on /repos/%/pulls: Validation Failed'
//   pr_number IS NULL
//   merge_sha IS NULL
//
// That `last_error` shape is written by `throwFromResponse` for a
// `POST /repos/…/pulls` — i.e. it is a POSITIONAL WITNESS that the worker was
// past `rebaseAndPush`. `pr_number IS NULL` and `merge_sha IS NULL` say nothing
// was opened and nothing was merged. So the current `nothing to land: ` prefix
// is a durable attestation that those four facts held, and no live code path
// writes that prefix — `land-policy` cancels with "ticket has no branch with
// work to land", and the live nothing-to-land path stamps a `landed_sha` and
// moves the queue row to `landed`, both excluded below.
//
// The one 422 shape that WOULD have been dangerous — "Field 'head' is invalid",
// i.e. the branch never reached the remote — is excluded by the same ordering
// argument: that outcome is unreachable, because a branch that failed to push
// throws at step 6 and never reaches the pull-request call at all.
//
// ─── why this is a migration and not a re-run of the real path ─────────────
//
// Re-running `closeNothingToLand` through `enqueueForLanding` would be the
// honest fix if it could run. It cannot, and the reason is in the data: the
// row's `workspace_path` is under the pre-rename `~/.ace/workspaces` root, so
// `checkWorkspaceAvailable` classifies it FOREIGN against today's
// `WORKSPACE_ROOT`; with `pushed_at IS NULL` that returns `kind: "error"` and
// the land fails again, this time on the workspace rather than the 422. It
// would also stamp a `landed_sha` and release `builds_on` dependents — a
// STRONGER claim than the evidence supports, and exactly the claim
// `20260745000000` deliberately declined to make from the outside.

/** The prefix `20260745000000` writes, and the only writer of it. */
export const NOTHING_TO_LAND_REPAIR_PREFIX = "nothing to land: ";

/**
 * The facts a candidate row carries, as they appear in the database. Every
 * field is read; nothing is inferred from a git ref, a filesystem path, or a
 * commit count.
 */
export type NothingToLandSettleInput = {
  /** `pending_pushes.pushed_at`. */
  pushedAt: string | null;
  /** `pending_pushes.ticket_id`. */
  ticketId: string | null;
  /** `pending_pushes.tenant_id`. */
  pushTenantId: string;
  /** `tickets.tenant_id` for `ticketId`. */
  ticketTenantId: string | null;
  /** `tickets.status`. */
  ticketStatus: string | null;
  /** `tickets.landed_sha`. */
  landedSha: string | null;
  /** `integration_queue.tenant_id` for the adjudicated row. */
  queueTenantId: string | null;
  /** `integration_queue.status`. */
  queueStatus: string | null;
  /** `integration_queue.pr_number`. */
  queuePrNumber: number | null;
  /** `integration_queue.last_error`. */
  queueLastError: string | null;
  /** `integration_queue.merge_sha`. */
  queueMergeSha: string | null;
  /** Count of OTHER `pending_pushes` rows for this ticket still unsettled. */
  otherUnsettledPushCount: number;
  /** Count of `integration_queue` rows for this ticket in a non-terminal
   *  status (`pending` / `landing` / `awaiting_merge_resolution`). */
  inFlightQueueCount: number;
};

export type NothingToLandSettleDecision =
  | { action: "settle" }
  | { action: "leave"; reason: string };

/**
 * Should this push row be settled on the delivery justification above?
 *
 * Refuses on every uncertain input. The failure direction is deliberate: a row
 * left unsettled keeps the badge at 1, which is trivially cheap; a row settled
 * without proof releases the reap guard on a workspace that may hold the only
 * copy of a commit, which is not recoverable.
 */
export function decideNothingToLandSettle(
  input: NothingToLandSettleInput,
): NothingToLandSettleDecision {
  if (input.pushedAt !== null) return { action: "leave", reason: "already-settled" };
  if (!input.ticketId) {
    // A ticket-less row has no ticket whose queue row could adjudicate it.
    return { action: "leave", reason: "no-ticket" };
  }

  // A row with no queue row at all is unadjudicated — reported as its own
  // reason rather than falling through to a tenant mismatch, which would be a
  // true refusal for a misleading stated cause.
  if (input.queueStatus === null && input.queueLastError === null) {
    return { action: "leave", reason: "no-queue-row" };
  }

  // Tenant scope. This is a service-role repair with RLS off, so these two
  // equalities are the entire boundary: the justification for settling OUR row
  // must come from OUR ticket and OUR queue row. A foreign verdict settling a
  // local row would mark another workspace's genuinely unpushed work as pushed.
  if (input.ticketTenantId !== input.pushTenantId) {
    return { action: "leave", reason: "ticket-tenant-mismatch" };
  }
  if (input.queueTenantId !== input.pushTenantId) {
    return { action: "leave", reason: "queue-tenant-mismatch" };
  }

  if (input.ticketStatus !== "done") return { action: "leave", reason: "ticket-not-done" };

  // NON-OVERLAP WITH #156 IS BY CONSTRUCTION, not by convention. A ticket with
  // ANY `landed_sha` — including the `'backfill'` sentinel, which records a
  // GUESS an earlier process made and which the operator has not adjudicated —
  // is out of scope here. `landed_sha IS NULL` is the exact complement of
  // `20260749000000`'s clause 3, so the two repairs can never both act on one
  // row and neither needs to know about the other's population.
  if (input.landedSha !== null) return { action: "leave", reason: "landed-sha-present" };

  // The adjudicated verdict, and the three facts it was itself derived from.
  // Re-asserted rather than trusted: they cost nothing to check and they are
  // what makes the 422 a PULL-REQUEST failure rather than something else.
  if (input.queueStatus !== "cancelled") return { action: "leave", reason: "queue-not-cancelled" };
  if (!(input.queueLastError ?? "").startsWith(NOTHING_TO_LAND_REPAIR_PREFIX)) {
    return { action: "leave", reason: "no-nothing-to-land-verdict" };
  }
  if (input.queuePrNumber !== null) return { action: "leave", reason: "pull-request-exists" };
  if (input.queueMergeSha !== null) return { action: "leave", reason: "merge-recorded" };

  // The verdict names a TICKET; the settle names a ROW. With two unsettled rows
  // on one ticket there is no way to tell which branch the worker resolved, so
  // both are left visible rather than one being settled on the other's evidence.
  if (input.otherUnsettledPushCount > 0) {
    return { action: "leave", reason: "ambiguous-push-rows" };
  }

  // A land still in flight will settle this row itself, with its own evidence,
  // through `stampLanded`. Settling it from underneath races that for no gain.
  if (input.inFlightQueueCount > 0) return { action: "leave", reason: "land-in-flight" };

  return { action: "settle" };
}
