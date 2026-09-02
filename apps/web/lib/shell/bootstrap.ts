// Single-round-trip loader for the authenticated (app) shell layout.
//
// `app/(app)/layout.tsx` renders on every hard navigation and needs the whole
// topbar payload (project switcher, notifications bell, health dot, automation
// switch), the runner-disconnected banner, and the readiness-checklist seed.
// Fetching those as separate loaders is ~9 Supabase round trips; on cloud
// latency that dominates the shell's TTFB. This loader calls the
// `shell_bootstrap` SQL function (see 20260707010000_shell_bootstrap_fn.sql),
// which returns everything in ONE round trip, then maps the bundle back into
// the exact shapes the individual loaders produce — reusing their mappers /
// health derivations so the rendered shell is byte-for-byte equivalent.
//
// The individual `load*` loaders still exist and are used by pages/actions;
// only the layout switches to this bundle.

import "server-only";
import { cache } from "react";

import { supabaseServer } from "@/lib/db/server";
import {
  mapProjectRow,
  loadProjectsForTenant,
  type ProjectRecord,
  type ProjectRow,
} from "@/lib/projects/load";
import {
  mapNotificationRow,
  loadInitialNotifications,
  type NotificationRow,
} from "@/lib/notifications/load";
import type { NotificationItem } from "@/lib/realtime/use-notifications";
import {
  mapAutomationOverview,
  mapRunnerDisconnected,
  loadTenantAutomationState,
  loadRunnerDisconnectedTickets,
  type AutomationOverview,
  type TenantAutomationRow,
  type DisconnectedTicketRow,
  type RunnerDisconnectedTickets,
} from "@/lib/automation/queries";
import {
  deriveRunnerHealth,
  deriveDevServerHealth,
  type RunnerRow,
  type DevRow,
} from "@/lib/health/probes";
import { loadSystemHealthSnapshot } from "@/lib/health/load";
import { localRunnerExpectedForMode } from "@/lib/health/runner-mode";
import type { SystemHealthSnapshot } from "@/lib/health/types";
import { normalizeLlmAuthMode, LLM_AUTH_MODE_CONFIG_KEY } from "@/lib/llm/auth-mode";
import { githubTokenPresent, hasFinishedRun } from "@/lib/onboarding/readiness.server";

/** Everything the (app) layout fetches server-side in one shot. Field shapes
 *  match the individual loaders exactly so the layout's component props are
 *  unchanged. `systemHealth` is `undefined` for a null tenant (mirrors the
 *  layout's `tenantId ? … : undefined`). */
export type ShellBootstrap = {
  projects: ProjectRecord[];
  initialNotifications: NotificationItem[];
  automation: AutomationOverview | null;
  disconnected: RunnerDisconnectedTickets;
  systemHealth: SystemHealthSnapshot | undefined;
  githubConnected: boolean;
  firstRunDone: boolean;
};

/** Raw jsonb bundle returned by the `shell_bootstrap(p_tenant)` RPC. */
type BootstrapPayload = {
  projects: ProjectRow[] | null;
  notifications: NotificationRow[] | null;
  tenant: (TenantAutomationRow & { config?: Record<string, unknown> | null }) | null;
  disconnected: { count: number | string; rows: DisconnectedTicketRow[] | null } | null;
  runners: RunnerRow[] | null;
  dev_servers: DevRow[] | null;
  github_connected: boolean | null;
  first_run_done: boolean | null;
};

function systemHealthFrom(payload: BootstrapPayload, latencyMs: number): SystemHealthSnapshot {
  const runner = deriveRunnerHealth(payload.runners ?? [], latencyMs);
  const devServers = deriveDevServerHealth(payload.dev_servers ?? [], latencyMs);
  // expectsLocalRunner mirrors `tenantExpectsLocalRunner` → `getLlmAuthMode`:
  // read the tenant's config, normalise the auth-mode (absent → claude_code),
  // then map to whether a local runner is expected.
  const mode = normalizeLlmAuthMode((payload.tenant?.config ?? {})[LLM_AUTH_MODE_CONFIG_KEY]);
  return {
    checkedAt: new Date().toISOString(),
    llmPinged: false,
    expectsLocalRunner: localRunnerExpectedForMode(mode),
    services: [runner, devServers],
  };
}

/**
 * Load the whole (app) shell payload in a single database round trip.
 *
 * React.cache: request-scoped dedupe, consistent with the Wave-1 caching on
 * the individual loaders — the layout asks once and any nested consumer on the
 * same request reuses it. Outside an RSC render cache() is a passthrough.
 */
export const loadShellBootstrap = cache(
  async (userId: string, tenantId: string | null): Promise<ShellBootstrap> => {
    const supabase = await supabaseServer();
    const started = Date.now();
    const { data, error } = await supabase.rpc("shell_bootstrap", { p_tenant: tenantId });
    const latencyMs = Date.now() - started;

    if (error || !data) {
      // Deploy-order safety net: if the function isn't in the database yet
      // (code deployed before `supabase db push`), fall back to the per-loader
      // fetches so the shell keeps working. Delete once the migration is
      // applied everywhere.
      const functionMissing = error?.code === "42883" || error?.code === "PGRST202";
      console.warn(
        functionMissing
          ? "[loadShellBootstrap] shell_bootstrap function missing " +
              `(code ${error?.code}); falling back to per-loader fetches. ` +
              "Apply migration 20260707010000_shell_bootstrap_fn.sql."
          : "[loadShellBootstrap] shell_bootstrap rpc failed " +
              `(code ${error?.code ?? "unknown"}): ${error?.message ?? "no data"}; ` +
              "falling back to per-loader fetches.",
      );
      return loadShellBootstrapByParts(userId, tenantId);
    }

    const payload = data as BootstrapPayload;
    const disconnectedRows = payload.disconnected?.rows ?? [];
    return {
      projects: (payload.projects ?? []).map(mapProjectRow),
      initialNotifications: (payload.notifications ?? []).map(mapNotificationRow),
      automation: payload.tenant ? mapAutomationOverview(payload.tenant) : null,
      disconnected: mapRunnerDisconnected(
        Number(payload.disconnected?.count ?? disconnectedRows.length),
        disconnectedRows,
      ),
      systemHealth: tenantId ? systemHealthFrom(payload, latencyMs) : undefined,
      githubConnected: Boolean(payload.github_connected),
      firstRunDone: Boolean(payload.first_run_done),
    };
  },
);

/** Fallback path: the original per-loader parallel fetch. Produces an identical
 *  ShellBootstrap. Only reached when the RPC is unavailable (deploy-order) or
 *  errors. */
async function loadShellBootstrapByParts(
  userId: string,
  tenantId: string | null,
): Promise<ShellBootstrap> {
  const [
    projects,
    initialNotifications,
    automation,
    disconnected,
    systemHealth,
    githubConnected,
    firstRunDone,
  ] = await Promise.all([
    tenantId ? loadProjectsForTenant(tenantId) : [],
    loadInitialNotifications(),
    loadTenantAutomationState(tenantId),
    loadRunnerDisconnectedTickets(tenantId),
    tenantId ? loadSystemHealthSnapshot(tenantId) : undefined,
    githubTokenPresent(userId),
    tenantId ? hasFinishedRun(tenantId) : false,
  ]);
  return {
    projects,
    initialNotifications,
    automation,
    disconnected,
    systemHealth,
    githubConnected,
    firstRunDone,
  };
}
