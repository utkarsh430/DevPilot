// Pure policy for the project scaffolder's seed + release.
//
// Why this exists
// ───────────────
// The scaffolder is the agent that authors the FIRST commit of a genuinely
// empty repo (`auto_init: false`). Two facts about it fight each other:
//
//   1. It must ALWAYS run. An empty repo that never gets seeded is a dead
//      project - so `createProjectWithNewRepoAction` is the ONE place that
//      files the ticket, and it does so unconditionally.
//   2. It should run INFORMED. When the operator asked for a plan, the
//      scaffolder's stack decisions are exactly what the planning discussion
//      settles. Firing it at create time throws that away.
//
// The reconciliation is ONE row, released two ways: the create action always
// inserts exactly one scaffolder ticket, but a plan-mode create inserts it
// HELD (`backlog`, not dispatched) and the plan commit RELEASES it. Nothing
// else may ever insert a scaffolder row - that is the #79 invariant. PR #79
// ("Part D") fixed a duplicate-scaffolder bug caused by a SECOND creator (the
// plan consolidator filed its own scaffolder on every plan build, including for
// connect-existing projects that need none). Release-don't-insert is what makes
// that class of bug structurally impossible rather than merely absent.
//
// A held row still has to be released if the plan is never committed, so a
// delayed fallback releases it with base context (`lib/engine/scaffolder-fallback.ts`).
// Both release paths guard on the still-held state in the UPDATE itself, so the
// two can race freely and exactly one wins.
//
// Deliberately pure - no DB, no env, no Next imports - so the whole surface is
// unit-testable (`__tests__/scaffolder.test.ts`). The IO halves live in
// `scaffolder-release.server.ts` and the two call sites.

/** The role slug the create action stamps and every release path matches on. */
export const SCAFFOLDER_ROLE_SLUG = "project_scaffolder";

/**
 * Is this role slug the scaffolder?
 *
 * Exists so the PLAN flow can REJECT the slug without ever containing the
 * literal. That is not cosmetic: `project_scaffolder` is a full catalog slug, so
 * the Thorough tier's planner (which sees the whole catalog) can propose it and
 * an operator edit can set it, and `commitPlanAction` used to copy
 * `requested_role` verbatim into its bulk insert - which meant the plan flow
 * could file a SECOND scaffolder row. Routing the check through this helper
 * keeps the plan actions free of the slug, which in turn keeps the
 * single-creator source scan (`__tests__/scaffolder-single-creator.test.ts`)
 * tight instead of needing an allowlist entry for the very file the invariant
 * is about.
 */
export function isScaffolderRole(slug: string | null | undefined): boolean {
  return slug === SCAFFOLDER_ROLE_SLUG;
}

/**
 * Why the plan flow refuses to file a scaffolder. Surfaced to the operator on a
 * proposed-ticket edit, so "the planner suggested it and it vanished" is never
 * silent.
 */
export const PLAN_SCAFFOLDER_ROLE_REFUSAL =
  "project_scaffolder is filed by project creation, not by a plan. Pick another role " +
  "(the project's scaffolder ticket already exists and auto-runs when you commit the plan).";

/**
 * How the create action seeds the single scaffolder row.
 *
 * `held` is the whole feature: the row exists from the start (so the board
 * shows the project's root work immediately, and so there is something for the
 * commit to RELEASE rather than create), it just doesn't run yet.
 */
export type ScaffolderSeed = {
  /** The status to insert at. */
  status: "ready" | "backlog";
  /**
   * `tickets.plan_hold` - the DURABLE identity of the held instance, and the
   * thing every release path claims on. Not derivable from `status ===
   * "backlog"`: that shape is also worn by a released-then-reset row and by a
   * human-filed second scaffolder, and releasing either of those would be a
   * re-run nobody asked for. See migration 20260727000000.
   */
  planHold: boolean;
  /** Emit `ticket/dispatch-needed` right away? */
  dispatchNow: boolean;
  /** Arm the abandonment fallback (only meaningful for a held row)? */
  scheduleFallback: boolean;
};

/**
 * Decide how to seed the scaffolder.
 *
 * No plan (a plain create, or connect-existing) → `ready` + dispatch, which is
 * byte-for-byte today's behaviour: there is no plan to wait for, so waiting
 * would be pure latency.
 *
 * Plan mode → HELD at `backlog`, with the fallback armed. The operator is about
 * to have a discussion that decides this ticket's content; running it now
 * produces a scaffold the plan then has to fight.
 */
export function decideScaffolderSeed(args: { generatePlan: boolean }): ScaffolderSeed {
  if (!args.generatePlan) {
    return { status: "ready", planHold: false, dispatchNow: true, scheduleFallback: false };
  }
  return { status: "backlog", planHold: true, dispatchNow: false, scheduleFallback: true };
}

/**
 * The `→ ready` gate for a held scaffolder.
 *
 * A held row sits in Backlog where the operator can see it - and where two
 * things that know nothing about plans can promote it: a board drag
 * (`moveTicketAction`) and the backlog drain (`drainBacklogFn`, which force-
 * promotes the backlog head when nothing else is eligible). Both reach `ready`
 * through `transitionTicket`, so that seam is where this is enforced, and
 * enforcing it there makes it bypass-proof for any future path too.
 *
 * ACTOR-AGNOSTIC on purpose, unlike the reopen/safety gates. This is not "who is
 * allowed to decide" - the authorized releaser (`releaseScaffolder`) does its own
 * guarded UPDATE and never comes through here, so refusing every actor at this
 * seam costs the release nothing and closes the promote-vs-release double-
 * dispatch race from the other side.
 *
 * The operator is not stuck: committing the plan releases it enriched,
 * discarding the plan releases it with base context, and the TTL fallback
 * releases it if they walk away. All three go through the release seam, which
 * dispatches exactly once.
 */
export type PlanHoldDecision = { allow: true } | { allow: false; reason: string };

export function decidePlanHoldGate(args: { to: string; planHold: boolean }): PlanHoldDecision {
  if (!args.planHold || args.to !== "ready") return { allow: true };
  return {
    allow: false,
    reason:
      "this project's scaffolder is held for its pending plan - it runs automatically when you " +
      "commit the plan (or discard the plan to run it now with just the project description)",
  };
}

/**
 * How long a held scaffolder waits for its plan before the fallback releases it.
 *
 * 90 minutes: comfortably longer than a real planning discussion (the panel run
 * itself is minutes), short enough that an operator who abandoned the plan
 * before lunch comes back to a seeded repo. The cost of firing early is a
 * scaffold the plan then has to work with; the cost of firing late is only
 * latency - so this errs long.
 */
export const DEFAULT_SCAFFOLDER_HOLD_TTL_MINUTES = 90;

/**
 * Resolve the hold TTL from `DEVPILOT_SCAFFOLDER_HOLD_TTL_MINUTES`.
 *
 * A non-numeric or < 1 value falls back to the default rather than disabling
 * the fallback: this is the guarantee that an empty repo never stays empty, so
 * a typo in an env file must not be able to switch it off. Pure - the env read
 * lives in the caller.
 */
export function resolveScaffolderHoldTtlMinutes(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_SCAFFOLDER_HOLD_TTL_MINUTES);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SCAFFOLDER_HOLD_TTL_MINUTES;
  return Math.floor(n);
}

/**
 * A committed plan ticket, as the rooting planner sees it.
 */
export type CommittedTicket = {
  ticketId: string;
  /** Ids of the OTHER committed tickets this one already depends on. */
  blockedBy: readonly string[];
};

/**
 * Statuses of an existing scaffolder that the plan's backlog should NOT be
 * rooted on.
 *
 * `failed` only. Every other state is a fine root: a held/ready/in_progress
 * scaffolder is an open blocker (correct - feature work should wait for the
 * seed), and a `done` one is CLOSED the moment it lands (`classifyBlocker`), so
 * rooting on it costs nothing and still holds dependents through the
 * done-but-unlanded window that WI-5 exists for.
 *
 * `failed` is excluded because a `builds_on` edge to it never closes: it would
 * silently wedge the ENTIRE committed backlog behind a dead ticket, with the
 * board showing no reason. A failed seed is an operator problem to fix (re-run
 * or refile); it should not also swallow the plan.
 */
export const UNROOTABLE_SCAFFOLDER_STATUSES: readonly string[] = ["failed"];

export function isRootableScaffolder(status: string): boolean {
  return !UNROOTABLE_SCAFFOLDER_STATUSES.includes(status);
}

export type ScaffolderRootRow = {
  ticket_id: string;
  blocks_ticket_id: string;
  relation_type: "builds_on";
};

/**
 * Root the committed backlog on the scaffolder.
 *
 * Feature work must branch off the SEEDED repo, not off an empty one. A
 * `builds_on` edge to the scaffolder gives us that for free through machinery
 * that already exists: `builds_on` is in `BLOCKING_RELATION_TYPES`, so the
 * landed-readiness gate holds every dependent until the scaffold actually lands
 * on the integration branch, and `builds_on` re-rooting cuts the child's branch
 * from the parent's landed sha.
 *
 * Scope: only the plan's ROOTS - tickets with no other committed blocker. A
 * ticket that already depends on another committed ticket transitively reaches
 * the scaffolder through that one, so adding a direct edge would be redundant
 * noise in the graph (and would make every card show two blockers where one is
 * implied). The scaffolder itself is never given an edge to itself.
 *
 * Deliberately NOT gated on the scaffolder still being HELD. Rooting and
 * releasing are different questions, and tying them together lost the rooting in
 * two real cases: a discussion longer than the hold TTL (the fallback releases
 * at 90 minutes, the operator commits at 120) and an operator who promoted the
 * row by hand before committing. In both, the scaffolder exists and is exactly
 * what the plan should branch off - "already running" is no reason to let the
 * whole backlog root on an empty repo instead.
 *
 * Pure: returns the rows to insert, never inserts them.
 */
export function planScaffolderRooting(args: {
  scaffolderTicketId: string;
  committed: readonly CommittedTicket[];
}): ScaffolderRootRow[] {
  const rows: ScaffolderRootRow[] = [];
  for (const t of args.committed) {
    // Defensive: the scaffolder is never one of the plan's committed tickets
    // (it predates them), but a self-edge is refused by a DB CHECK anyway and
    // silently dropping it here keeps the caller from having to care.
    if (t.ticketId === args.scaffolderTicketId) continue;
    if (t.blockedBy.length > 0) continue;
    rows.push({
      ticket_id: t.ticketId,
      blocks_ticket_id: args.scaffolderTicketId,
      relation_type: "builds_on",
    });
  }
  return rows;
}
