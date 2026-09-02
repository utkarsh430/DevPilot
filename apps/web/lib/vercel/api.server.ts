import "server-only";

// Credential resolution for the Vercel client. This is the ONLY file that reads
// the token; everything else takes it as an argument, which is what keeps the
// transport in `api.ts` unit-testable and keeps the number of places that can
// leak the value down to one.
//
// The three keys live in platform-secrets at INSTANCE storage and resolve
// tenant » instance » env through the standard resolver, so the settings page,
// the setup wizard and a plain `.env.local` all work with no extra wiring.
//
// ── The token must never reach a runner ────────────────────────────────────
// It lives in `platform_secrets`, which is never shipped to the runner. It must
// NOT be written into `project_secrets`: that vault IS materialised into the
// agent's `.env.local` at every dispatch, so a token placed there would be
// handed to every agent that runs. Nothing here writes it anywhere; this note
// exists so a later "convenience" change does not.

import { ensurePlatformSecretsLoaded, resolveSync } from "@/lib/platform-secrets/resolver";
import { runVercelPreflight, type PreflightConfig } from "@/lib/vercel/api";
import { loadVercelConnectionToken } from "@/lib/vercel/connection.server";
import type { PreflightReport } from "@/lib/vercel/preflight";

export const VERCEL_TOKEN_KEY = "VERCEL_TOKEN";
export const VERCEL_TEAM_ID_KEY = "VERCEL_TEAM_ID";
export const VERCEL_GIT_NAMESPACE_KEY = "VERCEL_GIT_NAMESPACE";

/**
 * Resolve the Vercel configuration for a tenant.
 *
 * ── PRECEDENCE: an OAuth connection beats a pasted token ──────────────────
 * "Connect Vercel" (PR 3) adds a rung ABOVE the `VERCEL_TOKEN` platform secret.
 * When a `vercel_oauth_connections` row exists for the tenant, its token and
 * its `team_id` are used and the pasted key is not consulted. The reasoning:
 *
 *   * A connection is the more RECENT and more SPECIFIC act. It is performed
 *     deliberately, in a browser, against a named account, and it records what
 *     it resolved to. A pasted token is often a leftover from before.
 *   * Disconnect must be a real off switch. If the paste won, an operator who
 *     connected would still be deploying with the old pasted credential and the
 *     card would be reporting an account nothing was using.
 *   * The fallback direction is the safe one. Losing a connection falls back to
 *     a credential the operator already chose; the reverse would let a stale
 *     paste silently override a fresh, deliberate connection.
 *
 * The pasted field is NOT deleted and NOT deprecated — it is the documented
 * fallback for an instance with no integration set up, and the recovery path
 * when a configuration is disabled. Because a paste can be SHADOWED by a
 * connection, the settings card reports which one is in effect rather than
 * letting the operator edit a value that does nothing (the `shadowed` posture
 * `describeEffectiveModel` established for per-agent models).
 *
 * `teamId` follows the winning credential ALL THE WAY DOWN. Mixing an OAuth
 * token with a pasted `VERCEL_TEAM_ID` would reintroduce exactly the silent
 * wrong-scope failure `client.ts` was shaped to prevent, so a connection's team
 * id is used verbatim — including when it is null, which is the correct value
 * for the personal/Hobby account this feature is built around.
 *
 * `VERCEL_GIT_NAMESPACE` is orthogonal and still read from platform-secrets in
 * both cases: it names a GitHub owner, not a Vercel credential, and no part of
 * the OAuth response carries one.
 *
 * Returns the token, so every caller is a place the credential exists — keep
 * the number of callers small and never pass the result somewhere it could be
 * serialised to a client component or a log.
 */
export async function resolveVercelConfig(tenantId: string | null): Promise<PreflightConfig> {
  await ensurePlatformSecretsLoaded(tenantId);
  const get = (key: string) => resolveSync(key, { tenantId })?.trim() || null;
  const gitNamespace = get(VERCEL_GIT_NAMESPACE_KEY);

  const pastedToken = get(VERCEL_TOKEN_KEY);

  if (tenantId) {
    const connection = await loadVercelConnectionToken(tenantId);
    if (connection) {
      return {
        token: connection.token,
        teamId: connection.teamId,
        gitNamespace,
        source: "oauth",
        pastedTokenConfigured: pastedToken !== null,
      };
    }
  }

  return {
    token: pastedToken,
    teamId: get(VERCEL_TEAM_ID_KEY),
    gitNamespace,
    source: pastedToken ? "pasted" : "none",
    pastedTokenConfigured: pastedToken !== null,
  };
}

/** Is a Vercel token configured at all? Cheap enough for a render path, and it
 *  never returns the value. */
export async function vercelTokenConfigured(tenantId: string | null): Promise<boolean> {
  const cfg = await resolveVercelConfig(tenantId);
  return (cfg.token ?? "").length > 0;
}

/** Run the preflight against the real API using the tenant's configuration. */
export async function runVercelPreflightForTenant(
  tenantId: string | null,
): Promise<PreflightReport> {
  const config = await resolveVercelConfig(tenantId);
  return runVercelPreflight({ config, fetchImpl: (url, init) => fetch(url, init) });
}
