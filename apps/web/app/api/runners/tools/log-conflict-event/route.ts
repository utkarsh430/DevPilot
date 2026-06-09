// POST /api/runners/tools/log-conflict-event
//
// Phase 2.5+ / Slice IB-B — runner-side audit relay. The release_engineer
// (merger) role calls this tool from inside its workspace to stream per-file
// resolution events into `merge_conflict_events`, which the /changes
// Conflicts tab subscribes to via realtime.
//
// Auth: `x-devpilot-runner-key` header (same gate as the other tool relays).
//
// Request body:
//   {
//     pendingPushId: uuid,       // the originating pending_pushes.id
//     kind: 'file_resolved' | 'merger_started' | 'merger_completed' |
//           'retry_pushed' | 'retry_failed',
//     payload?: Record<string, unknown>,
//     runnerId?: string,
//   }
//
// Response 200: { eventId: string }
// Response 400: { error } — missing/invalid fields
// Response 401: { error } — bad runner key
// Response 404: { error } — pending_push not found
//
// The runner never inserts `detected`, `merger_spawned`, or
// `operator_overrode` — those are emitted server-side from
// pushPendingChangesAction (lib/engine/conflict-audit.ts). Letting the
// runner forge them would defeat the audit trail's purpose; we reject any
// such kind here even if the runner sends it.

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";

export const dynamic = "force-dynamic";

type Body = {
  pendingPushId?: string;
  kind?: string;
  payload?: Record<string, unknown> | null;
  runnerId?: string;
};

const RUNNER_ALLOWED_KINDS = new Set([
  "merger_started",
  "file_resolved",
  "merger_completed",
  "retry_pushed",
  "retry_failed",
]);

export async function POST(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body?.pendingPushId || typeof body.pendingPushId !== "string") {
    return NextResponse.json({ error: "pendingPushId required" }, { status: 400 });
  }
  if (!body.kind || typeof body.kind !== "string") {
    return NextResponse.json({ error: "kind required" }, { status: 400 });
  }
  if (!RUNNER_ALLOWED_KINDS.has(body.kind)) {
    return NextResponse.json(
      {
        error: `kind '${body.kind}' is not relay-allowed. Allowed: ${[...RUNNER_ALLOWED_KINDS].join(
          ", ",
        )}`,
      },
      { status: 400 },
    );
  }

  const supabase = supabaseService();
  const { data: pp } = await supabase
    .from("pending_pushes")
    .select("tenant_id, project_id, ticket_id, merger_ticket_id")
    .eq("id", body.pendingPushId)
    .maybeSingle();
  if (!pp) {
    return NextResponse.json({ error: "pending_push not found" }, { status: 404 });
  }

  // Bound payload size so a misbehaving merger can't write multi-MB blobs.
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  const serialized = JSON.stringify(payload);
  if (serialized.length > 16_000) {
    return NextResponse.json({ error: "payload too large (max 16 KB)" }, { status: 400 });
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("merge_conflict_events")
    .insert({
      tenant_id: pp.tenant_id,
      project_id: pp.project_id,
      pending_push_id: body.pendingPushId,
      ticket_id: pp.ticket_id,
      merger_ticket_id: pp.merger_ticket_id,
      kind: body.kind,
      payload,
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    return NextResponse.json(
      { error: `insert failed: ${insertErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }
  return NextResponse.json({ eventId: inserted.id });
}
