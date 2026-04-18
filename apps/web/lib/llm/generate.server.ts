import "server-only";

// Auth-mode-aware one-shot structured generation — the single entry point for
// server-side features that need "give me a JSON object from the LLM" outside
// a durable Inngest run (server actions, route handlers, `step.run` bodies).
//
// Honours the tenant's Settings → LLM auth choice (`tenants.config.
// llm_auth_mode` via the `getLlmAuthMode` resolver), exactly like
// `decidePolicy` in lib/plan/runner-bridge.ts does for the planner:
//
//   claude_code (default) → the local-cc Claude Code runner (subscription),
//                           via lib/runners/local-cc-oneshot.server.ts. The
//                           runner returns free text, so the system prompt is
//                           wrapped in a strict JSON contract and the reply is
//                           extracted + Zod-validated here.
//   api_key               → the direct Anthropic API, with the key resolved
//                           through the tenant-scoped model factory
//                           (lib/llm/models-tenant.ts: tenant » instance »
//                           env) — never the raw env getter.
//
// Every can't-proceed branch returns a FRIENDLY, actionable `{ok: false,
// error}` (copy in lib/llm/routing.ts) — the raw "Missing required env var:
// ANTHROPIC_API_KEY" crash must never reach an operator.

import { generateObject } from "ai";
import type { z } from "zod";
import { getLlmAuthMode } from "@/lib/llm/auth-mode.server";
import { modelForProviderConfig, modelForTenant } from "@/lib/llm/models-tenant";
import {
  resolveLlmProviderConfig,
  type ResolvedProviderConfig,
} from "@/lib/llm/provider-config.server";
import type { ModelTier } from "@/lib/llm/models";
import {
  apiKeyMissingError,
  buildJsonContractSystemPrompt,
  buildJsonRetryPrompt,
  decideJsonRetry,
  extractJsonCandidates,
  providerMisconfiguredError,
  routeForProvider,
  runnerNotConnectedError,
  type LlmRoute,
} from "@/lib/llm/routing";
import { resolvePlatformSecret } from "@/lib/platform-secrets/resolver";
import {
  invokeLocalCcOneShot,
  LOCAL_CC_DEFAULT_TIMEOUT_MS,
} from "@/lib/runners/local-cc-oneshot.server";
import { readRunnerHealth } from "@/lib/health/probes";

export type TenantGenerateObjectArgs<T> = {
  tenantId: string;
  /** WI-12 — when the feature is project-scoped, pass the project id and the call
   *  honours that project's LLM provider (an `openai_compatible` project routes to
   *  the API path regardless of auth-mode, since `claude -p` can't speak it).
   *  Omit for tenant-wide features — they resolve from the tenant default down. */
  projectId?: string | null;
  /** Human-readable feature name for error copy, e.g. "Role synthesis". */
  featureName: string;
  tier: ModelTier;
  system: string;
  prompt: string;
  /** Validates the parsed object on BOTH paths (the direct path enforces it
   *  natively via `generateObject`; the local-cc path via `safeParse`). */
  schema: z.Schema<T>;
  /** Compact JSON-shape description embedded in the local-cc prompt — the
   *  subscription runner returns free text, so the model needs the shape
   *  spelled out. E.g. `{"slug":"<snake_case>","score":0-10}`. */
  schemaHint: string;
  /** Local-cc poll ceiling. Defaults to the bridge's 2 min. */
  timeoutMs?: number;
  /** Direct-path-only generation options (claude -p has no equivalents). */
  maxTokens?: number;
  temperature?: number;
};

/**
 * WHY A FAILURE IS CLASSIFIED, and not merely described.
 *
 * Every branch below already returned actionable copy, and a caller that only
 * concatenates `error` into its own sentence can still get the story exactly
 * backwards. The supervisor console did: it prefixed EVERY failure with "I
 * could not reach the model to write that up", and reported a reply that came
 * back 3,270 characters long and would not parse as a reachability problem.
 * Those have different causes and different fixes - restart the runner, versus
 * look at what the model actually said - so one sentence claiming both sends
 * the reader at the wrong one.
 *
 * The split that matters is DID THE MODEL ANSWER. `unparseable` and
 * `invalid_shape` both mean yes; everything else means no.
 */
export type LlmFailureKind =
  /** Never reached, or reached and never answered: no runner, or a timeout. */
  | "unreachable"
  /** Reachable in principle, but the credential/endpoint is not usable. */
  | "misconfigured"
  /** The call itself threw - a transport error, a provider refusal, a 5xx. */
  | "call_failed"
  /** THE MODEL ANSWERED. We could not find JSON in what it said. */
  | "unparseable"
  /** THE MODEL ANSWERED with JSON, and it did not match the schema. */
  | "invalid_shape";

export type TenantGenerateObjectResult<T> =
  | { ok: true; object: T; route: LlmRoute }
  | {
      ok: false;
      error: string;
      kind: LlmFailureKind;
      /**
       * WHAT THE MODEL ACTUALLY SAID, when it said something we could not use.
       *
       * Present only on the local-cc path and only for `unparseable` /
       * `invalid_shape` - i.e. exactly the cases where a good answer may have
       * been thrown away by the envelope. Bounded, and it is RAW: no schema ran
       * over it, so a caller that displays it must present it as the model's own
       * unvalidated words and must NOT derive anything actionable from it.
       *
       * It exists because the alternative was measured and is worse: on
       * 2026-08-04 an operator asked the supervisor console a question, got a
       * specific, grounded, genuinely useful 1,453-character answer, and was
       * shown "the reply contained no readable JSON" instead of one word of it.
       */
      rawReply?: string;
    };

export async function generateObjectForTenant<T>(
  args: TenantGenerateObjectArgs<T>,
): Promise<TenantGenerateObjectResult<T>> {
  const [mode, config] = await Promise.all([
    getLlmAuthMode(args.tenantId),
    resolveLlmProviderConfig({ tenantId: args.tenantId, projectId: args.projectId ?? null }),
  ]);
  // WI-12 — the provider can only ever push a call TOWARD the API path: an
  // OpenAI-compatible endpoint has nowhere else to run, because the local runner
  // is the Claude CLI. An Anthropic project keeps the exact auth-mode routing it
  // has today.
  const route = routeForProvider(mode, config.provider);
  return route === "direct_api" ? generateDirect(args, config) : generateViaLocalCc(args);
}

// ─── direct API path (api_key mode, or any non-Anthropic provider) ───────────

async function generateDirect<T>(
  args: TenantGenerateObjectArgs<T>,
  config: ResolvedProviderConfig,
): Promise<TenantGenerateObjectResult<T>> {
  // Anthropic: the tenant explicitly selected `api_key` mode, so an unresolvable
  // key is a real misconfiguration — surface it as actionable copy, not the env
  // crash the lazy `models` singleton would throw.
  if (config.provider === "anthropic" && !config.apiKey) {
    return { ok: false, error: apiKeyMissingError(args.featureName), kind: "misconfigured" };
  }
  // Any other provider: the endpoint/model/credential come from the resolver, and
  // `modelForProviderConfig` re-validates the base URL against SSRF before it
  // builds a client. A refusal there is an operator-actionable message, not a
  // stack trace.
  const built = await modelForProviderConfig(config, args.tier);
  if (!built.ok) {
    return {
      ok: false,
      error: providerMisconfiguredError(args.featureName, built.error),
      kind: "misconfigured",
    };
  }
  try {
    const res = await generateObject({
      model: built.model,
      system: args.system,
      schema: args.schema,
      prompt: args.prompt,
      ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
      ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    });
    return { ok: true, object: res.object, route: "direct_api" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return {
      ok: false,
      error: `${args.featureName} failed: ${msg.slice(0, 300)}`,
      kind: "call_failed",
    };
  }
}

// ─── local-cc runner (claude_code mode, the default) ─────────────────────────
//
// THE STRUCTURAL PROBLEM THIS PATH HAS, and the three layers that answer it.
//
// `claude -p` returns TEXT. There is no structured-output mode, so the schema
// is a REQUEST here and not a constraint - unlike the direct path, where
// `generateObject` enforces it. Callers that ask for terse structured data
// (dependency suggestion, lesson extraction, capability inference) mostly get
// away with it. A caller that asks for an EXPLANATION does not: on 2026-08-04
// the supervisor console asked what the board was doing, the model answered in
// 1,453 characters of good, grounded prose, and the operator was told the reply
// "contained no readable JSON".
//
//   1. READ HARDER. `extractJsonCandidates` walks every fence and every
//      BALANCED brace span, so an object embedded in prose is recovered. The
//      caller's schema picks between candidates - the only thing that can.
//   2. BIND HARDER. `buildJsonContractSystemPrompt` now says where a narrative
//      GOES (inside a string field), which is the instruction the first attempt
//      was actually missing.
//   3. ASK AGAIN, ONCE. A bounded retry that quotes the rejected reply back.
//
// And when all three fail, the reply is CARRIED OUT on the result so the caller
// can show the operator what came back. An answer they can read beats a clean
// failure.

/** How much of an unusable reply is carried back to the caller. Bounded: it is
 *  displayed, and a model reply has no upper length we control. */
const RAW_REPLY_MAX_CHARS = 4000;

async function generateViaLocalCc<T>(
  args: TenantGenerateObjectArgs<T>,
): Promise<TenantGenerateObjectResult<T>> {
  // Fast liveness pre-check. The plan bridge skips this and leans on its
  // durable waitForEvent timeout, but these callers are synchronous UX —
  // making an operator wait out the full poll ceiling just to learn the
  // runner is down is unacceptable, and the health read is one indexed
  // DB query against the same heartbeat the topbar dot uses.
  const runner = await readRunnerHealth(args.tenantId);
  if (runner.state !== "ok") {
    return { ok: false, error: runnerNotConnectedError(args.featureName), kind: "unreachable" };
  }

  // ONE wall-clock budget across BOTH attempts - `decideJsonRetry` owns the
  // arithmetic (pure, so the boundary is assertable; this file reaches
  // `server-only` and cannot load under Vitest).
  const startedAt = Date.now();
  const budgetMs = args.timeoutMs ?? LOCAL_CC_DEFAULT_TIMEOUT_MS;
  const system = buildJsonContractSystemPrompt(args.system, args.schemaHint);

  const first = await attemptLocalCc(args, system, args.prompt, budgetMs);
  if (first.kind === "ok") return { ok: true, object: first.object, route: "local_cc" };
  if (first.kind === "transport") return first.result;

  // The model ANSWERED and we could not use it. That is the only case worth a
  // second call: a timeout or a dead runner will not answer differently, and
  // retrying one would burn the rest of the budget proving it.
  const retry = decideJsonRetry({ budgetMs, elapsedMs: Date.now() - startedAt });
  if (retry.retry) {
    const retryPrompt = buildJsonRetryPrompt(args.prompt, first.text);
    const second = await attemptLocalCc(args, system, retryPrompt, retry.timeoutMs);
    if (second.kind === "ok") return { ok: true, object: second.object, route: "local_cc" };
    if (second.kind === "transport") {
      // The retry's transport failure is reported, but the FIRST reply is what
      // is carried out: it is the only thing the model actually said about the
      // operator's question, and losing it to a failed second call would undo
      // the whole point of surfacing it.
      return { ...second.result, rawReply: boundReply(first.text) };
    }
    return { ...second.result, rawReply: boundReply(second.text || first.text) };
  }
  return { ...first.result, rawReply: boundReply(first.text) };
}

function boundReply(text: string): string | undefined {
  const t = (text ?? "").trim();
  return t.length === 0 ? undefined : t.slice(0, RAW_REPLY_MAX_CHARS);
}

/** One local-cc call, parsed and validated.
 *
 *  `transport` (no runner, timeout, runner error) is separated from `rejected`
 *  (the model answered, the answer was unusable) because ONLY the second is
 *  worth asking again - and because the two need different words in front of
 *  an operator. */
type LocalCcAttempt<T> =
  | { kind: "ok"; object: T }
  | { kind: "transport"; result: Extract<TenantGenerateObjectResult<T>, { ok: false }> }
  | {
      kind: "rejected";
      result: Extract<TenantGenerateObjectResult<T>, { ok: false }>;
      /** What the model said. Empty only if it said nothing. */
      text: string;
    };

async function attemptLocalCc<T>(
  args: TenantGenerateObjectArgs<T>,
  system: string,
  prompt: string,
  timeoutMs: number,
): Promise<LocalCcAttempt<T>> {
  const bridge = await invokeLocalCcOneShot({
    tenantId: args.tenantId,
    systemPrompt: system,
    prompt,
    modelTier: args.tier,
    timeoutMs,
  });
  if (!bridge.ok) {
    if (bridge.reason === "timeout") {
      return {
        kind: "transport",
        result: {
          ok: false,
          error:
            `${args.featureName} timed out waiting for your local runner. ` +
            "Check that the runner is idle enough to pick up jobs, then try again.",
          kind: "unreachable",
        },
      };
    }
    return {
      kind: "transport",
      result: {
        ok: false,
        error: `${args.featureName} failed: ${bridge.reason.slice(0, 300)}`,
        kind: "call_failed",
      },
    };
  }

  const text = bridge.text ?? "";
  // EVERY readable object, in document order - then the SCHEMA picks. That
  // ordering matters: a reply that wraps the answer in an envelope, or that
  // quotes a small unrelated object in its prose, is only disambiguable by
  // which candidate validates.
  const candidates = extractJsonCandidates(text);
  let firstIssue: string | null = null;
  for (const candidate of candidates) {
    const valid = args.schema.safeParse(candidate);
    if (valid.success) return { kind: "ok", object: valid.data };
    if (firstIssue === null) {
      const issue = valid.error.issues[0];
      firstIssue = `${issue?.path?.join(".") || "reply"}: ${issue?.message ?? "schema mismatch"}`;
    }
  }

  // LOG WHAT CAME BACK. The cause of this failure is entirely inside a string
  // nobody kept, and without this line the only record of a 1,453-character
  // reply that would not parse is that it did not parse. Bounded, with the
  // length reported separately so a truncated log still says how much there
  // was. (The reply is ALSO returned to the caller now - the log survives
  // because it is the record that outlives the request.)
  if (candidates.length === 0) {
    console.warn(
      `[llm] ${args.featureName}: no parseable JSON in a ${text.length}-char reply. ` +
        `First 500 chars: ${JSON.stringify(text.slice(0, 500))}`,
    );
    return {
      kind: "rejected",
      text,
      result: {
        ok: false,
        error: `${args.featureName} answered, but the reply contained no readable JSON — try again.`,
        kind: "unparseable",
      },
    };
  }
  console.warn(
    `[llm] ${args.featureName}: ${candidates.length} JSON object(s) in a ${text.length}-char ` +
      `reply, none matching the schema (${firstIssue ?? "unknown"}).`,
  );
  return {
    kind: "rejected",
    text,
    result: {
      ok: false,
      error:
        `${args.featureName} returned an invalid draft (${firstIssue ?? "schema mismatch"}) ` +
        `— try again.`,
      kind: "invalid_shape",
    },
  };
}

// ─── direct-model gate for text-shaped callers ──────────────────────────────
//
// `generateText`-shaped features (e.g. text-to-SQL) that can only run on the
// direct API use this to resolve a tenant-scoped model WITH the friendly
// missing-key error, instead of touching the env-backed `models` singleton.

export type DirectModelResult =
  | { ok: true; model: ReturnType<typeof modelForTenant> }
  | { ok: false; error: string };

export async function requireDirectApiModel(
  tenantId: string,
  tier: ModelTier,
  featureName: string,
): Promise<DirectModelResult> {
  const apiKey = await resolvePlatformSecret("ANTHROPIC_API_KEY", { tenantId });
  if (!apiKey || apiKey.length === 0) {
    return { ok: false, error: apiKeyMissingError(featureName) };
  }
  return { ok: true, model: modelForTenant(tenantId, tier) };
}
