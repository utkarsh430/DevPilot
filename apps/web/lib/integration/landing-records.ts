// Loads the landing EVIDENCE for a set of tickets, so the board can derive and
// render each ticket's landing state. READ-ONLY — this module has no insert,
// update or delete, and nothing here lands, pushes or retries anything.
//
// ── Why a plain module (no `server-only`, no session) ──
// It takes an injected `SupabaseClient` and an already-resolved `tenantId`, the
// same DI split `lib/learning/write.ts` and `harvest-batch.ts` use, so the reads
// and their tenant scoping are unit-testable against a fake client. The board
// query (`lib/board/queries.ts`) is the caller and supplies the RLS-bound
// server client plus the tenant from the session.
//
// ── Tenant scoping ──
// The co-located `.eq("tenant_id", tenantId)` on ALL THREE reads is the boundary and
// is deliberately not left to RLS alone. The caller's client is RLS-bound today,
// but this module is written to be safe under a service client as well, because
// the failure mode is quiet: a foreign `integration_queue` row keyed on a
// ticket id we are already showing would attach ANOTHER tenant's land error to
// OUR card, and a wrong reason is worse than no reason — it sends the operator
// after a failure that never happened here. `__tests__/landing-records.test.ts`
// drives a filter-APPLYING fake plus a control that neuters the predicate and
// asserts the foreign row WOULD be picked up, so deleting either `.eq` turns
// the suite red.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LandingEvidence } from "@/lib/integration/landing-state";
import {
  NOTHING_TO_LAND_AUTHOR_ID,
  NOTHING_TO_LAND_METADATA_KIND,
} from "@/lib/integration/land-outcome";

/** Evidence for one ticket, minus the `landed_sha` (which the board already
 *  selects off the ticket row itself). */
export type TicketLandingRecords = Pick<LandingEvidence, "push" | "queue" | "nothingToLandNotice">;

type NoticeRow = {
  ticket_id: string | null;
  author_type: string | null;
  author_id: string | null;
  metadata: unknown;
  created_at: string | null;
};

/**
 * Is this comment PR #137's "nothing to land" record?
 *
 * All three clauses are required and none is decorative. The only agent-facing
 * comment route (`app/api/runners/tools/comment/route.ts`) hardcodes
 * `author_type: "agent"`, writes no `metadata` at all, and passes its author id
 * through a role-slug regex — so `author_type === "system"` is the clause an
 * agent cannot satisfy, and it is what makes this record safe to READ as
 * authoritative rather than merely suggestive. The author id and metadata kind
 * are checked as well so an unrelated future system comment can't be mistaken
 * for this outcome.
 */
function isNothingToLandNotice(row: NoticeRow): boolean {
  if (row.author_type !== "system") return false;
  if (row.author_id !== NOTHING_TO_LAND_AUTHOR_ID) return false;
  const meta = row.metadata;
  if (!meta || typeof meta !== "object") return false;
  return (meta as { kind?: unknown }).kind === NOTHING_TO_LAND_METADATA_KIND;
}

type PushRow = {
  ticket_id: string | null;
  branch: string | null;
  pushed_at: string | null;
  conflict_state: string | null;
  unpushed_count: number | null;
  updated_at: string | null;
};

type QueueRow = {
  ticket_id: string | null;
  status: string;
  last_error: string | null;
  claimed_at: string | null;
  updated_at: string | null;
};

/**
 * Fetch the most recent `pending_pushes` and `integration_queue` row per ticket.
 *
 * "Most recent" matters on both sides: a ticket that was rejected, fixed and
 * re-enqueued has several queue rows, and only the newest describes where the
 * work stands now. Rows arrive `updated_at DESC` and the first one per ticket
 * wins — the same first-wins pattern `loadBoardTickets` already uses for pushes.
 *
 * Unlike the board's existing pending-push read, this one does NOT filter on
 * `pushed_at IS NULL`: a ticket whose branch reached GitHub but never landed is
 * precisely one of the cases we exist to surface, and that filter would hide it.
 *
 * Returns an empty map on error or empty input. A missing evidence row is not a
 * failure — it is the normal shape for a ticket that never produced a branch —
 * so callers read absence as "no record", never as "unknown".
 */
export async function loadTicketLandingRecords(
  db: SupabaseClient,
  tenantId: string,
  ticketIds: readonly string[],
): Promise<Map<string, TicketLandingRecords>> {
  const out = new Map<string, TicketLandingRecords>();
  if (ticketIds.length === 0) return out;

  const [pushes, queue, notices] = await Promise.all([
    db
      .from("pending_pushes")
      .select("ticket_id, branch, pushed_at, conflict_state, unpushed_count, updated_at")
      .eq("tenant_id", tenantId)
      .in("ticket_id", ticketIds as string[])
      .order("updated_at", { ascending: false }),
    db
      .from("integration_queue")
      .select("ticket_id, status, last_error, claimed_at, updated_at")
      .eq("tenant_id", tenantId)
      .in("ticket_id", ticketIds as string[])
      .order("updated_at", { ascending: false }),
    // PR #137's explicit "nothing to land" record. Filtered on the author id
    // server-side to keep this off the ticket's whole comment history; the
    // `author_type`/`metadata.kind` half of the check is applied below, because
    // a jsonb predicate here would be the one clause easiest to get subtly wrong
    // and the cheapest to verify in TypeScript.
    db
      .from("comments")
      .select("ticket_id, author_type, author_id, metadata, created_at")
      .eq("tenant_id", tenantId)
      .eq("author_id", NOTHING_TO_LAND_AUTHOR_ID)
      .in("ticket_id", ticketIds as string[])
      .order("created_at", { ascending: false }),
  ]);

  const entry = (ticketId: string): TicketLandingRecords => {
    const existing = out.get(ticketId);
    if (existing) return existing;
    const fresh: TicketLandingRecords = { push: null, queue: null, nothingToLandNotice: null };
    out.set(ticketId, fresh);
    return fresh;
  };

  for (const row of (pushes.data ?? []) as PushRow[]) {
    const tid = row.ticket_id;
    if (!tid) continue;
    const e = entry(tid);
    if (e.push) continue; // already have the newest
    e.push = {
      pushedAt: row.pushed_at,
      conflictState: row.conflict_state,
      unpushedCount: row.unpushed_count,
      branch: row.branch,
    };
  }

  for (const row of (queue.data ?? []) as QueueRow[]) {
    const tid = row.ticket_id;
    if (!tid) continue;
    const e = entry(tid);
    if (e.queue) continue;
    e.queue = {
      status: row.status,
      lastError: row.last_error,
      claimedAt: row.claimed_at,
    };
  }

  for (const row of (notices.data ?? []) as NoticeRow[]) {
    const tid = row.ticket_id;
    if (!tid) continue;
    if (!isNothingToLandNotice(row)) continue;
    const e = entry(tid);
    if (e.nothingToLandNotice) continue; // newest wins
    const meta = row.metadata as { branch?: unknown; base?: unknown };
    e.nothingToLandNotice = {
      branch: typeof meta.branch === "string" ? meta.branch : null,
      base: typeof meta.base === "string" ? meta.base : null,
    };
  }

  return out;
}
