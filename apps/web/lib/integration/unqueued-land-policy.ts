// THE LANDING NOTHING WAS EVER ASKED FOR - the decision core for a `done`
// ticket that holds a branch, is not landed, and has NO `integration_queue` row
// at all. PURE (no IO), like its siblings `land-policy.ts` and
// `land-rescue-policy.ts`.
//
// ── THE GAP, and it is a hole in the RECOVERY LAYER, not in the queue ───────
// Landing is EVENT-driven from end to end. `enqueueForLanding` runs inline on
// the `→ done` seam and every pump after it is an `integration/land-needed`
// emit. Both halves can be lost, and one of them loses SILENTLY:
// `inngest.send` ends in a `fetch` with no timeout, and AGENTS.md records the
// consequence - a HANG IS NOT AN ERROR. It never rejects, so a surrounding
// `try/catch` never runs and every statement after the emit is simply never
// executed. During the ~6h Inngest wedge on 2026-08-03 the emits were swallowed
// AND every recovery cron was dead.
//
// What that left behind is a shape NO existing sweep can see:
//
//   `landRescueReaper`        scans `pending` rows                → a land that
//                                                                   never STARTED
//   `integrationQueueReaper`  scans `landing` /
//                             `awaiting_merge_resolution`         → a land that
//                                                                   started and STALLED
//
// Neither asks whether a done ticket has a queue row AT ALL. Measured live on
// project `scoursh` (2026-08-03): of 70 done tickets, 45 landed, 19 correctly
// produced no branch, and 6 were stranded - three of those (#69, #76, #77) with
// a real branch, real commits, `landed_sha IS NULL` and NO ROW IN THE QUEUE.
// Permanently invisible to the entire recovery layer.
//
// ── THE PRINCIPLE: RELEASE ON THE FACT, NOT THE EVENT ──────────────────────
// Copied deliberately from `dispatch-rescue-policy.ts`, which closed the same
// class one layer over: a `pending` `dispatch_queue` row was released by exactly
// one thing, the ARRIVAL of an event, and events are lossy. A ticket is owed a
// landing if the DATABASE says so - done, unlanded, holding a branch, in an
// auto-land project - regardless of whether any event ever arrived.
//
// ── EVERY CLAUSE IS LOAD-BEARING; the sharp one is `hasQueueRow` ────────────
// The selection rule is deliberately conservative, and the clause that does the
// most work is the one `enqueueForLanding` CANNOT provide for itself.
//
//   • `hasQueueRow` covers ANY status, including the TERMINAL ones. The partial
//     unique index on `integration_queue(ticket_id)` covers only
//     pending/landing/awaiting_merge_resolution, so an insert for a ticket
//     carrying a `failed` or `cancelled` row SUCCEEDS and mints a fresh pending
//     row. Without this clause the sweep would re-enqueue #42/#45 (`failed`,
//     `attempts=3`, push rejected non-fast-forward) every five minutes forever.
//     A `failed` row is a DECISION THAT WAS ALREADY REACHED; a `cancelled` row
//     means "nothing to land" and must stay that way. The operator's "Land now"
//     is the deliberate, human re-drive for those - see `landTicketNowAction`.
//     This sweep never auto-retries a verdict.
//
//   • `hasBranch` is what keeps the 19-ticket MAJORITY case out. Most tickets
//     produce no branch at all (the ~48 non-code roles, spec-only work, a
//     reviewer that read and changed nothing). Enqueueing those would put a
//     permanent stream of no-op lands through a worker that is serialized ONE
//     AT A TIME PER PROJECT - i.e. it would use up the project's only land lane
//     on work that does not exist. A test that only proves the three stranded
//     tickets get enqueued passes for an implementation that enqueues all 22, so
//     both directions are asserted.
//
//   • `autoLandEnabled` (project) and the instance kill switch mirror
//     `decideLandable` and are NOT bypassed. A sweep that lands for a project
//     which opted out is a sweep that ships code nobody asked it to ship.
//
//   • `landedSha` non-null stands the sweep down even for the `'backfill'`
//     SENTINEL. The sentinel is a guess an old migration recorded, not a
//     landing - but adjudicating it is exactly what `decideLandedShaGate`'s
//     `force` path exists for, and `force` is reachable only from the operator's
//     own "Land now". A cron must not make that call on 35 tickets' behalf.
//
//   • a MERGER (`release_engineer` + `parent_ticket_id`) stands down, because
//     `enqueueForLanding` would only redirect it to its SOURCE - and the source
//     is in this same scan, judged on its own facts. The rule is
//     `decideMergerRelease`, the seam's own, so the two cannot disagree about
//     which ticket a landing belongs to.
//
//   • `dependencyDeferred` - a `builds_on` child whose parent has not landed is
//     pending BY DESIGN (the SQL claim skips it). It is neither enqueued nor
//     failed here; the sweep runs every five minutes, so the tick after the
//     parent lands is the one that picks it up.
//
//   • the GRACE, measured from `tickets.updated_at`, is what keeps the sweep
//     from racing a ticket's OWN inline enqueue. It must exceed the cron period
//     - the same relationship `orphanTicketReaper`'s 30-minute grace has to the
//     stale-run threshold plus its cron - and a test pins it.
//
// ── WHAT IT DELIBERATELY IS NOT ────────────────────────────────────────────
// It is not a widening of either existing reaper. AGENTS.md records why the
// stuck-ticket sweep was NOT widened to cover the orphan reaper's cases: two
// crons with two policies acting on one row endanger each other. This is a
// SIBLING with a scope disjoint by construction - those two select ON a queue
// row, this one selects on the ABSENCE of one - and the disjointness is pinned
// by a source scan, exactly as `landRescueReaper` and `integrationQueueReaper`
// pin theirs.
//
// And it reimplements no enqueue. The action is `enqueueForLanding`, the one
// entry point, which owns the merger redirect, the 23505 collision handling and
// the pump. A second inserter is how the two paths drift.

/** How long a ticket must have sat `done` + unlanded before the sweep will look
 *  at it. Comfortably above the 5-minute cron period so a ticket whose own
 *  inline enqueue (or the async `pending_push.upserted` enqueue behind it) is
 *  still in flight is never raced. */
export const UNQUEUED_LAND_GRACE_SECONDS_DEFAULT = 15 * 60;

/** The cadence the cron actually runs at. Exported so the grace/period
 *  relationship is a TEST rather than a comment. */
export const UNQUEUED_LAND_CRON_PERIOD_SECONDS = 5 * 60;

export type UnqueuedLandCandidate = {
  ticketId: string;
  /**
   * Is this an auto-spawned MERGER (`release_engineer` + `parent_ticket_id`)?
   * A merger has no branch of its own and can never land - `enqueueForLanding`
   * redirects it to its SOURCE - so evaluating one here would call the seam
   * every tick to re-derive a redirect, and the source is in this same scan on
   * its own merits anyway. Decided by `decideMergerRelease`, never re-derived.
   */
  isMerger: boolean;
  /** Live ticket status. */
  status: string | null;
  /** `tickets.landed_sha`, including the `'backfill'` sentinel. */
  landedSha: string | null;
  /** `tickets.updated_at` - the grace anchor. */
  updatedAtIso: string | null;
  /** `projects.auto_land_enabled`. */
  autoLandEnabled: boolean;
  /** The instance kill switch (`DEVPILOT_AUTO_LAND_ENABLED`). */
  instanceAutoLandEnabled: boolean;
  /** Does an `integration_queue` row exist for this ticket in ANY status? */
  hasQueueRow: boolean;
  /** Does the ticket resolve to a `pending_pushes` row with a branch? */
  hasBranch: boolean;
  /**
   * Is a blocking relation legitimately holding the land back? Callers that
   * cannot determine this MUST pass `true` - never enqueue on an unknown.
   */
  dependencyDeferred: boolean;
};

export type UnqueuedLandDecision =
  /** Hand it to `enqueueForLanding`. */
  | { action: "enqueue"; reason: string }
  /** Leave it alone, with the clause that said so. */
  | { action: "none"; reason: string };

/**
 * Should this done-and-unlanded ticket be handed back to the land queue?
 *
 * The ORDER is the design. `hasQueueRow` is first and unconditional because it
 * is the anti-loop guard: everything below it assumes no decision about this
 * ticket's landing has already been recorded. The two opt-ins come next (a
 * project that opted out must not be measured, let alone acted on), then the
 * facts about the work itself, then - last - the clock, so a ticket that is
 * ineligible for a structural reason is reported by that reason rather than by
 * "too soon", which would read as "it will happen shortly" and be false.
 */
export function decideUnqueuedLandRescue(
  candidate: UnqueuedLandCandidate,
  nowIso: string,
  graceSeconds: number,
): UnqueuedLandDecision {
  // (a) A decision about this ticket's landing already exists - pending
  //     (landRescueReaper's), in flight (integrationQueueReaper's), or terminal
  //     (nobody's, deliberately: a human re-drives it).
  if (candidate.hasQueueRow) return { action: "none", reason: "already-queued" };

  // (a2) A merger is never the thing that lands. `enqueueForLanding` would
  //      redirect it to its source, so calling the seam for it every tick just
  //      re-derives a redirect - and the source is in this same scan, where it
  //      is judged on its own facts. A merger whose source is genuinely owed a
  //      landing therefore still gets one, via the source.
  if (candidate.isMerger) return { action: "none", reason: "merger-redirects-to-source" };

  // (b) The instance kill switch, then the project opt-in. Mirrors
  //     `decideLandable`; neither is bypassed.
  if (!candidate.instanceAutoLandEnabled) {
    return { action: "none", reason: "auto-land-kill-switch" };
  }
  if (!candidate.autoLandEnabled) {
    return { action: "none", reason: "auto-land-disabled-for-project" };
  }

  // (c) Only a `done` ticket has an approved verdict to land. A ticket parked to
  //     `blocked` or reverted to `in_progress` has had that verdict withdrawn.
  if (candidate.status !== "done") {
    return { action: "none", reason: `not-done:${candidate.status ?? "missing"}` };
  }

  // (d) Already landed - including the `'backfill'` sentinel, which only the
  //     operator's `force` path may adjudicate.
  if (candidate.landedSha) return { action: "none", reason: "already-landed" };

  // (e) THE MAJORITY CASE. No branch means there is genuinely nothing to land,
  //     and a serialized worker must not spend its project's only lane on it.
  if (!candidate.hasBranch) return { action: "none", reason: "no-branch" };

  // (f) A `builds_on` parent that has not landed yet. Deferred by design; the
  //     tick after the parent lands is the one that acts.
  if (candidate.dependencyDeferred) return { action: "none", reason: "dependency-deferred" };

  // (g) The clock, last. Unparseable timestamps fail CLOSED - a ticket whose
  //     idle time we cannot compute is never acted on.
  const idleMs = idleMsOf(candidate.updatedAtIso, nowIso);
  if (idleMs === null) return { action: "none", reason: "indeterminate-idle-time" };
  if (idleMs < graceSeconds * 1000) return { action: "none", reason: "within-grace" };

  return {
    action: "enqueue",
    reason:
      `done and unlanded for ${Math.round(idleMs / 1000)}s with a branch and ` +
      `no integration_queue row`,
  };
}

function idleMsOf(updatedAtIso: string | null, nowIso: string): number | null {
  if (!updatedAtIso) return null;
  const then = Date.parse(updatedAtIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  return Math.max(0, now - then);
}
