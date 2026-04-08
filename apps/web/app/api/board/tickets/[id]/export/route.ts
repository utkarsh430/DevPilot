// GET /api/board/tickets/[id]/export
//
// The per-ticket audit PDF: aggregate → render → stream, synchronously. One
// click in the drawer, one file in the downloads folder.
//
// ── Auth mirrors the sibling attachments route, on purpose ──────────────────
// `requireUser()` + `getCurrentTenantId()`, then the ticket's own `tenant_id` is
// compared and a mismatch 404s (not 403 — "exists but not yours" and "does not
// exist" must be indistinguishable from outside). Every read then goes through
// the RLS-bound `supabaseServer()`, so the tenant check is defence in depth and
// RLS is the actual boundary: a foreign id returns NO ROWS regardless of what
// this handler remembers to compare.
//
// ── Why Node runtime + force-dynamic ────────────────────────────────────────
// react-pdf needs Node (Buffer, streams, fontkit); it cannot run on Edge. And
// the response is per-user, per-ticket, and reflects live data — caching it
// would be both wrong and a cross-tenant hazard, so `force-dynamic` plus an
// explicit `no-store`.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";
import { loadTicketAuditExport } from "@/lib/export/ticket-audit.server";
import { renderTicketPdfStream } from "@/lib/export/render.server";
import { buildContentDisposition, ticketExportBasename } from "@/lib/export/filename";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const tenantId = await getCurrentTenantId();
  if (!tenantId) return NextResponse.json({ error: "no tenant" }, { status: 401 });

  const { id } = await params;
  const supabase = await supabaseServer();

  // Tenant ownership guard — RLS also enforces this; check for a clearer 404
  // and so we can name the project on the cover in the same round trip.
  const { data: ticket, error: ticketErr } = await supabase
    .from("tickets")
    .select("tenant_id, project_id")
    .eq("id", id)
    .maybeSingle();
  if (ticketErr) {
    console.error(`[export] ticket guard failed for ${id}: ${ticketErr.message}`);
    return NextResponse.json({ error: "load failed" }, { status: 500 });
  }
  if (!ticket || ticket.tenant_id !== tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let projectName: string | null = null;
  if (ticket.project_id) {
    const { data: project } = await supabase
      .from("projects")
      .select("name")
      .eq("id", ticket.project_id as string)
      .maybeSingle();
    projectName = (project?.name as string | undefined) ?? null;
  }

  try {
    // `tenantId` is the session's, and the guard above has already proved this
    // ticket belongs to it — so the aggregation's explicit tenant scoping and
    // this client's RLS agree rather than one covering for the other.
    const data = await loadTicketAuditExport(supabase as unknown as SupabaseClient, tenantId, id);
    if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

    const stream = await renderTicketPdfStream({
      data,
      projectName,
      generatedAt: new Date().toISOString(),
    });

    // The title is agent-authorable; `buildContentDisposition` is what keeps it
    // out of the header's control plane (see lib/export/filename.ts).
    const basename = ticketExportBasename({
      ticketNumber: data.ticket.ticketNumber,
      ticketId: data.ticket.id,
      title: data.ticket.title.value,
    });

    return new Response(stream as unknown as ReadableStream, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": buildContentDisposition(basename),
        "Cache-Control": "no-store, private",
        // The bytes are drawn by us from our own data; there is no active
        // content in the payload. Belt-and-braces against a viewer sniffing it
        // as something else.
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err: unknown) {
    // The aggregator FAILS LOUD on land-state / verification reads. That lands
    // here, and a 500 is the correct outcome: an export that cannot establish
    // whether a blocker landed, or whether QA passed, must not be produced at
    // all. A confidently wrong audit artifact is worse than a missing one.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[export] ticket ${id} export failed: ${msg}`);
    return NextResponse.json({ error: "export failed" }, { status: 500 });
  }
}
