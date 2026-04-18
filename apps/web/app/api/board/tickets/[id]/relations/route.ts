// GET /api/board/tickets/[id]/relations
// Returns the ticket's relations grouped by direction/type plus its direct
// sub-issues. Used by the TicketDrawer's M2 Relations / Sub-issues panels.

import { NextResponse } from "next/server";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";
import type { TicketStatus } from "@/lib/board/state";
import {
  allReferencedIds,
  groupRelationIds,
  type InverseDepRow,
  type OwnDepRow,
} from "@/lib/export/relations";

export const dynamic = "force-dynamic";

export type RelationRef = {
  id: string;
  title: string;
  status: TicketStatus;
};

export type RelationsResponse = {
  blockedBy: RelationRef[];
  blocks: RelationRef[];
  related: RelationRef[];
  duplicate: RelationRef[];
  // Slice IB-C — this ticket stacks on top of the parent(s). Own-direction.
  buildsOn: RelationRef[];
  // Slice IB-C — these tickets stack on top of this one. Inverse direction.
  builtOnBy: RelationRef[];
  subIssues: RelationRef[];
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const tenantId = await getCurrentTenantId();
  if (!tenantId) return NextResponse.json({ error: "no tenant" }, { status: 401 });

  const { id } = await params;
  const supabase = await supabaseServer();

  // Tenant guard via the parent ticket — clearer 404 than letting RLS empty
  // the result set.
  const { data: parent } = await supabase
    .from("tickets")
    .select("tenant_id")
    .eq("id", id)
    .maybeSingle();
  if (!parent || parent.tenant_id !== tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Two-direction relation lookup: rows where this ticket sits on either
  // endpoint. Then bulk-fetch the referenced tickets once.
  const { data: depsOwn } = await supabase
    .from("ticket_dependencies")
    .select("blocks_ticket_id, relation_type")
    .eq("ticket_id", id);
  const { data: depsInv } = await supabase
    .from("ticket_dependencies")
    .select("ticket_id, relation_type")
    .eq("blocks_ticket_id", id);

  // Directionality + de-duplication live in the shared, unit-tested
  // `lib/export/relations.ts` — the audit-export aggregator lowers the same raw
  // rows through the SAME function. Two copies of a "which side blocks which"
  // rule is how this panel and the export silently come to disagree about what
  // blocks what, and an auditor would have no way to tell which was right.
  const own = (depsOwn ?? []) as unknown as OwnDepRow[];
  const inverse = (depsInv ?? []) as unknown as InverseDepRow[];
  const grouped = groupRelationIds({ own, inverse });

  const refIds = allReferencedIds({ own, inverse });
  let ticketsById = new Map<string, RelationRef>();
  if (refIds.length > 0) {
    const { data: rows } = await supabase
      .from("tickets")
      .select("id, title, status")
      .in("id", refIds);
    ticketsById = new Map(
      (rows ?? []).map((r) => [
        r.id as string,
        { id: r.id as string, title: r.title as string, status: r.status as TicketStatus },
      ]),
    );
  }

  /** Ids → refs, dropping any the tickets query didn't return (RLS, or deleted). */
  const resolve = (ids: readonly string[]): RelationRef[] =>
    ids.map((refId) => ticketsById.get(refId)).filter((r): r is RelationRef => r !== undefined);

  // Sub-issues: tickets whose parent_ticket_id is this ticket.
  const { data: subs } = await supabase
    .from("tickets")
    .select("id, title, status")
    .eq("parent_ticket_id", id);

  const payload: RelationsResponse = {
    blockedBy: resolve(grouped.blockedBy),
    blocks: resolve(grouped.blocks),
    related: resolve(grouped.related),
    duplicate: resolve(grouped.duplicate),
    buildsOn: resolve(grouped.buildsOn),
    builtOnBy: resolve(grouped.builtOnBy),
    subIssues: (subs ?? []).map((s) => ({
      id: s.id as string,
      title: s.title as string,
      status: s.status as TicketStatus,
    })),
  };

  return NextResponse.json(payload);
}
