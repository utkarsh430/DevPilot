// GET /api/board/tickets/[id]/blockers
// Lists the tickets that block this one (ticket_dependencies → tickets).
// Used by the TicketDrawer's "Dependencies" section.

import { NextResponse } from "next/server";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { loadBlockers } from "@/lib/board/dependencies";
import { supabaseServer } from "@/lib/db/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const tenantId = await getCurrentTenantId();
  if (!tenantId) return NextResponse.json({ error: "no tenant" }, { status: 401 });

  const { id } = await params;
  // Tenant ownership guard. RLS would enforce this on the dependencies read
  // but check the parent ticket for clearer 404s.
  const supabase = await supabaseServer();
  const { data: ticket } = await supabase
    .from("tickets")
    .select("tenant_id")
    .eq("id", id)
    .maybeSingle();
  if (!ticket || ticket.tenant_id !== tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // `tenantId` is the caller's own tenant, and the guard above already proved
  // this ticket belongs to it — so it is the correct scope for the blocker read.
  const blockers = await loadBlockers(id, tenantId);
  return NextResponse.json({ blockers });
}
