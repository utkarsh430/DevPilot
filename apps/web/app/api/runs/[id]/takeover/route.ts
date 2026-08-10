// POST /api/runs/[id]/takeover
//
// "Take the wheel" — an operator grabs a running ticket to drive it by hand.
// We pause the ticket (reason='takeover', which cancels the in-flight headless
// run via the existing pauseTicket machinery) and LPUSH an `open` control
// message so the LOCAL runner opens an interactive `claude` session in the
// ticket's workspace. The operator then attaches via tmux and steers; the
// session's transcript is mirrored back into this run's log.
//
// On Release (release-takeover/route.ts) the ticket resumes via resumeTicket,
// which replays the headless run from its last committed checkpoint — so commit
// your work in the interactive session before releasing; uncommitted edits are
// auto-stashed by prepareWorkspace, not carried forward.
//
// Only valid for `runner_kind='local-cc'` runs — the API/multi-tenant path has
// no local terminal to surface.

import { NextResponse } from "next/server";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";
import { pauseTicket } from "@/lib/engine/pause-resume";
import { pushTakeoverOpen } from "@/lib/engine/takeover-control";

export const dynamic = "force-dynamic";

const ACTIVE_RUN_STATUSES = ["running", "awaiting_human"];

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const tenantId = await getCurrentTenantId();
  if (!tenantId) {
    return NextResponse.json({ error: "no tenant" }, { status: 401 });
  }

  const { id: runId } = await params;

  // Tenant gate via RLS-bound client.
  const supabase = await supabaseServer();
  const { data: run } = await supabase
    .from("runs")
    .select("id, tenant_id, ticket_id, status, runner_kind, fan_out_role")
    .eq("id", runId)
    .maybeSingle();
  if (!run || run.tenant_id !== tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (run.runner_kind !== "local-cc") {
    return NextResponse.json(
      {
        error: "take the wheel is only available for local Claude Code runs",
        code: "not-local-runner",
      },
      { status: 400 },
    );
  }
  if (!run.ticket_id) {
    return NextResponse.json(
      { error: "run has no ticket to take over", code: "no-ticket" },
      { status: 409 },
    );
  }
  if (!ACTIVE_RUN_STATUSES.includes(run.status as string)) {
    return NextResponse.json(
      {
        error: `run is ${run.status}; only an active run can be taken over`,
        code: "run-not-active",
      },
      { status: 409 },
    );
  }

  // Human-readable branch slug (cached on the ticket) — handed to the runner so
  // it can recover the workspace by branch if it was GC'd. Best-effort.
  const { data: ticket } = await supabase
    .from("tickets")
    .select("git_branch_name")
    .eq("id", run.ticket_id)
    .maybeSingle();

  // Pause the ticket + cancel the in-flight headless run. reason='takeover' so
  // the UI shows "you have the wheel" (runs.status_reason='paused:takeover').
  const paused = await pauseTicket({
    ticketId: run.ticket_id,
    tenantId,
    reason: "takeover",
  });
  if (!paused.ok) {
    return NextResponse.json({ error: paused.error, code: paused.code }, { status: 409 });
  }

  // Tell the local runner to open the interactive session. Fire-and-forget
  // onto the control queue; the runner picks it up within ~1s.
  await pushTakeoverOpen({
    kind: "open",
    runId,
    tenantId,
    ticketId: run.ticket_id,
    workspaceTicketId: run.ticket_id,
    role: (run.fan_out_role as string | null) ?? null,
    ticketSlug: (ticket?.git_branch_name as string | null) ?? null,
  });

  return NextResponse.json({ ok: true, runId });
}
