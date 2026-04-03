// POST /v1/agents/{id}/runs
//
// Phase 1 / M14 — the platform's "agent run" surface. Authenticated with an
// `Authorization: Bearer ace_<prefix>_<secret>` API key (full scope only —
// widget tokens are 403 here).
//
// Body shape:
//   {
//     prompt:      string,            // required
//     budgetCents: number?,           // defaults to DEFAULT_RUN_BUDGET_CENTS
//     stream:      boolean?,          // false → JSON, true → SSE of run-steps
//     metadata:    Record<string, unknown>?  // opaque; landed on runs.metadata
//   }
//
// Defaults:
//   - Async response: `{ runId, status: "queued" }` with HTTP 202.
//   - Stream response: text/event-stream, polled run_steps inserts, terminator
//     `data: [DONE]\n\n`. Each event payload is
//       { runId, idx, kind, payload, status }
//
// Auth + safety:
//   - resolveApiKey runs constant-time hash compare.
//   - Per-key sliding-window rate limit (60/min default; tunable).
//   - Tenant velocity ceiling → 402 Payment Required.
//   - The agent must belong to the same tenant as the key OR be a NULL-tenant
//     built-in (none today, but the check is robust to future seeding).
//
// CLAUDE.md non-negotiables held:
//   - API key sha256 at rest; constant-time compare.
//   - Per-key rate limit (not per-tenant — tenant velocity guard handles that).
//   - The agent run still goes through `assertCanProceed` via the engine; this
//     endpoint just emits the durable `agent/run.requested` event.

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { supabaseService } from "@/lib/db/server";
import { requireApiKey } from "@/lib/api/key-auth";
import { checkRateLimit } from "@/lib/api/rate-limit";
import { sseResponse } from "@/lib/api/sse";
import { redis } from "@/lib/cache/redis";
import { applyOperatorOverlay } from "@/lib/roles/overlay";
import { loadOverlayForDispatch } from "@/lib/roles/overlay.server";

export const dynamic = "force-dynamic";

const DEFAULT_RUN_BUDGET_CENTS = Number(process.env.DEFAULT_RUN_BUDGET_CENTS ?? "500");
const STREAM_TIMEOUT_MS = 10 * 60_000; // 10 min hard cap on a streamed run
const STREAM_POLL_MS = 750;

const VELOCITY_WINDOW_SEC = 60;
const VELOCITY_LIMIT_CENTS_PER_MIN = Number(
  process.env.DEVPILOT_TENANT_VELOCITY_CENTS_PER_MIN ?? "500",
);

async function tenantOverVelocity(tenantId: string): Promise<boolean> {
  if (VELOCITY_LIMIT_CENTS_PER_MIN <= 0) return false;
  try {
    const bucket = Math.floor(Date.now() / 1000 / VELOCITY_WINDOW_SEC);
    const key = `devpilot:spend:${tenantId}:${bucket}`;
    const v = await redis().get<string | number>(key);
    const n = typeof v === "number" ? v : v == null ? 0 : Number(v) || 0;
    return n >= VELOCITY_LIMIT_CENTS_PER_MIN;
  } catch {
    return false; // fail-open like the engine guard
  }
}

type RunsBody = {
  prompt?: unknown;
  budgetCents?: unknown;
  stream?: unknown;
  metadata?: unknown;
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // 1. Auth.
  const auth = await requireApiKey(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }
  const { key } = auth;

  // 2. Rate limit.
  const rl = await checkRateLimit(key.id);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate limit exceeded", limit: rl.limit },
      {
        status: 429,
        headers: {
          "Retry-After": String(rl.retryAfterSeconds),
          "X-RateLimit-Limit": String(rl.limit),
        },
      },
    );
  }

  // 3. Tenant velocity hard cutoff → 402.
  if (await tenantOverVelocity(key.tenantId)) {
    return NextResponse.json(
      {
        error: "tenant cost-velocity ceiling exceeded",
        limit_cents_per_min: VELOCITY_LIMIT_CENTS_PER_MIN,
        retry_after_seconds: VELOCITY_WINDOW_SEC,
      },
      { status: 402, headers: { "Retry-After": String(VELOCITY_WINDOW_SEC) } },
    );
  }

  // 4. Body.
  const body = (await request.json().catch(() => null)) as RunsBody | null;
  if (!body || typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return NextResponse.json({ error: "prompt required" }, { status: 400 });
  }
  const budgetCents =
    typeof body.budgetCents === "number" && Number.isFinite(body.budgetCents)
      ? Math.max(0, Math.floor(body.budgetCents))
      : DEFAULT_RUN_BUDGET_CENTS;
  const stream = body.stream === true;
  const metadata =
    body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : null;

  // 5. Agent ownership check.
  const { id: agentId } = await params;
  const supabase = supabaseService();
  const { data: agent, error: agentErr } = await supabase
    .from("agents")
    .select("id, tenant_id, name, role, config")
    .eq("id", agentId)
    .maybeSingle();
  if (agentErr || !agent) {
    return NextResponse.json({ error: "agent not found" }, { status: 404 });
  }
  if (agent.tenant_id !== key.tenantId) {
    return NextResponse.json({ error: "agent not in this tenant" }, { status: 404 });
  }

  // 6. Pick model tier + runner policy from the agent's config when present;
  //    otherwise inherit dispatcher defaults.
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

  // 7. Emit the durable run event.
  const runId = randomUUID();
  await sendEventBounded({
    name: "agent/run.requested",
    data: {
      runId,
      tenantId: key.tenantId,
      agentId: agent.id as string,
      prompt: body.prompt,
      systemPrompt: systemPromptWithOverlay,
      iterations: 1,
      modelTier,
      budgetCents,
      runnerPolicy,
      role: (agent.role as string | null) ?? undefined,
      agentDisplayName: (agent.name as string | null) ?? undefined,
    },
  });

  // 8a. Async path — JSON 202.
  if (!stream) {
    return NextResponse.json(
      {
        runId,
        status: "queued",
        metadata,
      },
      { status: 202 },
    );
  }

  // 8b. Stream path — SSE of run_steps as they land + terminal run row.
  return sseResponse(async (emit) => {
    await emit.write({ runId, status: "queued" });
    const start = Date.now();
    let lastIdx = -1;
    while (Date.now() - start < STREAM_TIMEOUT_MS) {
      // Pull any new run_steps for this run.
      const { data: steps } = await supabase
        .from("run_steps")
        .select("idx, kind, payload")
        .eq("run_id", runId)
        .gt("idx", lastIdx)
        .order("idx", { ascending: true })
        .limit(50);
      if (steps && steps.length > 0) {
        for (const s of steps) {
          await emit.write({
            runId,
            idx: s.idx,
            kind: s.kind,
            payload: s.payload,
          });
          lastIdx = Math.max(lastIdx, Number(s.idx ?? lastIdx));
        }
      }

      // Pull run status — when terminal, emit the final and exit.
      const { data: run } = await supabase
        .from("runs")
        .select("status, spent_cents, budget_cents")
        .eq("id", runId)
        .maybeSingle();
      if (run && (run.status === "done" || run.status === "failed")) {
        await emit.write({
          runId,
          status: run.status,
          spentCents: run.spent_cents,
          budgetCents: run.budget_cents,
        });
        return;
      }
      await new Promise((r) => setTimeout(r, STREAM_POLL_MS));
    }
    await emit.write({ runId, status: "timeout" });
  });
}
