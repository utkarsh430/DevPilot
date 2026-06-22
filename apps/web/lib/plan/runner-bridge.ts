// Phase 2.5+ / M7 (REVISION 2026-06-04) — Plan-mode runner bridge.
//
// Routes every planner LLM call through the same primitives `run-agent.ts`
// uses for ticket-bound agents: the local-cc Redis queue + Inngest
// `step.waitForEvent("runner/step-result")` round-trip. Uses the per-token
// ApiRunner only when the tenant has explicitly selected `api_key` auth-mode
// in Settings; the default `claude_code` mode always routes to the local-cc
// subscription path.
//
// Why a single helper rather than inlining the policy in every plan
// Inngest function:
//
//   • The decision (local-cc vs api) is identical at every plan stage.
//   • The synthetic `runs` row attached to the plan session, the
//     idempotent fallback-warning system message, the LangFuse span, and
//     the JSON-block extraction quirks of local-cc replies are all
//     load-bearing details the call-sites should NOT have to re-implement.
//   • Centralising the policy is the cleanest way to honour the
//     "Runner-first" non-negotiable in CLAUDE.md — feature code never
//     touches `@ai-sdk/anthropic`; it goes through this bridge.

import { NonRetriableError } from "inngest";
import { ApiRunner } from "@/lib/runners/api";
import type { StepResult } from "@/lib/runners/types";
import { MODEL_IDS, type ModelTier } from "@/lib/llm/models";
import { costCents } from "@/lib/llm/cost";
import { supabaseService } from "@/lib/db/server";
import { redis } from "@/lib/cache/redis";
import { env } from "@/lib/env";
import { resolvePlatformSecret } from "@/lib/platform-secrets/resolver";
import { getLlmAuthMode } from "@/lib/llm/auth-mode.server";
import { decideRunnerPolicy } from "@/lib/llm/routing";
import type { LlmProvider } from "@/lib/llm/provider";
import { resolveLlmProviderConfig } from "@/lib/llm/provider-config.server";
import { langfuseForTenant } from "@/lib/tracing/langfuse";

const LOCAL_CC_QUEUE = "devpilot:jobs:local-cc:ready";
// Runner-side kill channel. The runner's cancel consumer (apps/runner/src/
// index.ts → cancelLoop, which calls cancelClaudeRun in claude.ts) drains this
// and delivers SIGTERM→SIGKILL to the matching `claude -p` (or kills its tmux
// pane on the default path). We emit on bridge timeout (PLANNER_TIMEOUT) so a
// wedged `claude -p` doesn't keep chewing the user's subscription rate-limit
// after the engine has already given up waiting for its `runner/step-result`.
//
// Payload shape (LPUSH'd as JSON string):
//   { runId: string, reason: "timeout" | "user-cancel", stage?: PlannerStage }
//
// The runner uses runId to find the in-flight subprocess (it's the same
// runId stamped on the claude job from invokeLocalCCRunner below).
//
// Exported so server actions (e.g. discardPlanSessionAction → user-cancel)
// and tests can use the same constant rather than restating the literal.
export const LOCAL_CC_CANCEL_QUEUE = "devpilot:jobs:local-cc:cancel";

// Per-stage timeouts. The consolidator chews ~5 min on a healthy run merging
// 30+ drafts (10K-15K-char JSON output); 5 min is the right ceiling so a
// genuinely stuck consolidator doesn't sit unrecoverable for the legacy 10m.
// Lead replies are 10-30s on the subscription so 5m is generous. Panel
// stages can take 3-6 min on long transcripts, so we keep the looser 10m
// ceiling there.
//
// All three are operator-overridable via dedicated env vars so a slow runner
// host or a multi-minute Opus warm-start doesn't trip the default. The
// legacy `DEVPILOT_PLANNER_LOCAL_CC_TIMEOUT` still applies as the FLOOR for any
// stage not explicitly overridden (keeps existing env config working).
//
// The legacy variable used to be ALL stages; preserving it as a stage-less
// fallback so an existing deployment with `DEVPILOT_PLANNER_LOCAL_CC_TIMEOUT=30m`
// keeps the looser ceiling rather than silently tightening to 5m.
export type PlannerStage = "lead" | "panel" | "consolidator";

const LEGACY_TIMEOUT_OVERRIDE = process.env.DEVPILOT_PLANNER_LOCAL_CC_TIMEOUT;
const STAGE_TIMEOUTS: Record<PlannerStage, string> = {
  lead: process.env.DEVPILOT_PLANNER_LOCAL_CC_TIMEOUT_LEAD ?? LEGACY_TIMEOUT_OVERRIDE ?? "5m",
  panel: process.env.DEVPILOT_PLANNER_LOCAL_CC_TIMEOUT_PANEL ?? LEGACY_TIMEOUT_OVERRIDE ?? "10m",
  consolidator:
    process.env.DEVPILOT_PLANNER_LOCAL_CC_TIMEOUT_CONSOLIDATOR ?? LEGACY_TIMEOUT_OVERRIDE ?? "5m",
};

function timeoutForStage(stage: PlannerStage | undefined): string {
  // Default to the consolidator ceiling (tightest) when callers don't pass a
  // stage — the bridge's primary failure mode IS the consolidator hang.
  return STAGE_TIMEOUTS[stage ?? "consolidator"];
}

// Minimal `step` shape we need from inside the bridge. We don't depend on
// Inngest's `StepTools` generic surface (which shifts between SDK versions)
// because we only call `run` and `waitForEvent`. Callers pass the
// function-scoped `step` argument directly — TS lets the structural subset
// match without us having to import the full helper type.
type StepRunFn = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
type StepWaitForEventFn = (
  id: string,
  opts: { event: string; timeout: string; match?: string; if?: string },
) => Promise<{
  data: {
    runId: string;
    ok: boolean;
    result?: {
      text: string;
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      finishReason?: string;
      modelId?: string;
    };
    error?: string;
  };
} | null>;

export type PlannerStep = {
  run: StepRunFn;
  waitForEvent: StepWaitForEventFn;
};

export type PlannerInvocation = {
  tenantId: string;
  sessionId: string;
  /**
   * WI-12 — the project this planning session is for, when it has one. Only used
   * to resolve the LLM provider server-side; omit and the provider resolves from
   * the tenant default down, which is what every caller does today.
   */
  projectId?: string | null;
  /**
   * The synthetic `runs` row id this LLM call writes to. The caller (the
   * Inngest function) must read it from its triggering event's `data.runId`
   * so the waitForEvent below can `match: "data.runId"` against the runner's
   * step-result event.
   */
  runId: string;
  /**
   * Index within the calling Inngest function — bumps per invocation so
   * the local-cc enqueue / await steps don't collide on memoised keys
   * when an Inngest function calls the bridge multiple times.
   *
   * 0 for the first turn within a function. The caller is responsible
   * for incrementing this when re-using the bridge inside the same
   * function (e.g. the lead reply + Haiku goal summary).
   */
  iterationIdx: number;
  modelTier: ModelTier;
  systemPrompt: string;
  prompt: string;
  /** Optional name for the Langfuse generation span. */
  spanName?: string;
  /**
   * Per-stage timeout selector. Defaults to "consolidator" (tightest 5-min
   * ceiling) when omitted so the legacy single-timeout failure mode is the
   * conservative choice. Each Inngest function should pass its own stage so
   * the planConsolidatorFn hang fix actually takes effect:
   *
   *   - planLeadReplyFn       → "lead"        (5 min default)
   *   - planPanelStepFn       → "panel"       (10 min default)
   *   - planConsolidatorFn    → "consolidator" (5 min default)
   *
   * Override via DEVPILOT_PLANNER_LOCAL_CC_TIMEOUT_{LEAD,PANEL,CONSOLIDATOR}; the
   * legacy DEVPILOT_PLANNER_LOCAL_CC_TIMEOUT still applies as the catch-all
   * fallback when a per-stage var is unset.
   */
  stage?: PlannerStage;
};

export type PlannerResult = {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  modelId: string;
  runnerKind: "local-cc" | "api";
};

type PolicyDecision = "local-cc" | "api";
type PolicyResult = { policy: PolicyDecision; provider: LlmProvider };

// ─── policy: the tenant's LLM auth-mode, plus the provider dimension ─────────

async function decidePolicy(tenantId: string, projectId: string | null): Promise<PolicyResult> {
  // The routing choice is driven by the tenant's explicit auth-mode setting
  // (Settings → LLM auth), NOT a heuristic on token presence:
  //
  //   claude_code (default) → local-cc  (the Claude Code subscription runner)
  //   api_key               → api       (per-token ANTHROPIC_API_KEY path)
  //
  // `getLlmAuthMode` is the single resolver every path reads
  // (lib/health/runner-mode.ts and lib/health/probes.ts read it too), so
  // onboarding runner-mode detection, the health check, and this routing
  // decision all stay in lockstep. In `claude_code` mode we enqueue to
  // local-cc unconditionally — matching run-agent.ts (the canonical local-cc
  // caller), which never runtime-checks the token and relies on the
  // `step.waitForEvent` timeout as the safety net.
  //
  // WI-12 — the PROVIDER now overrides that, in one direction only: an
  // OpenAI-compatible endpoint cannot ride the subscription runner (it's the
  // Claude CLI), so it forces `api` whatever the auth-mode says. An Anthropic
  // provider — every project that configures nothing — leaves the mapping above
  // exactly as it was. `decideRunnerPolicy` is the shared rule (lib/llm/routing.ts),
  // so this bridge, run-agent, and the one-shot generator can't drift.
  const [mode, config] = await Promise.all([
    getLlmAuthMode(tenantId),
    resolveLlmProviderConfig({ tenantId, projectId }),
  ]);
  return { policy: decideRunnerPolicy(mode, config.provider), provider: config.provider };
}

// ─── main entry point ──────────────────────────────────────────────────────

export async function invokePlannerRunner(
  step: PlannerStep,
  args: PlannerInvocation,
): Promise<PlannerResult> {
  // 1. Policy decision in its own durable step so the choice replays
  //    deterministically across Inngest restarts.
  const decision = await step.run(
    `policy-decide-${args.iterationIdx}`,
    async (): Promise<PolicyResult> => decidePolicy(args.tenantId, args.projectId ?? null),
  );

  if (decision.policy === "api") {
    // Anthropic on the API path: the tenant explicitly selected `api_key`
    // auth-mode, so an unset key is a real misconfiguration (not a fallback) —
    // fail loud and point at Settings. A NON-Anthropic provider has its own
    // credential story (and may legitimately need none — a local Ollama), so this
    // check would be wrong for it; `modelForProviderConfig` inside the ApiRunner
    // raises the provider-specific error instead.
    if (decision.provider === "anthropic") {
      const apiKey = await resolvePlatformSecret("ANTHROPIC_API_KEY", { tenantId: args.tenantId });
      if (!apiKey || apiKey.length === 0) {
        throw new NonRetriableError(
          "PLANNER_NO_API_KEY: LLM auth-mode is set to API key but ANTHROPIC_API_KEY " +
            "is not configured. Set the key, or switch to Claude Code auth in Settings → LLM auth.",
        );
      }
    }
    return invokeApiRunner(step, args);
  }

  return invokeLocalCCRunner(step, args);
}

// ─── api path ──────────────────────────────────────────────────────────────

async function invokeApiRunner(step: PlannerStep, args: PlannerInvocation): Promise<PlannerResult> {
  const spanName = args.spanName ?? "plan.llm";

  const result = await step.run(`api-call-${args.iterationIdx}`, async (): Promise<StepResult> => {
    const runner = new ApiRunner();
    return runner.execute({
      // The api runner ignores runId for anything load-bearing — it
      // only uses it as the trace metadata. Pass the sessionId so the
      // Langfuse span carries a meaningful id.
      runId: args.sessionId,
      tenantId: args.tenantId,
      iterationIdx: args.iterationIdx,
      modelTier: args.modelTier,
      systemPrompt: args.systemPrompt,
      prompt: args.prompt,
      // WI-12 — lets the runner resolve THIS project's provider server-side.
      projectId: args.projectId ?? null,
    });
  });

  // The model the runner actually used (an OpenAI-compatible endpoint serves
  // something that isn't in MODEL_IDS at all), falling back to the tier map.
  const modelId = result.modelId ?? MODEL_IDS[args.modelTier];

  // Best-effort Langfuse generation so the plan-mode trace tree shows
  // every LLM hop even on the api fallback. Failures here don't fail
  // the planner — observability is non-blocking.
  try {
    const lf = langfuseForTenant(args.tenantId);
    const gen = lf.generation({
      name: spanName,
      model: modelId,
      input: { prompt: args.prompt, systemPrompt: args.systemPrompt },
      output: result.text,
      usage: result.usage
        ? {
            input: result.usage.promptTokens,
            output: result.usage.completionTokens,
            total: result.usage.totalTokens,
            unit: "TOKENS",
          }
        : undefined,
      metadata: {
        sessionId: args.sessionId,
        tenantId: args.tenantId,
        runnerKind: "api",
      },
    });
    gen.end();
    await lf.flushAsync();
  } catch {
    // swallow
  }

  return {
    text: result.text,
    usage: result.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    modelId: result.modelId ?? modelId,
    runnerKind: "api",
  };
}

// ─── local-cc path ─────────────────────────────────────────────────────────

async function invokeLocalCCRunner(
  step: PlannerStep,
  args: PlannerInvocation,
): Promise<PlannerResult> {
  const modelId = MODEL_IDS[args.modelTier];
  const spanName = args.spanName ?? "plan.llm";

  // 1. Seed a synthetic `runs` row. This is the same shape `run-agent.ts`
  //    uses, with `ticket_id=null` + `agent_id=null` + a new
  //    `plan_session_id` column so the planner runs are queryable from
  //    the session.
  //
  //    runId is provided by the caller (the Inngest function), which got it
  //    from its triggering event's data. This is the key fix: the
  //    `runner/step-result` waitForEvent below uses `match: "data.runId"`,
  //    which compares the runId across the function's TRIGGER event and the
  //    incoming runner event — both must carry the same runId. Previously the
  //    bridge generated its own runId here, so the trigger event had none and
  //    match never fired.
  const runId = await step.run(`lc-init-run-${args.iterationIdx}`, async () => {
    const id = args.runId;
    const supabase = supabaseService();
    const { error } = await supabase.from("runs").upsert(
      {
        id,
        tenant_id: args.tenantId,
        agent_id: null,
        ticket_id: null,
        // The new column from migration
        // `20260603210000_phase2_5_planner_runs_link.sql`. Casted via the
        // supabase-js any-key type since the generated DB types haven't
        // been re-run yet; safe because the operator applies the
        // migration before this code path executes.
        plan_session_id: args.sessionId,
        // 50¢ per-call ceiling. The per-session cap in
        // assertCanProceedPlan is the real guard; this just keeps any
        // single runaway call from melting a budget on its own.
        budget_cents: 50,
        spent_cents: 0,
        status: "running",
        depth: 0,
        runner_kind: "local-cc",
        last_event_at: new Date().toISOString(),
        fan_out_group: null,
        fan_out_role: null,
      } as Record<string, unknown>,
      { onConflict: "id" },
    );
    if (error) {
      throw new NonRetriableError(
        `lc-init-run failed for session ${args.sessionId}: ${error.message}`,
      );
    }
    return id;
  });

  // 2. LPUSH the job. The runner's existing consumer already handles
  //    `workspacePath: null` (skip workspace prep), which is what we want
  //    for a plan-mode LLM-only call.
  await step.run(`lc-enqueue-${args.iterationIdx}`, async () => {
    await redis().lpush(
      LOCAL_CC_QUEUE,
      JSON.stringify({
        // The runner consumer requires BOTH `jobId` (per-attempt lifecycle id
        // it echoes back when POSTing step-result) AND `runId` (DB row id).
        // The planner only spawns one job per synthetic run, so they're 1:1.
        jobId: runId,
        runId,
        tenantId: args.tenantId,
        iterationIdx: args.iterationIdx,
        modelTier: args.modelTier,
        systemPrompt: args.systemPrompt,
        prompt: args.prompt,
        ticketId: null,
        agentId: null,
        workspacePath: null,
        engineUrl: env.LOCAL_CC_ENGINE_URL,
      }),
    );
  });

  // 3. Wait for the runner's `runner/step-result` event. Same shape as
  //    run-agent.ts — `match: "data.runId"` compares between the function's
  //    triggering event (which now carries runId per the caller pattern) and
  //    each incoming `runner/step-result` event.
  const stageTimeout = timeoutForStage(args.stage);
  const ev = await step.waitForEvent(`lc-await-${args.iterationIdx}`, {
    event: "runner/step-result",
    timeout: stageTimeout,
    match: "data.runId",
  });

  if (!ev) {
    // PRIMARY FIX FOR THE planConsolidatorFn HANG.
    //
    // Inngest's waitForEvent expired without a step-result coming back. The
    // `claude -p` subprocess on the runner host is still alive — it's chewing
    // the user's subscription rate-limit silently and there's no way for the
    // engine to reach back into a child process spawn'd on a remote host.
    //
    // We LPUSH a kill request onto the runner-side cancel queue. The runner's
    // cancel consumer (apps/runner/src/index.ts → cancelLoop → cancelClaudeRun)
    // matches the runId against its in-flight run and tears it down: killing the
    // `devpilot-run-<id>` tmux pane on the default path, or SIGTERM→SIGKILL on the
    // no-tmux fallback. Same shape as dev-server-loop.ts (`kind: 'stop'`) and
    // takeover-loop.ts (`kind: 'close'`).
    //
    // Enqueue BEFORE the DB writes so a slow Supabase write can't delay the
    // kill signal. The runner's poll cadence (1s) bounds the worst-case kill
    // latency.
    await step.run(`lc-cancel-${args.iterationIdx}`, async () => {
      try {
        await redis().lpush(
          LOCAL_CC_CANCEL_QUEUE,
          JSON.stringify({
            runId,
            reason: "timeout",
            stage: args.stage ?? "consolidator",
            timeoutHint: stageTimeout,
          }),
        );
      } catch (err) {
        // Best-effort — failing to enqueue the cancel doesn't change the
        // engine-side outcome (we still throw PLANNER_TIMEOUT below). Just
        // log so the operator can investigate why the runner kept burning
        // subscription quota past the timeout.
        console.warn(
          `[runner-bridge] failed to enqueue cancel for run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    await step.run(`lc-fail-${args.iterationIdx}`, async () => {
      const supabase = supabaseService();
      await supabase
        .from("runs")
        .update({
          status: "failed",
          status_reason: `planner-timeout:${args.stage ?? "consolidator"} did not return within ${stageTimeout}`,
          last_event_at: new Date().toISOString(),
        })
        .eq("id", runId);
      await supabase.from("planning_messages").insert({
        session_id: args.sessionId,
        tenant_id: args.tenantId,
        role: "system",
        content: "Planner timed out — try again or check runner status.",
        agent_role: null,
        metadata: {
          stage: "runner.timeout",
          runId,
          plannerStage: args.stage ?? "consolidator",
          timeoutHint: stageTimeout,
        },
      });
    });
    throw new NonRetriableError(
      `PLANNER_TIMEOUT: local-cc step did not return within ${stageTimeout} ` +
        `(runId=${runId}, sessionId=${args.sessionId}, stage=${args.stage ?? "consolidator"})`,
    );
  }
  if (!ev.data.ok || !ev.data.result) {
    await step.run(`lc-fail-${args.iterationIdx}`, async () => {
      const supabase = supabaseService();
      await supabase
        .from("runs")
        .update({
          status: "failed",
          status_reason: `planner-runner-failed:${(ev.data.error ?? "unknown").slice(0, 280)}`,
          last_event_at: new Date().toISOString(),
        })
        .eq("id", runId);
    });
    throw new NonRetriableError(
      `PLANNER_RUNNER_FAILED: runner reported failure on session ${args.sessionId}: ${
        ev.data.error ?? "unknown"
      }`,
    );
  }

  const text = ev.data.result.text;
  const usage = ev.data.result.usage ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  // 4. Finalise: mark the synthetic runs row done + record spend. The
  //    session-level spend is bumped by the caller via
  //    recordPlanSessionSpend so the bridge stays caller-agnostic.
  await step.run(`lc-finalize-${args.iterationIdx}`, async () => {
    const cents = costCents(args.modelTier, {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });
    const supabase = supabaseService();
    await supabase
      .from("runs")
      .update({
        status: "done",
        spent_cents: cents,
        last_event_at: new Date().toISOString(),
      })
      .eq("id", runId);
  });

  // 5. Best-effort Langfuse trace for the plan-mode timeline.
  try {
    const lf = langfuseForTenant(args.tenantId);
    const gen = lf.generation({
      name: spanName,
      model: ev.data.result.modelId ?? modelId,
      input: { prompt: args.prompt, systemPrompt: args.systemPrompt },
      output: text,
      usage: {
        input: usage.promptTokens,
        output: usage.completionTokens,
        total: usage.totalTokens,
        unit: "TOKENS",
      },
      metadata: {
        sessionId: args.sessionId,
        tenantId: args.tenantId,
        runId,
        runnerKind: "local-cc",
      },
    });
    gen.end();
    await lf.flushAsync();
  } catch {
    // swallow — trace is non-blocking
  }

  return {
    text,
    usage,
    modelId: ev.data.result.modelId ?? modelId,
    runnerKind: "local-cc",
  };
}

// ─── helper: extract the first JSON block from a (potentially noisy) reply ─
//
// local-cc replies arrive as plain text — `claude -p` doesn't honour Vercel
// AI SDK's `generateObject` contract. Panel + consolidator prompts ask for
// `{proposedTickets: [...]}` so we look for the first balanced JSON object
// in the text and parse it. Returns `null` on any extraction failure so the
// caller can decide whether to surface a user-visible error or retry.

export function safeParseJsonBlock<T = unknown>(text: string): T | null {
  if (!text) return null;
  // Strip a markdown fence if present — Claude often emits ```json…```.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  // Find the first `{` and walk to the matching `}`. Tolerates nested
  // objects / arrays without depending on a regex.
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return JSON.parse(slice) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
