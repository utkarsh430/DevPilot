// POST /api/export/projects/[id]
//
// Enqueue an async project audit export. This route is the AUTHORISATION step of
// the whole project-export pipeline: it is the only place in that flow with a
// session, so it asserts membership here and stamps the result onto the job row.
// Everything downstream (the durable worker, the download route) trusts that
// stamped `tenant_id` rather than re-deriving it from a payload.
//
// `assertProjectAccess` reads `projects` through RLS, so a foreign id resolves
// to nothing and 404s — indistinguishable from a missing project, on purpose.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { assertProjectAccess } from "@/lib/export/project-audit.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type CreateProjectExportResponse = { exportId: string };

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const access = await assertProjectAccess(id);
  if (!access) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Service role writes the row: the table's RLS denies every JWT insert, so the
  // job record can only ever be created by a path like this one that has already
  // checked membership.
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("exports")
    .insert({
      // Stamped from the SESSION's tenant, not from the request. This column is
      // the background worker's entire trust root.
      tenant_id: access.tenantId,
      project_id: access.row.id,
      status: "pending",
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error(`[export] could not create export job for project ${id}: ${error?.message}`);
    return NextResponse.json({ error: "could not start export" }, { status: 500 });
  }

  const exportId = data.id as string;

  try {
    await sendEventBounded({
      name: "export/project.requested",
      data: { exportId, tenantId: access.tenantId, projectId: access.row.id },
    });
  } catch (err: unknown) {
    // The row exists but nothing will ever pick it up — say so now rather than
    // leaving the client polling a `pending` row forever.
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from("exports")
      .update({ status: "failed", error: `could not enqueue: ${msg.slice(0, 200)}` })
      .eq("id", exportId);
    console.error(`[export] enqueue failed for export ${exportId}: ${msg}`);
    return NextResponse.json({ error: "could not start export" }, { status: 500 });
  }

  const payload: CreateProjectExportResponse = { exportId };
  return NextResponse.json(payload, { status: 202 });
}
