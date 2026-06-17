// Credential isolation for the SUBSCRIPTION `claude -p` spawn.
//
// THE INVARIANT: the local-cc runner is the subscription path, by definition. If
// an Anthropic API key reaches `claude -p`, claude-code silently switches to
// pay-per-token mode and ignores the operator's OAuth credentials — the API key
// takes precedence over stored OAuth. (Real incident: Wave 3 M6 acceptance,
// 2026-06-02.) claude.ts has stripped ANTHROPIC_API_KEY from the spawn env ever
// since.
//
// THE HOLE THIS CLOSES: the strip was being undone downstream. `envOverrides` is
// spread LAST into the spawn env (so it WINS over the strip), and the per-project
// secrets vault is spread into `envOverrides` with NO key-name filter at all. A
// project secret literally named ANTHROPIC_API_KEY therefore re-injected itself
// onto the subscription spawn and silently moved the tenant onto per-token
// billing. Worse — and this is the part that makes it a security bug rather than
// a billing one — the same path accepts ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN, which are real claude-code env vars: a vault secret by
// that name redirects the agent's entire LLM traffic (prompts, repo contents, the
// OAuth token in the Authorization header) to a host of the writer's choosing.
//
// THE TRUST BOUNDARY, stated once: the runner HOST's own process.env is
// operator-controlled and trusted — we don't police it beyond the historic
// ANTHROPIC_API_KEY strip. `envOverrides` is NOT: it is assembled from the
// database (the per-project vault, the engine-fetched tenant config), which is
// exactly the surface an attacker with write access to a project would use. So
// the filter belongs on envOverrides, and it is applied at BOTH the composition
// site (index.ts) and the spawn site (claude.ts) — the second is the one that
// holds if someone adds a third caller.
//
// Pure module: no imports, no env reads, so the test can exercise the real
// composition rather than a re-implementation of it.

/**
 * Env names a DB-sourced override may never set on the subscription spawn.
 *
 * Anthropic trio: the credential itself, its OAuth-shaped sibling, and the
 * endpoint — all three redirect or re-authenticate the agent's LLM traffic.
 * Provider names (WI-12): a provider credential belongs to the API path and has
 * no business on a subscription spawn at all; blocking it by name means a vault
 * secret cannot shadow it into one. DEVPILOT_LLM_API_KEY is the fixed vault key
 * the project form writes a provider key to — keep in lockstep with
 * PROJECT_LLM_API_KEY in apps/web/lib/llm/credential-ref.ts.
 *
 * This is a DENY list on a spawn that must stay subscription-authenticated, not
 * a general secrets policy: a project's own OPENAI_API_KEY still reaches its
 * workspace `.env.local` (written from the same payload on a different path), so
 * the app under test keeps working. What it can't do is reach the agent process.
 */
export const SUBSCRIPTION_BLOCKED_ENV_KEYS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "DEVPILOT_LLM_API_KEY",
  "LLM_PROVIDER_API_KEY",
  "LLM_PROVIDER_BASE_URL",
];

export function isBlockedSubscriptionEnvKey(key: string): boolean {
  return SUBSCRIPTION_BLOCKED_ENV_KEYS.includes(key.trim().toUpperCase());
}

/** Drop every blocked name from a candidate override map. Case-insensitive on the
 *  key: `anthropic_api_key` is the same env var on the platforms we run on, and a
 *  filter that a lower-cased name walks past is not a filter. */
export function sanitizeSubscriptionEnvOverrides(
  overrides: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (isBlockedSubscriptionEnvKey(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Parse the per-project secrets JSON into an envOverrides-shaped object, MINUS
 * anything on the blocklist. Defensive against malformed payloads (the LPUSHed
 * JSON has already been parsed once at the outer level; this is the inner secrets
 * blob, a string of `{"KEY": "value", …}`).
 *
 * Returns an empty object on null / unparseable / non-string values so the caller
 * can spread it unconditionally.
 */
export function parseSecretsForEnvOverrides(
  json: string | null | undefined,
): Record<string, string> {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== "string") continue;
      if (isBlockedSubscriptionEnvKey(k)) {
        console.warn(
          `[devpilot-runner] project secret "${k}" is not allowed on the subscription spawn — ignoring it there (it still reaches the workspace .env.local).`,
        );
        continue;
      }
      out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export type SubscriptionEnvInput = {
  runId: string;
  tenantId: string;
  /** WI-14 — the ticket this run is working. The MCP relay's `devpilot_create_ticket`
   *  derives the new ticket's tenant AND project from this id SERVER-SIDE, so the
   *  model never gets to name either. Absent on a ticket-less run (supervisor
   *  child, ad-hoc replay), where the relay refuses the tool outright. */
  ticketId?: string | null;
  role?: string | null;
  workspacePath?: string | null;
  baseSha?: string | null;
  /** L1 / B2 — integration/base branch, so the MCP relay's hook (i) can count
   *  `commits_ahead` exactly as index.ts's hook (ii) does. */
  baseBranch?: string | null;
  qaVerifyEnabled: boolean;
  /** Verdictless-review seam — the run-scoped file the MCP relay appends to when
   *  it successfully relays an outcome-recording tool, and which the runner reads
   *  back after `claude -p` exits. Chosen by the RUNNER (see
   *  `outcome-marker.ts`) and injected here so it reaches the relay through the
   *  same map that already carries `DEVPILOT_RUN_ID`, i.e. via both spawn paths
   *  with no second piece of plumbing. Absent leaves the relay recording nothing
   *  and the seam permanently skipped — today's behaviour exactly. */
  outcomeMarkerPath?: string | null;
  /** Engine-fetched per-tenant config (already excludes ANTHROPIC_API_KEY by
   *  construction — see runnerConfigEnvOverrides — but re-filtered here anyway:
   *  one choke point, no "it's fine because the caller is careful"). */
  runnerConfig: Record<string, string>;
  /** Raw per-project secrets JSON from the job payload. */
  projectSecretsJson?: string | null;
};

/**
 * The complete `envOverrides` map for a subscription `claude -p` job — the real
 * composition, extracted from index.ts so the isolation test can assert against
 * what actually ships rather than a paraphrase of it.
 *
 * Order matters and is preserved from the original: DEVPILOT_* run scoping, then the
 * tenant config, then the project secrets (a project's explicit value wins over
 * the tenant default). The blocklist filter runs over the WHOLE result, so no
 * layer can smuggle a blocked name in past the ones before it.
 */
export function buildSubscriptionEnvOverrides(input: SubscriptionEnvInput): Record<string, string> {
  const merged: Record<string, string> = {
    DEVPILOT_RUN_ID: input.runId,
    DEVPILOT_TENANT_ID: input.tenantId,
    ...(input.ticketId ? { DEVPILOT_TICKET_ID: input.ticketId } : {}),
    ...(input.role ? { DEVPILOT_ROLE: input.role } : {}),
    ...(input.workspacePath ? { DEVPILOT_WORKSPACE_PATH: input.workspacePath } : {}),
    ...(input.baseSha ? { DEVPILOT_BASE_SHA: input.baseSha } : {}),
    ...(input.baseBranch ? { DEVPILOT_BASE_BRANCH: input.baseBranch } : {}),
    ...(input.outcomeMarkerPath ? { DEVPILOT_OUTCOME_MARKER_PATH: input.outcomeMarkerPath } : {}),
    // Written in BOTH directions on purpose. Omitting it when false would let
    // the child inherit the runner HOST's own ENGINEER_QA_VERIFY_ENABLED (the
    // spawn env is process.env with these overrides layered on top), so the
    // engine's decision would be authoritative for "on" but not for "off" —
    // exactly the engine/runner disagreement this field exists to end.
    ENGINEER_QA_VERIFY_ENABLED: input.qaVerifyEnabled ? "1" : "0",
    ...input.runnerConfig,
    ...parseSecretsForEnvOverrides(input.projectSecretsJson),
  };
  return sanitizeSubscriptionEnvOverrides(merged);
}
