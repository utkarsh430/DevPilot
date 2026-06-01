// The NEVER-TRIGGERED land — the decision core for rescuing a `pending`
// `integration_queue` row whose `integration/land-needed` event was lost.
// PURE (no IO), like its sibling `land-policy.ts`.
//
// ── THE GAP ────────────────────────────────────────────────────────────────
// Landing is EVENT-DRIVEN: `enqueueForLanding` inserts the row and emits
// `integration/land-needed`, and every land re-emits the next one. If that
// event is lost — the emit failed, the process died between the insert and the
// send, an earlier attempt errored in a way that never re-pumped — the row sits
// `pending` and NOTHING looks at it. `integrationQueueReaper` scans
// `landing` / `awaiting_merge_resolution` only: it recovers a land that STARTED
// and stalled, never one that never started. Observed in production: a correct,
// unblocked, auto-land-enabled row sat `pending attempts=1 claimed_at=null` for
// hours, and the only thing that moved it was a human pressing "Land now".
//
// The reaper did carry a blind cron floor ("for every project with a pending
// row, emit a pump") which this replaces. That floor was project-level: it
// could not tell a row enqueued three seconds ago from one stuck for six
// hours, could not back off, recorded nothing, and — the part that matters —
// could never give up, so a permanently-failing or permanently-unclaimable row
// stayed invisible forever. This is the same job done per ROW, with a grace, a
// backoff, a give-up, and a record.
//
// ── 1. NEVER-STARTED vs STARTED-BUT-SLOW (the double-land guard) ───────────
// The primary guard is NOT the grace period, and it would be dishonest to
// present it as one. It is structural, in three layers:
//
//   (a) `status = 'pending'` MEANS no worker holds this row. A claim is an
//       atomic `pending → landing` flip inside `integration_queue_claim_next`
//       (FOR UPDATE SKIP LOCKED). A row this sweep looks at is by definition
//       not in flight — an in-flight row is `landing`, which is the EXISTING
//       reaper's territory and is never touched here.
//   (b) The rescue's own write is a compare-and-set on `status = 'pending'`,
//       taken AFTER the read and BEFORE the emit. A row claimed in that window
//       loses the CAS and is not rescued at all.
//   (c) `landTicketFn` is `concurrency {limit: 1, key: projectId}`. Even a
//       redundant emit cannot produce a second CONCURRENT land — it queues
//       behind the live one and then claims at most one row, or no-ops.
//
// So what IS the grace for? Noise, not correctness: not re-emitting for a row
// whose original event is legitimately still in flight. And `projectLandInFlight`
// stands the sweep down entirely while the project's lane is busy, because that
// land will re-pump the queue itself when it finishes — the pump is not missing,
// it is pending.
//
// ── 2. RETRY STORMS (backoff + give-up) ────────────────────────────────────
// A land can fail identically forever: the `workflow`-scope push rejection is
// live in this operator's data and will be rejected the same way on every
// attempt. Two independent ceilings, and they cover DIFFERENT shapes:
//
//   • A row that IS claimed and fails is bounded by the EXISTING
//     `MAX_LAND_ATTEMPTS` — `attempts` is bumped by the claim and the worker
//     fails the row for good at the ceiling. This sweep does not duplicate,
//     re-implement or weaken that; it only spaces the retries out.
//   • A row that is NEVER claimed advances `attempts` not at all, so that
//     ceiling can never bind. That shape is bounded HERE, by the rescue count.
//
// Backoff is exponential in the rescue count (5m → 10 → 20 → 40 → 80 → 160,
// capped), measured from the row's own `updated_at`. It works without a new
// column because the rescue WRITES the marker onto `last_error`, which bumps
// `updated_at` through the table's existing trigger — the record and the clock
// are the same act.
//
// ── 3. NOT MASKING THE FAULT ───────────────────────────────────────────────
// A land that keeps needing rescue is a signal. Every rescue prepends a
// machine-parseable marker to `last_error` PRESERVING the original text (that
// text is the real diagnosis — the workflow-scope rejection — and overwriting
// it would destroy the one thing an operator needs), and logs. Give-up is a
// terminal `failed` whose `last_error` names the rescue count, which
// `deriveLandingState` already renders on the board card as
// "Not landed — land failed" with that detail. A pattern of rescues is
// therefore readable, and a row that has exhausted them stops being silent.
//
// Giving up is deliberately NOT reachable for a row the claim is legitimately
// skipping (a `builds_on` parent that has not landed yet). Failing those would
// break a stacked chain that is working exactly as designed — see
// `dependencyDeferred`.

/** Base grace before the FIRST rescue, and the unit the backoff doubles from.
 *  Matches the 5-minute cadence of the cron floor it replaces, so a row whose
 *  event was lost is recovered no more slowly than it used to be. */
export const LAND_RESCUE_BASE_GRACE_MS = 5 * 60_000;

/** Never wait longer than this between rescues, however many have happened. */
export const LAND_RESCUE_BACKOFF_CAP_MS = 3 * 60 * 60_000;

/** How many times one row may be re-emitted before we stop and fail it.
 *  With the doubling backoff this is ~5 hours of trying. */
export const LAND_RESCUE_MAX_RESCUES = 6;

/** `last_error` marker written by a rescue. Machine-parseable so the NEXT
 *  rescue can count without a new column, human-readable so an operator
 *  reading the row sees the history rather than a bare error. */
const MARKER_RE = /^\[land-rescue (\d+)\/(\d+) @ ([^\]\s]+)\]\s*/;

export type RescueRecord = {
  /** How many rescues this row has already had (0 when never rescued). */
  rescues: number;
  /** The `last_error` text underneath the marker — the REAL failure reason,
   *  preserved verbatim across every rescue. `null` when there was none. */
  original: string | null;
};

/** Read the rescue history off a queue row's `last_error`. */
export function parseRescueRecord(lastError: string | null | undefined): RescueRecord {
  if (!lastError) return { rescues: 0, original: null };
  const m = MARKER_RE.exec(lastError);
  if (!m) return { rescues: 0, original: lastError };
  const rescues = Number.parseInt(m[1] ?? "", 10);
  const tail = lastError.slice(m[0].length);
  return {
    rescues: Number.isInteger(rescues) && rescues >= 0 ? rescues : 0,
    original: tail.length > 0 ? tail : null,
  };
}

/** Render the marker for rescue number `rescues`, keeping `original` beneath it. */
export function renderRescueRecord(args: {
  rescues: number;
  maxRescues: number;
  nowIso: string;
  original: string | null;
}): string {
  const head = `[land-rescue ${args.rescues}/${args.maxRescues} @ ${args.nowIso}]`;
  const body = args.original
    ? args.original
    : "the land event was never picked up; re-emitted integration/land-needed";
  return `${head} ${body}`.slice(0, 2000);
}

/** How long to wait before the (rescues + 1)-th rescue. */
export function rescueBackoffMs(rescues: number, baseMs = LAND_RESCUE_BASE_GRACE_MS): number {
  const n = Number.isFinite(rescues) && rescues > 0 ? Math.floor(rescues) : 0;
  // Cap the exponent before shifting so a corrupt marker can't overflow.
  const exp = Math.min(n, 20);
  return Math.min(baseMs * 2 ** exp, LAND_RESCUE_BACKOFF_CAP_MS);
}

export type LandRescueInput = {
  /** The row's live status. Anything but `pending` is not ours. */
  status: string;
  /** now − max(updated_at, enqueued_at), in ms. */
  idleMs: number;
  /** Rescues already recorded on this row (from `parseRescueRecord`). */
  rescues: number;
  /** `integration_queue.attempts` — reported in the give-up reason, never
   *  gated on: the attempt ceiling belongs to the land worker. */
  attempts: number;
  /** Is another row in this project currently `landing`? */
  projectLandInFlight: boolean;
  /** Is the claim legitimately skipping this row because a blocking
   *  relation is not satisfied yet? Callers that cannot determine this must
   *  pass `true` — never give up on a row whose dependency state is unknown. */
  dependencyDeferred: boolean;
  baseGraceMs?: number;
  maxRescues?: number;
};

export type LandRescueDecision =
  /** Re-emit `integration/land-needed` and record the rescue. */
  | { action: "rescue"; reason: string; nextRescueCount: number }
  /** Out of rescues. Fail the row so it stops being silently pending. */
  | { action: "give_up"; reason: string }
  /** Leave it alone. */
  | { action: "skip"; reason: string };

/**
 * What to do with a `pending` queue row.
 *
 * The order is the design. Both "never damage" guards (not-pending, lane busy)
 * run first and unconditionally; `dependencyDeferred` runs before ANY clock so
 * a legitimately-waiting stacked child can neither be rescued pointlessly nor
 * ever be given up on; and the backoff is checked before the give-up so the
 * last rescue is given its full window rather than being failed one tick after
 * it was issued.
 */
export function decideLandRescue(input: LandRescueInput): LandRescueDecision {
  const maxRescues = input.maxRescues ?? LAND_RESCUE_MAX_RESCUES;
  const baseGraceMs = input.baseGraceMs ?? LAND_RESCUE_BASE_GRACE_MS;

  // (a) Not a pending row. `landing` / `awaiting_merge_resolution` are the
  //     EXISTING reaper's, and touching them here is exactly the double-land
  //     this sweep must not cause.
  if (input.status !== "pending") {
    return { action: "skip", reason: `not-pending:${input.status}` };
  }

  // (b) The project's single land lane is busy. That worker re-pumps the queue
  //     when it finishes, so the event is not missing — it is queued behind a
  //     land in progress.
  if (input.projectLandInFlight) {
    return { action: "skip", reason: "project-lane-busy" };
  }

  // (c) The claim is skipping this row on purpose: a `builds_on` parent has not
  //     landed, or a `blocked_by` gate is not done. Emitting would achieve
  //     nothing and giving up would fail a healthy stacked chain.
  if (input.dependencyDeferred) {
    return { action: "skip", reason: "dependency-deferred" };
  }

  const waitMs = rescueBackoffMs(input.rescues, baseGraceMs);
  if (input.idleMs < waitMs) {
    return { action: "skip", reason: `within-backoff:${Math.round(waitMs / 1000)}s` };
  }

  if (input.rescues >= maxRescues) {
    return {
      action: "give_up",
      reason:
        `land never started after ${input.rescues} re-emitted events ` +
        `(claim attempts: ${input.attempts}) — needs a human`,
    };
  }

  return {
    action: "rescue",
    reason: `pending and idle for ${Math.round(input.idleMs / 1000)}s with nothing in flight`,
    nextRescueCount: input.rescues + 1,
  };
}

// ── the dependency gate, mirrored ──────────────────────────────────────────

/**
 * The TS twin of `integration_queue_claim_next`'s dependency gate.
 *
 * The two relation types gate landing DIFFERENTLY and conflating them
 * deadlocks the queue (see the SQL function's comment):
 *
 *   • `builds_on`  — the child's branch was cut from the parent's, so the
 *                    parent's work must already be ON dev. Open iff
 *                    `ticket_land_open(parent)`.
 *   • `blocked_by` — a gate ticket. The auto-spawned merger is the load-bearing
 *                    case: the source is `blocked_by` its merger, and a merger
 *                    has no branch and can never land. Gate on DONE, not landed.
 *
 * This is only ever used to decide "is the claim skipping this row for a good
 * reason" — the claim itself remains the authority on what may actually land.
 */
export type BlockingRelation = {
  relationType: "blocked_by" | "builds_on";
  blockerStatus: string | null;
  blockerLandedSha: string | null;
  /** Does the blocker have an `integration_queue` row in a LAND_PENDING state? */
  blockerLandPending: boolean;
};

export function isDependencyDeferred(relations: readonly BlockingRelation[]): boolean {
  return relations.some((r) => {
    // A blocker we could not resolve is treated as open — the same
    // never-fail-open posture the readiness path takes.
    if (r.blockerStatus === null) return true;
    if (r.relationType === "blocked_by") return r.blockerStatus !== "done";
    // builds_on → ticket_land_open(parent)
    if (r.blockerLandedSha) return false;
    if (r.blockerStatus !== "done") return true;
    return r.blockerLandPending;
  });
}
