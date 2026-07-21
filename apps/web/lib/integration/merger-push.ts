// THE LINK BETWEEN A LAND QUEUE ROW AND THE BRANCH IT IS SUPPOSED TO LAND.
//
// THE BUG THIS CLOSES. `integration_queue` rows are keyed on the SOURCE ticket -
// deliberately, and `enqueueForLanding`'s merger→retry edge (`decideMergerRelease`)
// goes out of its way to redirect a finished merger back to its source rather
// than enqueueing the merger itself. The source ticket is the one that gets
// `tickets.landed_sha` stamped, and that stamp is what releases every dependent
// gated on LANDED. A merger has no branch of its own and no dependents; landing
// "the merger" would stamp the wrong row and wedge the source's dependents
// forever.
//
// Meanwhile `pending-push-tracker.ts` upserts ONE row per (project, branch,
// pushed_at IS NULL) and, on the UPDATE path, wrote `ticket_id` from whichever
// run it was reacting to. A merger resolves the conflict IN THE SOURCE TICKET'S
// WORKSPACE, ON THE SOURCE TICKET'S BRANCH - so the merger's own run matched the
// source's push row and re-parented it to the merger. The queue row still named
// the source; the push row now named the merger; nothing joined them again.
//
// The land worker then behaved CORRECTLY on separated data: it looked up the
// source's branch, found no push attached to the source, and cancelled with
// "ticket has no branch with work to land". Six commits sat outside `dev` for a
// day with the board showing Done.
//
// TWO HALVES, and both are needed.
//
//   `decidePushOwnership` - the WRITE-side guard, applied in the tracker. A
//   merger contributes commits to the source's branch; it does not take
//   ownership of it. Prevents any NEW orphan.
//
//   `resolveTicketPush` - the READ-side reconciliation, applied wherever the
//   land path asks "which push carries this ticket's branch". Heals rows that
//   are ALREADY orphaned, of which the operator has live ones. Without it the
//   write-side guard fixes only tickets that conflict in the future.
//
// WHY READ-TIME RECONCILIATION RATHER THAN RE-PARENTING THE ROWS BACK. Moving
// records after the fact is what created the split, and a repair pass would race
// the tracker that caused it (the tracker fires on every `agent/run.completed`
// for the merger, so a repair and a re-steal can interleave). A read that
// derives the relationship from two columns neither writer contends on cannot
// race anything, and it needs no migration.
//
// THE DISAMBIGUATION, which is the part worth getting right. Reconciliation is
// NOT "find any push mentioning a merger" - with several conflicts in flight in
// one project that picks arbitrarily. `spawnMerger` writes BOTH ends of one
// relationship in one call:
//
//     tickets(M).parent_ticket_id   = A     (the merger's source)
//     pending_pushes(P).merger_ticket_id = M    (the push that conflicted)
//
// so the join P.merger_ticket_id → M.id → M.parent_ticket_id = A reconnects
// exactly the push whose conflict spawned exactly the merger spawned for A.
// Mergers for other tickets carry other parents and are never candidates.
//
// The constraint comes from the `merger_ticket_id` SIDE, not from the parent
// side, and that is load-bearing: `tickets.parent_ticket_id` is also ordinary
// sub-issue nesting, so "children of A" is far too wide a set. Only a ticket
// `spawnMerger` created is ever named by a `merger_ticket_id`, so starting from
// that column is what keeps a sub-issue from ever being mistaken for a merger.
//
// TENANT SCOPE. Both reads are service-role (the land worker and the reaper are
// Inngest functions with no session, so RLS is off), which makes the co-located
// `.eq("tenant_id", …)` the ENTIRE boundary - and it matters unusually much
// here, because the value returned is a BRANCH NAME that the land worker then
// merges into the integration branch. A foreign row reaching this return is a
// foreign branch handed to a merge. Hence the DI'd `SupabaseClient` + resolved
// `tenantId` (the `land-outcome-write.ts` / `lib/learning/write.ts` shape, not a
// `.server.ts` twin): the scoping is the point, and scoping nothing can test is
// the gap every one of this repo's tenant-leak rounds lived in.

import type { SupabaseClient } from "@supabase/supabase-js";

/** The push fields the land path needs off a resolved row. */
export type ResolvedPush = {
  id: string;
  branch: string;
  workspacePath: string;
  pushedAt: string | null;
  headSha: string | null;
  mergerTicketId: string | null;
  /** How the row was reached - `direct` is the ordinary case, `merger` means it
   *  was recovered through a merger that had re-parented it. Diagnostic only;
   *  no caller branches on it, but it is what makes an orphan visible in a log
   *  instead of silently looking like a normal land. */
  via: "direct" | "merger";
};

const PUSH_COLUMNS = "id, branch, workspace_path, pushed_at, head_sha, merger_ticket_id";

function mapPush(row: Record<string, unknown>, via: ResolvedPush["via"]): ResolvedPush {
  return {
    id: row.id as string,
    branch: row.branch as string,
    workspacePath: row.workspace_path as string,
    pushedAt: (row.pushed_at as string | null) ?? null,
    headSha: (row.head_sha as string | null) ?? null,
    mergerTicketId: (row.merger_ticket_id as string | null) ?? null,
    via,
  };
}

/**
 * Which `pending_pushes` row carries this ticket's branch.
 *
 * Direct ownership first - that is the ordinary case and it is byte-for-byte the
 * lookup this replaced, so a ticket whose push was never stolen resolves exactly
 * as before and never reaches the reconciliation below.
 *
 * Only when the ticket owns NO push at all do we ask whether one of its mergers
 * is holding it. That ordering matters: a source ticket that still owns its own
 * push must never have a merger's row preferred over it.
 *
 * Returns `null` for a genuinely branchless ticket - the ~48 non-code roles, a
 * review-only ticket, a spec ticket. That is a correct and common answer, and
 * the land worker's "ticket has no branch with work to land" cancel on it is
 * right and must survive.
 */
export async function resolveTicketPush(
  db: SupabaseClient,
  args: { ticketId: string; tenantId: string },
): Promise<ResolvedPush | null> {
  const { data: direct, error: directErr } = await db
    .from("pending_pushes")
    .select(PUSH_COLUMNS)
    .eq("ticket_id", args.ticketId)
    .eq("tenant_id", args.tenantId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (directErr) throw new Error(`resolveTicketPush(direct): ${directErr.message}`);
  if (direct) return mapPush(direct as Record<string, unknown>, "direct");

  // No push of its own. It may have been re-parented to a merger spawned for
  // THIS ticket. Candidates are this ticket's children; the `merger_ticket_id`
  // predicate below is what narrows them to actual mergers.
  const { data: children, error: childErr } = await db
    .from("tickets")
    .select("id")
    .eq("parent_ticket_id", args.ticketId)
    .eq("tenant_id", args.tenantId);
  if (childErr) throw new Error(`resolveTicketPush(children): ${childErr.message}`);

  const childIds = (children ?? [])
    .map((r) => (r as Record<string, unknown>).id as string)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (childIds.length === 0) return null;

  const { data: viaMerger, error: mergerErr } = await db
    .from("pending_pushes")
    .select(PUSH_COLUMNS)
    .in("merger_ticket_id", childIds)
    .eq("tenant_id", args.tenantId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (mergerErr) throw new Error(`resolveTicketPush(merger): ${mergerErr.message}`);
  if (!viaMerger) return null;

  return mapPush(viaMerger as Record<string, unknown>, "merger");
}

/**
 * Which merger, if any, owns the conflict parking this ticket's land.
 *
 * Separate from `resolveTicketPush` on purpose. The reaper asks a NARROWER
 * question - "is there a merger, and what is its status" - and its original
 * query preferred a merger-bearing row explicitly (`merger_ticket_id IS NOT
 * NULL`) rather than taking the ticket's newest push. Routing it through the
 * general resolver would silently drop that preference: a ticket holding both a
 * merger-bearing row and a newer plain one would resolve to the plain one and
 * the parked land would never be released. So the direct read here is the
 * ORIGINAL query, unchanged, and the merger walk is added strictly BEHIND it as
 * the orphan recovery - the non-orphaned path behaves byte-for-byte as before.
 */
export async function resolveMergerTicketId(
  db: SupabaseClient,
  args: { ticketId: string; tenantId: string },
): Promise<string | null> {
  const { data: direct, error } = await db
    .from("pending_pushes")
    .select("merger_ticket_id")
    .eq("ticket_id", args.ticketId)
    .eq("tenant_id", args.tenantId)
    .not("merger_ticket_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`resolveMergerTicketId(direct): ${error.message}`);
  const mergerId = (direct as Record<string, unknown> | null)?.merger_ticket_id as string | null;
  if (mergerId) return mergerId;

  // Orphaned: the push naming the merger was re-parented TO that merger, so the
  // read above finds nothing and the parked land was never released.
  const push = await resolveTicketPush(db, args);
  return push?.via === "merger" ? push.mergerTicketId : null;
}

/**
 * WRITE-side guard for the pending-push tracker's UPDATE path: who owns the
 * (project, branch) row when a run reports unpushed commits on it.
 *
 * Pure, because `pending-push-tracker.ts` is an Inngest function module and
 * cannot load under Vitest - a rule left inline there would be a rule nothing
 * can test, which is exactly how the re-parent shipped unnoticed.
 *
 * The rule is deliberately NARROW: ownership is preserved only when the
 * incoming run's ticket IS the row's own merger. Every other update re-parents
 * exactly as it did before, so this changes nothing outside the one shape that
 * produced the bug.
 *
 * A blanket "never re-parent" would also have fixed this case, and was not
 * chosen: the tracker's re-parent is load-bearing on the ordinary path (a row
 * is keyed on the branch, and the run that last touched the branch is normally
 * the right owner), and widening a fix past the defect it is closing is how the
 * NEXT silent behaviour change ships.
 */
export function decidePushOwnership(args: {
  existingTicketId: string | null;
  existingMergerTicketId: string | null;
  incomingTicketId: string;
}): { ticketId: string; reparented: boolean; reason: "merger_keeps_source" | "reparent" } {
  const { existingTicketId, existingMergerTicketId, incomingTicketId } = args;

  if (
    existingMergerTicketId &&
    existingMergerTicketId === incomingTicketId &&
    existingTicketId &&
    existingTicketId !== incomingTicketId
  ) {
    // The merger is committing onto the source's branch. It contributes the
    // commits; it does not take the branch. Leaving `ticket_id` where it is
    // keeps the queue row (which names the source) joined to the push.
    return { ticketId: existingTicketId, reparented: false, reason: "merger_keeps_source" };
  }

  return { ticketId: incomingTicketId, reparented: true, reason: "reparent" };
}
