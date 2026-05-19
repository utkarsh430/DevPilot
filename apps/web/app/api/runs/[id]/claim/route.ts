// POST /api/runs/[id]/claim
//
// Runner → engine signal: "I'm about to execute this run, please stamp
// runs.runner_id with my id so the runner-watchdog (lib/engine/runner-
// watchdog.ts) can correctly attribute in-flight runs to me." Called by
// apps/runner/src/index.ts right after the runner rpops a job from Redis
// and BEFORE handleJob spawns claude -p.
//
// Idempotency
// ───────────
// The UPDATE is conditional on `runner_id IS NULL`, so a re-pop of the same
// job (Inngest replay, runner restart) doesn't overwrite a prior runner's
// stamp. A duplicate-claim by the same runner returns 200 with the existing
// id; a cross-runner claim attempt returns 409 (the original claimer keeps
// ownership for watchdog accounting; the new runner can still execute, the
// watchdog just won't reap correctly if THAT runner crashes — caller logs).
//
// Why not just write from the runner directly
// ───────────────────────────────────────────
// Runners don't have service-role credentials and shouldn't. The engine is
// the boundary that owns DB writes; the runner POSTs intent. Auth is the
// existing x-devpilot-runner-key shared-secret pattern (lib/runners/auth.ts).
//
// This route is DELIBERATELY NOT TENANT-SCOPED — do not "fix" it
// ─────────────────────────────────────────────────────────────
// The UPDATE is keyed on `(id = :runId AND runner_id IS NULL)` and nothing else.
// That is not an oversight: RUNNERS ARE SHARED ACROSS TENANTS. A runner
// registers under one tenant (`api/runners/register`) and then claims whatever
// the queue hands it, including runs belonging to other tenants — pooled compute,
// working as designed. Prod: one runner had served all three tenants.
//
// A `.eq("tenant_id", <the runner's tenant>)` here was added and reverted once
// already. It reads like defence in depth and is actually an outage: the claim
// matches no row, the run never gets a `runner_id`, and it WEDGES while the
// runner that already rpop'd the job executes it anyway. The corresponding DB
// trigger was dropped for the same reason (migration 20260733000000), and
// `runs.runner_id -> runners` is recorded in `CROSS_TENANT_BY_DESIGN`
// (lib/security/tenant-scope-scan.ts) so the tenant-scope detector does not ask
// for it back.
//
// The integrity that DOES matter here is ownership, and it is already enforced
// without tenancy: `runner_id IS NULL` makes the first claim win, and a
// cross-runner claim gets a 409 rather than stealing the row.

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: 401 });
  }

  const { id: runId } = await params;
  const body = (await request.json().catch(() => null)) as {
    runnerId?: string;
    /**
     * Track 2 — the headless tmux session name (`devpilot-run-<runId-16char>`)
     * the runner just opened to wrap this run's `claude -p` step. Stamped
     * onto `runs.tmux_session_name` so the UI can render an attach command
     * (`tmux attach -t <name>`). Always allowed regardless of who currently
     * holds runner_id ownership — multiple claims for the same run from the
     * same runner happen on Inngest replay, and a re-spawn should refresh
     * the visible session name. Null/undefined leaves the column untouched.
     */
    tmuxSession?: string | null;
  } | null;
  if (!body?.runnerId || typeof body.runnerId !== "string") {
    return NextResponse.json({ error: "runnerId required" }, { status: 400 });
  }

  const supabase = supabaseService();
  const tmuxSession =
    typeof body.tmuxSession === "string" && body.tmuxSession.length > 0 ? body.tmuxSession : null;

  // Build the patch object once so the tmux-only refresh below and the
  // first-claim stamp below share the same shape. tmux_session_name is only
  // included when the runner actually sent a value — undefined means "don't
  // touch", null means "explicitly clear" (which the runner never sends
  // today, but the column accepts it).
  const updatePatch: Record<string, unknown> = { runner_id: body.runnerId };
  if (body.tmuxSession !== undefined) {
    updatePatch.tmux_session_name = tmuxSession;
  }

  // Conditional first-stamp. select returns the row when the update matched
  // a previously-null runner_id, an empty array when it didn't (either the
  // run is missing, the runner_id was already set, or the run row matched
  // but the conditional failed).
  const { data: claimed, error: updErr } = await supabase
    .from("runs")
    .update(updatePatch)
    .eq("id", runId)
    .is("runner_id", null)
    .select("id");
  if (updErr) {
    return NextResponse.json({ error: `claim failed: ${updErr.message}` }, { status: 500 });
  }
  if (claimed && claimed.length > 0) {
    return NextResponse.json({ ok: true, claimed: true });
  }

  // Conditional didn't match — read the row to decide between 404, 200
  // (same-runner re-claim), and 409 (cross-runner claim).
  const { data: existing, error: readErr } = await supabase
    .from("runs")
    .select("id, runner_id, tmux_session_name")
    .eq("id", runId)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: `lookup failed: ${readErr.message}` }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  if ((existing.runner_id as string | null) === body.runnerId) {
    // Same runner re-claiming (Inngest job replay) — idempotent OK. Also
    // refresh tmux_session_name when one was sent and changed; a runner
    // restart can re-open the pane under a fresh session id even though the
    // run row is already owned.
    if (
      body.tmuxSession !== undefined &&
      (existing.tmux_session_name as string | null) !== tmuxSession
    ) {
      await supabase.from("runs").update({ tmux_session_name: tmuxSession }).eq("id", runId);
    }
    return NextResponse.json({ ok: true, claimed: false, alreadyOwned: true });
  }
  // Different runner already owns this run. Surface as 409; the runner that
  // called us still executes the job (the rpop already removed it from the
  // queue), but the watchdog can't reap correctly if THIS runner dies.
  return NextResponse.json(
    {
      error: `run already claimed by runner ${existing.runner_id}`,
      claimedBy: existing.runner_id,
    },
    { status: 409 },
  );
}
