// GET /api/board/tickets/[id]/attachments
// Used by the ticket drawer to show a ticket's image attachments read-only.
// Returns short-lived signed URLs so a private-bucket object can be rendered in
// the browser without making the bucket public.

import { NextResponse } from "next/server";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";
import { ATTACHMENT_BUCKET } from "@/lib/board/attachments";

export const dynamic = "force-dynamic";

// Signed URL lifetime. Short on purpose — the drawer re-fetches on open, so a
// URL never needs to outlive a viewing session, and a leaked link expires fast.
const SIGNED_URL_TTL_SECONDS = 300;

export type TicketAttachmentDTO = {
  id: string;
  mime: string;
  bytes: number;
  signedUrl: string | null;
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const tenantId = await getCurrentTenantId();
  if (!tenantId) return NextResponse.json({ error: "no tenant" }, { status: 401 });

  const { id } = await params;
  // Tenant ownership guard — RLS also enforces this, but check for a clearer 404.
  const supabase = await supabaseServer();
  const { data: ticket } = await supabase
    .from("tickets")
    .select("tenant_id")
    .eq("id", id)
    .maybeSingle();
  if (!ticket || ticket.tenant_id !== tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: rows, error } = await supabase
    .from("ticket_attachments")
    .select("id, storage_key, mime, bytes")
    .eq("ticket_id", id)
    .order("created_at", { ascending: true });
  if (error) {
    // Don't swallow — a silent [] would read as "no attachments" (see the
    // PostgREST-embed-ambiguity note in AGENTS.md).
    console.error(`[attachments] load failed for ticket ${id}: ${error.message}`);
    return NextResponse.json({ error: "load failed" }, { status: 500 });
  }

  const attachments: TicketAttachmentDTO[] = await Promise.all(
    (rows ?? []).map(async (r) => {
      const { data: signed } = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .createSignedUrl(r.storage_key as string, SIGNED_URL_TTL_SECONDS);
      return {
        id: r.id as string,
        mime: r.mime as string,
        bytes: r.bytes as number,
        signedUrl: signed?.signedUrl ?? null,
      };
    }),
  );

  return NextResponse.json({ attachments });
}
