// Data-loading helpers for the Work Board. Use the RLS-bound server client
// so a user only ever sees their own tenant's tickets.

import { supabaseServer } from "@/lib/db/server";
import type {
  BoardComment,
  BoardTicket,
  BoardTicketLabel,
  TicketPriority,
} from "@/components/board/types";
import type { TicketStatus } from "@/lib/board/state";
import type { DepSuggestion } from "@/lib/engine/dep-suggest";
import { deriveLandingState } from "@/lib/integration/landing-state";
import {
  loadTicketLandingRecords,
  type TicketLandingRecords,
} from "@/lib/integration/landing-records";

const MAX_LISTED_TICKETS = 200;

/**
 * Load tickets for the board.
 *
 * When `projectId` is a uuid, the board is project-scoped — only tickets
 * with `project_id = projectId` are returned. When `projectId` is null
 * ("All projects" mode), every tenant ticket is returned, including
 * legacy ones with `project_id IS NULL` from before M5a.
 */
export async function loadBoardTickets(
  projectId: string | null = null,
  tenantId: string | null = null,
): Promise<BoardTicket[]> {
  const supabase = await supabaseServer();
  // One round-trip for tickets; another for their last comments.
  let query = supabase
    .from("tickets")
    .select(
      "id, project_id, title, description, acceptance_criteria, status, retry_count, updated_at, column_position, ticket_number, auto_promote_when_unblocked, priority, estimate_cents, due_at, parent_ticket_id, safety_critical, suggested_dependencies, landed_sha",
    )
    // C3 — backlog DAG ordering. `column_position` is written by
    // commitPlanAction's topological sort; legacy / operator-created tickets
    // tie at 0 and fall through to the secondary `updated_at desc` order
    // (which matches today's behaviour for non-plan-committed work).
    .order("column_position", { ascending: true })
    .order("updated_at", { ascending: false })
    .limit(MAX_LISTED_TICKETS);
  if (projectId) {
    query = query.eq("project_id", projectId);
  }
  const { data: tickets, error } = await query;
  if (error || !tickets) return [];
  if (tickets.length === 0) return [];

  const ticketIds = tickets.map((t) => t.id);
  const { data: comments } = await supabase
    .from("comments")
    .select("ticket_id, author_id, author_type, body, created_at")
    .in("ticket_id", ticketIds)
    .order("created_at", { ascending: false });

  const lastByTicket = new Map<
    string,
    { author: string; body: string; createdAt: string; count: number }
  >();
  for (const c of comments ?? []) {
    const existing = lastByTicket.get(c.ticket_id);
    if (!existing) {
      lastByTicket.set(c.ticket_id, {
        author: `${c.author_type}:${c.author_id}`,
        body: c.body,
        createdAt: c.created_at,
        count: 1,
      });
    } else {
      existing.count += 1;
    }
  }

  // M5i — pending_pushes lookup so each card can surface a "Review N changes"
  // CTA into the existing /changes/<id> flow. We only want the most recent
  // unpushed row per ticket; the realtime hook in BoardClient overlays live
  // updates on top of this seed.
  const { data: pushes } = await supabase
    .from("pending_pushes")
    .select("id, ticket_id, branch, unpushed_count, updated_at")
    .in("ticket_id", ticketIds)
    .is("pushed_at", null)
    .order("updated_at", { ascending: false });

  const latestPushByTicket = new Map<
    string,
    { id: string; branch: string; unpushedCount: number; updatedAt: string }
  >();
  for (const p of pushes ?? []) {
    const tid = (p as { ticket_id: string | null }).ticket_id;
    if (!tid) continue;
    if (latestPushByTicket.has(tid)) continue; // rows are already updated_at DESC
    latestPushByTicket.set(tid, {
      id: p.id,
      branch: p.branch,
      unpushedCount: (p as { unpushed_count: number | null }).unpushed_count ?? 0,
      updatedAt: p.updated_at,
    });
  }

  // Landing visibility — the evidence behind each card's "did this ticket's
  // work actually reach dev?" chip. Two more reads (pending_pushes without the
  // `pushed_at IS NULL` filter, and integration_queue), reconciled by the pure
  // `deriveLandingState`. Skipped entirely when the caller supplied no tenant:
  // the loader's `.eq("tenant_id", …)` is its isolation boundary, and a chip is
  // an enrichment — degrading to "no landing state" is strictly better than
  // running the read unscoped.
  const landingRecords = tenantId
    ? await loadTicketLandingRecords(supabase, tenantId, ticketIds)
    : new Map<string, TicketLandingRecords>();

  // M1 — labels. Single round-trip joins `ticket_labels` to `labels` so each
  // card can render its chip row from server-rendered data. Realtime UPDATEs
  // on `labels`/`ticket_labels` later fold deltas in via the existing channel.
  const { data: ticketLabels } = await supabase
    .from("ticket_labels")
    .select("ticket_id, labels(id, name, color)")
    .in("ticket_id", ticketIds);

  // PostgREST returns the embedded `labels` as either a singular object or
  // an array depending on how the client types it; cast through unknown so
  // we can normalise both shapes into one push.
  const labelsByTicket = new Map<string, BoardTicketLabel[]>();
  for (const row of (ticketLabels ?? []) as unknown as Array<{
    ticket_id: string;
    labels:
      | { id: string; name: string; color: string }
      | Array<{ id: string; name: string; color: string }>
      | null;
  }>) {
    const lbls = Array.isArray(row.labels) ? row.labels : row.labels ? [row.labels] : [];
    if (lbls.length === 0) continue;
    const list = labelsByTicket.get(row.ticket_id) ?? [];
    for (const lbl of lbls) {
      list.push({ id: lbl.id, name: lbl.name, color: lbl.color });
    }
    labelsByTicket.set(row.ticket_id, list);
  }

  // M2 — sub-issue progress chip. One query for every direct child of any
  // visible ticket, then aggregate done vs total per parent. Children
  // outside the visible window aren't surfaced (intentional — board is a
  // bounded snapshot, drawer does its own deep query).
  const { data: subIssueRows } = await supabase
    .from("tickets")
    .select("parent_ticket_id, status")
    .in("parent_ticket_id", ticketIds);

  const subIssueByParent = new Map<string, { total: number; done: number }>();
  for (const row of (subIssueRows ?? []) as Array<{
    parent_ticket_id: string | null;
    status: TicketStatus;
  }>) {
    const pid = row.parent_ticket_id;
    if (!pid) continue;
    const agg = subIssueByParent.get(pid) ?? { total: 0, done: 0 };
    agg.total += 1;
    if (row.status === "done") agg.done += 1;
    subIssueByParent.set(pid, agg);
  }

  return tickets.map((t) => {
    const last = lastByTicket.get(t.id);
    const subAgg = subIssueByParent.get(t.id) ?? { total: 0, done: 0 };
    const rawPriority = (t as { priority: number | null }).priority ?? 0;
    return {
      id: t.id,
      projectId: (t as { project_id: string | null }).project_id ?? null,
      title: t.title,
      description: t.description,
      acceptanceCriteria: t.acceptance_criteria,
      status: t.status as TicketStatus,
      retryCount: t.retry_count ?? 0,
      updatedAt: t.updated_at,
      columnPosition: (t as { column_position: number | null }).column_position ?? null,
      ticketNumber: (t as { ticket_number: number | null }).ticket_number ?? null,
      autoPromoteWhenUnblocked:
        (t as { auto_promote_when_unblocked: boolean | null }).auto_promote_when_unblocked === true,
      lastCommentAuthor: last?.author ?? null,
      lastCommentBody: last?.body ?? null,
      lastCommentAt: last?.createdAt ?? null,
      commentCount: last?.count ?? 0,
      pendingPush: latestPushByTicket.get(t.id) ?? null,
      priority: (rawPriority >= 0 && rawPriority <= 4 ? rawPriority : 0) as TicketPriority,
      estimateCents: (t as { estimate_cents: number | null }).estimate_cents ?? null,
      dueAt: (t as { due_at: string | null }).due_at ?? null,
      labels: labelsByTicket.get(t.id) ?? [],
      parentTicketId: (t as { parent_ticket_id: string | null }).parent_ticket_id ?? null,
      subIssueTotal: subAgg.total,
      subIssueDone: subAgg.done,
      safetyCritical: (t as { safety_critical: boolean | null }).safety_critical === true,
      suggestedDependencies:
        (t as { suggested_dependencies: DepSuggestion[] | null }).suggested_dependencies ?? [],
      landedSha: (t as { landed_sha: string | null }).landed_sha ?? null,
      landingState: tenantId
        ? deriveLandingState({
            landedSha: (t as { landed_sha: string | null }).landed_sha ?? null,
            push: landingRecords.get(t.id)?.push ?? null,
            queue: landingRecords.get(t.id)?.queue ?? null,
            nothingToLandNotice: landingRecords.get(t.id)?.nothingToLandNotice ?? null,
          })
        : undefined,
    };
  });
}

export async function loadTicketComments(ticketId: string): Promise<BoardComment[]> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("comments")
    .select("id, author_type, author_id, body, created_at, metadata")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data.map((c) => ({
    id: c.id,
    authorType: c.author_type as BoardComment["authorType"],
    authorId: c.author_id,
    body: c.body,
    createdAt: c.created_at,
    metadata: (c as { metadata?: unknown }).metadata as Record<string, unknown> | null,
  }));
}

/** Bound on how many dependency rows we load for the graph view. */
const MAX_LISTED_DEPENDENCIES = 500;

/** Shape of a ticket-dependency row used by the board graph view. */
export type TicketDependencyEdge = {
  ticket_id: string;
  blocks_ticket_id: string;
};

/**
 * Load ticket dependency edges for the board graph view (G2).
 *
 * Each row reads "this ticket cannot start until the blocker is done"; the
 * graph renders an edge from `blocks_ticket_id` (source) → `ticket_id`
 * (target).
 *
 * Tenant isolation is enforced by the `ticket_dependencies_member_read`
 * RLS policy (see `20260601000000_core.sql`), which gates on the parent
 * ticket's tenant. When `projectId` is non-null we additionally scope to
 * that project by intersecting both endpoints with the set of project
 * ticket ids — keeps the graph honest when an operator pins to a single
 * project (otherwise cross-project edges would leak in for multi-project
 * tenants).
 */
export async function loadTicketDependencies(
  projectId: string | null = null,
): Promise<TicketDependencyEdge[]> {
  const supabase = await supabaseServer();
  // When a project is active, resolve its ticket id set first so we can
  // intersect both edge endpoints. RLS still scopes us to the tenant.
  let projectTicketIds: Set<string> | null = null;
  if (projectId) {
    const { data: pTickets, error: pErr } = await supabase
      .from("tickets")
      .select("id")
      .eq("project_id", projectId)
      .limit(MAX_LISTED_DEPENDENCIES * 4);
    if (pErr || !pTickets) return [];
    projectTicketIds = new Set(pTickets.map((t) => t.id as string));
    if (projectTicketIds.size === 0) return [];
  }
  const { data, error } = await supabase
    .from("ticket_dependencies")
    .select("ticket_id, blocks_ticket_id")
    .limit(MAX_LISTED_DEPENDENCIES);
  if (error || !data) return [];
  const edges = data.map((d) => ({
    ticket_id: d.ticket_id as string,
    blocks_ticket_id: d.blocks_ticket_id as string,
  }));
  if (projectTicketIds) {
    return edges.filter(
      (e) => projectTicketIds!.has(e.ticket_id) && projectTicketIds!.has(e.blocks_ticket_id),
    );
  }
  return edges;
}
