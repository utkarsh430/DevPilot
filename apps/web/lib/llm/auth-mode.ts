// LLM auth-mode — the explicit, per-tenant choice of which credential the
// platform uses to reach Claude.
//
//   "claude_code" (DEFAULT) — the local Claude Code runner on the operator's
//                             own Pro/Max subscription (CLAUDE_CODE_OAUTH_TOKEN
//                             or an authenticated `claude` CLI). No API key
//                             required. This is CLAUDE.md non-negotiable #1:
//                             the local-cc subscription runner is the default.
//   "api_key"               — the per-token Anthropic API path (ANTHROPIC_API_KEY),
//                             used for multi-tenant / per-token serving.
//
// This module is PURE: no `server-only`, no DB, no `process.env`. It is safe to
// import from both client components (the Settings form) and server code (the
// resolver, runner bridge, and health probes). The DB-backed resolver lives in
// `auth-mode.server.ts`.

export type LlmAuthMode = "claude_code" | "api_key";

/** Absent / unset / anything unrecognised resolves here, so a fresh install is
 *  Claude Code auth with zero configuration. */
export const DEFAULT_LLM_AUTH_MODE: LlmAuthMode = "claude_code";

export const LLM_AUTH_MODES: readonly LlmAuthMode[] = ["claude_code", "api_key"];

/** The `tenants.config` jsonb key this setting is stored under. Kept here so the
 *  reader, the writer (server action), and any migration/doc reference the same
 *  literal rather than restating the string. */
export const LLM_AUTH_MODE_CONFIG_KEY = "llm_auth_mode";

/** Coerce an arbitrary stored value (jsonb is `unknown` at the type level) into a
 *  valid mode. Only the exact string "api_key" opts out of the Claude Code
 *  default — everything else (null, undefined, "", legacy values, typos) falls
 *  back to `claude_code` so the default is never a surprise. */
export function normalizeLlmAuthMode(raw: unknown): LlmAuthMode {
  return raw === "api_key" ? "api_key" : DEFAULT_LLM_AUTH_MODE;
}

export function isLlmAuthMode(value: unknown): value is LlmAuthMode {
  return value === "claude_code" || value === "api_key";
}

/** Human-facing copy for the Settings cards and any status surface. Kept beside
 *  the type so the UI and docs stay in lockstep with the enum. */
export const LLM_AUTH_MODE_META: Record<
  LlmAuthMode,
  { label: string; tagline: string; recommended: boolean }
> = {
  claude_code: {
    label: "Claude Code subscription",
    tagline:
      "Run agents on your own Claude Pro/Max subscription via the local runner. No API key required.",
    recommended: true,
  },
  api_key: {
    label: "Anthropic API key",
    tagline: "Use a per-token ANTHROPIC_API_KEY. Needed for multi-tenant / per-token serving.",
    recommended: false,
  },
};

/** Does the ANTHROPIC_API_KEY health check apply in this mode? The API key is
 *  irrelevant under `claude_code`, so the probe must report not-applicable
 *  rather than "down" when it's absent. */
export function apiKeyCheckAppliesForMode(mode: LlmAuthMode): boolean {
  return mode === "api_key";
}
