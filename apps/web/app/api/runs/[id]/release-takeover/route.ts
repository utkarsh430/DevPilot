// POST /api/runs/[id]/release-takeover
//
// "Take the wheel" — the operator hands control back. We resume the ticket via
// the existing resumeTicket machinery (replay the headless run from its last
// committed checkpoint) and LPUSH a `close` control message so the runner winds
// down the interactive tmux session after its linger delay.
//
// Commit your work in the interactive session before releasing: resume replays
// from committed state; uncommitted edits are auto-stashed by prepareWorkspace,
// not carried forward into the resumed run.

import { NextResponse } from "next/server";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { supabaseServer, supabaseService } from "@/lib/db/server";
import { resumeTicket } from "@/lib/engine/pause-resume";
import { pushTakeoverClose } from "@/lib/engine/takeover-control";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const tenantId = await getCurrentTenantId();
  if (!tenantId) {
    return NextResponse.json({ error: "no tenant" }, { status: 401 });
  }

  const { id: runId } = await params;

  const supabase = await supabaseServer();
  const { data: run } = await supabase
    .from("runs")
    .select("id, tenant_id, ticket_id")
    .eq("id", runId)
    .maybeSingle();
  if (!run || run.tenant_id !== tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Always wind the interactive session down — the operator released control.
  // (The runner keeps the pane attachable for its linger delay before killing
  // it, so this is safe even if resume below is refused.)
  await pushTakeoverClose(runId).catch(() => undefined);

  // Clear the takeover marker on the (cancelled) run so its page stops showing
  // "Release control". Best-effort; service-role write (RLS forbids user writes
  // to runs). Scoped to this run + the takeover reason so we never trample
  // another pause reason.
  await supabaseService()
    .from("runs")
    .update({ status_reason: "takeover-released" })
    .eq("id", runId)
    .eq("status_reason", "paused:takeover")
    .then(
      () => undefined,
      () => undefined,
    );

  if (!run.ticket_id) {
    return NextResponse.json({ ok: true, mode: "no-ticket" });
  }

  const resumed = await resumeTicket({
    ticketId: run.ticket_id,
    tenantId,
  });
  if (!resumed.ok) {
    // The session is already closing; surface why the headless run didn't
    // resume (e.g. automation paused) so the operator can act from the ticket.
    return NextResponse.json(
      { error: resumed.error, code: resumed.code, released: true },
      { status: 409 },
    );
  }

  return NextResponse.json(resumed);
}
