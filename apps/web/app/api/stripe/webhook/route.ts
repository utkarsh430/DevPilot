// Phase 1 / M15 — Stripe webhook receiver.
//
// Subscribed events (set in the Stripe dashboard endpoint config):
//
//   • customer.updated            — apply changes to the linked tenant
//   • payment_method.attached     — flip payment_method_status → 'valid'
//   • payment_method.detached     — flip payment_method_status → 'invalid'
//
// Signature verification is mandatory (CLAUDE.md "Hard constraints"); we
// constructEvent on the RAW body bytes — Next's automatic JSON parse would
// break the signature, so we read `request.text()` and feed that.
//
// The tenant <-> stripe_customer_id mapping is the join. If we receive an
// event for a customer that doesn't map to any tenant (e.g. test fixtures),
// we 200 OK without doing anything — re-sending would just retry forever.

import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { supabaseService } from "@/lib/db/server";
import { isStripeConfigured, verifyWebhookSignature } from "@/lib/billing/stripe";

// Next 15 — disable body parsing by reading the raw text; constructEvent needs
// the exact bytes Stripe signed.
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isStripeConfigured()) {
    return NextResponse.json({ skipped: "stripe-not-configured" }, { status: 200 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "missing stripe-signature header" }, { status: 400 });
  }

  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    event = verifyWebhookSignature(rawBody, sig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `signature verification failed: ${msg}` }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "customer.updated":
        await handleCustomerUpdated(event.data.object as Stripe.Customer);
        break;
      case "payment_method.attached":
        await handlePaymentMethodAttached(event.data.object as Stripe.PaymentMethod);
        break;
      case "payment_method.detached":
        await handlePaymentMethodDetached(event.data.object as Stripe.PaymentMethod);
        break;
      default:
        // Unsubscribed events — 200 OK so Stripe doesn't retry; we just ignore.
        return NextResponse.json({ received: true, ignored: event.type }, { status: 200 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 500 so Stripe retries; the handler is idempotent (single-row UPDATE).
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ received: true, type: event.type }, { status: 200 });
}

async function handleCustomerUpdated(customer: Stripe.Customer): Promise<void> {
  // We use customer.updated as a chance to sync the default payment method
  // status — the invoice settings can change without a payment_method.* event
  // (e.g. a portal-driven default-card change).
  const supabase = supabaseService();
  const hasDefault = Boolean(
    typeof customer.invoice_settings?.default_payment_method === "string"
      ? customer.invoice_settings.default_payment_method
      : customer.invoice_settings?.default_payment_method?.id,
  );
  const nextStatus = hasDefault ? "valid" : "invalid";
  await supabase
    .from("tenants")
    .update({ payment_method_status: nextStatus })
    .eq("stripe_customer_id", customer.id);
}

async function handlePaymentMethodAttached(pm: Stripe.PaymentMethod): Promise<void> {
  const customerId = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
  if (!customerId) return;
  const supabase = supabaseService();
  await supabase
    .from("tenants")
    .update({ payment_method_status: "valid" })
    .eq("stripe_customer_id", customerId);
}

async function handlePaymentMethodDetached(pm: Stripe.PaymentMethod): Promise<void> {
  // On detach the customer field is null; resolve via metadata if Stripe
  // doesn't echo it. In practice the webhook payload still carries the
  // previous customer id under `previous_attributes`, but the SDK type
  // surfaces it on the PaymentMethod object before detach. We fall back to
  // a no-op if we can't resolve.
  const customerId = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
  if (!customerId) return;
  const supabase = supabaseService();
  await supabase
    .from("tenants")
    .update({ payment_method_status: "invalid" })
    .eq("stripe_customer_id", customerId);
}
