// Server-side loader for the unpushed-work policy (`unpushed-work.ts`).
//
// Split out so the policy itself stays pure and unit-testable (same pattern as
// `qa-gate.ts` / `qa-gate.server.ts`).

import { supabaseService } from "@/lib/db/server";
import {
  formatUnpushedWorkNotice,
  holdsUnpushedWork,
  type PendingPushLike,
} from "@/lib/workspace/unpushed-work";

/** Author of the `→ done` notice. Also its idempotency key - see below. */
export const UNPUSHED_WORK_COMMENT_AUTHOR = "unpushed_work_guard";

/**
 * Every `pending_pushes` row for `ticketId`, pushed or not.
 *
 * Returns `[]` when the ticket has no rows. Throws on a query error - callers
 * on the reap path MUST NOT treat "the DB is unreachable" as "nothing to
 * protect"; failing the step is correct, and Inngest retries it.
 */
export async function loadPendingPushesForTicket(
  ticketId: string,
  tenantId: string,
): Promise<PendingPushLike[]> {
  const supabase = supabaseService();
  // Tenant-scoped. Note which way the risk runs here: this feeds the DATA-LOSS
  // guard, so the danger of a predicate is not that it lets something through
  // but that it might hide a REAL unpushed row and let the reaper delete the
  // only copy of a commit. It cannot: `trg_pending_pushes_ticket_id_tenant`
  // refuses any row whose `tenant_id` disagrees with its ticket's, so every
  // genuine row for this ticket is in this tenant. What the predicate does drop
  // is a PLANTED row, which could otherwise pin our workspaces alive forever.
  const { data, error } = await supabase
    .from("pending_pushes")
    .select("id, branch, workspace_path, pushed_at, unpushed_count")
    .eq("ticket_id", ticketId)
    .eq("tenant_id", tenantId);
  if (error) throw new Error(`pending_pushes lookup failed: ${error.message}`);
  return (data ?? []) as PendingPushLike[];
}

/**
 * A ticket just reached `done`. If its branch was never pushed, say so on the
 * ticket.
 *
 * The reap guard keeps those commits alive on disk, but "alive on one host's
 * disk" is not "delivered": nothing is on the remote and no PR exists. Before
 * this, the only trace was a sidebar badge on /changes, so a ticket could read
 * `done` with its work having gone nowhere and nobody would know. This makes it
 * visible in the one place an operator actually reads - the ticket timeline.
 *
 * Deliberately a NOTICE, not a block: `transitionTicket`'s gates (L1 QA, SME
 * safety) refuse the move, and refusing `→ done` here would strand every ticket
 * whose operator simply has not pushed yet. Whether this should hard-block is
 * the captain's call, not this function's.
 *
 * Idempotent: re-posts nothing for a `pending_pushes` row already noticed on
 * this ticket (a ticket can be reopened and re-completed). Best-effort by
 * contract - the caller must not let a failure here roll back the transition.
 *
 * The comment is written directly rather than through `transitions.ts`'s
 * `addComment` to keep this module free of an import cycle with its only caller.
 */
export async function noticeUnpushedWorkOnDone(args: {
  ticketId: string;
  tenantId: string;
}): Promise<{ noticed: string[] }> {
  const supabase = supabaseService();
  const holding = (await loadPendingPushesForTicket(args.ticketId, args.tenantId)).filter(
    holdsUnpushedWork,
  );
  if (holding.length === 0) return { noticed: [] };

  // Tenant-scoped: this is the idempotency read. A planted notice comment would
  // read as "already noticed" and silence the real warning that a done ticket's
  // work never left the operator's disk.
  const { data: existing } = await supabase
    .from("comments")
    .select("metadata")
    .eq("ticket_id", args.ticketId)
    .eq("tenant_id", args.tenantId)
    .eq("author_type", "system")
    .eq("author_id", UNPUSHED_WORK_COMMENT_AUTHOR);
  const alreadyNoticed = new Set(
    (existing ?? [])
      .flatMap((c) => {
        const m = c.metadata as { pending_push_ids?: unknown } | null;
        return Array.isArray(m?.pending_push_ids) ? m.pending_push_ids : [];
      })
      .filter((id): id is string => typeof id === "string"),
  );

  const fresh = holding.filter((r) => !alreadyNoticed.has(r.id));
  if (fresh.length === 0) return { noticed: [] };

  const { error } = await supabase.from("comments").insert({
    ticket_id: args.ticketId,
    tenant_id: args.tenantId,
    author_type: "system",
    author_id: UNPUSHED_WORK_COMMENT_AUTHOR,
    body: formatUnpushedWorkNotice(fresh),
    metadata: {
      kind: "unpushed_work",
      // The idempotency key. Read back by the query above, so a ticket that is
      // reopened and re-completed does not accumulate duplicate notices.
      pending_push_ids: fresh.map((r) => r.id),
    },
  });
  if (error) throw new Error(`unpushed-work notice failed: ${error.message}`);
  return { noticed: fresh.map((r) => r.id) };
}
