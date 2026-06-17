// GET /api/export/[exportId]/download
//
// Redeem a ready project export: mint a short-TTL signed URL and redirect.
//
// ── Three checks, and each one is doing work ────────────────────────────────
//  1. The row is read through RLS (`exports_member_read`), so a foreign export
//     id resolves to nothing.
//  2. `row.tenant_id !== tenantId` → 404. Defence in depth behind RLS, and the
//     404 (not 403) keeps "exists but not yours" indistinguishable from
//     "doesn't exist".
//  3. The STORED `storage_key` is re-checked against the caller's tenant with
//     `isExportKeyUnderTenant` before signing. This is the one that is not
//     redundant: signing is a service-role operation that bypasses bucket RLS
//     entirely, so without this a corrupted/mis-stamped row would be enough to
//     mint a signed URL for another tenant's object. The bucket RLS protects the
//     bucket; this protects the signer.

import { NextResponse } from "next/server";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { supabaseServer, supabaseService } from "@/lib/db/server";
import {
  EXPORTS_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  isExportKeyUnderTenant,
} from "@/lib/export/storage";
import { buildContentDisposition, projectExportBasename } from "@/lib/export/filename";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ exportId: string }> },
) {
  await requireUser();
  const tenantId = await getCurrentTenantId();
  if (!tenantId) return NextResponse.json({ error: "no tenant" }, { status: 401 });

  const { exportId } = await params;
  const supabase = await supabaseServer();
  const { data: row, error } = await supabase
    .from("exports")
    .select("id, tenant_id, status, storage_key, created_at, projects!project_id ( name )")
    .eq("id", exportId)
    .maybeSingle();
  if (error) {
    // Never swallow a Supabase error into a bare 404 — an ambiguous PostgREST
    // embed would otherwise read as "missing" with nothing in the logs
    // (AGENTS.md, the PGRST201 note).
    console.error(`[export] download load failed for ${exportId}: ${error.message}`);
    return NextResponse.json({ error: "load failed" }, { status: 500 });
  }
  if (!row || row.tenant_id !== tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (row.status !== "ready" || !row.storage_key) {
    return NextResponse.json({ error: `export is ${row.status}` }, { status: 409 });
  }

  const storageKey = row.storage_key as string;
  // See the header: this guards the SIGNER, which bypasses bucket RLS.
  if (!isExportKeyUnderTenant(storageKey, tenantId)) {
    console.error(`[export] refusing to sign key outside tenant for export ${exportId}`);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const project = Array.isArray(row.projects) ? row.projects[0] : row.projects;
  const basename = projectExportBasename({
    name: (project?.name as string | undefined) ?? "project",
    generatedAt: row.created_at as string,
  });

  const { data: signed, error: signErr } = await supabaseService()
    .storage.from(EXPORTS_BUCKET)
    .createSignedUrl(storageKey, SIGNED_URL_TTL_SECONDS, {
      // Ask Storage to serve it as a download with our sanitized filename, so
      // the redirect target behaves like the synchronous ticket route does.
      download: `${basename}.pdf`,
    });
  if (signErr || !signed?.signedUrl) {
    console.error(`[export] could not sign export ${exportId}: ${signErr?.message}`);
    return NextResponse.json({ error: "could not sign" }, { status: 500 });
  }

  // 302 to the signed object. The Content-Disposition here is advisory (the
  // redirect target sets its own via `download`), but it keeps the sanitization
  // contract in one place — the header value is always built by the same
  // injection-safe helper.
  return NextResponse.redirect(signed.signedUrl, {
    status: 302,
    headers: {
      "Cache-Control": "no-store, private",
      "Content-Disposition": buildContentDisposition(basename),
    },
  });
}
