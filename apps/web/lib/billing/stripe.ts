// Phase 1 / M15 — Stripe SDK wrapper.
//
// Why a wrapper:
//   • The Stripe SDK is the only vendor primitive in the billing surface;
//     keeping all imports here means feature code (meter, dispatcher gate,
//     webhook handler, settings UI) imports from "@/lib/billing/stripe" and
//     a swap to a different billing provider is one file.
//   • Test-mode detection (`STRIPE_SECRET_KEY` starts with `sk_test_`) lives
//     here so the acceptance script and UI can branch on it consistently.
//   • The Meter Events API and Billing Portal are version-pinned by the SDK
//     constructor; pinning here keeps the rest of the codebase off the version
//     surface.
//
// Hard rules (CLAUDE.md §"Hard constraints"):
//   • Stripe key is in env only, never in DB. Reads from STRIPE_SECRET_KEY.
//   • Webhook signature verification lives in this file too (constructEvent),
//     so the route handler stays small and the verify call can't be skipped.
//   • The meter event idempotency key is deterministic from (tenantId, day);
//     a second emit for the same (tenantId, day) is a Stripe-level no-op.

import Stripe from "stripe";

let _stripe: Stripe | null = null;

/**
 * Lazy Stripe client. Throws if `STRIPE_SECRET_KEY` is unset — callers MUST
 * gate on `isStripeConfigured()` before invoking this in code paths that
 * should be optional (the dispatcher gate, the settings UI's portal button).
 */
export function stripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set; billing operations are disabled. Set sk_test_… (test mode) or sk_live_… in apps/web/.env.local.",
    );
  }
  _stripe = new Stripe(key, {
    // Pin the API version so SDK upgrades don't silently change request shapes.
    // Stable API version with Meter Events support.
    apiVersion: "2026-05-27.dahlia",
    typescript: true,
    appInfo: { name: "devpilot", version: "0.1.0" },
  });
  return _stripe;
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function isStripeTestMode(): boolean {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  return key.startsWith("sk_test_");
}

/**
 * Meter event name registered in the Stripe dashboard for DevPilot usage. Operators
 * MUST create a Stripe Meter with this `event_name` and bind it to a recurring
 * Price on the operator's product. The meter aggregates the `value` field
 * (which we set to overage cents) into a usage line item.
 *
 * Env override `STRIPE_METER_EVENT_NAME` lets ops point the codebase at a
 * differently-named meter without a redeploy — including at the pre-rename
 * `ace_overage_cents` meter, if one is already registered and bound to a live
 * Price. Stripe matches this string against the dashboard-registered Meter, so
 * an instance that was billing before the rename must either set the override
 * or register a new Meter under the new name.
 */
export function meterEventName(): string {
  return process.env.STRIPE_METER_EVENT_NAME ?? "devpilot_overage_cents";
}

/**
 * Webhook signing secret. Distinct from the API secret; printed in the Stripe
 * dashboard when a webhook endpoint is registered. The webhook route MUST
 * call `verifyWebhookSignature` — never trust the raw body.
 */
function webhookSecret(): string {
  const s = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s) {
    throw new Error(
      "STRIPE_WEBHOOK_SECRET is not set; webhook signature verification cannot proceed.",
    );
  }
  return s;
}

/**
 * Verify a Stripe webhook payload. Returns the parsed event on success;
 * throws on signature failure (caller maps to HTTP 400).
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string): Stripe.Event {
  return stripe().webhooks.constructEvent(rawBody, signatureHeader, webhookSecret());
}

/**
 * Create OR reuse a Stripe customer for a tenant. Idempotent on the
 * `tenant.id → stripe_customer_id` mapping at the DB layer; the caller is
 * responsible for persisting the returned id on the tenants row.
 *
 * The acceptance script reuses any existing `stripe_customer_id`, so this
 * helper does NOT consult the DB — it just calls the Stripe API. Lookup +
 * persistence happen in the caller (lib/billing/meter.ts and the signup hook).
 */
export async function createCustomer(args: {
  tenantId: string;
  tenantName: string;
  email?: string | null;
}): Promise<Stripe.Customer> {
  const client = stripe();
  return client.customers.create({
    name: args.tenantName,
    email: args.email ?? undefined,
    metadata: { devpilot_tenant_id: args.tenantId },
  });
}

/**
 * POST a Meter Event. Stripe's docs guarantee that a duplicate `identifier`
 * within the meter's idempotency window (~24h) is dropped — that's how we
 * make the nightly aggregator safe to re-run the same day.
 */
export async function postMeterEvent(args: {
  stripeCustomerId: string;
  /** Overage cents for the period. The Stripe meter aggregates these as the
   *  usage line-item quantity. */
  valueCents: number;
  /** Deterministic id from (tenantId, day). Stripe dedupes on this. */
  identifier: string;
  /** When the spend occurred. Stripe expects a unix timestamp in seconds. */
  occurredAtSec: number;
}): Promise<Stripe.Billing.MeterEvent> {
  const client = stripe();
  return client.billing.meterEvents.create({
    event_name: meterEventName(),
    payload: {
      stripe_customer_id: args.stripeCustomerId,
      value: String(args.valueCents),
    },
    identifier: args.identifier,
    timestamp: args.occurredAtSec,
  });
}

/**
 * Create a Billing Portal session for the tenant. The portal handles card
 * management; we only need the redirect URL.
 */
export async function createBillingPortalSession(args: {
  stripeCustomerId: string;
  returnUrl: string;
}): Promise<Stripe.BillingPortal.Session> {
  const client = stripe();
  return client.billingPortal.sessions.create({
    customer: args.stripeCustomerId,
    return_url: args.returnUrl,
  });
}
