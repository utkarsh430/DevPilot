// A landed ticket whose `pending_pushes` row was never settled: the decision
// core. PURE (no IO), like its siblings `land-rescue-policy.ts` and
// `unqueued-land-policy.ts`.
//
// ── WHY THIS EXISTS WHEN AGENTS.md REFUSED A SWEEPER ───────────────────────
// PR #156 closed the settle-on-landing hole by moving the write into
// `stampLanded` and making `pendingPushId` a REQUIRED argument, and its header
// says outright why it is not a reaper:
//
//     "The fix is not a sweeper. A reaper over `pending_pushes` would have
//      hidden exactly this, and the stale rows were the only visible evidence
//      the write path was incomplete."
//
// That reasoning is CORRECT and is not overturned here. A sweeper that silently
// tidies is strictly worse than the stale badge, because the badge is the only
// thing that ever told anybody the write path had a gap.
//
// But "never sweep" is wrong too, and the same board proves it: eleven stale
// rows accumulated, and every one of them needed a human to notice. On
// 2026-08-04 two more routes were found that land work without settling its row
// - a landing that arrived via a hand-merged rescue pull request, and PR #191's
// merger-landing path. Work lands by routes nobody designed for, and the
// required-argument guard can only bind the paths that call `stampLanded`.
//
// The supervisor already resolved this exact tension for a different symptom.
// From `supervisor-policy.ts`:
//
//     "An operator hand-swept this board ~six times in one day; every sweep
//      worked and every sweep hid a WIP-slot leak, which stayed invisible for
//      hours precisely because its symptoms kept being cleared."
//
// Its answer was not to stop sweeping. It was to record every fix in
// `supervisor_actions` WITH ITS CAUSE and escalate repeats as a suspected
// defect. So this repairs the state AND files an indictment. A sweep that
// leaves no trace is the thing #156 refused; a sweep that accuses is the thing
// the supervisor was built to be.
//
// ── IT IS A BACKSTOP, AND THAT IS THE WHOLE POINT ─────────────────────────
// Migration `20260757000000` moved the settle into the DATABASE: a trigger on
// `tickets` settles the ticket's rows whenever `landed_sha` goes NULL ->
// non-NULL. So this repair firing AT ALL is now the defect signal - it means
// work reached a state that trigger should have made unrepresentable, i.e. by a
// route that does not stamp `landed_sha` on that transition at all. That is
// precisely why it must indict rather than tidy: a backstop that stays quiet is
// a backstop nobody can tell is being used.
//
// It is NARROWER than the trigger, deliberately and for that migration's own
// stated reason. The trigger fires ON the landing, so it can honestly claim the
// whole ticket's rows; a sweep arriving later holds weaker evidence and settles
// only the row `resolveTicketPush` names. Two mechanisms with different scopes
// is not a disagreement - it is each claiming exactly what its evidence
// supports.
//
// ── THE SAFETY CONSTRAINT IS DATA-LOSS, NOT TIDINESS ──────────────────────
// `pushed_at` non-null RELEASES the unpushed-work reap guard
// (`decideWorkspaceReap`, and the runner's own `checkWorkspaceReapSafety`), so
// settling a row whose commits are not provably on the remote is a route to
// deleting the only copy of a commit. Every rule below therefore fails CLOSED,
// and the two that look like over-caution are the two that matter most:
//
//   • `landed_sha = 'backfill'` is REFUSED. That sentinel is a guess
//     `20260715000000` stamped over every already-done ticket without
//     contacting a remote or resolving a branch; #157 and #158 both excluded it
//     for exactly this reason. It is not evidence of a landing.
//
//   • A ticket carrying #137's `nothing_to_land` NOTICE is REFUSED. #137 stamps
//     `landed_sha` for that outcome too (the base tip), deliberately, so the sha
//     alone can no longer tell the two apart - `deriveLandingState` orders the
//     notice first for the same reason. And a nothing-to-land ticket is exactly
//     the shape whose branch may never have reached the remote at all: that was
//     DevPilot-7, and settling it needed the positional witness #158 went and
//     built. A cron must not make that call on anyone's behalf.
//
// ── IT REIMPLEMENTS NO LANDING LOGIC ──────────────────────────────────────
// The row to settle is `resolveTicketPush`'s answer - the SAME resolver
// `loadLandContext` feeds `stampLanded` - and the write is `settleLandedPush`,
// the same writer. `requireResolvedRowMatches` then insists the two agree, so
// the supervisor settles EXACTLY the row the landing path would have settled
// and can never reach one it would not. That inherits #156's scope argument
// verbatim rather than restating it: one row, by id, never "every unpushed row
// for this ticket".

/** `tickets.landed_sha` written by `20260715000000` §6 over every already-done
 *  ticket. A placeholder, not a commit - see the header. Re-declared here rather
 *  than imported so this stays a leaf module (`land-policy.ts` pulls in the land
 *  gate); `__tests__/unsettled-push-policy.test.ts` pins the two equal. */
export const BACKFILL_SENTINEL = "backfill";

/** Everything the decision needs about one unsettled `pending_pushes` row. */
export type UnsettledPushEvidence = {
  /** The row under consideration. */
  pushId: string;
  /** `pending_pushes.pushed_at`. Non-null means somebody already settled it. */
  pushedAt: string | null;
  /** `pending_pushes.ticket_id`. Null for a row whose ticket was deleted. */
  ticketId: string | null;
  /** `tickets.landed_sha` for that ticket, or null when it has not landed. */
  landedSha: string | null;
  /** True when that ticket carries PR #137's `nothing_to_land` system notice. */
  hasNothingToLandNotice: boolean;
  /** What `resolveTicketPush` returns for that ticket - the row the landing
   *  path itself would have settled. Null when the ticket resolves to no push
   *  at all (a genuinely branchless ticket). */
  resolvedPushId: string | null;
};

export type UnsettledPushDecision =
  | { action: "settle"; reason: string }
  | { action: "stand_down"; reason: UnsettledPushStandDown; detail: string };

/** Why a candidate was left alone. Named so a future reader can tell "we
 *  checked and it is fine" from "we could not prove it". */
export type UnsettledPushStandDown =
  | "already-settled"
  | "no-ticket"
  | "not-landed"
  | "backfill-sentinel"
  | "nothing-to-land"
  | "not-the-landings-row";

/**
 * May this row be settled?
 *
 * Ordered most-conservative-first, and every arm is a refusal except the last.
 * `not-landed` is the one that carries the whole feature: a `pending_pushes`
 * row with no landing behind it is ORDINARY - it is in-flight work, it is what
 * the /changes badge is for, and it is what holds the workspace against the
 * reaper. A repair that acted on it would look identical to a correct one on a
 * healthy board while quietly releasing the guard on live work.
 */
export function decideUnsettledPushRepair(e: UnsettledPushEvidence): UnsettledPushDecision {
  if (e.pushedAt) {
    return {
      action: "stand_down",
      reason: "already-settled",
      detail: `already settled at ${e.pushedAt}`,
    };
  }

  if (!e.ticketId) {
    // A row whose ticket was deleted (`on delete set null`) has no landing to
    // point at, so nothing here can establish that its commits shipped.
    return {
      action: "stand_down",
      reason: "no-ticket",
      detail: "the push row names no ticket, so no landing can vouch for it",
    };
  }

  if (!e.landedSha) {
    return {
      action: "stand_down",
      reason: "not-landed",
      detail: "the ticket has not landed - this row is live, unpushed work",
    };
  }

  if (e.landedSha === BACKFILL_SENTINEL) {
    return {
      action: "stand_down",
      reason: "backfill-sentinel",
      detail:
        "`landed_sha` is the 'backfill' sentinel, which is a guess an old migration recorded " +
        "rather than a commit - it proves no landing",
    };
  }

  if (e.hasNothingToLandNotice) {
    return {
      action: "stand_down",
      reason: "nothing-to-land",
      detail:
        "the ticket closed as `nothing_to_land`, whose `landed_sha` is the base tip rather than " +
        "this branch's work - the branch may never have reached the remote",
    };
  }

  if (!e.resolvedPushId || e.resolvedPushId !== e.pushId) {
    return {
      action: "stand_down",
      reason: "not-the-landings-row",
      detail:
        `the landing resolved push ${e.resolvedPushId ?? "<none>"}, not this one - only the row ` +
        `the land path itself would have settled is settled here`,
    };
  }

  return {
    action: "settle",
    reason: `landed at ${e.landedSha} with its push row still unsettled`,
  };
}

/**
 * The operator-facing sentence recorded in `supervisor_actions.detail`.
 *
 * It says what was repaired AND that the repair is itself a symptom, because
 * this row is the evidence a landing route skipped the settle. `cause` is the
 * grouping key and is deliberately route-agnostic (see
 * `SUPERVISOR_CAUSES.landed_push_unsettled`); the diagnosis lives here, where a
 * human reads it.
 */
export function describeUnsettledPushRepair(args: {
  ticketId: string;
  pushId: string;
  branch: string;
  landedSha: string;
  /** How `resolveTicketPush` reached the row - `merger` means the push had been
   *  re-parented to a merger, which is itself a route worth naming. */
  via: "direct" | "merger";
}): string {
  const viaNote =
    args.via === "merger"
      ? " The row was reached through a merger that had re-parented it, so the landing route " +
        "involved a conflict resolution."
      : "";
  return (
    `Ticket ${args.ticketId} landed at ${args.landedSha}, but its push row ${args.pushId} ` +
    `(branch \`${args.branch}\`) was still unsettled - so the Changes badge counted work that had ` +
    `already shipped and the workspace stayed pinned against the reaper. Settled it.${viaNote} ` +
    `THIS REPAIR IS ITSELF A DEFECT SIGNAL: every landing path is supposed to settle its own row ` +
    `through \`stampLanded\`, so a row reaching this sweep means work landed by a route that did ` +
    `not. Find the route rather than letting the supervisor keep absorbing it.`
  );
}
