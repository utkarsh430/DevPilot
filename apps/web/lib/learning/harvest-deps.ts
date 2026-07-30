// The PRODUCTION harvest deps — the service client + the role→onSuccessStatus
// resolver — built WITHOUT a `server-only` marker so the backfill CLI can run
// under a plain `pnpm tsx` (no `--conditions=react-server`).
//
// ── Why this file exists (the PR 1 follow-up fix) ──
// PR 1 put `defaultHarvestDeps` in `harvest.server.ts`, which carries
// `import "server-only"`. The backfill script imported it, so the script would
// only run under `NODE_OPTIONS='--conditions=react-server'` — its documented
// `pnpm tsx --env-file=.env.local scripts/...` invocation THREW the server-only
// error at import time. Unit tests never caught it (they import the pure
// `harvest-batch.ts` with a fake client), so the throw shipped. This is the exact
// "script imports server-only, tests pass, script throws" class.
//
// The fix: the deps builder needs nothing server-only. `supabaseService()`
// (lib/db/server, no server-only) and the built-in role catalog (lib/roles/index
// `ROLES`, no server-only) both import cleanly under plain tsx. The ONLY thing
// that pulled server-only in was resolving the role via `getBuiltinRoleConfig`
// from `lib/roles/load.ts`, which transitively imports `lib/skills/select` →
// `lib/llm/generate.server` (server-only). We sidestep that whole chain by
// reading `ROLES` directly — `getBuiltinRoleConfig(slug)` is just `ROLES[slug]`
// for a built-in slug — and falling back to the agent's stored role_config for
// custom JD-synthesized roles (no DB, no catalog).
//
// `harvest.server.ts` keeps the `server-only` marker and simply re-exports
// `defaultHarvestDeps` from here, so the go-forward Inngest hook (which runs
// inside the Next server anyway) is unchanged.

import { supabaseService } from "@/lib/db/server";
import { ROLES, type Role, type RoleConfig } from "@/lib/roles/index";
import { type HarvestDeps } from "@/lib/learning/harvest-batch";

const BUILTIN_ROLES = ROLES as Record<string, RoleConfig | undefined>;

/**
 * Resolve a producer's onSuccessStatus (`in_review` = producer, `done` =
 * reviewer). Built-in slug → read the static `ROLES` catalog directly (avoids
 * the server-only `roles/load` chain); custom JD-synthesized role → read the
 * agent's stored `role_config.onSuccessStatus`. Same result as PR 1's
 * `getBuiltinRoleConfig`-based resolver, without the server-only import.
 */
export function resolveOnSuccessStatus(role: string | null, agentConfig: unknown): string | null {
  if (!role) return null;
  const builtin = BUILTIN_ROLES[role as Role];
  if (builtin?.onSuccessStatus) return builtin.onSuccessStatus;
  const rc = (agentConfig as { role_config?: { onSuccessStatus?: unknown } } | null)?.role_config;
  return typeof rc?.onSuccessStatus === "string" ? rc.onSuccessStatus : null;
}

/** Production deps: the service client + the role resolver above. */
export function buildHarvestDeps(): HarvestDeps {
  return {
    db: supabaseService(),
    resolveOnSuccessStatus,
  };
}
