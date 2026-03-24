// Ticket-dependency helpers.
//
// Phase 1 / M3 — `ticket_dependencies` rows (ticket_id, blocks_ticket_id) say
// "this ticket cannot start until the blocker is done". The dispatcher refuses
// to move a ticket into `ready` while it has at least one open blocker.
//
// Both helpers use the RLS-bound server client so the tenant guard runs
// implicitly (the `ticket_dependencies_member_read` policy joins through
// `tickets`).

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer, supabaseService } from "@/lib/db/server";
import type { BoardTicket } from "@/components/board/types";
import type { TicketStatus } from "@/lib/board/state";
import {
  classifyBlocker,
  isBlockerOpen,
  isResolvableSha,
  summarizeBlockers,
  LAND_PENDING_QUEUE_STATES,
  type BlockerLandState,
  type BlockerSummary,
} from "@/lib/integration/landed";

/**
 * Two FKs from ticket_dependencies → tickets force PostgREST to use the
 * explicit constraint name when embedding. Postgres autogenerates these
 * from `<table>_<column>_fkey`.
 */
const BLOCKER_FK = "ticket_dependencies_blocks_ticket_id_fkey";

/**
 * The relation flavours that actually BLOCK. `ticket_dependencies` was
 * generalised into a multi-flavour relations table (20260607010000), but the
 * blocker queries kept selecting every row - so `related` and `duplicate` rows
 * acted as hard "not ready" blockers. That is not a theoretical edge: an
 * @mention in a comment auto-creates a `related` row (`parse-mentions.ts`), so
 * @mentioning a ticket that isn't done yet silently wedged the commenter's own
 * ticket out of `ready` forever, with nothing on the board explaining why.
 *
 *   • `blocked_by` - the original semantics: cannot start until it's done.
 *   • `builds_on`  - a stacked branch; the parent must land first.
 *   • `related` / `duplicate` - references. Informational, never blocking.
 *
 * Every readiness/blocker query filters on this set. Keep it as the single
 * source of truth rather than re-listing the strings at each call site.
 */
export const BLOCKING_RELATION_TYPES = ["blocked_by", "builds_on"] as const;

async function fetchBlockerRows(
  supabase: SupabaseClient,
  ticketId: string,
  tenantId: string,
): Promise<BoardTicket[]> {
  // Two-hop: dependencies → blocker ids → tickets. Doing it in two queries
  // keeps the PostgREST shape stable across server / service clients and
  // avoids the embedded-FK alias gotcha (PostgREST's 2-FK disambiguation
  // syntax has changed across versions).
  const { data: deps, error: depsErr } = await supabase
    .from("ticket_dependencies")
    .select("blocks_ticket_id")
    .eq("ticket_id", ticketId)
    .in("relation_type", BLOCKING_RELATION_TYPES as unknown as string[]);
  if (depsErr || !deps || deps.length === 0) {
    // touch the constant so editors / linters don't drop the import-time guard
    void BLOCKER_FK;
    return [];
  }
  const ids = deps.map((d) => d.blocks_ticket_id as string).filter(Boolean);
  if (ids.length === 0) return [];
  const { data: rows, error: ticketsErr } = await supabase
    .from("tickets")
    .select(
      // WI-5: landed_sha / integrated_at are the readiness truth. They are read
      // HERE, in the one data source that feeds both `hasOpenBlockers` and the
      // inline `→ ready` guard in transitions.ts, so the two can never disagree.
      "id, project_id, title, description, acceptance_criteria, status, retry_count, updated_at, column_position, ticket_number, landed_sha, integrated_at",
    )
    .in("id", ids)
    // Defence in depth on the service-role path: a blocker of a ticket in tenant
    // T is, by the schema-wide tenant-matches-parent trigger, itself in T. So
    // this predicate never drops a legitimate blocker — it only refuses to
    // resolve a dependency row that points out of the tenant.
    .eq("tenant_id", tenantId);
  if (ticketsErr || !rows) return [];

  // WI-5: "is a landing still owed for this blocker?" A done blocker with NO
  // queue row has nothing owed (a PM ticket, a design ticket, an auto-spawned
  // merger — none of them ever produce a branch), and gating on landed_sha alone
  // would wedge their dependents forever. See lib/integration/landed.ts.
  const landPending = await fetchLandPendingSet(supabase, ids, tenantId);

  return rows.map((row) => ({
    id: row.id as string,
    projectId: (row.project_id as string | null) ?? null,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    acceptanceCriteria: (row.acceptance_criteria as string | null) ?? null,
    status: row.status as TicketStatus,
    retryCount: (row.retry_count as number | null) ?? 0,
    updatedAt: row.updated_at as string,
    columnPosition: (row.column_position as number | null) ?? null,
    ticketNumber: (row.ticket_number as number | null) ?? null,
    autoPromoteWhenUnblocked: false,
    lastCommentAuthor: null,
    lastCommentBody: null,
    lastCommentAt: null,
    commentCount: 0,
    // Blockers render as compact reference cards in the drawer — they don't
    // need their own push CTA (it would be a UX rabbit hole). Leave null.
    pendingPush: null,
    // Blocker reference cards skip the property/relation/sub-issue eager
    // fields — the drawer only renders title + status for them.
    priority: 0,
    estimateCents: null,
    dueAt: null,
    labels: [],
    parentTicketId: null,
    subIssueTotal: 0,
    subIssueDone: 0,
    // Blocker reference cards render only title + status; the safety badge is
    // shown on the real board card, not these compact refs.
    safetyCritical: false,
    // WI-5 — surfaced on blocker cards so a "done" blocker that is still holding
    // the dependent back is legible on the board instead of looking like a bug.
    landedSha: (row.landed_sha as string | null) ?? null,
    integratedAt: (row.integrated_at as string | null) ?? null,
    landOpenness: classifyBlocker({
      status: row.status as TicketStatus,
      landedSha: (row.landed_sha as string | null) ?? null,
      landPending: landPending.has(row.id as string),
    }),
  }));
}

/**
 * Which of these tickets have an integration_queue row that still owes a
 * landing? One query, `IN (…)` over the blocker ids.
 *
 * Read through the SERVICE client even when the caller handed us an RLS-bound
 * one: `integration_queue` denies non-service writes and only exposes SELECT to
 * tenant members, and a blocker the user can see is a blocker whose land state
 * they are entitled to see. Failing open (empty set → "nothing owed" → blocker
 * reads as closed) would silently restore the pre-WI-5 behaviour, so an error
 * here is loud rather than quiet.
 */
async function fetchLandPendingSet(
  _supabase: SupabaseClient,
  ticketIds: readonly string[],
  tenantId: string,
): Promise<Set<string>> {
  if (ticketIds.length === 0) return new Set();
  const svc = supabaseService();
  const { data, error } = await svc
    .from("integration_queue")
    .select("ticket_id")
    .in("ticket_id", ticketIds as string[])
    // Tenant-scoped: `integration_queue`'s member write policy pins the row's own
    // `tenant_id` and says nothing about `ticket_id`, so an unscoped read keyed on
    // OUR ticket ids would answer from a row a hostile tenant planted. The queue
    // row for a ticket in T is in T, so nothing legitimate is excluded.
    .eq("tenant_id", tenantId)
    .in("status", LAND_PENDING_QUEUE_STATES as unknown as string[]);
  if (error) {
    // Do NOT fail open. An unreadable queue would make every done-but-unlanded
    // blocker read as closed, which is exactly the unsafe state WI-5 exists to
    // prevent. Treat it as "a landing may be owed" for every candidate, so the
    // dependent waits (and a human can override) rather than branching off a
    // tree that might be missing its parent's commits.
    console.warn(`[dependencies] integration_queue read failed: ${error.message}`);
    return new Set(ticketIds);
  }
  return new Set((data ?? []).map((r) => r.ticket_id as string));
}

/** The land state of every blocker, classified. The shape both the readiness
 *  guard and the drain probe reason over. */
function toLandStates(blockers: readonly BoardTicket[]): BlockerLandState[] {
  return blockers.map((b) => ({
    status: b.status,
    landedSha: b.landedSha ?? null,
    // `landOpenness` was already computed against the live queue in
    // fetchBlockerRows; recover the landPending bit from it rather than
    // re-querying (a done+unlanded blocker is awaiting_land iff a land is owed).
    landPending: b.landOpenness === "awaiting_land",
  }));
}

/**
 * Load the blockers (tickets this ticket depends on) for `ticketId`.
 * RLS-bound — used by the drawer / API route. Returns full BoardTicket shape
 * so the UI can render blocker cards identically to board cards.
 */
export async function loadBlockers(ticketId: string, tenantId: string): Promise<BoardTicket[]> {
  const supabase = await supabaseServer();
  return fetchBlockerRows(supabase as unknown as SupabaseClient, ticketId, tenantId);
}

/**
 * True iff any blocker still holds this ticket back.
 *
 * WI-5 — this used to be `b.status !== "done"`. It is now "the blocker's work
 * isn't on the integration branch yet, and a landing is still owed for it"
 * (`isBlockerOpen`, lib/integration/landed.ts). `done` is not the same fact as
 * `landed`: between the two sits the land worker, and a dependent started in
 * that window branches off a dev tip that does not contain its parent's commits.
 *
 * Uses the service-role client because callers (transitionTicket) operate from
 * server actions and durable engine steps where tenant context is already
 * established and RLS would be redundant.
 */
export async function hasOpenBlockers(ticketId: string, tenantId: string): Promise<boolean> {
  const blockers = await loadBlockersService(ticketId, tenantId);
  return toLandStates(blockers).some(isBlockerOpen);
}

/**
 * The classified blocker state for `ticketId` — how many blockers are open, and
 * crucially WHY. The drain needs the distinction (`working` upstream ⇒ force and
 * record stuck; `awaiting_land` ⇒ defer and wait for the worker) and so does the
 * `→ ready` guard (a human may override the latter, never the former).
 */
export async function loadBlockerSummaryService(
  ticketId: string,
  tenantId: string,
): Promise<{
  blockers: BoardTicket[];
  summary: BlockerSummary;
}> {
  const blockers = await loadBlockersService(ticketId, tenantId);
  return { blockers, summary: summarizeBlockers(toLandStates(blockers)) };
}

/**
 * Service-role variant: returns the full blocker list for an exception payload
 * (`BlockedByDependencyError.blockers`). Same data shape as `loadBlockers`.
 */
export async function loadBlockersService(
  ticketId: string,
  tenantId: string,
): Promise<BoardTicket[]> {
  const supabase = supabaseService();
  return fetchBlockerRows(supabase as unknown as SupabaseClient, ticketId, tenantId);
}

/**
 * WI-5.2 — resolve the base a `builds_on` child roots its workspace at.
 *
 * Returns one of three roots, and WHICH one is the whole point:
 *
 *   • `{ kind: "landed" }`  — the parent has LANDED. Root the child on the
 *     integration branch AT the parent's `landed_sha`. Deterministic: the child
 *     gets a tree that provably contains its parent's work and nothing that
 *     landed after it. This is the case `builds_on` should almost always be in
 *     once auto-land is on, and it is what makes stacked work reproducible.
 *
 *   • `{ kind: "branch" }` — the parent has NOT landed. Root the child on the
 *     parent's own `devpilot/<slug>` branch, which is where the parent's commits
 *     actually live right now.
 *
 *   • `null` — no builds_on parent, or the parent was abandoned (`failed`).
 *     The caller falls back to the integration tip.
 *
 * THE STALE-TIP FALLBACK IS GONE, and its deletion is the fix. The old code
 * gated on `status ∈ {assigned, in_progress, in_review}` and returned null for
 * anything else — including a parent that was DONE. Null meant "root at the
 * integration tip", and the comment justified it with "the parent's work has
 * either landed and is reachable from integration_branch, or is abandoned". That
 * assumption was simply false: nothing landed the parent. So the moment a parent
 * finished, its children silently started rooting at an integration tip that did
 * NOT contain the parent's commits — building on a tree that never existed. That
 * is the original stale-tree damage, and a `done` parent is the exact case that
 * triggered it.
 *
 * Now: a done-but-unlanded parent roots the child on the parent's BRANCH (the
 * work is there), and a landed parent roots it on the sha (the work is on dev).
 * There is no longer any path where a parent's completion moves its children off
 * of its work. `builds_on` also becomes strictly serialized-after-land: WI-5's
 * readiness gate holds the child out of `ready` until the parent's landing is
 * stamped, so in the steady state a child is dispatched only once the `landed`
 * root above is available.
 */
export type BuildsOnBase = {
  parentTicketId: string;
} & (
  | {
      kind: "landed";
      /** Integration branch to clone (e.g. "dev"). */
      baseBranch: string;
      /** The exact commit on it that contains the parent's work. */
      baseSha: string;
    }
  | {
      kind: "branch";
      /** The parent's branch WITHOUT the `devpilot/` prefix — the caller prepends it. */
      parentBranchName: string;
    }
);

export async function loadBuildsOnBase(ticketId: string): Promise<BuildsOnBase | null> {
  const supabase = supabaseService();

  // 1. Find the builds_on parent. We expect at most one in practice; if
  //    multiple are wired, pick the first (most-recently-created) and log a
  //    warning. Multi-parent stacks are out of scope for IB-C.
  const { data: depRows, error: depErr } = await supabase
    .from("ticket_dependencies")
    .select("blocks_ticket_id")
    .eq("ticket_id", ticketId)
    .eq("relation_type", "builds_on");
  if (depErr) {
    console.warn(`[builds_on] lookup failed for ticket ${ticketId}: ${depErr.message}`);
    return null;
  }
  if (!depRows || depRows.length === 0) return null;
  if (depRows.length > 1) {
    console.warn(
      `[builds_on] ticket ${ticketId} has ${depRows.length} builds_on parents; using the first`,
    );
  }
  const first = depRows[0];
  if (!first) return null;
  const parentId = first.blocks_ticket_id as string;

  const { data: parent } = await supabase
    .from("tickets")
    .select("status, git_branch_name, title, project_id, landed_sha")
    .eq("id", parentId)
    .maybeSingle();
  if (!parent) return null;

  // 2. Landed parent → root on the integration branch AT the parent's sha.
  //    `isResolvableSha` filters out the migration's `backfill` sentinel: those
  //    are historical tickets whose real sha is unknowable, and whose work IS
  //    already reachable from the integration tip, so the child correctly falls
  //    through to the tip (null) rather than asking git to check out a ref that
  //    doesn't exist.
  const landedSha = (parent.landed_sha as string | null) ?? null;
  if (isResolvableSha(landedSha)) {
    const projectId = (parent.project_id as string | null) ?? null;
    const integrationBranch = projectId ? await loadIntegrationBranch(projectId) : null;
    if (integrationBranch) {
      return {
        parentTicketId: parentId,
        kind: "landed",
        baseBranch: integrationBranch,
        baseSha: landedSha,
      };
    }
    // Landed, but the project has no integration branch configured — nothing to
    // root the sha against. Fall through to the parent's branch, which still
    // holds the work.
  }
  if (landedSha) {
    // Backfilled (or otherwise unusable) sha: the parent's work is on the
    // integration tip. Root there — that's the caller's default when we
    // return null.
    return null;
  }

  // 3. Unlanded parent → root on the parent's own branch, which is where its
  //    commits actually are. This INCLUDES a `done` parent (the case the old
  //    active-status gate silently sent to the stale integration tip). A
  //    `failed` parent is abandoned: there is nothing worth stacking on, so the
  //    child roots at the integration tip.
  if ((parent.status as string) === "failed") return null;

  // Resolve the parent's branch name. Prefer git_branch_name (cached); fall
  // back to a slugify of title using the same rules as the runner.
  const stored = (parent.git_branch_name as string | null) ?? null;
  const fromTitle = stored ? null : slugifyForBranch((parent.title as string | null) ?? "");
  const branchName = stored ?? fromTitle;
  if (!branchName) return null;

  return { parentTicketId: parentId, kind: "branch", parentBranchName: branchName };
}

async function loadIntegrationBranch(projectId: string): Promise<string | null> {
  const supabase = supabaseService();
  const { data } = await supabase
    .from("projects")
    .select("integration_branch, default_branch")
    .eq("id", projectId)
    .maybeSingle();
  if (!data) return null;
  return (
    ((data.integration_branch as string | null) ?? (data.default_branch as string | null)) || null
  );
}

function slugifyForBranch(s: string): string {
  // Mirrors apps/runner/src/workspace.ts:slugify — keep in sync.
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "ticket"
  );
}

/**
 * Slice IB-C — load all tickets that `builds_on` the given parent. Used by
 * the cascade-rebase Inngest function when the parent's push lands: each
 * child needs to rebase onto the new integration tip.
 */
export async function loadBuildsOnChildren(
  parentTicketId: string,
): Promise<Array<{ id: string; status: string }>> {
  const supabase = supabaseService();
  const { data: deps, error: depErr } = await supabase
    .from("ticket_dependencies")
    .select("ticket_id")
    .eq("blocks_ticket_id", parentTicketId)
    .eq("relation_type", "builds_on");
  if (depErr || !deps || deps.length === 0) return [];

  const ids = deps.map((d) => d.ticket_id as string);
  const { data: rows } = await supabase.from("tickets").select("id, status").in("id", ids);
  return (rows ?? []).map((r) => ({
    id: r.id as string,
    status: r.status as string,
  }));
}
