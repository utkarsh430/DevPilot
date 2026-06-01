// Phase 1 / M15 — nightly meter aggregator.
//
// Once per day (Inngest cron @ 04:00 UTC, offset 1h from the workspace
// reaper @ 03:00 UTC), for every tenant:
//
//   1. SUM(`runs.spent_cents`) for runs that:
//        • belong to the tenant,
//        • finished (status in 'done','failed') in the last 24h,
//        • have NOT been billed yet (`billed_at IS NULL`).
//   2. Apply the markup → debit `tenant.balance_cents`.
//      Markup math: spent * (1 + DEVPILOT_BILLING_MARKUP_PCT/100), rounded to the
//      nearest cent. Operator-configurable; defaults to 20%.
//   3. POST a Stripe Meter Event with:
//        - value = max(0, overage_cents) where overage = balance_cents drawn
//          below the included monthly bucket. We track the bucket in
//          `tenants.monthly_included_cents` (a credit that resets monthly via
//          `tenants.billing_period_start`).
//        - identifier = `devpilot_meter_${tenantId}_${yyyymmdd}` (deterministic so
//          a re-run today is dropped by Stripe).
//   4. Mark the contributing run rows `billed_at = now()` so the next run is
//      a no-op for them.
//
// Idempotency two ways:
//   • DB: `runs.billed_at IS NULL` filter; we set it to now() at the end of
//     a successful aggregation. A second run today selects zero rows.
//   • Stripe: deterministic `identifier` from (tenant, day). Even if step 4
//     fails after step 3, Stripe drops the duplicate event silently.
//
// Lazy customer provisioning:
//   If a tenant has `stripe_customer_id IS NULL` but `spent_cents > 0`, we
//   create the Stripe customer here (per DEVPILOT_PHASE1_PLAN.md M15: "Stripe
//   customer creation on tenant signup OR lazily on first spend").

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import {
  createCustomer,
  isStripeConfigured,
  meterEventName,
  postMeterEvent,
} from "@/lib/billing/stripe";

const DEFAULT_MARKUP_PCT = 20;
const MARKUP_PCT = Number(process.env.DEVPILOT_BILLING_MARKUP_PCT ?? String(DEFAULT_MARKUP_PCT));

/** Apply the markup. Always rounds to the nearest cent. Pure. */
export function applyMarkup(spentCents: number, markupPct: number = MARKUP_PCT): number {
  if (spentCents <= 0) return 0;
  const pct = Number.isFinite(markupPct) ? markupPct : DEFAULT_MARKUP_PCT;
  return Math.round(spentCents * (1 + pct / 100));
}

/** YYYYMMDD in UTC for deterministic per-tenant-per-day Stripe identifiers. */
function utcDayString(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// The identifier is Stripe's idempotency key for the day's meter event. It was
// `ace_meter_…` before the rename, so on an instance that had ALREADY sent an
// event for the current UTC day, the first post-rename aggregation for that same
// day carries a new identifier and Stripe will not dedupe it against the old one
// — that day could be counted twice. Stripe is unconfigured here (no STRIPE_*
// env, no meter, no events), so there is nothing to double-count; an instance
// that IS billing should cut over between daily aggregations.
export function meterIdentifier(tenantId: string, date: Date = new Date()): string {
  return `devpilot_meter_${tenantId}_${utcDayString(date)}`;
}

export type AggregationResult = {
  tenantId: string;
  spentCents: number;
  chargeCents: number;
  runsBilled: number;
  /** Plan-mode sessions (Phase 2.5+/M7) whose spent_cents was rolled into
   *  this billing cycle. Mirrors `runsBilled` for the planning surface. */
  planSessionsBilled: number;
  meterEvent?: { identifier: string; valueCents: number; eventName: string };
  stripeCustomerId?: string;
  skipped?: string;
};

/**
 * Aggregate billable spend for a single tenant since `since` (default: 24h
 * ago) and emit a Stripe meter event for the overage cents. Marks the
 * contributing runs `billed_at = now()` on success.
 *
 * Exposed as a standalone function so the acceptance script (and operator
 * tooling) can trigger it without waiting on the cron.
 */
export async function aggregateTenant(args: {
  tenantId: string;
  since?: Date;
  now?: Date;
  /** When true, skips the Stripe POST (used by unit tests / dry-runs). */
  dryRun?: boolean;
}): Promise<AggregationResult> {
  const supabase = supabaseService();
  const now = args.now ?? new Date();
  const since = args.since ?? new Date(now.getTime() - 24 * 3_600_000);

  // 1. Load the tenant row.
  const { data: tenant, error: tenantErr } = await supabase
    .from("tenants")
    .select(
      "id, name, stripe_customer_id, balance_cents, monthly_included_cents, payment_method_status, billing_period_start",
    )
    .eq("id", args.tenantId)
    .maybeSingle();
  if (tenantErr || !tenant) {
    return {
      tenantId: args.tenantId,
      spentCents: 0,
      chargeCents: 0,
      runsBilled: 0,
      planSessionsBilled: 0,
      skipped: "tenant-not-found",
    };
  }

  // 2a. SUM unbilled spend on terminal runs in the window.
  const { data: runs, error: runsErr } = await supabase
    .from("runs")
    .select("id, spent_cents, last_event_at")
    .eq("tenant_id", args.tenantId)
    .in("status", ["done", "failed"])
    .is("billed_at", null)
    .gte("last_event_at", since.toISOString());
  if (runsErr) {
    throw new Error(`aggregateTenant: select runs failed: ${runsErr.message}`);
  }
  const billableRuns = runs ?? [];
  const runsSpentCents = billableRuns.reduce((sum: number, r) => sum + (r.spent_cents ?? 0), 0);

  // 2b. SUM unbilled spend on terminal plan-mode sessions in the window
  //     (Phase 2.5+ / M7). A session is "terminal" once status is committed
  //     or discarded; mid-discussion sessions stay un-billed until the
  //     operator commits or walks away. Same markup + meter event path.
  const { data: planSessions, error: planErr } = await supabase
    .from("planning_sessions")
    .select("id, spent_cents, updated_at")
    .eq("tenant_id", args.tenantId)
    .in("status", ["committed", "discarded"])
    .is("billed_at", null)
    .gte("updated_at", since.toISOString());
  if (planErr) {
    throw new Error(`aggregateTenant: select planning_sessions failed: ${planErr.message}`);
  }
  const billablePlanSessions = planSessions ?? [];
  const planSessionsSpentCents = billablePlanSessions.reduce(
    (sum: number, p) => sum + (p.spent_cents ?? 0),
    0,
  );

  const spentCents = runsSpentCents + planSessionsSpentCents;

  if (spentCents <= 0) {
    return {
      tenantId: args.tenantId,
      spentCents: 0,
      chargeCents: 0,
      runsBilled: 0,
      planSessionsBilled: 0,
      skipped: "no-billable-spend",
      stripeCustomerId: tenant.stripe_customer_id as string | undefined,
    };
  }

  // 3. Apply markup → debit balance.
  const chargeCents = applyMarkup(spentCents);
  const newBalance = (tenant.balance_cents ?? 0) - chargeCents;

  // 4. Lazy Stripe customer provisioning.
  let customerId = tenant.stripe_customer_id as string | null;
  if (!customerId && isStripeConfigured() && !args.dryRun) {
    const customer = await createCustomer({
      tenantId: args.tenantId,
      tenantName: tenant.name as string,
    });
    customerId = customer.id;
  }

  // 5. POST the Stripe meter event. Overage = the portion of charge that
  //    drove balance negative (i.e., past the included credits + any prior
  //    positive balance). We compute it from the balance delta:
  //       overage = max(0, -newBalance) - max(0, -oldBalance)
  //    which is the additional negative balance accrued THIS period.
  const oldBalance = tenant.balance_cents ?? 0;
  const overageCents = Math.max(0, -newBalance) - Math.max(0, -oldBalance);

  let meterEvent: AggregationResult["meterEvent"] = undefined;
  if (isStripeConfigured() && customerId && overageCents > 0 && !args.dryRun) {
    const identifier = meterIdentifier(args.tenantId, now);
    await postMeterEvent({
      stripeCustomerId: customerId,
      valueCents: overageCents,
      identifier,
      occurredAtSec: Math.floor(now.getTime() / 1000),
    });
    meterEvent = {
      identifier,
      valueCents: overageCents,
      eventName: meterEventName(),
    };
  }

  // 6. Persist: tenant balance + customer id, runs.billed_at on contributors,
  //    and planning_sessions.billed_at on plan-mode contributors. Order:
  //    mark BOTH source tables BEFORE we update the tenant balance — that
  //    way a crash between writes leaves the next aggregation idempotent
  //    via the `billed_at IS NULL` filter (Stripe is already idempotent on
  //    the deterministic identifier).
  const billedAtIso = now.toISOString();
  const runIds = billableRuns.map((r) => r.id as string);
  if (!args.dryRun && runIds.length > 0) {
    const { error: markErr } = await supabase
      .from("runs")
      .update({ billed_at: billedAtIso })
      .in("id", runIds)
      .is("billed_at", null);
    if (markErr) {
      throw new Error(`aggregateTenant: mark billed_at failed: ${markErr.message}`);
    }
  }
  const planSessionIds = billablePlanSessions.map((p) => p.id as string);
  if (!args.dryRun && planSessionIds.length > 0) {
    const { error: planMarkErr } = await supabase
      .from("planning_sessions")
      .update({ billed_at: billedAtIso })
      .in("id", planSessionIds)
      .is("billed_at", null);
    if (planMarkErr) {
      throw new Error(
        `aggregateTenant: mark planning_sessions.billed_at failed: ${planMarkErr.message}`,
      );
    }
  }

  if (!args.dryRun) {
    const tenantPatch: Record<string, unknown> = { balance_cents: newBalance };
    if (customerId && customerId !== tenant.stripe_customer_id) {
      tenantPatch.stripe_customer_id = customerId;
    }
    const { error: tenantUpErr } = await supabase
      .from("tenants")
      .update(tenantPatch)
      .eq("id", args.tenantId);
    if (tenantUpErr) {
      throw new Error(`aggregateTenant: tenant update failed: ${tenantUpErr.message}`);
    }
  }

  return {
    tenantId: args.tenantId,
    spentCents,
    chargeCents,
    runsBilled: billableRuns.length,
    planSessionsBilled: billablePlanSessions.length,
    meterEvent,
    stripeCustomerId: customerId ?? undefined,
  };
}

/**
 * Cron-driven aggregator. Walks all tenants and calls `aggregateTenant`.
 * Scheduled at 04:00 UTC (offset 1h from the 03:00 workspace reaper).
 */
export const billingMeterAggregator = inngest.createFunction(
  { id: "billing-meter-aggregator", retries: 1 },
  { cron: "0 4 * * *" },
  async ({ step }) => {
    if (!isStripeConfigured()) {
      return { skipped: "stripe-not-configured" };
    }

    const tenantIds = await step.run("list-tenants", async () => {
      const supabase = supabaseService();
      const { data, error } = await supabase.from("tenants").select("id");
      if (error) throw new Error(`list-tenants: ${error.message}`);
      return (data ?? []).map((r) => r.id as string);
    });

    const results: AggregationResult[] = [];
    for (const tenantId of tenantIds) {
      // One step.run per tenant — failures bubble up as Inngest retries on
      // a per-tenant basis without re-billing earlier tenants.
      const result = await step.run(`aggregate-${tenantId}`, async () =>
        aggregateTenant({ tenantId }),
      );
      results.push(result);
    }

    const totalCharged = results.reduce((s, r) => s + r.chargeCents, 0);
    return {
      tenants: results.length,
      totalChargedCents: totalCharged,
      results,
    };
  },
);
