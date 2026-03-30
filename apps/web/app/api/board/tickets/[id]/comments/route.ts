// GET /api/board/tickets/[id]/comments
// Used by the ticket drawer to refresh the thread on a tighter interval
// than the full board re-render.

import { NextResponse } from "next/server";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { loadTicketComments } from "@/lib/board/queries";
import { supabaseServer } from "@/lib/db/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const tenantId = await getCurrentTenantId();
  if (!tenantId) return NextResponse.json({ error: "no tenant" }, { status: 401 });

  const { id } = await params;
  // Tenant ownership guard — RLS would already enforce this but check for
  // clearer error messaging.
  const supabase = await supabaseServer();
  const { data: ticket } = await supabase
    .from("tickets")
    .select("tenant_id")
    .eq("id", id)
    .maybeSingle();
  if (!ticket || ticket.tenant_id !== tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const comments = await loadTicketComments(id);
  return NextResponse.json({ comments });
}
