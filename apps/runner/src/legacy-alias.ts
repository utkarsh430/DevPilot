// Legacy env-var alias shim (runner) — TRANSITIONAL, delete in the final rename
// batch. Twin of `apps/web/lib/env/legacy-alias.ts`; see that file for the full
// rationale. Duplicated rather than shared because the runner is a separate
// package with no dependency on the web app (same reason `workspace-root.ts` is
// duplicated), and because this whole file goes away in one commit.
//
// For every `ACE_<X>` in the environment, mirror it onto `DEVPILOT_<X>` unless
// the new name is already set. New name wins; old name is a fallback.
//
// MUST be the FIRST import in every runner entry point, ahead of anything that
// reads env at module scope (`env.ts` calls `required("DEVPILOT_RUNNER_...")` in
// its module body, and it would `process.exit(1)` on a miss). There are TWO
// entry points, not one:
//   • `src/index.ts`      — the worker process
//   • `src/mcp/server.ts` — the MCP relay, spawned FRESH by `claude -p` on every
//                           step with its own environment. It reads
//                           DEVPILOT_RUN_ID / _TENANT_ID / _TICKET_ID / _ROLE /
//                           _WORKSPACE_PATH / _BASE_SHA. Miss this one and the
//                           relay silently loses its run context.

type EnvLike = Record<string, string | undefined>;

const LEGACY_ENV_PREFIX = "ACE_";
const ENV_PREFIX = "DEVPILOT_";

export function applyLegacyEnvAliases(envObj: EnvLike = process.env): string[] {
  const applied: string[] = [];
  for (const legacy of Object.keys(envObj)) {
    if (!legacy.startsWith(LEGACY_ENV_PREFIX)) continue;
    const value = envObj[legacy];
    if (value === undefined || value === "") continue;
    const next = ENV_PREFIX + legacy.slice(LEGACY_ENV_PREFIX.length);
    if (envObj[next] !== undefined && envObj[next] !== "") continue;
    envObj[next] = value;
    applied.push(next);
  }
  return applied;
}

applyLegacyEnvAliases();
