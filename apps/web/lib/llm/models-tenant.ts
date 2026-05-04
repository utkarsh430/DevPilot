// The vendor-SDK boundary for tenant/project-scoped model calls (server-only).
//
// Together with lib/llm/models.ts (the env-backed Anthropic singleton) this is
// the ONLY place in the codebase allowed to import a vendor SDK — CLAUDE.md
// non-negotiable #1. Feature code asks for a model; it never learns which vendor
// answered.
//
// Two providers, one cache. `createAnthropic({apiKey})` generalises to a factory
// that also returns `createOpenAI({baseURL, apiKey})` for an OpenAI-compatible
// endpoint (Ollama, vLLM, LiteLLM, OpenAI itself). The client memo — previously
// keyed by the resolved api key alone — is now keyed by provider + baseURL +
// apiKey, because those three together are what identify a client: two projects
// pointing at different Ollama hosts with no key at all must not share one.
//
// SSRF: the base URL is re-validated HERE, immediately before the client is
// built, on every call. The write path already rejected anything unsafe, so this
// is the second half of the DNS-rebinding defence (a record that turns malicious
// after it was saved). It is intentionally NOT cached — the whole point is to
// re-resolve.

import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";
import { MODEL_IDS, models, type ModelTier } from "@/lib/llm/models";
import { validateLlmBaseUrl } from "@/lib/llm/base-url.server";
import { resolveApiModelId, type LlmProvider } from "@/lib/llm/provider";
import type { ResolvedProviderConfig } from "@/lib/llm/provider-config.server";
import { apiKeyMissingError } from "@/lib/llm/routing";
import { platformSecretsEnabled, resolveSync } from "@/lib/platform-secrets/resolver";

type ClientFactory = (modelId: string) => LanguageModelV1;

// Bounded memo: provider|baseURL|apiKey → the client factory built from it.
const MAX_CLIENTS = 8;
const clients = new Map<string, ClientFactory>();

function cacheKey(provider: LlmProvider, baseUrl: string | null, apiKey: string | null): string {
  return `${provider}|${baseUrl ?? ""}|${apiKey ?? ""}`;
}

function remember(key: string, factory: ClientFactory): ClientFactory {
  if (clients.size >= MAX_CLIENTS) {
    const oldest = clients.keys().next().value;
    if (oldest !== undefined) clients.delete(oldest);
  }
  clients.set(key, factory);
  return factory;
}

function clientFor(
  provider: LlmProvider,
  baseUrl: string | null,
  apiKey: string | null,
): ClientFactory {
  const key = cacheKey(provider, baseUrl, apiKey);
  const existing = clients.get(key);
  if (existing) return existing;

  if (provider === "openai_compatible") {
    // `apiKey` may legitimately be absent (a local Ollama authenticates nobody);
    // the SDK requires a string, so send a placeholder rather than crash.
    const openai = createOpenAI({
      baseURL: baseUrl ?? undefined,
      apiKey: apiKey ?? "not-required",
      // Ollama/vLLM/LiteLLM implement the plain chat-completions contract;
      // the SDK's default "responses" API is OpenAI-proprietary and 404s there.
      compatibility: "compatible",
    });
    return remember(key, (modelId) => openai.chat(modelId));
  }

  const anthropic = createAnthropic({ apiKey: apiKey ?? undefined });
  return remember(key, (modelId) => anthropic(modelId));
}

export type ProviderModelResult =
  | { ok: true; model: LanguageModelV1; modelId: string }
  | { ok: false; error: string };

/**
 * Build the model for a resolved provider config. Async because the base URL is
 * DNS-validated before we hand it to the SDK — see the header.
 *
 * Returns a result rather than throwing so the callers (ApiRunner, the plan
 * bridge, generateObjectForTenant) can surface an actionable message instead of
 * an SDK stack trace: a misconfigured provider is an operator problem, and "we
 * refused to call your endpoint because it resolves to 10.0.0.5" needs to reach
 * them intact.
 */
export async function modelForProviderConfig(
  config: ResolvedProviderConfig,
  tier: ModelTier,
): Promise<ProviderModelResult> {
  const modelId = resolveApiModelId(config.provider, tier, config.model);

  if (config.provider === "openai_compatible") {
    if (!config.baseUrl) {
      return {
        ok: false,
        error:
          "This project uses an OpenAI-compatible provider but no base URL is configured. " +
          "Set one in the project's LLM provider settings.",
      };
    }
    if (!modelId) {
      return {
        ok: false,
        error:
          "This project uses an OpenAI-compatible provider but no model is configured. " +
          "Name the model your endpoint serves (e.g. `llama3.1:70b`) in the project's LLM provider settings.",
      };
    }
    // CALL-TIME SSRF re-check. Never skip this on the grounds that the write path
    // already validated — that check ran against yesterday's DNS.
    const safe = await validateLlmBaseUrl(config.baseUrl);
    if (!safe.ok) {
      return { ok: false, error: `Refusing to call this project's LLM endpoint: ${safe.message}` };
    }
    return {
      ok: true,
      model: clientFor(config.provider, safe.normalized, config.apiKey)(modelId),
      modelId,
    };
  }

  // Anthropic on the API path with no key anywhere (tenant » instance » env) is a
  // real misconfiguration. Surface the actionable copy rather than letting the SDK
  // raise its own "apiKey is missing" mid-generate — the invariant routing.ts
  // guards is that the raw crash never reaches an operator.
  if (!config.apiKey) {
    return { ok: false, error: apiKeyMissingError("This run") };
  }
  const id = modelId ?? MODEL_IDS[tier];
  return { ok: true, model: clientFor("anthropic", null, config.apiKey)(id), modelId: id };
}

/**
 * Anthropic model for `tier`, bound to the tenant's resolved ANTHROPIC_API_KEY.
 *
 * The pre-provider entry point, unchanged in behaviour and still used by the
 * Anthropic-only call sites (text-to-SQL, the direct-API structured path). Falls
 * back to the env-backed `models` singleton when platform-secrets is off or
 * nothing resolves — which throws on first use exactly like today if env is also
 * unset. Warm the resolver (`ensurePlatformSecretsLoaded`) before calling so a
 * per-tenant override is in cache.
 */
export function modelForTenant(tenantId: string | null, tier: ModelTier) {
  if (!platformSecretsEnabled()) return models[tier];
  const key = resolveSync("ANTHROPIC_API_KEY", { tenantId });
  return key ? clientFor("anthropic", null, key)(MODEL_IDS[tier]) : models[tier];
}
