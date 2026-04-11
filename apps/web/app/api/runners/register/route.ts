// POST /api/runners/register
//
// Worker → engine handshake. Upsert a row in `runners` (idempotent on
// tenant_id,name so a boot-race retry re-resolves to the same runner instead of
// duplicating it) and return its id + the tenant(s) it's allowed to pull jobs
// for. Phase 0: one tenant per runner, picked from the request body
// (worker-side env config).

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    tenantId?: string;
    name?: string;
    capabilities?: string[];
  } | null;
  if (!body?.tenantId || !body?.name) {
    return NextResponse.json({ error: "tenantId and name required" }, { status: 400 });
  }

  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("runners")
    .upsert(
      {
        tenant_id: body.tenantId,
        kind: "local-cc",
        name: body.name,
        capabilities: body.capabilities ?? ["text", "file_edit", "bash", "git"],
        status: "idle",
        last_heartbeat_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,name" },
    )
    .select("id, tenant_id")
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
  }

  return NextResponse.json({
    runnerId: data.id,
    tenantId: data.tenant_id,
  });
}
