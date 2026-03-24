// Dispatch queue — the WIP-gated holding area that replaces the broadcast
// `dispatchOnRunComplete` re-fan disabled in Wave 3 hotfix.
//
// Why this exists
// ───────────────
// The original M3 design re-emitted `ticket/dispatch-needed` for every
// non-terminal ticket on every `agent/run.completed`. With a misbehaving role
// (QA failing to transition via MCP), this opened an unbounded loop — the
// 2026-06-02 runaway incident in §8b of the handoff doc. The fix landed by
// disabling the re-fan entirely; this module is the Phase 2 replacement.
//
// Contract
// ────────
// • The dispatcher enqueues a row ONLY when it would otherwise have dispatched
//   but is blocked by an agent's WIP cap. Tickets that simply need their next
//   role go via the normal `ticket/dispatch-needed` path emitted from
//   `transitionTicket` — they never touch this queue.
// • On `agent/run.completed`, the drain function claims at most ONE pending
//   row for the (tenant, agent) pair of the completed run and re-emits
//   `ticket/dispatch-needed`. One release per completion is enough to keep the
//   queue moving; releasing N here would re-introduce the runaway shape.
// • Idempotency is enforced by the unique partial index
//   `(ticket_id, agent_id) WHERE status='pending'` from the migration. Repeated
//   enqueue attempts during Inngest replay silently no-op.
// • Cancellation: when a ticket reaches a terminal state, all pending entries
//   for that ticket are cancelled. The drain re-verifies the ticket is still
//   non-terminal before re-emitting, so a missed cancel is benign.

import { supabaseService } from "@/lib/db/server";

export type EnqueueInput = {
  tenantId: string;
  ticketId: string;
  agentId: string;
  /** Mirrors `tickets.priority` (1=critical … 5=low). Default 3. */
  priority?: number;
  /** Snapshot of `agents.config.wip_limit` at enqueue time, for auditing. */
  wipLimitSnapshot: number;
  /** Optional caller-supplied context (source runId, etc.). */
  metadata?: Record<string, unknown>;
};

export type EnqueueResult =
  | { enqueued: true; queueId: string }
  | { enqueued: false; reason: "already-pending" };

export type DequeueResult = {
  queueId: string;
  ticketId: string;
} | null;

export async function enqueueDispatch(input: EnqueueInput): Promise<EnqueueResult> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("dispatch_queue")
    .insert({
      tenant_id: input.tenantId,
      ticket_id: input.ticketId,
      agent_id: input.agentId,
      priority: input.priority ?? 3,
      wip_limit_snapshot: input.wipLimitSnapshot,
      metadata: input.metadata ?? {},
      status: "pending",
    })
    .select("id")
    .single();

  if (error) {
    // 23505 — unique_violation on (ticket_id, agent_id) WHERE status='pending'.
    // The ticket is already queued for this agent; treat as a no-op so the
    // dispatcher can keep moving without a hard failure.
    if ((error as { code?: string }).code === "23505") {
      return { enqueued: false, reason: "already-pending" };
    }
    throw new Error(`enqueueDispatch: ${error.message}`);
  }
  return { enqueued: true, queueId: data.id as string };
}

/**
 * Claim the next pending entry for (tenantId, agentId). Atomic via the
 * `dispatch_queue_claim_next` SQL function (SELECT FOR UPDATE SKIP LOCKED →
 * UPDATE status='dispatched' in one statement). Returns null when the queue
 * is empty for this pair.
 */
export async function claimNext(tenantId: string, agentId: string): Promise<DequeueResult> {
  const supabase = supabaseService();
  const { data, error } = await supabase.rpc("dispatch_queue_claim_next", {
    p_tenant_id: tenantId,
    p_agent_id: agentId,
  });
  if (error) throw new Error(`claimNext: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; ticket_id: string }>;
  const head = rows[0];
  if (!head) return null;
  return { queueId: head.id, ticketId: head.ticket_id };
}

/**
 * Cancel a single queue row. Used when the drain function dequeues a row but
 * the ticket has since reached a terminal state — we mark it cancelled rather
 * than dispatched so audit history is honest.
 *
 * Note: the row is already 'dispatched' at this point (claimNext flipped it),
 * so we lift the status guard and overwrite. The cancel_reason makes the
 * intent clear.
 */
export async function cancelDispatchedAsStale(queueId: string, reason: string): Promise<void> {
  const supabase = supabaseService();
  const { error } = await supabase
    .from("dispatch_queue")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancel_reason: reason,
      // Null out dispatched_at so the cross-column check (dispatched implies
      // dispatched_at) still holds after the status flip.
      dispatched_at: null,
    })
    .eq("id", queueId);
  if (error) throw new Error(`cancelDispatchedAsStale: ${error.message}`);
}

/**
 * Cancel every PENDING queue entry for a ticket. Called when the ticket
 * reaches a terminal state — leaving stale pending rows would let the drain
 * re-emit a dispatch on a done/failed ticket (cheap to handle, but noisy).
 *
 * Returns the count of rows cancelled.
 */
export async function cancelPendingForTicket(
  ticketId: string,
  tenantId: string,
  reason: string,
): Promise<number> {
  const supabase = supabaseService();
  // Tenant-scoped. This is an UPDATE, so the unscoped version was not a leak but
  // a cross-tenant WRITE: `dispatch_queue`'s member write policy pins the row's
  // own `tenant_id` and says nothing about `ticket_id`, so a hostile tenant
  // could aim a row at our ticket and have our terminal transition cancel THEIR
  // pending dispatch.
  const { data, error } = await supabase
    .from("dispatch_queue")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancel_reason: reason,
    })
    .eq("ticket_id", ticketId)
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(`cancelPendingForTicket: ${error.message}`);
  return (data ?? []).length;
}

/**
 * Read-only helper for acceptance scripts / inspector UIs. Returns the
 * pending depth (count) for a tenant, optionally narrowed to one agent.
 */
export async function pendingDepth(tenantId: string, agentId?: string): Promise<number> {
  const supabase = supabaseService();
  let q = supabase
    .from("dispatch_queue")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "pending");
  if (agentId) q = q.eq("agent_id", agentId);
  const { count, error } = await q;
  if (error) throw new Error(`pendingDepth: ${error.message}`);
  return count ?? 0;
}
