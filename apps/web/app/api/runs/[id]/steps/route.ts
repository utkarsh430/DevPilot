// POST /api/runs/[id]/steps
//
// "Take the wheel" — the local runner mirrors an interactive Claude takeover
// session's transcript into the ticket log by POSTing one step at a time here.
// The runner can't write `run_steps` directly (RLS / service-role only), so we
// insert on its behalf. The run page's existing Supabase Realtime subscription
// (useLiveRunSteps) lights these up live — so the operator sees the agent's AND
// their own typed turns reflected in the ticket log.
//
// Auth: `x-devpilot-runner-key` header — same gate as the other runner routes.
//
// Idx allocation: takeover steps live in a high band [50000, 99000) so they
//   (a) never collide on the (run_id, idx) unique constraint with the engine's
//       small iteration indices or the 99_99x system-audit markers, and
//   (b) are excluded from resumeTicket's checkpoint math, which only considers
//       productive steps with idx < 9999 (see computeLastGoodStepIdx). So the
//       headless resume point is never polluted by takeover activity.

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";

export const dynamic = "force-dynamic";

const TAKEOVER_STEP_FLOOR = 50_000;
const TAKEOVER_STEP_CEIL = 99_000; // stay below the 99_99x system-audit band

const ALLOWED_KINDS = new Set(["think", "tool_call", "tool_result", "human", "system"]);

type Body = {
  kind?: string;
  payload?: Record<string, unknown>;
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const { id: runId } = await params;
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body?.kind || !ALLOWED_KINDS.has(body.kind)) {
    return NextResponse.json(
      { error: `kind must be one of ${[...ALLOWED_KINDS].join(", ")}` },
      { status: 400 },
    );
  }
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};

  const supabase = supabaseService();

  // Confirm the run exists (service-role bypasses RLS). 404 keeps a stray /
  // stale runner from inserting orphan steps.
  const { data: run, error: runErr } = await supabase
    .from("runs")
    .select("id")
    .eq("id", runId)
    .maybeSingle();
  if (runErr) {
    return NextResponse.json({ error: runErr.message }, { status: 500 });
  }
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  // Next idx within the takeover band. The runner serializes its POSTs per run
  // (transcript-tail.ts chains them), so there's no concurrent writer to this
  // band for a given run.
  const { data: top, error: topErr } = await supabase
    .from("run_steps")
    .select("idx")
    .eq("run_id", runId)
    .gte("idx", TAKEOVER_STEP_FLOOR)
    .lt("idx", TAKEOVER_STEP_CEIL)
    .order("idx", { ascending: false })
    .limit(1);
  if (topErr) {
    return NextResponse.json({ error: topErr.message }, { status: 500 });
  }
  const topRow = top?.[0];
  const lastIdx = topRow && typeof topRow.idx === "number" ? topRow.idx : TAKEOVER_STEP_FLOOR - 1;
  const idx = lastIdx + 1;

  const { error: insErr } = await supabase.from("run_steps").insert({
    run_id: runId,
    idx,
    kind: body.kind,
    payload,
  });
  if (insErr) {
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, idx });
}
