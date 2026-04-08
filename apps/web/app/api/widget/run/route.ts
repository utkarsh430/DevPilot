// POST /api/widget/run
//
// Phase 1 / M14 — narrow surface for the embeddable widget. Auth is the same
// `Authorization: Bearer ace_<prefix>_<secret>` shape but the resolved key
// MUST be `scope: 'widget'` AND MUST be bound to the same `agent_id` the
// caller is asking about.
//
// We keep this route separate from `/v1/agents/.../runs` so:
//   - the widget cannot accidentally use a full-scope key.
//   - rate-limit + audit can be tuned independently in a Phase 2 follow-up.

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { supabaseService } from "@/lib/db/server";
import { resolveApiKey } from "@/lib/api/key-auth";
import { checkRateLimit } from "@/lib/api/rate-limit";
import { sseResponse } from "@/lib/api/sse";
import { applyOperatorOverlay } from "@/lib/roles/overlay";
import { loadOverlayForDispatch } from "@/lib/roles/overlay.server";

export const dynamic = "force-dynamic";

const DEFAULT_RUN_BUDGET_CENTS = Number(process.env.DEFAULT_RUN_BUDGET_CENTS ?? "500");
const STREAM_TIMEOUT_MS = 10 * 60_000;
const STREAM_POLL_MS = 750;

type Body = { agentId?: unknown; prompt?: unknown; stream?: unknown };

export async function POST(request: Request) {
  const auth = await resolveApiKey(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }
  if (auth.key.scope !== "widget") {
    return NextResponse.json({ error: "widget scope required" }, { status: 403 });
  }
  const rl = await checkRateLimit(auth.key.id);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate limit exceeded", limit: rl.limit },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body || typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return NextResponse.json({ error: "prompt required" }, { status: 400 });
  }
  if (typeof body.agentId !== "string") {
    return NextResponse.json({ error: "agentId required" }, { status: 400 });
  }
  // Token-agent binding check.
  if (auth.key.agentId !== body.agentId) {
    return NextResponse.json({ error: "token not bound to this agent" }, { status: 403 });
  }
  const stream = body.stream === true;

  const supabase = supabaseService();
  const { data: agent } = await supabase
    .from("agents")
    .select("id, tenant_id, name, role, config")
    .eq("id", body.agentId)
    .maybeSingle();
  if (!agent || agent.tenant_id !== auth.key.tenantId) {
    return NextResponse.json({ error: "agent not found" }, { status: 404 });
  }
  const agentCfg = (agent.config ?? {}) as Record<string, unknown>;
  const roleCfg = (agentCfg.role_config ?? {}) as Record<string, unknown>;
  const modelTier = (roleCfg.modelTier as "default" | "heavy" | "cheap") ?? "default";
  const runnerPolicy = (roleCfg.runnerPolicy as "api" | "local-cc") ?? "api";
  const systemPrompt =
    typeof roleCfg.systemPrompt === "string" ? (roleCfg.systemPrompt as string) : undefined;

  // Phase 2 — the operator's overlay. This surface deliberately does NOT go
  // through `composeRoleSystemPrompt` (it has no ticket, so the
  // reviewer-awareness note would promise a QA review that can never happen),
  // but the OVERLAY is a property of the ROLE and is ticket-independent, so it
  // applies here too. Excluding it would make "your instructions apply to every
  // run of this agent" false on exactly the surfaces an operator cannot watch.
  // Skipped when the agent carries no base prompt: there is then no contract for
  // the fence's "the contract above wins" to refer to.
  const roleOverlay = systemPrompt
    ? await loadOverlayForDispatch(auth.key.tenantId, String(agent.role))
    : null;
  // Phase 4 — `styleOverridable: false`. This surface composes no SAFETY
  // CONTRACT section (it reads `role_config.systemPrompt` straight off the
  // agents row and skips `composeRoleSystemPrompt` entirely), so the
  // "operator outranks style, never the safety contract" wording would point
  // at a section that is not in the prompt — which reads to the model as
  // blanket authority. Base-wins is the correct precedence here.
  const systemPromptWithOverlay = systemPrompt
    ? applyOperatorOverlay(systemPrompt, roleOverlay, false)
    : systemPrompt;

  const runId = randomUUID();
  await sendEventBounded({
    name: "agent/run.requested",
    data: {
      runId,
      tenantId: auth.key.tenantId,
      agentId: agent.id as string,
      prompt: body.prompt,
      systemPrompt: systemPromptWithOverlay,
      iterations: 1,
      modelTier,
      budgetCents: DEFAULT_RUN_BUDGET_CENTS,
      runnerPolicy,
      role: (agent.role as string | null) ?? undefined,
      agentDisplayName: (agent.name as string | null) ?? undefined,
    },
  });

  if (!stream) {
    return NextResponse.json({ runId, status: "queued" }, { status: 202 });
  }

  return sseResponse(async (emit) => {
    await emit.write({ runId, status: "queued" });
    const start = Date.now();
    let lastIdx = -1;
    while (Date.now() - start < STREAM_TIMEOUT_MS) {
      const { data: steps } = await supabase
        .from("run_steps")
        .select("idx, kind, payload")
        .eq("run_id", runId)
        .gt("idx", lastIdx)
        .order("idx", { ascending: true })
        .limit(50);
      if (steps && steps.length > 0) {
        for (const s of steps) {
          await emit.write({ runId, idx: s.idx, kind: s.kind, payload: s.payload });
          lastIdx = Math.max(lastIdx, Number(s.idx ?? lastIdx));
        }
      }
      const { data: run } = await supabase
        .from("runs")
        .select("status")
        .eq("id", runId)
        .maybeSingle();
      if (run && (run.status === "done" || run.status === "failed")) {
        await emit.write({ runId, status: run.status });
        return;
      }
      await new Promise((r) => setTimeout(r, STREAM_POLL_MS));
    }
    await emit.write({ runId, status: "timeout" });
  });
}
