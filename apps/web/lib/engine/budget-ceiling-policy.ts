// Pure policy: does a run have headroom for its next budgeted action, and is
// the tenant under its cost-velocity ceiling? Extracted out of `budget.ts` so
// the decision itself is unit-testable without a Supabase/Redis client —
// `budget.ts` reaches `next/headers` transitively (via `supabaseService`) and
// cannot load under Vitest, the same gap documented for every other
// `*-policy.ts` sibling in this directory (`cancel-check-policy.ts`,
// `reconcile-policy.ts`, …).
//
// Why this exists — the per-run cap was a TURNSTILE, not a ceiling
// ──────────────────────────────────────────────────────────────
// `assertCanProceed` only ever asked "is there at least one cent of headroom
// RIGHT NOW", before an action starts. Once through, the action itself could
// cost anything — spend is recorded only AFTER it completes — and because
// every dispatch path sends `iterations: 1`, a run's single action IS its
// whole lifecycle: nothing ever looked at the cap again afterwards. Measured
// across the last 500 runs (2026-08-06/07): 13 exceeded their cap, $32.92
// spent beyond them, worst case 996¢ against a 500¢ cap (~2x) — and every one
// of those runs then completed NORMALLY (postprocess ran, the ticket
// advanced, the run read `done`), with nothing anywhere recording that the
// cap had been blown.
//
// The fix (see `lib/engine/run-agent.ts`) is to run this SAME check again
// immediately after every step's spend is recorded, not just before the step
// starts. `decideBudgetCeiling` is deliberately the one function used at both
// boundaries: a step is allowed to run once it has headroom, and the moment
// its actual cost is known, the very same rule decides whether the run may
// take another action. At most one step's worth of overshoot is now possible,
// and it is always followed by a clean stop — never a mid-action kill.
//
// `overrideCap` (per-project opt-in, `projects.budget_cap_override_enabled`)
// makes this function never refuse. It does NOT touch `decideVelocityBreaker`
// below — that check is deliberately a separate function with no override
// parameter at all, so "the per-run cap is ignored" can never be read as "no
// cap can ever apply" by a future caller. See its own header for why the
// breaker is the correct backstop rather than a second thing to bypass.

export type BudgetCeilingArgs = {
  /** Free-form label for the action being gated, folded into the refusal
   *  message (`"llm"` today; kept generic to match `BudgetAction` in
   *  `budget.ts` without this pure module depending on that type). */
  action: string;
  runId: string;
  spentCents: number;
  budgetCents: number;
  /** Minimum slack (cents) required for the check to pass. Kept as an input
   *  rather than a constant here so the pure module carries no policy
   *  numbers of its own — `budget.ts` owns `MIN_REMAINING_CENTS`. */
  minRemainingCents: number;
  /** Per-project escape hatch. `true` ⇒ this check never refuses, whatever
   *  `spentCents`/`budgetCents` say. */
  overrideCap: boolean;
};

export type BudgetCeilingDecision =
  | { ok: true; remainingCents: number }
  | { ok: false; remainingCents: number; message: string };

export function decideBudgetCeiling(args: BudgetCeilingArgs): BudgetCeilingDecision {
  const remaining = args.budgetCents - args.spentCents;
  if (args.overrideCap || remaining >= args.minRemainingCents) {
    return { ok: true, remainingCents: remaining };
  }
  return {
    ok: false,
    remainingCents: remaining,
    message:
      `budget exceeded for ${args.action} on run ${args.runId}: ` +
      `spent=${args.spentCents}¢ budget=${args.budgetCents}¢ remaining=${remaining}¢`,
  };
}

export type VelocityBreakerArgs = {
  tenantId: string;
  bucketCents: number;
  limitCentsPerMin: number;
  windowSec: number;
};

export type VelocityBreakerDecision = { ok: true } | { ok: false; message: string };

/**
 * The tenant-wide cost-velocity circuit breaker. Deliberately carries NO
 * `overrideCap` parameter — unlike `decideBudgetCeiling`, there is no
 * argument that makes this refuse less. A per-project bypass of the PER-RUN
 * ceiling must never also bypass this: the breaker is what stops "ignore my
 * cap" from meaning "no ceiling at all", and — because the bucket is shared
 * across every project in the tenant — it is also what stops one overridden
 * project's spend from starving every other project sharing the same window.
 * An overridden run is throttled by exactly the same shared bucket as
 * everyone else, never a wider or narrower one.
 */
export function decideVelocityBreaker(args: VelocityBreakerArgs): VelocityBreakerDecision {
  if (args.limitCentsPerMin <= 0) return { ok: true };
  if (args.bucketCents < args.limitCentsPerMin) return { ok: true };
  return {
    ok: false,
    message:
      `tenant velocity circuit breaker tripped: tenant=${args.tenantId} ` +
      `bucket=${args.bucketCents}¢ limit=${args.limitCentsPerMin}¢/min. ` +
      `Wait ${args.windowSec}s for the window to roll, then retry; raise ` +
      `DEVPILOT_TENANT_VELOCITY_CENTS_PER_MIN if this is expected load.`,
  };
}
