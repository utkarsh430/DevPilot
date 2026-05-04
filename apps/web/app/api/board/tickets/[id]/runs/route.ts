// GET /api/board/tickets/[id]/runs
// Lists the runs that have been spawned against a ticket. Used by the ticket
// drawer's "Runs" section to deep-link into /runs/[id].

import { NextResponse } from "next/server";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { loadRunsForTicket } from "@/lib/runs/queries";
import { supabaseServer } from "@/lib/db/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const tenantId = await getCurrentTenantId();
  if (!tenantId) return NextResponse.json({ error: "no tenant" }, { status: 401 });

  const { id } = await params;
  const supabase = await supabaseServer();
  const { data: ticket } = await supabase
    .from("tickets")
    .select("tenant_id")
    .eq("id", id)
    .maybeSingle();
  if (!ticket || ticket.tenant_id !== tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const runs = await loadRunsForTicket(id);
  return NextResponse.json({ runs });
}
