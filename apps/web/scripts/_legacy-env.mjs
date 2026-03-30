// Legacy env-var alias shim for the operator acceptance scripts —
// TRANSITIONAL, delete in the final rename batch.
//
// These scripts run under plain `node --env-file=apps/web/.env.local`, so they
// get neither Next's `instrumentation.ts` nor the runner's entry-point import.
// Without this, renaming their reads to `DEVPILOT_*` would break every
// acceptance script against an operator env file that still says `ACE_*`.
//
// Twin of `apps/web/lib/env/legacy-alias.ts` — see that file for the rationale.
// Import it FIRST, for side effects: `import "./_legacy-env.mjs";`

const LEGACY_ENV_PREFIX = "ACE_";
const ENV_PREFIX = "DEVPILOT_";

for (const legacy of Object.keys(process.env)) {
  if (!legacy.startsWith(LEGACY_ENV_PREFIX)) continue;
  const value = process.env[legacy];
  if (value === undefined || value === "") continue;
  const next = ENV_PREFIX + legacy.slice(LEGACY_ENV_PREFIX.length);
  if (process.env[next] !== undefined && process.env[next] !== "") continue;
  process.env[next] = value;
}
