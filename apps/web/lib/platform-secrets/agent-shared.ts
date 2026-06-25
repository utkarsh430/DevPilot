// Which platform secrets reach an AGENT's environment, and how they merge with
// the project's own vault.
//
// THE PROBLEM. `project_secrets` already reach the agent: `run-agent.ts` loads
// them at dispatch and the runner writes a 0600 `.env.local` and merges them
// into the `claude -p` spawn env. `platform_secrets` never did. So an
// account-wide credential like VERCEL_TOKEN — one value, identical for every
// project — had to be pasted into every project's vault by hand.
//
// THE CONSTRAINT. A blanket "missing at project level, so read platform level"
// fallback is NOT acceptable and is deliberately not built here.
// `platform_secrets` holds ANTHROPIC_API_KEY, SUPABASE_SECRET_KEY,
// STRIPE_SECRET_KEY, UPSTASH_REDIS_REST_TOKEN, INNGEST_SIGNING_KEY and more; a
// general fallback would place every one of them into every agent's environment
// on every dispatch, permanently. An agent can read its own environment, and a
// prompt-injected one will. So: PER-KEY OPT-IN, DEFAULT OFF, set in code.
//
// TWO INDEPENDENT GUARDS, and neither is alone.
//   1. ELIGIBILITY — the catalog's `shareWithAgents` flag, read here. Absent or
//      false means the key is never even selected for delivery.
//   2. DELIVERY — the runner's SUBSCRIPTION_BLOCKED_ENV_KEYS deny list
//      (`apps/runner/src/subscription-env.ts`), which strips blocked names off
//      the `claude -p` spawn regardless of where they came from. Shared platform
//      secrets travel in the SAME payload field as project secrets, so they
//      inherit that filter for free.
// This module ALSO applies a mirror of the deny list at selection time
// (`AGENT_ENV_DENY_KEYS` below), so a future maintainer marking a blocked key
// shareable gets nothing rather than a value that only the runner happens to
// stop. Belt and braces: the flag governs eligibility, the blocklist governs
// delivery, and either alone would still hold.
//
// Pure module — no `server-only`, no env reads, no DB. The IO half is
// `agent-shared.server.ts`.

import { PLATFORM_SECRET_CATALOG } from "@/lib/platform-secrets/catalog";

/**
 * Web-side mirror of the runner's `SUBSCRIPTION_BLOCKED_ENV_KEYS`
 * (`apps/runner/src/subscription-env.ts`). DUPLICATED, not imported: the web app
 * and the runner are separate packages with no shared constants package (same
 * situation as `ticket-branch.ts` / `workspace-root.ts`, duplicated for the same
 * reason).
 *
 * Keep the two lists in lockstep. Drift in the SAFE direction (a name here that
 * the runner does not block) costs nothing — this list only ever REMOVES keys
 * from delivery. Drift the other way is caught by the runner, which is the
 * authoritative guard on the spawn itself.
 */
export const AGENT_ENV_DENY_KEYS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "DEVPILOT_LLM_API_KEY",
  "LLM_PROVIDER_API_KEY",
  "LLM_PROVIDER_BASE_URL",
];

export function isAgentEnvDenied(key: string): boolean {
  return AGENT_ENV_DENY_KEYS.includes(key.trim().toUpperCase());
}

/**
 * Both guards, in one predicate: the flag must be explicitly true AND the key
 * must not be on the deny list.
 *
 * Takes the ENTRY rather than looking it up, so a test can construct the case
 * that cannot exist in the real catalog — a key that is both blocklisted AND
 * marked shareable — and prove the deny list wins. Asserting that against a
 * real catalog entry proves nothing: every blocklisted key is already unflagged,
 * so the flag check alone would carry the assertion.
 */
export function isAgentShareableEntry(entry: { key: string; shareWithAgents?: boolean }): boolean {
  if (isAgentEnvDenied(entry.key)) return false;
  return entry.shareWithAgents === true;
}

/**
 * Is this catalog key eligible to be shared into an agent's environment?
 * An unknown key is not shareable.
 */
export function isAgentShareableKey(key: string): boolean {
  const entry = PLATFORM_SECRET_CATALOG.find((e) => e.key === key);
  return entry !== undefined && isAgentShareableEntry(entry);
}

/**
 * Every catalog key currently shared with agents, deny-list applied.
 *
 * This is the list rendered on the Platform secrets page — "which of my
 * credentials are exposed to autonomous agents" must be visible on the page,
 * not inferred from code.
 */
export function agentShareablePlatformKeys(): string[] {
  return PLATFORM_SECRET_CATALOG.filter(isAgentShareableEntry).map((e) => e.key);
}

/**
 * Merge the resolved shared platform secrets UNDER the project's own vault, and
 * re-serialise to the `{"KEY":"value",…}` JSON string the runner already reads.
 *
 * PRECEDENCE: project » shared platform » nothing. A project-level value always
 * wins, so a project can override the account-wide default without the operator
 * having to remove the shared one.
 *
 * Returns null when the result is empty, matching `loadProjectSecretsJson`'s
 * contract (null = "this run has no secrets", the runner's legacy path).
 * Unparseable project JSON is treated as no project secrets rather than
 * discarding the shared layer — the caller has already logged upstream failures,
 * and dropping a value silently is the one outcome to avoid.
 */
export function mergeAgentSecretsJson(input: {
  sharedPlatform: Record<string, string>;
  projectSecretsJson: string | null;
}): string | null {
  const project = parseSecretsObject(input.projectSecretsJson);
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.sharedPlatform)) {
    if (isAgentEnvDenied(k)) continue; // re-assert: never trust the caller's selection
    if (typeof v === "string" && v.length > 0) merged[k] = v;
  }
  // Project last: its value wins on a key collision.
  for (const [k, v] of Object.entries(project)) merged[k] = v;
  return Object.keys(merged).length === 0 ? null : JSON.stringify(merged);
}

/** Resolve one platform secret for a tenant. INJECTED — that is what keeps the
 *  tenant scoping testable: `resolver.ts` is `server-only` and cannot load under
 *  Vitest, so a default-argument import would make this whole function
 *  untestable. Same split as `lib/learning/write.ts` vs its action wrapper. In
 *  production the `.server.ts` twin supplies `resolvePlatformSecret`. */
export type PlatformSecretResolve = (
  key: string,
  opts: { tenantId: string | null },
) => Promise<string | undefined>;

/**
 * The `{KEY: value}` map of platform secrets this tenant's agents may see.
 *
 * TENANT SCOPING: every read passes the RUN's own tenantId and nothing else, so
 * a tenant override wins for that tenant and no other tenant's override is
 * reachable. The injected resolver is the only thing that touches the DB, and it
 * is already scoped — this function's job is to never call it with anything but
 * the run's tenant.
 *
 * Best-effort throughout: a resolver failure drops that one key and logs rather
 * than failing the dispatch. A missing shared secret is exactly the state every
 * project was in before this existed.
 */
export async function resolveSharedPlatformSecrets(
  tenantId: string,
  resolve: PlatformSecretResolve,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of agentShareablePlatformKeys()) {
    // Defensive: `agentShareablePlatformKeys` already applied the deny list.
    if (isAgentEnvDenied(key)) continue;
    try {
      const value = await resolve(key, { tenantId });
      if (typeof value === "string" && value.length > 0) out[key] = value;
    } catch (err) {
      console.warn(
        `[platform-secrets] shared-with-agents resolve failed for ${key}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}

function parseSecretsObject(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
