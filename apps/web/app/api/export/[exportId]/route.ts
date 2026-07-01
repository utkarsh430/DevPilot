// GET /api/export/[exportId]
//
// Status poll for an async project export. The client hits this on a timer until
// `status` leaves `pending`, then follows the download route.
//
// Read through the RLS-bound client: `exports_member_read` scopes rows to the
// caller's tenants, so a foreign export id simply is not there. The explicit
// tenant compare after it is defence in depth.

import { NextResponse } from "next/server";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ExportStatusResponse = {
  id: string;
  status: "pending" | "ready" | "failed";
  bytes: number | null;
  error: string | null;
  createdAt: string;
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ exportId: string }> },
) {
  await requireUser();
  const tenantId = await getCurrentTenantId();
  if (!tenantId) return NextResponse.json({ error: "no tenant" }, { status: 401 });

  const { exportId } = await params;
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("exports")
    .select("id, tenant_id, status, bytes, error, created_at")
    .eq("id", exportId)
    .maybeSingle();
  if (error) {
    console.error(`[export] status load failed for ${exportId}: ${error.message}`);
    return NextResponse.json({ error: "load failed" }, { status: 500 });
  }
  if (!data || data.tenant_id !== tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const payload: ExportStatusResponse = {
    id: data.id as string,
    status: data.status as ExportStatusResponse["status"],
    bytes: (data.bytes as number | null) ?? null,
    // The stored reason is engine-authored (a DB/storage/aggregation message),
    // never agent text, so it is safe to surface verbatim to the operator.
    error: (data.error as string | null) ?? null,
    createdAt: data.created_at as string,
  };
  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store, private" } });
}
