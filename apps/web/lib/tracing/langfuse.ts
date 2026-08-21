// Langfuse span helpers. Every run/step/tool/LLM call in DevPilot emits a span
// through these wrappers — the trace tree is the source of truth for the Run
// Inspector and external observability.

import { Langfuse, type LangfuseSpanClient, type LangfuseTraceClient } from "langfuse";
import { env } from "@/lib/env";
import { decideTracing, disabledLangfuse, type TracingKeys } from "./optional";
import { costCents, tierFromModelId, type TokenUsage } from "@/lib/llm/cost";
import {
  ensurePlatformSecretsLoaded,
  platformSecretsEnabled,
  resolveSync,
} from "@/lib/platform-secrets/resolver";

function newLangfuse(publicKey: string, secretKey: string, baseUrl: string): Langfuse {
  return new Langfuse({
    publicKey,
    secretKey,
    baseUrl,
    // Phase 0 dev: flush eagerly so traces show up in the dashboard immediately.
    flushAt: 1,
    flushInterval: 1000,
  });
}

// ── Tracing is OPTIONAL; the run is not ─────────────────────────────────────
// The decision and the no-op client live in `./optional` (marker-free, tested).
// NEVER read the two key values through the `env.LANGFUSE_*` getters on this
// path: they THROW on a blank value, which is how every run on a local install
// used to die at its first step. A test pins that absence.

function rawKeys(tenantId: string | null): TracingKeys {
  const fromResolver = platformSecretsEnabled();
  const publicKey =
    (fromResolver ? resolveSync("LANGFUSE_PUBLIC_KEY", { tenantId }) : undefined) ??
    process.env.LANGFUSE_PUBLIC_KEY ??
    "";
  const secretKey =
    (fromResolver ? resolveSync("LANGFUSE_SECRET_KEY", { tenantId }) : undefined) ??
    process.env.LANGFUSE_SECRET_KEY ??
    "";
  return { publicKey: publicKey.trim(), secretKey: secretKey.trim() };
}

/** Both keys present (tenant override » instance » env). False means spans are
 *  dropped and the Langfuse links/probe should say "not configured". */
export function tracingKeysConfigured(tenantId: string | null): boolean {
  return decideTracing(rawKeys(tenantId)).enabled;
}

// Bounded memo: resolved (publicKey, secretKey, baseUrl) tuple → its client.
// Keyed by the RESOLVED values (like lib/llm/models-tenant.ts), so rotating a
// Langfuse key in the UI auto-builds a fresh client on the next call (a
// different tuple → memo miss). When the feature flag is off or nothing
// resolves, every tenant collapses onto the same env-backed tuple — i.e. the
// single instance the old `langfuse()` singleton returned.
const MAX_CLIENTS = 8;
const byTuple = new Map<string, Langfuse>();

function clientForTuple(publicKey: string, secretKey: string, baseUrl: string): Langfuse {
  // `\u0000` can't appear in any of the three values, so it's a safe joiner.
  const tupleKey = `${publicKey}\u0000${secretKey}\u0000${baseUrl}`;
  const existing = byTuple.get(tupleKey);
  if (existing) return existing;
  const client = newLangfuse(publicKey, secretKey, baseUrl);
  // Evict the oldest entry if over the cap (simple FIFO is plenty here).
  if (byTuple.size >= MAX_CLIENTS) {
    const oldest = byTuple.keys().next().value;
    if (oldest !== undefined) byTuple.delete(oldest);
  }
  byTuple.set(tupleKey, client);
  return client;
}

/**
 * Langfuse client bound to a tenant's resolved keys (tenant override » instance
 * » env). The result is memoised by the resolved tuple, so a UI key rotation
 * rebuilds the client on the next call. Warm the resolver
 * (`ensurePlatformSecretsLoaded`) before calling so a per-tenant override is in
 * cache; a cold cache / flag-off / unresolved value falls back to env, i.e.
 * byte-for-byte today's single instance.
 */
export function langfuseForTenant(tenantId: string | null): Langfuse {
  if (!platformSecretsEnabled()) return langfuse();
  const keys = rawKeys(tenantId);
  if (!decideTracing(keys).enabled) return disabledLangfuse();
  const { publicKey, secretKey } = keys;
  // env.LANGFUSE_BASE_URL already supplies the cloud default when unset, so the
  // resolver's undefined collapses to the same default the env getter returns.
  const baseUrl = resolveSync("LANGFUSE_BASE_URL", { tenantId }) ?? env.LANGFUSE_BASE_URL;
  return clientForTuple(publicKey, secretKey, baseUrl);
}

/** Env-backed Langfuse instance (the instance scope, tenantId:null). Retained as
 *  the default for callers that have no tenant in scope. */
export function langfuse(): Langfuse {
  const keys: TracingKeys = {
    publicKey: (process.env.LANGFUSE_PUBLIC_KEY ?? "").trim(),
    secretKey: (process.env.LANGFUSE_SECRET_KEY ?? "").trim(),
  };
  if (!decideTracing(keys).enabled) return disabledLangfuse();
  return clientForTuple(keys.publicKey, keys.secretKey, env.LANGFUSE_BASE_URL);
}

/**
 * Base URL + project id for building Langfuse trace/observation deep-links,
 * resolved the same way `langfuseForTenant` resolves the client keys (tenant
 * override » instance » env) so a value configured in Settings is honored by
 * the Run Inspector's trace links, not just by the client that emits spans.
 * Callers must warm the resolver first (`ensurePlatformSecretsLoaded`) so a
 * per-tenant override is in cache; a cold cache / flag-off / unresolved value
 * falls back to env, i.e. byte-for-byte today's behavior.
 */
export function resolveLangfuseLinkConfig(tenantId: string | null): {
  baseUrl: string;
  projectId: string;
} {
  if (!platformSecretsEnabled()) {
    return { baseUrl: env.LANGFUSE_BASE_URL, projectId: env.LANGFUSE_PROJECT_ID };
  }
  const baseUrl = resolveSync("LANGFUSE_BASE_URL", { tenantId }) ?? env.LANGFUSE_BASE_URL;
  const projectId = resolveSync("LANGFUSE_PROJECT_ID", { tenantId }) ?? env.LANGFUSE_PROJECT_ID;
  return { baseUrl, projectId };
}

export type RunSpanOptions = {
  runId: string;
  tenantId: string;
  userId?: string;
  agentName?: string;
  metadata?: Record<string, unknown>;
};

export type RunSpanContext = { trace: LangfuseTraceClient };

/** Top-level wrapper for an agent run. Creates the root trace. */
export async function withRunSpan<T>(
  opts: RunSpanOptions,
  fn: (ctx: RunSpanContext) => Promise<T>,
): Promise<T> {
  // Warm the resolver at this async boundary so the tenant's Langfuse keys are
  // in cache before we pick the client (no-op when the flag is off).
  await ensurePlatformSecretsLoaded(opts.tenantId);
  const client = langfuseForTenant(opts.tenantId);
  const trace = client.trace({
    id: opts.runId,
    name: opts.agentName ?? "agent.run",
    userId: opts.userId,
    metadata: { tenantId: opts.tenantId, ...opts.metadata },
  });
  try {
    return await fn({ trace });
  } catch (err) {
    trace.update({ metadata: { error: String(err) } });
    throw err;
  } finally {
    await client.flushAsync();
  }
}

export type SpanParent = LangfuseTraceClient | LangfuseSpanClient;

/** Generic wrapper for an agent step (think / iteration). */
export async function withStepSpan<T>(
  parent: SpanParent,
  opts: { name: string; input?: unknown; metadata?: Record<string, unknown> },
  fn: (span: LangfuseSpanClient) => Promise<T>,
): Promise<T> {
  const span = parent.span({ name: opts.name, input: opts.input, metadata: opts.metadata });
  try {
    const result = await fn(span);
    span.update({ output: result });
    return result;
  } catch (err) {
    span.update({ level: "ERROR", statusMessage: String(err) });
    throw err;
  } finally {
    span.end();
  }
}

/** Wrapper for a single tool invocation. */
export async function withToolSpan<T>(
  parent: SpanParent,
  opts: { name: string; input?: unknown },
  fn: () => Promise<T>,
): Promise<T> {
  const span = parent.span({ name: `tool:${opts.name}`, input: opts.input });
  try {
    const result = await fn();
    span.update({ output: result });
    return result;
  } catch (err) {
    span.update({ level: "ERROR", statusMessage: String(err) });
    throw err;
  } finally {
    span.end();
  }
}

export type LLMResultLike = {
  text?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
};

/**
 * Wrapper for an LLM call. Records token usage and cost (cents) on the
 * Langfuse generation, so the trace doubles as the spend ledger.
 */
export async function withLLMSpan<T extends LLMResultLike>(
  parent: SpanParent,
  opts: { name?: string; model: string; input: unknown; metadata?: Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  const gen = parent.generation({
    name: opts.name ?? "llm.call",
    model: opts.model,
    input: opts.input,
    metadata: opts.metadata,
  });
  try {
    const result = await fn();
    const usage = result.usage;
    const tier = tierFromModelId(opts.model);
    const tokenUsage: TokenUsage | null = usage
      ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }
      : null;
    const cents = tier && tokenUsage ? costCents(tier, tokenUsage) : null;
    gen.update({
      output: result.text,
      usage: usage
        ? {
            input: usage.promptTokens,
            output: usage.completionTokens,
            total: usage.totalTokens,
            unit: "TOKENS",
          }
        : undefined,
      metadata: {
        ...opts.metadata,
        ...(cents != null ? { cost_cents: cents } : {}),
      },
    });
    return result;
  } catch (err) {
    gen.update({ level: "ERROR", statusMessage: String(err) });
    throw err;
  } finally {
    gen.end();
  }
}
