"use server";

// Phase 1 / M15 — server actions for the billing settings page.
//
// Only one action: open the Stripe Billing Portal for the calling tenant.
// The portal handles all card management; we just redirect.

import { redirect } from "next/navigation";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import {
  createBillingPortalSession,
  createCustomer,
  isStripeConfigured,
} from "@/lib/billing/stripe";
import { env } from "@/lib/env";

export type OpenPortalResult = { ok: true; url: string } | { ok: false; error: string };

export async function openPortalAction(): Promise<never> {
  await requireUser();
  const tenantId = await requireTenantId();

  if (!isStripeConfigured()) {
    redirect("/settings/billing?error=stripe-not-configured");
  }

  const supabase = supabaseService();
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, name, stripe_customer_id")
    .eq("id", tenantId)
    .maybeSingle();
  if (!tenant) {
    redirect("/settings/billing?error=tenant-not-found");
  }

  let customerId = tenant.stripe_customer_id as string | null;
  if (!customerId) {
    // Lazy provisioning: portal needs a customer to manage.
    const customer = await createCustomer({
      tenantId,
      tenantName: tenant.name as string,
    });
    customerId = customer.id;
    await supabase.from("tenants").update({ stripe_customer_id: customerId }).eq("id", tenantId);
  }

  const session = await createBillingPortalSession({
    stripeCustomerId: customerId,
    returnUrl: `${env.APP_URL}/settings/billing`,
  });
  redirect(session.url);
}
