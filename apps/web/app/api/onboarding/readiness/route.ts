// GET /api/onboarding/readiness — the four onboarding checks (GitHub /
// project / runner / first run) for the topbar readiness checklist's live
// refresh. Auth-guarded + tenant-scoped; booleans only, no secrets.

import { NextResponse } from "next/server";
import { getUser, getCurrentTenantId } from "@/lib/auth";
import { loadReadinessSnapshot } from "@/lib/onboarding/readiness.server";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tenantId = await getCurrentTenantId();
  if (!tenantId) return NextResponse.json({ error: "no tenant" }, { status: 400 });
  return NextResponse.json(await loadReadinessSnapshot(user.id, tenantId));
}
