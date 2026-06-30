// The IO half of the scaffolder hold/release (pure policy: `./scaffolder.ts`).
//
// ONE row, released by one of three paths. `createProjectWithNewRepoAction` is
// the only creator of a `project_scaffolder` ticket; when the operator asked for
// a plan it inserts that row HELD (`plan_hold`, `backlog`, undispatched) and
// these race to release it:
//
//   • `commitPlanAction` - the happy path. Releases it WITH the plan's context
//     (stamps `plan_session_id`) and roots the committed backlog on it.
//   • `discardPlanSessionAction` - the operator saying "not planning this after
//     all". Releases with BASE context, immediately. This is also the
//     human-driven escape hatch that keeps the empty-repo guarantee off the
//     fallback's best-effort `inngest.send`, now that a held row cannot be
//     promoted by hand.
//   • `scaffolderFallbackFn` - the safety net. After a TTL, releases a
//     still-held row with BASE context (no `plan_session_id`), so an abandoned
//     plan can never leave an empty repo empty forever.
//
// None of them may INSERT - that is the #79 invariant (a second creator is
// exactly what produced the duplicate-scaffolder bug PR #79 fixed).
//
// The races between them are real (an operator can commit a plan at the instant
// the TTL fires) and are settled the same way every other atomic claim in this
// tree is: the claim lives in the UPDATE's WHERE clause, so the loser matches NO
// row and returns `released: false`. It is never a read-then-write - that is a
// TOCTOU both callers win, and "both win" here means two dispatch events on one
// ticket, i.e. two agents authoring the first commit of one empty repo.

import { sendEventBounded } from "@/lib/engine/send-bounded";
import { supabaseService } from "@/lib/db/server";
import { SCAFFOLDER_ROLE_SLUG, isRootableScaffolder } from "@/lib/plan/scaffolder";

export type HeldScaffolder = { ticketId: string };

/**
 * Find the project's HELD scaffolder row, if any.
 *
 * Keyed on `plan_hold`, NOT on `status = 'backlog'`. The status shape is worn by
 * three different tickets (the genuinely-held row, a released row an operator
 * later reset to Backlog, and a human-filed second scaffolder); only one of them
 * may be released, and `plan_hold` is the only thing that tells them apart. See
 * migration 20260727000000.
 *
 * Read-only - the claim in `releaseScaffolder` is what actually decides. This
 * exists so `commitPlanAction` can order its work around the claim.
 *
 * Returns null when the project has no scaffolder (connect-existing), when it
 * was never held (a plain create dispatched it at `ready`), or when some path
 * already released it.
 */
export async function findHeldScaffolder(args: {
  tenantId: string;
  projectId: string;
}): Promise<HeldScaffolder | null> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("tickets")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("project_id", args.projectId)
    .eq("requested_role", SCAFFOLDER_ROLE_SLUG)
    .eq("plan_hold", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return { ticketId: data.id as string };
}

/**
 * Find the project's scaffolder to ROOT the committed backlog on - held or not.
 *
 * A separate question from "is it still held", and the reason it is separate is
 * a bug: gating rooting on the hold silently dropped it whenever the scaffolder
 * had already been released (a discussion longer than the hold TTL, or an
 * operator promote), leaving every committed ticket branching off an unseeded
 * repo. Rooting on an already-running or already-done scaffolder is correct and
 * costs nothing - see `planScaffolderRooting` / `isRootableScaffolder`.
 *
 * Oldest-first: if a project somehow carries more than one scaffolder (a human
 * can file one from the board), the ORIGINAL seed is the one the plan roots on.
 */
export async function findScaffolderToRootOn(args: {
  tenantId: string;
  projectId: string;
}): Promise<HeldScaffolder | null> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("tickets")
    .select("id, status")
    .eq("tenant_id", args.tenantId)
    .eq("project_id", args.projectId)
    .eq("requested_role", SCAFFOLDER_ROLE_SLUG)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  if (!isRootableScaffolder(String(data.status))) return null;
  return { ticketId: data.id as string };
}

export type ReleaseResult =
  | { released: true; ticketId: string }
  | { released: false; reason: string };

/**
 * Release a held scaffolder: flip `backlog → ready`, clear the hold, dispatch.
 *
 * `.eq("plan_hold", true)` is the claim, and clearing `plan_hold` in the same
 * statement is what makes it ONE-SHOT: the row can never be claimed again, by
 * this path or any other, no matter what its status later becomes. An UPDATE
 * that matches no row means somebody else already released it, and we return
 * `released: false` rather than dispatching - a dispatch on a row we did not
 * claim is the double-run this whole design exists to prevent.
 *
 * `status = 'backlog'` is claimed too, so the manual-promote race resolves the
 * same way from either side (though the `→ ready` gate in `transitionTicket`
 * refuses that promote outright while the hold is live).
 *
 * `planSessionId` is the enrichment link: set it and the dispatch prompt picks
 * up the plan brief through the single injection seam (`lib/roles/context.ts`).
 * The fallback passes null - an abandoned plan has no confirmed context to
 * carry, so the ticket runs with base context exactly as a plain create's
 * scaffolder does.
 *
 * Provenance note: `ready` here is still operator-originated. The commit path
 * is a human clicking "Commit plan"; the fallback path traces back to a human
 * clicking "Create project" with a scaffold the platform PROMISED to run. No
 * agent can reach this function.
 */
export async function releaseScaffolder(args: {
  tenantId: string;
  ticketId: string;
  planSessionId: string | null;
  /** For the log line - which path released it. */
  via: "plan-commit" | "plan-discard" | "fallback";
}): Promise<ReleaseResult> {
  const supabase = supabaseService();
  // Clearing the hold is part of the claim, not bookkeeping: it is what stops
  // the sleeping TTL fallback from releasing this row a second time if it is
  // ever reset to Backlog later (a "Discard & restart from dev", a human reset).
  const patch: Record<string, unknown> = { status: "ready", plan_hold: false };
  if (args.planSessionId) patch.plan_session_id = args.planSessionId;

  const { data, error } = await supabase
    .from("tickets")
    .update(patch)
    .eq("id", args.ticketId)
    .eq("tenant_id", args.tenantId)
    .eq("requested_role", SCAFFOLDER_ROLE_SLUG)
    // The claim. `plan_hold` is the identity of the instance we parked, so this
    // guards the commit/fallback race, a re-entrant call, AND a row that was
    // released long ago and has since cycled back through Backlog.
    .eq("plan_hold", true)
    .eq("status", "backlog")
    .select("id");
  if (error) {
    return { released: false, reason: `update-failed:${error.message.slice(0, 120)}` };
  }
  if (!data || data.length === 0) {
    // Already released, already running, or moved by a human. Not an error -
    // this is the idempotence the two paths are built on.
    return { released: false, reason: "not-held" };
  }

  try {
    await sendEventBounded({
      name: "ticket/dispatch-needed",
      data: { ticketId: args.ticketId, tenantId: args.tenantId },
    });
  } catch (err) {
    // The row is already `ready` in the DB, and we've consumed the claim - the
    // same posture the create action takes on a flaky send. The board shows a
    // ready ticket; the next transition or the stale-run reaper picks it up.
    console.warn(
      `[scaffolder-release] via=${args.via} ticket=${args.ticketId} dispatch send failed: ${String(err)}`,
    );
  }
  console.log(`[scaffolder-release] via=${args.via} released ticket=${args.ticketId}`);
  return { released: true, ticketId: args.ticketId };
}
