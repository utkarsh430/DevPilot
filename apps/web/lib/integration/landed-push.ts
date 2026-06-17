// Settling the `pending_pushes` row a landing has just made moot.
//
// THE DEFECT THIS CLOSES. `stampLanded` (`queue.server.ts`) is, by its own
// header, "the only function in the codebase that writes `tickets.landed_sha`" -
// i.e. it is already the single choke point for the fact "this ticket's work is
// now on the integration branch". But the companion write that fact implies -
// clearing the ticket's `pending_pushes` row, which is what the /changes badge
// counts and what holds the workspace against the reaper - was DUPLICATED INLINE
// at two of its four call sites and simply absent at the other two:
//
//   land-worker `stamp-landed`          (the ordinary land)      settled  ✔
//   land-worker `close-nothing-to-land` (#152, review-only)      settled  ✔
//   land-worker `close-already-landed`  (duplicate enqueue)      LEAKED   ✗
//   land-worker reaper `stamp_landed`   (dead worker reconciled) LEAKED   ✗
//
// Both leaking sites do the FULL post-land fan-out - `branch/parent-landed`,
// `promoteUnblockedDependents`, `ticket-drain/requested` - so every downstream
// consumer was told the ticket landed and only the push row was left behind,
// reading `pushed_at IS NULL` forever. On the board that is a Changes badge
// counting work that shipped; on disk it is the unpushed-work reap guard
// (`decideWorkspaceReap`) pinning a workspace nothing will ever revisit.
//
// The fix is not a sweeper. A reaper over `pending_pushes` would have hidden
// exactly this, and the stale rows were the only visible evidence the write path
// was incomplete. Instead the settle MOVED here and became a REQUIRED argument
// of `stampLanded` - so a fifth landing path cannot be written without deciding
// what happens to the push row, and "forgot to settle" stops being expressible.
//
// SCOPE, and it is deliberately narrow. This settles the ONE row the landing
// resolved (`resolveTicketPush`, the ticket's newest push), never "every
// unpushed row for this ticket". `pushed_at` non-null releases the data-loss
// reap guard, so settling a row this landing did not prove is on the remote
// could let the reaper delete the only copy of a commit - the precise thing
// `lib/workspace/unpushed-work.ts` exists to prevent. A ticket carrying a second
// push on some other branch keeps it, and keeps being counted, correctly.
//
// The write is CAS-guarded on `pushed_at IS NULL` so an earlier, genuine push
// timestamp is never overwritten by a later replay.
//
// SINCE `20260757000000`, THIS IS NO LONGER THE ONLY SETTLE, and the paragraph
// above describes THIS function rather than the system. A required parameter
// binds one function: `closeMergerOutcome` is a second writer of `landed_sha`
// and a hand-written UPDATE is a third route, and both leaked (measured: 11 of
// 12 unsettled rows on `scoursh`, all on landed tickets). A trigger on
// `tickets` now settles the ticket's rows whenever `landed_sha` goes NULL ->
// non-NULL, so a ticket carrying a second push DOES have it settled by the
// landing — the trigger sees a ticket id and a sha and no row identity, so
// that is the widest scope it can honestly express. This function keeps the
// narrow row-identified write and the trigger stands behind it; when this one
// has already run, the trigger's CAS matches nothing. See that migration's
// header for the full argument, including why the runner-side
// `checkWorkspaceReapSafety` is what keeps the data-loss invariant intact.

import type { SupabaseClient } from "@supabase/supabase-js";

export type SettleLandedPushArgs = {
  /** The row the landing resolved, or null for a genuinely branchless ticket
   *  (the ~48 non-code roles, a spec-only ticket) - a correct, common answer. */
  pendingPushId: string | null;
  /** REQUIRED. This is a service-role write with RLS off, so the co-located
   *  `.eq("tenant_id", …)` below is the entire tenant boundary. Settling a
   *  foreign row would mark ANOTHER workspace's genuinely unpushed work as
   *  pushed - dropping it off their badge and releasing their reap guard. */
  tenantId: string;
};

/**
 * Marks the landed ticket's push row settled. Returns whether a row moved
 * (`false` for a branchless ticket, and for a row already stamped by an
 * earlier attempt - both are ordinary, neither is an error).
 */
export async function settleLandedPush(
  db: SupabaseClient,
  args: SettleLandedPushArgs,
): Promise<boolean> {
  if (!args.pendingPushId) return false;

  const { data, error } = await db
    .from("pending_pushes")
    .update({ pushed_at: new Date().toISOString() })
    .eq("id", args.pendingPushId)
    .eq("tenant_id", args.tenantId)
    .is("pushed_at", null)
    .select("id");
  if (error) throw new Error(`settleLandedPush: ${error.message}`);
  return (data?.length ?? 0) > 0;
}
