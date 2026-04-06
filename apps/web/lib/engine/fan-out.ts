// Phase 1 / M6 — fan-out / fan-in constants + helpers.
//
// Hard caps land here so both the dispatcher (emit side) and the aggregator
// (join side) reference the same source of truth. CLAUDE.md §3 is explicit:
// no agent spawn without passing fan-out, budget, and depth gates. M6 only
// touches fan-out; M8 will widen the gate to depth + budget on the spawn
// path.
//
// Phase 2.5 / M6 widens this from "one cohort per ticket" to a true
// multi-stage DAG via `tickets.cohort_plan`. Two new caps land here so the
// dispatcher and the spawn-gate share a single source of truth for
// "the operator wired too many cohorts":
//
//   • MAX_COHORT_DEPTH        — max nesting depth of cohort containers
//                               (env: DEVPILOT_MAX_COHORT_DEPTH, default 2).
//   • MAX_TOTAL_COHORTS_PER_TICKET — global cap per ticket
//                               (env: DEVPILOT_MAX_COHORTS_PER_TICKET, default 6).
//
// `parseCohortPlan` enforces the shape contract; `selectCohortForDispatch`
// implements the walk. Both are pure — the dispatcher's step.run boundary
// wraps them.
//
// NonRetriableError semantics in the cohort path:
//   • Bad SHAPE  (missing/malformed cohorts array, wrong types) → return null
//     from parseCohortPlan, log a warning. The dispatcher falls back to the
//     legacy single-cohort path so a misconfigured plan can't loop the
//     dispatcher with retries.
//   • Bad SEMANTICS (depth cap exceeded, total cap exceeded, cycle, missing
//     parent reference) → throw NonRetriableError at the call site. These
//     are operator errors that the builder should have caught at compile
//     time; the engine refuses loudly so the ticket fails fast with a clear
//     reason in the inspector instead of looping into bad routing.

/**
 * Maximum siblings the dispatcher may emit for a single fan-out cohort.
 * Ratified value from `docs/DEVPILOT_PHASE1_PLAN.md` Locked-decisions table.
 *
 * The dispatcher refuses (NonRetriableError) any plan that asks for more,
 * and the aggregator treats this as a sanity ceiling when reading a cohort
 * row back out of the DB.
 */
export const MAX_FAN_OUT = 4;

/**
 * Default phase label stamped on the cohort. Phase 1 only ever runs one
 * cohort per ticket (the "review" wave). Phase 2 may sequence multiple
 * cohorts on the same ticket — the phase column on `fan_in_decisions`
 * lets us key each decision uniquely.
 */
export const DEFAULT_FAN_OUT_PHASE = "review";

export type AcceptanceStrategy =
  | { kind: "single" }
  | { kind: "all" }
  | { kind: "quorum"; threshold: number };

/**
 * Parses the text persisted on `tickets.acceptance_strategy` into a tagged
 * union. Anything we don't recognise (legacy nulls, malformed strings) falls
 * back to 'single' so Phase 0 tickets keep their existing behaviour.
 */
export function parseAcceptanceStrategy(raw: string | null | undefined): AcceptanceStrategy {
  if (!raw) return { kind: "single" };
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "single") return { kind: "single" };
  if (trimmed === "all") return { kind: "all" };
  const m = trimmed.match(/^quorum\((\d+)\)$/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return { kind: "quorum", threshold: n };
  }
  return { kind: "single" };
}

/**
 * Sibling role plan for the canonical demo cohort. Tickets at the
 * post-PM / pre-Engineer state fan out to these roles when their
 * acceptance_strategy isn't 'single'. Order matters only for display —
 * the aggregator joins by cohort uuid, not by index.
 *
 * Phase 1 ships the canonical Engineer + Security plan. The Phase 2 LLM
 * classifier will produce per-ticket plans (e.g. "+ infra review for an
 * infra-heavy ticket") which can plug in here.
 */
export const DEFAULT_REVIEW_COHORT: ReadonlyArray<string> = ["engineer", "security"];

/**
 * Decides whether a cohort exceeds the hard cap. Pure — used by both the
 * dispatcher pre-emit guard and the aggregator's audit code.
 */
export function planFanOut(roles: ReadonlyArray<string>): {
  ok: boolean;
  size: number;
  reason?: string;
} {
  if (roles.length === 0) return { ok: false, size: 0, reason: "empty-cohort" };
  if (roles.length > MAX_FAN_OUT) {
    return {
      ok: false,
      size: roles.length,
      reason: `cohort size ${roles.length} exceeds MAX_FAN_OUT=${MAX_FAN_OUT}`,
    };
  }
  const dedup = new Set(roles);
  if (dedup.size !== roles.length) {
    return {
      ok: false,
      size: roles.length,
      reason: "duplicate role slugs in cohort",
    };
  }
  return { ok: true, size: roles.length };
}

/**
 * Returns true when a cohort of `siblingTotal` runs with `completedCount`
 * (any status) satisfies the strategy. Used by the aggregator.
 *
 * For `all`: every sibling must be completed.
 * For `quorum(n)`: at least N siblings completed (regardless of done/failed —
 *   the cohort-level acceptance treats failure as "this sibling spoke").
 */
export function strategySatisfied(
  strategy: AcceptanceStrategy,
  completedCount: number,
  siblingTotal: number,
): boolean {
  switch (strategy.kind) {
    case "single":
      return completedCount >= 1;
    case "all":
      return completedCount >= siblingTotal;
    case "quorum":
      return completedCount >= Math.min(strategy.threshold, siblingTotal);
  }
}

// ---------------------------------------------------------------------------
// Phase 2.5 / M6 — multi-stage cohort plan.
// ---------------------------------------------------------------------------

/**
 * Maximum cohort nesting depth on a single ticket. Root cohorts (parent_cohort_key=null)
 * count as depth 0; their children depth 1; etc. The dispatcher's fan-out path
 * stamps `runs.cohort_depth` and the spawn gate (spawning.ts) refuses to seed
 * a cohort whose depth would exceed this cap.
 *
 * Default 2 — i.e. root + one nested level. Loosen via env when an operator
 * intentionally wants deeper trees.
 */
export const MAX_COHORT_DEPTH = parseInt(process.env.DEVPILOT_MAX_COHORT_DEPTH ?? "2", 10);

/**
 * Maximum total cohort entries permitted in a single ticket's `cohort_plan`.
 * Counts every entry regardless of depth; trips at parse time so a
 * misconfigured plan never starts emitting siblings.
 *
 * Default 6 — the canonical demo (review + deep_review) is two; six leaves
 * headroom for reasonable workflows without inviting runaway shapes.
 */
export const MAX_TOTAL_COHORTS_PER_TICKET = parseInt(
  process.env.DEVPILOT_MAX_COHORTS_PER_TICKET ?? "6",
  10,
);

export type CohortPlanEntry = {
  cohort_key: string;
  members: string[];
  acceptance_strategy: string;
  /** Role that picks up after this cohort decides. `null` → state machine. */
  fan_in_role: string | null;
  /** Key of cohort whose decision spawns this. `null` → top-level. */
  parent_cohort_key: string | null;
  /** Top-level: dispatcher pick that fires this cohort.
   *  Nested: sibling-leaf role whose completion drops into this child. */
  trigger_role: string;
};

export type CohortPlan = {
  version: 1;
  cohorts: CohortPlanEntry[];
};

/**
 * Strict shape check for `agents.config.cohort_plan` / `tickets.cohort_plan`.
 * Returns `null` (and `console.warn`s) on shape errors so the dispatcher
 * falls through to the legacy path — a malformed plan must NEVER throw from
 * here (would NonRetriably fail the dispatcher; we want graceful degrade).
 *
 * Semantic invariants (depth cap, total cap, dangling parent refs, cycles)
 * are surfaced by the caller via `validateCohortPlan`, which throws
 * NonRetriableError so the operator sees the bad plan fail loudly in the
 * inspector.
 */
export function parseCohortPlan(raw: unknown): CohortPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    console.warn(
      `[fan-out] parseCohortPlan: unknown version=${String(obj.version)} (expected 1) — falling back to legacy path`,
    );
    return null;
  }
  if (!Array.isArray(obj.cohorts)) {
    console.warn(
      `[fan-out] parseCohortPlan: cohorts is not an array — falling back to legacy path`,
    );
    return null;
  }
  const cohorts: CohortPlanEntry[] = [];
  const seenKeys = new Set<string>();
  for (const c of obj.cohorts as unknown[]) {
    if (!c || typeof c !== "object") {
      console.warn(`[fan-out] parseCohortPlan: cohort entry not an object`);
      return null;
    }
    const e = c as Record<string, unknown>;
    if (typeof e.cohort_key !== "string" || e.cohort_key.length === 0) {
      console.warn(`[fan-out] parseCohortPlan: missing/blank cohort_key`);
      return null;
    }
    if (seenKeys.has(e.cohort_key)) {
      console.warn(`[fan-out] parseCohortPlan: duplicate cohort_key=${e.cohort_key}`);
      return null;
    }
    seenKeys.add(e.cohort_key);
    if (
      !Array.isArray(e.members) ||
      e.members.length === 0 ||
      !e.members.every((m) => typeof m === "string" && m.length > 0)
    ) {
      console.warn(`[fan-out] parseCohortPlan: cohort ${e.cohort_key} has empty/invalid members[]`);
      return null;
    }
    if (typeof e.acceptance_strategy !== "string") {
      console.warn(`[fan-out] parseCohortPlan: cohort ${e.cohort_key} missing acceptance_strategy`);
      return null;
    }
    // Strategy must parse to something other than the silent-fallback 'single'
    // when the raw text isn't 'single'. parseAcceptanceStrategy maps anything
    // unrecognised to 'single' — accepting that here would let a typo'd
    // 'qourum(2)' silently degrade to single-emit. Reject explicitly.
    const parsedStrategy = parseAcceptanceStrategy(e.acceptance_strategy);
    const isKnownStrategyText =
      e.acceptance_strategy === "single" ||
      e.acceptance_strategy === "all" ||
      /^quorum\(\d+\)$/.test(e.acceptance_strategy);
    if (!isKnownStrategyText && parsedStrategy.kind === "single") {
      console.warn(
        `[fan-out] parseCohortPlan: cohort ${e.cohort_key} acceptance_strategy=${e.acceptance_strategy} not recognised`,
      );
      return null;
    }
    if (
      e.fan_in_role !== null &&
      e.fan_in_role !== undefined &&
      typeof e.fan_in_role !== "string"
    ) {
      console.warn(`[fan-out] parseCohortPlan: cohort ${e.cohort_key} fan_in_role wrong type`);
      return null;
    }
    if (
      e.parent_cohort_key !== null &&
      e.parent_cohort_key !== undefined &&
      typeof e.parent_cohort_key !== "string"
    ) {
      console.warn(
        `[fan-out] parseCohortPlan: cohort ${e.cohort_key} parent_cohort_key wrong type`,
      );
      return null;
    }
    if (typeof e.trigger_role !== "string" || e.trigger_role.length === 0) {
      console.warn(`[fan-out] parseCohortPlan: cohort ${e.cohort_key} missing trigger_role`);
      return null;
    }
    cohorts.push({
      cohort_key: e.cohort_key,
      members: e.members as string[],
      acceptance_strategy: e.acceptance_strategy,
      fan_in_role: (e.fan_in_role ?? null) as string | null,
      parent_cohort_key: (e.parent_cohort_key ?? null) as string | null,
      trigger_role: e.trigger_role,
    });
  }
  return { version: 1, cohorts };
}

/**
 * Asserts the semantic invariants on a parsed plan. Throws the caller's
 * supplied `Err` constructor (typically `NonRetriableError` so the dispatcher
 * marks the run failed with a clear reason) on:
 *   • total cohorts > MAX_TOTAL_COHORTS_PER_TICKET
 *   • per-cohort members > MAX_FAN_OUT (reuses the existing sibling cap)
 *   • parent_cohort_key references a non-existent key
 *   • cycle in parent_cohort_key chain
 *   • cohort nesting depth > MAX_COHORT_DEPTH
 *
 * Returns a depth map { cohort_key → depth } so the dispatcher can stamp
 * runs.cohort_depth on seeded siblings.
 *
 * Why the throw discipline lives outside parseCohortPlan: shape is "did the
 * persisted JSON match our type?" (graceful fallback), but semantics is
 * "is the plan actually executable?" (operator error, refuse loudly).
 */
export function validateCohortPlan(
  plan: CohortPlan,
  Err: new (message: string) => Error = Error,
): Map<string, number> {
  if (plan.cohorts.length > MAX_TOTAL_COHORTS_PER_TICKET) {
    throw new Err(
      `cohort plan has ${plan.cohorts.length} cohorts, exceeds MAX_TOTAL_COHORTS_PER_TICKET=${MAX_TOTAL_COHORTS_PER_TICKET}`,
    );
  }
  const byKey = new Map(plan.cohorts.map((c) => [c.cohort_key, c]));
  for (const c of plan.cohorts) {
    const sizeCheck = planFanOut(c.members);
    if (!sizeCheck.ok) {
      throw new Err(`cohort ${c.cohort_key} rejected by MAX_FAN_OUT guard — ${sizeCheck.reason}`);
    }
    if (c.parent_cohort_key && !byKey.has(c.parent_cohort_key)) {
      throw new Err(
        `cohort ${c.cohort_key} references unknown parent_cohort_key=${c.parent_cohort_key}`,
      );
    }
  }
  // Compute depths + detect cycles. Memoised recursive walk: depth(c) =
  //   0                      if c.parent_cohort_key === null
  //   depth(parent) + 1      otherwise
  // Cycle detection lives in the per-call visited set.
  const depths = new Map<string, number>();
  const resolveDepth = (key: string, visiting: Set<string>): number => {
    const cached = depths.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) {
      throw new Err(`cohort plan contains a cycle through ${key}`);
    }
    const entry = byKey.get(key);
    if (!entry) {
      // Should have been caught by the parent-ref check above.
      throw new Err(`cohort plan references unknown key=${key}`);
    }
    if (entry.parent_cohort_key === null) {
      depths.set(key, 0);
      return 0;
    }
    visiting.add(key);
    const d = resolveDepth(entry.parent_cohort_key, visiting) + 1;
    visiting.delete(key);
    depths.set(key, d);
    return d;
  };
  for (const c of plan.cohorts) {
    resolveDepth(c.cohort_key, new Set<string>());
  }
  // Cap-check.
  for (const [key, depth] of depths) {
    if (depth > MAX_COHORT_DEPTH) {
      throw new Err(
        `cohort ${key} nesting depth=${depth} exceeds MAX_COHORT_DEPTH=${MAX_COHORT_DEPTH}`,
      );
    }
  }
  return depths;
}

/**
 * Picks the next cohort to fan out, given:
 *   • `currentRole`        — the role the dispatcher would have picked if no
 *                            cohort plan applied (typically the deterministic
 *                            state-machine choice OR a just-completed leaf
 *                            role when called from the completion path).
 *   • `completedCohortKeys`— cohort_keys that already have a recorded
 *                            fan_in_decisions row for this ticket.
 *
 * Walk:
 *   (a) If a nested cohort exists whose `parent_cohort_key` is in
 *       `completedCohortKeys` AND whose `trigger_role` == currentRole AND
 *       that nested cohort hasn't already been seeded (not in completed and
 *       no runs for it yet — caller checks the last bit separately), it wins.
 *   (b) Else if no cohorts have started yet (completedCohortKeys is empty)
 *       AND a top-level cohort (parent_cohort_key=null) has
 *       `trigger_role == currentRole`, that cohort wins.
 *   (c) Else null — state-machine takes over.
 *
 * Returns the matching CohortPlanEntry or null.
 */
export function selectCohortForDispatch(
  plan: CohortPlan,
  completedCohortKeys: ReadonlySet<string>,
  currentRole: string,
): CohortPlanEntry | null {
  // Branch (a): a child cohort fires off the completion of its parent's
  // trigger_role leaf. Walk children of every completed cohort.
  for (const c of plan.cohorts) {
    if (c.parent_cohort_key && completedCohortKeys.has(c.parent_cohort_key)) {
      if (c.trigger_role === currentRole && !completedCohortKeys.has(c.cohort_key)) {
        return c;
      }
    }
  }
  // Branch (b): no cohorts started yet AND a top-level cohort fires on
  // `currentRole`. The dispatcher reaches this when the deterministic
  // state-machine choice matches the operator's wired entry point.
  if (completedCohortKeys.size === 0) {
    for (const c of plan.cohorts) {
      if (c.parent_cohort_key === null && c.trigger_role === currentRole) {
        return c;
      }
    }
  }
  return null;
}
