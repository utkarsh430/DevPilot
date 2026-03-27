// The NEVER-RELEASED dispatch — the decision core for a `dispatch_queue` row
// whose `agent/run.completed` never arrived. PURE (no IO), like its siblings
// `land-rescue-policy.ts` and `orphan-ticket-policy.ts`.
//
// ── THE INCIDENT (2026-08-03) ──────────────────────────────────────────────
// The board reported five tickets `in_progress` and refused every new dispatch
// with "Engineer agent at WIP limit (3/3). Queued; will release when a sibling
// run completes." At the same instant, `running` runs instance-wide: ZERO.
// Every one of those tickets' latest runs had ended `failed` or `cancelled`
// hours earlier. Tickets queued behind them waited seven hours. The board
// looked busy and was completely stopped.
//
// ── THE ROOT CAUSE: RELEASE IS EVENT-DERIVED, NEVER STATE-DERIVED ─────────
// This is NOT "WIP is counted from ticket status". `checkWipLimit`
// (`lib/engine/dispatcher.ts`) already counts `runs` — `agent_id = X AND
// tenant_id = T AND status IN (running, awaiting_human)` — and no capacity
// gate anywhere in the tree counts tickets. Verified by grep across
// `apps/web/lib` and `apps/web/app`: there is no `count` over `tickets` used
// for capacity.
//
// The defect is one layer over. A `pending` `dispatch_queue` row is released
// by EXACTLY ONE thing: `dispatchOnRunComplete`, which triggers on
// `agent/run.completed`. There is no cron over `dispatch_queue`, no timeout,
// no sweep, and nothing anywhere re-derives "does this agent have capacity
// right now" from the database. So the release condition is the ARRIVAL OF AN
// EVENT, and events are lossy:
//
//   (a) `runAgentFailed` (`run-agent.ts`) returns EARLY without emitting when
//       the run was already terminated — `if (statusWhenFired !== "running")
//       return { skipped: "externally-terminated" }`. Reachable from the run
//       loop's own automation-pause cancel (`check-cancel` flips the row to
//       `cancelled`, then throws `NonRetriableError`, which routes straight
//       into that early return) and from any manual/external termination.
//   (b) The Inngest dev server wedged and was restarted, dropping in-flight
//       events wholesale. That is what happened here.
//
// Once the event is gone the row is IMMORTAL, and — this is the part that
// turned a stall into a deadlock — it also DISARMS the one reaper that owns
// failed/cancelled strandings. `orphanTicketReaper`'s guard (b) stands down on
// a pending `dispatch_queue` row, reasoning "the WIP gate is holding this
// ticket and the drain will release it". That reasoning is correct only while
// something can still release it. It is why the reaper recovered some of the
// stranded tickets and not the ones holding queue rows.
//
// The cycle, all four edges provable from the code:
//
//     pending queue row  ──needs──▶  agent/run.completed
//             ▲                              │
//             │                            needs
//          blocks                            ▼
//             │                        a running run
//     a fresh dispatch  ◀──needs───────────┘
//
// ── THE FIX: RELEASE ON THE FACT, NOT ON THE EVENT ────────────────────────
// This sweep asks the question the event was standing in for — "is this agent
// actually below its WIP limit right now?" — directly of `runs`, and releases
// the queue when the answer is yes. A slot is therefore held by a LIVE RUN and
// nothing else. A lost completion becomes a bounded delay (one grace period)
// instead of a permanent deadlock.
//
// It is the same bug class, and the same shape of fix, as
// `land-rescue-policy.ts`: "landing is EVENT-DRIVEN, so a lost
// `integration/land-needed` leaves the row `pending` with nothing looking at
// it". Read that file's header if this one is unfamiliar.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
//   • It does not remove, raise or bypass the WIP limit. `decideDispatchRescue`
//     returns `none/at-capacity` whenever live runs already fill the cap, so an
//     agent that is genuinely busy is untouched. Unbounded concurrency is what
//     makes the engine time out under load; the limit is correct and the
//     accounting is what was wrong.
//   • It does not resolve, fail or re-run any ticket. It releases a QUEUE ROW,
//     which returns the ticket to the ordinary dispatch path — the dispatcher
//     then re-applies every gate (WIP, billing, automation pause, QA ceiling)
//     from scratch.
//   • It does not touch `awaiting_human`. A run parked on a human decision is a
//     legitimate multi-day wait and still holds its slot, exactly as before.

/** Run statuses that occupy a WIP slot. Must stay identical to the set
 *  `checkWipLimit` counts (`lib/engine/dispatcher.ts`) — this sweep exists to
 *  answer the SAME question that gate asks, so a divergence here would release
 *  a queue row the dispatcher then immediately re-blocks. */
export const WIP_OCCUPYING_RUN_STATUSES = ["running", "awaiting_human"] as const;

/**
 * How long a `pending` row must sit before we believe its release event is
 * never coming. 10 minutes.
 *
 * The window has to clear the legitimate reasons a row is briefly pending
 * while its release is genuinely in flight:
 *
 *   1. The ordinary case: a sibling run IS live and will complete. That is not
 *      a timing question at all — `decideDispatchRescue` stands down on
 *      capacity before it ever looks at the clock, so a busy agent is never
 *      rescued no matter how old its queue is.
 *   2. The completion→drain hop. `agent/run.completed` is emitted, Inngest
 *      delivers it, `dispatchOnRunComplete` claims a row. Seconds normally,
 *      minutes if the queue is backed up or a deploy is rolling.
 *   3. The stale-run reaper's own 15-minute threshold does NOT need clearing
 *      here, and that is deliberate. That reaper turns a wedged `running` run
 *      into a `failed` one AND emits the synthetic completion; while the run
 *      still reads `running` we stand down on capacity anyway (rule 1). We are
 *      only reachable once the slot is already provably free.
 *
 * 10 minutes is short enough that a lost completion costs one coffee rather
 * than a working day, and long enough that a healthy board never sees this
 * code run. Override with DEVPILOT_DISPATCH_RESCUE_GRACE_SECONDS.
 */
export const DISPATCH_RESCUE_GRACE_SECONDS_DEFAULT = 600;

/** Everything known about one (tenant, agent) pair that holds pending rows. */
export type DispatchQueueGroup = {
  tenantId: string;
  agentId: string;
  /** Live `agents.config.wip_limit`, re-read at sweep time (config may have
   *  been edited since the rows were enqueued). */
  wipLimit: number;
  /** Runs in `running` — actually executing. */
  runningRuns: number;
  /** Runs in `awaiting_human` — parked on a human, still holding a slot. */
  waitingRuns: number;
  /** How many rows are `pending` for this pair. */
  pendingRows: number;
  /** `enqueued_at` of the OLDEST pending row. The age clock. */
  oldestPendingIso: string;
};

export type DispatchRescueDecision =
  | { action: "none"; reason: string }
  | { action: "release"; slots: number; reason: string };

/** Runs occupying a slot right now — the number `checkWipLimit` would return. */
export function occupiedSlots(g: Pick<DispatchQueueGroup, "runningRuns" | "waitingRuns">): number {
  return g.runningRuns + g.waitingRuns;
}

/**
 * Should this (tenant, agent) pair have queue rows released, and how many?
 *
 * Order matters and is the safety story:
 *   1. CAPACITY FIRST, unconditionally. A pair whose live runs fill the cap is
 *      standing on a real WIP limit and is never rescued — this is the branch
 *      that keeps the fix from becoming "stop counting".
 *   2. Then the clock, so a row whose completion is legitimately still in
 *      flight is left alone.
 *
 * `slots` never exceeds the genuine free capacity, so a rescue cannot push an
 * agent over its limit even if every released ticket dispatches at once. The
 * dispatcher re-checks WIP itself and re-enqueues idempotently, so the release
 * is a nudge, never an override.
 */
export function decideDispatchRescue(
  g: DispatchQueueGroup,
  nowIso: string,
  graceSeconds: number,
): DispatchRescueDecision {
  if (g.pendingRows <= 0) return { action: "none", reason: "queue-empty" };

  // A non-positive or unparseable limit would make `slots` meaningless. Treat
  // it as "we cannot reason about capacity" and stand down — fail-closed, the
  // orphan reaper still owns the tickets.
  if (!Number.isFinite(g.wipLimit) || g.wipLimit <= 0) {
    return { action: "none", reason: "unusable-wip-limit" };
  }

  // ── 1. Capacity. The WIP limit still bites. ──────────────────────────────
  const occupied = occupiedSlots(g);
  const free = g.wipLimit - occupied;
  if (free <= 0) {
    return { action: "none", reason: `at-capacity:${occupied}/${g.wipLimit}` };
  }

  // ── 2. Grace. ────────────────────────────────────────────────────────────
  const ageMs = Date.parse(nowIso) - Date.parse(g.oldestPendingIso);
  if (!Number.isFinite(ageMs)) {
    // Unparseable timestamps: we do not know how long this has been queued, so
    // we do not act. Waiting is bounded; acting on an unknown is not.
    return { action: "none", reason: "indeterminate-queue-age" };
  }
  if (ageMs < graceSeconds * 1000) return { action: "none", reason: "within-grace" };

  return {
    action: "release",
    slots: Math.min(free, g.pendingRows),
    reason:
      `${g.pendingRows} row(s) pending since ${g.oldestPendingIso} while only ` +
      `${occupied}/${g.wipLimit} slots are occupied — the release event never arrived`,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The contradiction detector.
//
// "The board is at its WIP limit" and "nothing is running" are simultaneously
// true and jointly impossible. That state was trivially derivable from two
// counts the system already had, and it went unseen for six hours because
// nothing ever put the two numbers next to each other. The operator sees a full
// board and reasonably assumes progress.
//
// It is deliberately NARROW, because a detector that cannot tell a stall from
// ordinary work is noise, and noise gets ignored:
//
//   • `runningRuns > 0`  → SILENT. The board is working. This is the case the
//     brief calls out and the one that must never fire.
//   • `waitingRuns > 0`  → SILENT, and this is a real distinction rather than a
//     technicality. A run in `awaiting_human` is parked on a human decision, so
//     "queued behind it" is the system working as designed; the operator is the
//     blocker and telling him the engine is broken would be false. Reported
//     separately as `parked` so it is still visible without being an alarm.
//   • within grace       → SILENT. A queue row released seconds from now is a
//     race, not a contradiction.
//
// So it fires on exactly one state: rows have been queued longer than the
// grace, and NOTHING — running or parked — can ever release them.
// ───────────────────────────────────────────────────────────────────────────

export type DispatchStallSignal = {
  /** True only for the impossible state: queued past grace with zero live runs. */
  contradiction: boolean;
  /** True when the queue is held by runs parked on a human. Not an alarm. */
  parked: boolean;
  /** Pending rows across every (tenant, agent) pair in the contradiction. */
  stalledRows: number;
  /** Agents whose queue is stalled with nothing live. */
  stalledAgents: number;
  runningRuns: number;
  waitingRuns: number;
  /** Age of the oldest stalled row, in whole minutes. */
  oldestStalledMinutes: number;
};

export const NO_DISPATCH_STALL: DispatchStallSignal = {
  contradiction: false,
  parked: false,
  stalledRows: 0,
  stalledAgents: 0,
  runningRuns: 0,
  waitingRuns: 0,
  oldestStalledMinutes: 0,
};

/**
 * Fold every (tenant, agent) group into one operator-facing signal.
 *
 * A group contributes to the contradiction only when it is BOTH past grace AND
 * has nothing live. A tenant with one busy agent and one stalled agent is still
 * reporting a genuine stall — the stalled agent's queue really is unreleasable
 * — so the fold is per-GROUP, not "are any runs alive anywhere".
 */
export function detectDispatchStall(
  groups: readonly DispatchQueueGroup[],
  nowIso: string,
  graceSeconds: number,
): DispatchStallSignal {
  const now = Date.parse(nowIso);
  let stalledRows = 0;
  let stalledAgents = 0;
  let runningRuns = 0;
  let waitingRuns = 0;
  let parked = false;
  let oldestStalledMs = 0;

  for (const g of groups) {
    if (g.pendingRows <= 0) continue;
    runningRuns += g.runningRuns;
    waitingRuns += g.waitingRuns;

    const ageMs = now - Date.parse(g.oldestPendingIso);
    if (!Number.isFinite(ageMs) || ageMs < graceSeconds * 1000) continue;

    // Past grace. Who is holding the queue?
    if (g.runningRuns > 0) continue; // working — not a contradiction.
    if (g.waitingRuns > 0) {
      parked = true; // held by a human decision — visible, not an alarm.
      continue;
    }

    stalledAgents += 1;
    stalledRows += g.pendingRows;
    if (ageMs > oldestStalledMs) oldestStalledMs = ageMs;
  }

  return {
    contradiction: stalledAgents > 0,
    parked,
    stalledRows,
    stalledAgents,
    runningRuns,
    waitingRuns,
    oldestStalledMinutes: Math.floor(oldestStalledMs / 60_000),
  };
}

/**
 * The operator-facing sentence. Says what is true, what is impossible about it,
 * and what to do — "Board at WIP limit" with no explanation is what sent
 * somebody into the database by hand.
 */
export function describeDispatchStall(s: DispatchStallSignal): string {
  if (s.contradiction) {
    const rows = s.stalledRows === 1 ? "1 ticket is" : `${s.stalledRows} tickets are`;
    const agents = s.stalledAgents === 1 ? "1 agent" : `${s.stalledAgents} agents`;
    return (
      `${rows} queued behind ${agents} at the WIP limit, but nothing is running — ` +
      `oldest queued ${s.oldestStalledMinutes}m ago. Those tickets cannot be released ` +
      `by anything (the queue drains on run completion, and no run is live).`
    );
  }
  if (s.parked) {
    return `queue held by ${s.waitingRuns} run(s) awaiting a human`;
  }
  if (s.runningRuns > 0) return `${s.runningRuns} run(s) executing`;
  return "idle";
}
