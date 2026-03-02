// Legacy env-var alias shim — TRANSITIONAL, delete in the final rename batch.
//
// DevPilot was formerly ACE, and every platform env var was named `ACE_*`. The
// code now reads `DEVPILOT_*`. Operators' `.env.local` files (and any running
// host) still carry the old names, and a rename that silently drops a required
// var is the worst failure mode available: `ACE_RUNNER_REGISTRATION_KEY` going
// missing does not crash, it 401s every runner→engine call.
//
// So: for every `ACE_<X>` in the environment, mirror it onto `DEVPILOT_<X>`
// unless the new name is already set explicitly. The new name always wins; the
// old one is a fallback, never an override.
//
// This is a PREFIX RULE, not a hand-maintained table of the ~66 names, for two
// reasons: a table drifts the moment someone adds a var, and it cannot express
// the one dynamically-constructed family (`DEVPILOT_DATA_SOURCE_<uuid>_URL`,
// see lib/data/sql.ts). Every uppercase `ACE_`-prefixed variable is ours by
// definition, so mirroring the whole prefix is exactly right.
//
// MUST be imported BEFORE anything that reads env at module scope. Entry point:
// `instrumentation.ts` (Next's server-boot hook, which runs before any route
// module loads). Mirrored — deliberately, across the app boundary — in
// `apps/runner/src/legacy-alias.ts` (worker + MCP relay, separate processes)
// and `apps/web/scripts/_legacy-env.mjs` (operator acceptance scripts).

/** Anything process.env-shaped. Widened from NodeJS.ProcessEnv so tests can pass
 *  plain object literals. */
export type EnvLike = Record<string, string | undefined>;

export const LEGACY_ENV_PREFIX = "ACE_";
export const ENV_PREFIX = "DEVPILOT_";

/** Mirror `ACE_*` → `DEVPILOT_*` in place. Idempotent. Returns the names it set. */
export function applyLegacyEnvAliases(envObj: EnvLike = process.env): string[] {
  const applied: string[] = [];
  for (const legacy of Object.keys(envObj)) {
    if (!legacy.startsWith(LEGACY_ENV_PREFIX)) continue;
    const value = envObj[legacy];
    if (value === undefined || value === "") continue;
    const next = ENV_PREFIX + legacy.slice(LEGACY_ENV_PREFIX.length);
    // An explicitly-set new name always wins — the alias is a fallback only.
    if (envObj[next] !== undefined && envObj[next] !== "") continue;
    envObj[next] = value;
    applied.push(next);
  }
  return applied;
}

applyLegacyEnvAliases();
