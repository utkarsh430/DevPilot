// WI-5 — the "landed on dev" readiness predicate. PURE (no IO): this is the
// decision core the blocker/readiness/drain paths share, and the only place the
// rule is written down.
//
// THE CHANGE WI-5 MAKES
// ─────────────────────
// Readiness used to ask "is the blocker `done`?". That is the wrong question.
// `done` means the agent finished and QA approved — it says nothing about where
// the code IS. Between "done" and "on dev" sits the land worker (WI-4), and a
// dependent started in that window branches off a dev tip that does NOT contain
// its parent's commits. It then re-implements them, or conflicts with them, or
// silently builds on a tree that never existed. The question readiness must ask
// is "is the blocker's work ON the integration branch?".
//
// WHY THIS ISN'T JUST `landed_sha IS NOT NULL`
// ────────────────────────────────────────────
// Most tickets never produce a branch. The ~48 non-code roles (PM, design,
// research, marketing…) go straight to done with nothing to land, and an
// auto-spawned merger ticket carries no branch of its own — it resolves the
// SOURCE ticket's branch, inside the source's workspace. None of them will ever
// have a landed_sha. Gating on `landed_sha IS NOT NULL` alone would wedge every
// dependent of every one of them, permanently.
//
// So the rule is: a blocker is CLOSED unless its work is still coming. Three
// signals, in order:
//
//   landed          → the sha is stamped. The work is on dev. CLOSED.
//   working         → not done yet. OPEN, and the dependent waits as it always did.
//   awaiting_land   → done, unlanded, and a live integration_queue row says a
//                     landing is still owed. OPEN — this is the new state, and
//                     the one the drain must DEFER on rather than drop.
//   (done, unlanded, nothing queued) → CLOSED. Nothing was ever owed.
//
// That last line is what keeps non-code tickets and mergers working, and it is
// also why a project with auto_land_enabled = false needs no special-casing
// anywhere: it never writes queue rows, so `open ⟺ not done` falls out on its
// own — byte-for-byte the legacy behaviour.
//
// SQL twin: `ticket_land_open(uuid)` in 20260715000000_integration_queue.sql,
// which the claim function's dependency gate uses. Keep the two in sync.

import type { TicketStatus } from "@/lib/board/state";

/** Queue states that mean "a landing is still owed for this ticket".
 *  `failed` is included deliberately: a land that failed means the work is NOT
 *  on dev, so a dependent must still not build on it. The operator sees the
 *  failure on the board and can either fix it or use the human override — that
 *  is strictly safer than silently letting dependents proceed onto a tree that
 *  is missing the parent's commits. `cancelled` is NOT included: it means the
 *  ticket turned out to be non-landable, i.e. nothing is owed. */
export const LAND_PENDING_QUEUE_STATES = [
  "pending",
  "landing",
  "awaiting_merge_resolution",
  "failed",
] as const;

export type LandPendingQueueState = (typeof LAND_PENDING_QUEUE_STATES)[number];

export type BlockerLandState = {
  status: TicketStatus;
  /** `tickets.landed_sha` — non-null iff the work is on the integration branch. */
  landedSha: string | null;
  /** True iff the ticket has an integration_queue row in a LAND_PENDING state. */
  landPending: boolean;
};

/**
 * `closed`        — the blocker no longer holds the dependent back.
 * `working`       — the blocker hasn't finished. The dependent waits (legacy).
 * `awaiting_land` — the blocker is done but its work isn't on dev yet. The
 *                   dependent waits, but this is a TRANSIENT wait with a known
 *                   resolver (the land worker), which is why the drain defers
 *                   on it instead of force-stucking, and why a human is allowed
 *                   to override it.
 */
export type BlockerOpenness = "closed" | "working" | "awaiting_land";

export function classifyBlocker(b: BlockerLandState): BlockerOpenness {
  if (b.landedSha !== null && b.landedSha !== undefined) return "closed";
  if (b.status !== "done") return "working";
  return b.landPending ? "awaiting_land" : "closed";
}

export function isBlockerOpen(b: BlockerLandState): boolean {
  return classifyBlocker(b) !== "closed";
}

export type BlockerSummary = {
  open: number;
  working: number;
  awaitingLand: number;
  /** True iff at least one blocker is open AND every open blocker is merely
   *  awaiting its landing. This is the state the drain DEFERS on (the parent is
   *  finished; a worker is on its way to land it) and the state a human may
   *  override — as opposed to a `working` blocker, where the upstream work
   *  genuinely isn't finished. */
  onlyAwaitingLand: boolean;
};

export function summarizeBlockers(blockers: readonly BlockerLandState[]): BlockerSummary {
  let working = 0;
  let awaitingLand = 0;
  for (const b of blockers) {
    const k = classifyBlocker(b);
    if (k === "working") working++;
    else if (k === "awaiting_land") awaitingLand++;
  }
  const open = working + awaitingLand;
  return { open, working, awaitingLand, onlyAwaitingLand: open > 0 && working === 0 };
}

/**
 * Can a HUMAN move this ticket into `ready` over these blockers?
 *
 * The `→ ready` guard is actor-agnostic today, and WI-5 tightening it would
 * otherwise silently take something AWAY from operators: a blocker that is done
 * has never blocked a human move, and after WI-5 a done-but-unlanded one would.
 * The operator can see on the board that the parent is finished; the landing is
 * an engine detail. So a human may override `awaiting_land` — and only that. A
 * `working` blocker still refuses, exactly as it does today, for humans and
 * agents alike.
 *
 * (Mirrors the QA gate's human short-circuit: a human is the override path, and
 * the gate exists to stop the ENGINE from doing something unsafe on its own.)
 */
export function humanMayOverride(summary: BlockerSummary): boolean {
  return summary.onlyAwaitingLand;
}

/**
 * Is `sha` something git can actually resolve to a commit?
 *
 * The migration backfills historical done tickets with the sentinel `backfill`
 * rather than inventing a sha it cannot know. Everything treats landed_sha as an
 * opaque "is it set" flag EXCEPT the builds_on re-root, which checks the child
 * out AT the parent's sha — and `git checkout -b child backfill` would simply
 * fail. A child of a backfilled parent roots at the integration TIP instead,
 * which for historical work is exactly right: the tip already contains it.
 */
export function isResolvableSha(sha: string | null | undefined): sha is string {
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha);
}
