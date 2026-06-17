// POST /api/runs/[id]/replay
//
// Phase 1 / M13. Endpoint behind the Run Inspector's "Replay from here"
// button. Validates the request against the calling user's tenant, runs the
// replay plan (cap check + step bound check), and emits
// `agent/run.replay-requested` so the Inngest function does the durable work.
//
// We do the validation inline (not just in the Inngest function) so the
// Inspector can show a clean 4xx error to the operator if the replay is
// refused — replay-cap-exceeded is the common one.

import { NextResponse } from "next/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";
import { planReplay, ReplayRefused } from "@/lib/engine/replay";
import {
  getEffectivePause,
  getEffectivePauseForTicket,
  pauseRefusalMessage,
} from "@/lib/engine/automation-state";

export const dynamic = "force-dynamic";

type Body = {
  fromStepIdx: number;
  overrides?: {
    promptOverride?: string;
    systemPromptOverride?: string;
    modelTierOverride?: "default" | "heavy" | "cheap";
    budgetCentsOverride?: number;
  };
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const tenantId = await getCurrentTenantId();
  if (!tenantId) {
    return NextResponse.json({ error: "no tenant" }, { status: 401 });
  }

  const { id: originalRunId } = await params;

  // Tenant gate via RLS-bound client — refuses if the original isn't in
  // the caller's tenant. The replay engine re-checks tenant ownership via
  // service-role; this is defense in depth.
  const supabase = await supabaseServer();
  const { data: run } = await supabase
    .from("runs")
    .select("id, tenant_id, ticket_id")
    .eq("id", originalRunId)
    .maybeSingle();
  if (!run || run.tenant_id !== tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Refuse operator-replay against a paused ticket. The replayed role would
  // hit `paused → <target>` inside devpilot_move_ticket and fail the same way the
  // dispatcher-side run does. The drawer's per-run Resume button auto-routes
  // through resumeTicketAction in this case; this guard catches any other
  // caller (Inspector "Replay from here", curl, future surfaces).
  if (run.ticket_id) {
    const { data: ticket } = await supabase
      .from("tickets")
      .select("status")
      .eq("id", run.ticket_id)
      .maybeSingle();
    if (ticket?.status === "paused") {
      return NextResponse.json(
        {
          error: "ticket is paused; un-pause it from the ticket header before replaying",
          code: "ticket-paused",
        },
        { status: 409 },
      );
    }
  }

  // Refuse when workspace/project automation is paused. The replay would
  // dead-end at the dispatcher's automation gate immediately.
  const automationGate = run.ticket_id
    ? await getEffectivePauseForTicket(tenantId, run.ticket_id)
    : await getEffectivePause(tenantId, null);
  if (automationGate.paused) {
    return NextResponse.json(
      {
        error: pauseRefusalMessage(automationGate),
        code: "automation-paused",
      },
      { status: 409 },
    );
  }

  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body || typeof body.fromStepIdx !== "number") {
    return NextResponse.json({ error: "fromStepIdx required (number)" }, { status: 400 });
  }
  if (body.fromStepIdx < 0 || !Number.isFinite(body.fromStepIdx)) {
    return NextResponse.json(
      { error: "fromStepIdx must be a non-negative integer" },
      { status: 400 },
    );
  }

  // Inline plan check so cap / step-range failures hit as 4xx instead of
  // burning an Inngest function invocation that immediately throws.
  try {
    await planReplay({
      originalRunId,
      tenantId,
      fromStepIdx: body.fromStepIdx,
    });
  } catch (err) {
    if (err instanceof ReplayRefused) {
      const status =
        err.code === "replay-cap-exceeded" ? 429 : err.code === "original-not-found" ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }

  await sendEventBounded({
    name: "agent/run.replay-requested",
    data: {
      originalRunId,
      tenantId,
      fromStepIdx: body.fromStepIdx,
      overrides: body.overrides,
    },
  });

  return NextResponse.json({
    ok: true,
    originalRunId,
    fromStepIdx: body.fromStepIdx,
  });
}
