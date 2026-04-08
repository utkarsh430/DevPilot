// POST /v1/chat/completions
//
// Phase 1 / M14 — OpenAI-shaped endpoint that maps to a single-shot agent
// run against the tenant's configured default agent. The `model` field on
// the request is preserved verbatim in the response (so callers swapping
// `gpt-4o` in / out can keep working) — internally we dispatch the tenant's
// configured default agent.
//
// Default agent resolution order:
//   1. tenants.config.default_agent_id   (when set)
//   2. first agent of role 'pm' in the tenant
//   3. any agent in the tenant — fallback
// If none exist → 404 with a clear body.
//
// Streaming:
//   - `stream: true` → SSE of OpenAI-shaped delta chunks. We poll run_steps
//     and emit a content delta per `think` step's text. Terminator is the
//     OpenAI canonical `data: [DONE]\n\n`.
//   - `stream: false` → JSON ChatCompletion with the final text concatenated
//     from all `think` steps.
//
// No `openai` npm dep — we hand-craft the wire shape.

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { supabaseService } from "@/lib/db/server";
import { requireApiKey } from "@/lib/api/key-auth";
import { checkRateLimit } from "@/lib/api/rate-limit";
import { sseResponse, openAiChunk, openAiCompletion } from "@/lib/api/sse";
import { redis } from "@/lib/cache/redis";
import { applyOperatorOverlay } from "@/lib/roles/overlay";
import { loadOverlayForDispatch } from "@/lib/roles/overlay.server";

export const dynamic = "force-dynamic";

const DEFAULT_RUN_BUDGET_CENTS = Number(process.env.DEFAULT_RUN_BUDGET_CENTS ?? "500");
const STREAM_TIMEOUT_MS = 10 * 60_000;
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
    return false;
  }
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type ChatBody = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
};

function flattenMessages(messages: ChatMessage[]): {
  system: string | undefined;
  user: string;
} {
  // OpenAI semantics: the last user message is the "main" prompt; earlier
  // messages form context. We concatenate non-system messages as a single
  // prompt string and pass the joined system messages as systemPrompt.
  const sys = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");
  const promptParts: string[] = [];
  for (const m of turns) {
    if (m.role === "user") promptParts.push(`User: ${m.content}`);
    else if (m.role === "assistant") promptParts.push(`Assistant: ${m.content}`);
  }
  return {
    system: sys.length > 0 ? sys : undefined,
    user: promptParts.join("\n\n"),
  };
}

async function resolveDefaultAgent(tenantId: string): Promise<{
  id: string;
  name: string;
  role: string | null;
  config: Record<string, unknown>;
} | null> {
  const supabase = supabaseService();
  // 1. tenants.config.default_agent_id
  const { data: tenant } = await supabase
    .from("tenants")
    .select("config")
    .eq("id", tenantId)
    .maybeSingle();
  const cfg = (tenant?.config ?? {}) as Record<string, unknown>;
  const defaultId =
    typeof cfg.default_agent_id === "string" ? (cfg.default_agent_id as string) : null;
  if (defaultId) {
    const { data } = await supabase
      .from("agents")
      .select("id, name, role, config")
      .eq("id", defaultId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (data) return data as never;
  }
  // 2. first pm agent
  const { data: pm } = await supabase
    .from("agents")
    .select("id, name, role, config")
    .eq("tenant_id", tenantId)
    .eq("role", "pm")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (pm) return pm as never;
  // 3. any agent
  const { data: any } = await supabase
    .from("agents")
    .select("id, name, role, config")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (any) return any as never;
  return null;
}

export async function POST(request: Request) {
  // 1. Auth (full-scope only — widget tokens get 403).
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

  // 3. Tenant velocity cutoff.
  if (await tenantOverVelocity(key.tenantId)) {
    return NextResponse.json(
      {
        error: "tenant cost-velocity ceiling exceeded",
        limit_cents_per_min: VELOCITY_LIMIT_CENTS_PER_MIN,
      },
      { status: 402, headers: { "Retry-After": String(VELOCITY_WINDOW_SEC) } },
    );
  }

  // 4. Body validation — OpenAI shape.
  const body = (await request.json().catch(() => null)) as ChatBody | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json(
      { error: { message: "messages required", type: "invalid_request_error" } },
      { status: 400 },
    );
  }
  const messages = (body.messages as ChatMessage[]).filter(
    (m) =>
      m &&
      typeof m === "object" &&
      typeof m.content === "string" &&
      (m.role === "system" || m.role === "user" || m.role === "assistant"),
  );
  if (messages.length === 0) {
    return NextResponse.json(
      { error: { message: "no valid messages", type: "invalid_request_error" } },
      { status: 400 },
    );
  }
  const model = typeof body.model === "string" ? (body.model as string) : "gpt-4o";
  const stream = body.stream === true;
  const { system: systemFromMessages, user: prompt } = flattenMessages(messages);

  // 5. Resolve default agent.
  const agent = await resolveDefaultAgent(key.tenantId);
  if (!agent) {
    return NextResponse.json(
      {
        error: {
          message:
            "no default agent configured for this tenant — set tenants.config.default_agent_id or create at least one agent",
          type: "invalid_request_error",
        },
      },
      { status: 404 },
    );
  }
  const agentCfg = (agent.config ?? {}) as Record<string, unknown>;
  const roleCfg = (agentCfg.role_config ?? {}) as Record<string, unknown>;
  const modelTier = (roleCfg.modelTier as "default" | "heavy" | "cheap") ?? "default";
  const runnerPolicy = (roleCfg.runnerPolicy as "api" | "local-cc") ?? "api";
  const agentSystemBase =
    typeof roleCfg.systemPrompt === "string" ? (roleCfg.systemPrompt as string) : undefined;

  // Phase 2 — the operator's overlay. This surface deliberately does NOT go
  // through `composeRoleSystemPrompt` (it has no ticket, so the
  // reviewer-awareness note would promise a QA review that can never happen),
  // but the OVERLAY is a property of the ROLE and is ticket-independent, so it
  // applies here too. Excluding it would make "your instructions apply to every
  // run of this agent" false on exactly the surfaces an operator cannot watch.
  // Skipped when the agent carries no base prompt: there is then no contract for
  // the fence's "the contract above wins" to refer to.
  //
  // Attached to the AGENT's prompt, before the caller's system messages are
  // merged — the operator's standing instructions belong with the agent's own
  // contract, not appended after a per-request message an API caller supplied.
  const roleOverlay =
    agentSystemBase && agent.role
      ? await loadOverlayForDispatch(key.tenantId, String(agent.role))
      : null;
  // Phase 4 — `styleOverridable: false`. This surface composes no SAFETY
  // CONTRACT section (it reads `role_config.systemPrompt` straight off the
  // agents row and skips `composeRoleSystemPrompt` entirely), so the
  // "operator outranks style, never the safety contract" wording would point
  // at a section that is not in the prompt — which reads to the model as
  // blanket authority. Base-wins is the correct precedence here.
  const agentSystem = agentSystemBase
    ? applyOperatorOverlay(agentSystemBase, roleOverlay, false)
    : agentSystemBase;

  // Merge: agent system prompt + caller's system messages.
  const systemPrompt =
    agentSystem && systemFromMessages
      ? `${agentSystem}\n\n${systemFromMessages}`
      : (agentSystem ?? systemFromMessages);

  // 6. Emit run.
  const runId = randomUUID();
  const completionId = `chatcmpl-${runId.replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  await sendEventBounded({
    name: "agent/run.requested",
    data: {
      runId,
      tenantId: key.tenantId,
      agentId: agent.id,
      prompt,
      systemPrompt,
      iterations: 1,
      modelTier,
      budgetCents: DEFAULT_RUN_BUDGET_CENTS,
      runnerPolicy,
      role: agent.role ?? undefined,
      agentDisplayName: agent.name,
    },
  });

  const supabase = supabaseService();

  // 7a. Streaming — emit chunks as steps land.
  if (stream) {
    return sseResponse(async (emit) => {
      // Initial role-only chunk per OpenAI's wire shape.
      await emit.write(
        openAiChunk({ id: completionId, model, created, role: "assistant", content: "" }),
      );

      const start = Date.now();
      let lastIdx = -1;
      let lastEmittedTextLen = 0;
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
            lastIdx = Math.max(lastIdx, Number(s.idx ?? lastIdx));
            if (s.kind !== "think") continue;
            const text = ((s.payload ?? {}) as { text?: unknown }).text;
            if (typeof text === "string" && text.length > lastEmittedTextLen) {
              const delta = text.slice(lastEmittedTextLen);
              lastEmittedTextLen = text.length;
              await emit.write(openAiChunk({ id: completionId, model, created, content: delta }));
            }
          }
        }

        const { data: run } = await supabase
          .from("runs")
          .select("status")
          .eq("id", runId)
          .maybeSingle();
        if (run && (run.status === "done" || run.status === "failed")) {
          await emit.write(openAiChunk({ id: completionId, model, created, finishReason: "stop" }));
          return;
        }
        await new Promise((r) => setTimeout(r, STREAM_POLL_MS));
      }
      await emit.write(openAiChunk({ id: completionId, model, created, finishReason: "stop" }));
    });
  }

  // 7b. Non-streaming — wait for the run to terminate, then return JSON.
  const start = Date.now();
  let finalText = "";
  let promptTokens = 0;
  let completionTokens = 0;
  while (Date.now() - start < STREAM_TIMEOUT_MS) {
    const { data: run } = await supabase
      .from("runs")
      .select("status")
      .eq("id", runId)
      .maybeSingle();
    if (run && (run.status === "done" || run.status === "failed")) {
      const { data: steps } = await supabase
        .from("run_steps")
        .select("kind, payload")
        .eq("run_id", runId)
        .order("idx", { ascending: true });
      for (const s of steps ?? []) {
        if (s.kind !== "think") continue;
        const p = (s.payload ?? {}) as {
          text?: string;
          usage?: { promptTokens?: number; completionTokens?: number };
        };
        if (typeof p.text === "string") finalText = p.text;
        if (p.usage) {
          promptTokens += p.usage.promptTokens ?? 0;
          completionTokens += p.usage.completionTokens ?? 0;
        }
      }
      break;
    }
    await new Promise((r) => setTimeout(r, STREAM_POLL_MS));
  }

  return NextResponse.json(
    openAiCompletion({
      id: completionId,
      model,
      created,
      content: finalText,
      promptTokens,
      completionTokens,
    }),
  );
}
