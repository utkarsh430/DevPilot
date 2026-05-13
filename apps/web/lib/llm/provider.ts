// LLM provider — WHICH vendor endpoint a run's LLM calls go to.
//
// Orthogonal to the auth-MODE (lib/llm/auth-mode.ts), which answers "which
// credential do we present": mode is about the Anthropic credential, provider
// is about the endpoint. The two compose:
//
//   anthropic          — the vendor default. Honours the auth-mode: `claude_code`
//                        rides the local-cc subscription runner, `api_key` uses
//                        the direct Anthropic API. This is today's behaviour and
//                        stays the default for every project that configures
//                        nothing.
//   openai_compatible  — an OpenAI-shaped `/chat/completions` endpoint at an
//                        operator-supplied base URL (Ollama, vLLM, LiteLLM, a
//                        gateway, OpenAI itself). API PATH ONLY.
//
// The API-path-only rule is not a limitation we can engineer around: the
// local-cc runner IS the Claude CLI (`claude -p`), which speaks the Anthropic
// protocol and nothing else. Selecting `openai_compatible` therefore FORCES the
// run onto the ApiRunner (see `decideRunnerPolicy` in lib/llm/routing.ts). The
// subscription runner stays strictly Anthropic — anything else would either
// silently bill the wrong account or break the run.
//
// This module is PURE: no `server-only`, no DB, no `process.env`. Safe to import
// from client components (the project forms) and server code alike. The DB-backed
// resolver lives in `provider-config.server.ts`.

import { MODEL_IDS, type ModelTier } from "@/lib/llm/models";

export type LlmProvider = "anthropic" | "openai_compatible";

export const MODEL_ID_MAX = 120;
/** Model ids are vendor-shaped slugs (`claude-opus-4-7`, `llama3.1:70b`,
 *  `gpt-4o-2024-08-06`). Constrained rather than free text because the value
 *  reaches a subprocess argv on the local-cc path (`claude -p --model <x>`), and
 *  an operator-supplied string is not something to hand a shell-adjacent boundary
 *  unchecked. Shared by every Zod schema that accepts a model. */
export const MODEL_ID_RE = /^[A-Za-z0-9._:\-/]{1,120}$/;

/** Absent / unset / unrecognised resolves here, so a project that configures
 *  nothing behaves byte-for-byte like today. */
export const DEFAULT_LLM_PROVIDER: LlmProvider = "anthropic";

export const LLM_PROVIDERS: readonly LlmProvider[] = ["anthropic", "openai_compatible"];

/** The `tenants.config` jsonb key the tenant-level default is stored under.
 *  Mirrors LLM_AUTH_MODE_CONFIG_KEY — one literal, read by the resolver and
 *  written by the settings action. */
export const LLM_PROVIDER_CONFIG_KEY = "llm_provider";

/** Coerce an arbitrary stored value (jsonb / a DB enum column / a form field is
 *  `unknown` at the type level) into a valid provider. Only the exact string
 *  "openai_compatible" opts out of the Anthropic default. */
export function normalizeLlmProvider(raw: unknown): LlmProvider {
  return raw === "openai_compatible" ? "openai_compatible" : DEFAULT_LLM_PROVIDER;
}

export function isLlmProvider(value: unknown): value is LlmProvider {
  return value === "anthropic" || value === "openai_compatible";
}

/** Does this provider require a base URL? Only the OpenAI-compatible one — the
 *  Anthropic endpoint is fixed, and letting a project point "Anthropic" at an
 *  arbitrary host would be a credential-exfiltration primitive, not a feature. */
export function providerRequiresBaseUrl(provider: LlmProvider): boolean {
  return provider === "openai_compatible";
}

/** Can this provider run on the local-cc subscription runner? Only Anthropic —
 *  see the header. Callers use this to force the API path. */
export function providerSupportsLocalCc(provider: LlmProvider): boolean {
  return provider === "anthropic";
}

export const LLM_PROVIDER_META: Record<
  LlmProvider,
  { label: string; tagline: string; recommended: boolean }
> = {
  anthropic: {
    label: "Anthropic (Claude)",
    tagline:
      "The default. Runs on your Claude Code subscription via the local runner, or the Anthropic API — whichever this workspace's LLM auth-mode selects.",
    recommended: true,
  },
  openai_compatible: {
    label: "OpenAI-compatible endpoint",
    tagline:
      "Any server speaking the OpenAI /chat/completions API — Ollama, vLLM, LiteLLM, a gateway, or OpenAI itself. Runs on the API path only (the subscription runner is Claude-CLI-based and can't speak it).",
    recommended: false,
  },
};

// ─── model resolution ───────────────────────────────────────────────────────
//
// Per-role `modelTier` has always been a documented NO-OP on the local-cc path:
// the engine never wrote a model into the runner job, and `claude -p` was
// spawned with no `--model`, so every step ran on whatever the operator's
// account default is. That stays TRUE unless a project explicitly opts in by
// setting a model — the `--model` flag is DEFAULT-OFF, and `resolveModelId`
// returning `null` is what preserves today's exact behaviour.

/** Model aliases the Claude CLI resolves against the account's plan at run time
 *  ("give me the best Opus this subscription can run"). Safer than a pinned id:
 *  they can't go stale, and they're what an operator on a Pro plan actually
 *  wants. Accepted alongside the concrete `MODEL_IDS` values. */
export const CLAUDE_MODEL_ALIASES: readonly string[] = ["opus", "sonnet", "haiku"];

/** The model ids/aliases we will hand to `claude -p --model`. An allowlist, not a
 *  regex: `--model` is a value the engine passes to a subprocess argv, and an
 *  operator-supplied string is not something to interpolate there unchecked.
 *  Anything outside this set is REFUSED (→ no `--model`, account default), never
 *  a hard run failure — see `resolveClaudeModelArg`. */
export const ALLOWED_CLAUDE_MODELS: readonly string[] = [
  ...CLAUDE_MODEL_ALIASES,
  ...Object.values(MODEL_IDS),
];

export type ClaudeModelDecision =
  | { kind: "account_default"; reason: "not_configured" }
  | { kind: "explicit"; model: string }
  | { kind: "account_default"; reason: "unrecognised_model"; rejected: string };

/**
 * Decide what (if anything) to pass as `claude -p --model` for a run.
 *
 * Three outcomes, and only ONE of them changes today's behaviour:
 *   • nothing configured        → account_default (NO `--model` flag emitted).
 *     This is the path every existing project takes. Default-OFF.
 *   • a recognised model/alias  → explicit, the flag is emitted.
 *   • anything else             → account_default, and the caller logs the
 *     rejection. A typo'd or plan-unavailable model must NEVER hard-fail a run:
 *     dropping back to the account default costs the operator nothing, while
 *     failing the run costs them a ticket.
 *
 * The second half of the safe-fallback story lives on the runner: even a model
 * that passes this allowlist can be unavailable on the operator's actual plan
 * (Opus on a Pro subscription), which only `claude` itself can know. The runner
 * detects that failure and retries once WITHOUT `--model` — see
 * apps/runner/src/model-args.ts.
 */
export function resolveClaudeModelArg(configured: string | null | undefined): ClaudeModelDecision {
  const model = (configured ?? "").trim();
  if (model.length === 0) return { kind: "account_default", reason: "not_configured" };
  if (!ALLOWED_CLAUDE_MODELS.includes(model)) {
    return { kind: "account_default", reason: "unrecognised_model", rejected: model };
  }
  return { kind: "explicit", model };
}

/**
 * The model id for an API-path call.
 *
 * `anthropic` keeps the existing tier → model map (MODEL_IDS), so nothing moves
 * for a project that configures no model. An OpenAI-compatible endpoint has no
 * tier concept we can know about — the operator names the one model their server
 * serves (`llama3.1:70b`, `gpt-4o`, …) and we use it for every tier. An
 * `openai_compatible` project with no model configured is a misconfiguration the
 * caller must surface (there is no sane default to invent), hence `null`.
 */
export function resolveApiModelId(
  provider: LlmProvider,
  tier: ModelTier,
  configuredModel: string | null | undefined,
): string | null {
  const model = (configuredModel ?? "").trim();
  if (provider === "openai_compatible") return model.length > 0 ? model : null;
  // Anthropic: an explicit model overrides the tier map, but only if it's one we
  // recognise — the same allowlist reasoning as above (it reaches an API call,
  // and a bogus id is a 404 mid-run).
  if (model.length > 0 && ALLOWED_CLAUDE_MODELS.includes(model) && !isAlias(model)) {
    return model;
  }
  return MODEL_IDS[tier];
}

/** Aliases are a Claude-CLI concept (`--model sonnet`); the HTTP API needs a
 *  concrete id, so an alias falls back to the tier map on the API path. */
function isAlias(model: string): boolean {
  return CLAUDE_MODEL_ALIASES.includes(model);
}

// ─── precedence: project » tenant » instance » env ──────────────────────────

export type ProviderSelection = {
  provider: LlmProvider;
  /** Only ever non-null for `openai_compatible`. */
  baseUrl: string | null;
  /** Explicit model id/alias, or null = "whatever the tier map / account says". */
  model: string | null;
  /** Opaque pointer to the credential (see credential-ref.ts). Null = fall back
   *  to the platform-secrets key for this provider. */
  credentialRef: string | null;
  /** Which layer won. Surfaced in traces + the settings UI so an operator can
   *  see WHY a run went where it went. */
  source: "project" | "tenant" | "default";
};

export type ProjectProviderRow = {
  provider: LlmProvider | null;
  baseUrl: string | null;
  model: string | null;
  credentialRef: string | null;
};

/**
 * The precedence rule, as one pure function: a project's explicit choice wins
 * outright over the tenant default, which wins over the built-in Anthropic
 * default.
 *
 * "Wins outright" is deliberate — we do NOT merge field-by-field across layers.
 * A project that says `openai_compatible` must not silently inherit the tenant's
 * Anthropic key, and a project on `anthropic` must not inherit a tenant base URL
 * that would redirect Claude traffic to a third-party host. Provider selection
 * and the endpoint/credential that go with it are one atomic decision.
 *
 * The instance/env layer is NOT represented here: it's the fallback INSIDE the
 * credential + base-URL resolution (platform-secrets already resolves tenant »
 * instance » env for a given key), which is why a tenant-level selection carries
 * a null baseUrl/credentialRef and lets that chain fill it in.
 */
export function selectProvider(inputs: {
  project?: ProjectProviderRow | null;
  tenantProvider?: LlmProvider | null;
}): ProviderSelection {
  const project = inputs.project;
  if (project?.provider) {
    return {
      provider: project.provider,
      baseUrl: project.provider === "openai_compatible" ? project.baseUrl : null,
      model: project.model,
      credentialRef: project.credentialRef,
      source: "project",
    };
  }
  if (inputs.tenantProvider) {
    return {
      provider: inputs.tenantProvider,
      baseUrl: null,
      model: null,
      credentialRef: null,
      source: "tenant",
    };
  }
  return {
    provider: DEFAULT_LLM_PROVIDER,
    baseUrl: null,
    model: null,
    credentialRef: null,
    source: "default",
  };
}
