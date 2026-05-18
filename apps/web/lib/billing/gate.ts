// Phase 1 / M15 — dispatcher billing gate.
//
// Single entry point used by the dispatcher's `step.run("billing-gate")`.
// Contract:
//
//   • Returns `{ refused: false }` when the dispatch may proceed.
//   • Returns `{ refused: true, balanceCents, paymentMethodStatus }` when:
//       - tenant.balance_cents < 0 AND
//       - tenant.payment_method_status !== 'valid'.
//     In the refused case the gate also writes a `system` comment on the
//     ticket explaining the stall so the operator can act.
//
// Why a separate file: the gate is the only place feature code touches
// billing semantics, and keeping it out of dispatcher.ts means future tweaks
// to the cutoff rule (grace periods, dunning, etc.) land in one place.
//
// Idempotent on Inngest replays: the comment-writer checks for an existing
// system comment with the same identifier in the last 24h and skips re-posting.

import { supabaseService } from "@/lib/db/server";
import { addComment } from "@/lib/board/transitions";

export type BillingGateResult =
  | { refused: false; balanceCents: number; paymentMethodStatus: string }
  | { refused: true; balanceCents: number; paymentMethodStatus: string };

const SYSTEM_AUTHOR_ID = "billing-gate";

export async function checkBillingGate(args: {
  tenantId: string;
  ticketId: string;
}): Promise<BillingGateResult> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("tenants")
    .select("balance_cents, payment_method_status")
    .eq("id", args.tenantId)
    .maybeSingle();

  if (error || !data) {
    // Fail open — better to dispatch than stall on a transient lookup error.
    // The aggregator will catch up at the next cron and re-bill as needed.
    return { refused: false, balanceCents: 0, paymentMethodStatus: "none" };
  }

  const balance = (data.balance_cents as number) ?? 0;
  const status = (data.payment_method_status as string) ?? "none";

  if (balance < 0 && status !== "valid") {
    await writeRefusalComment({
      tenantId: args.tenantId,
      ticketId: args.ticketId,
      balanceCents: balance,
      paymentMethodStatus: status,
    });
    return { refused: true, balanceCents: balance, paymentMethodStatus: status };
  }

  return { refused: false, balanceCents: balance, paymentMethodStatus: status };
}

async function writeRefusalComment(args: {
  tenantId: string;
  ticketId: string;
  balanceCents: number;
  paymentMethodStatus: string;
}): Promise<void> {
  // De-dupe: if we already wrote a billing-gate refusal on this ticket in the
  // last 24h, skip. Inngest replays would otherwise spam the thread.
  const supabase = supabaseService();
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { data: existing } = await supabase
    .from("comments")
    .select("id")
    .eq("ticket_id", args.ticketId)
    .eq("tenant_id", args.tenantId)
    .eq("author_type", "system")
    .eq("author_id", SYSTEM_AUTHOR_ID)
    .gte("created_at", since)
    .limit(1);
  if (existing && existing.length > 0) return;

  const dollars = (Math.abs(args.balanceCents) / 100).toFixed(2);
  const body =
    `Dispatch refused: tenant balance is -$${dollars} and payment_method_status='${args.paymentMethodStatus}'. ` +
    `Attach a valid card in Settings → Billing, then re-trigger this ticket to resume.`;

  await addComment({
    ticketId: args.ticketId,
    tenantId: args.tenantId,
    authorType: "system",
    authorId: SYSTEM_AUTHOR_ID,
    body,
  });
}
