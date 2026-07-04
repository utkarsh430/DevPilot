// System-health types shared by the probe layer, the API route, the topbar
// dot, and the settings page. Status is intentionally COARSE — operators want
// a glanceable "is it up?", not a metrics dashboard.
//
// This file is imported by client components, so it must stay free of any
// server-only access (no process.env, no service clients) — keep it pure.

export type ServiceState = "ok" | "degraded" | "down" | "unknown";

export type ServiceId =
  | "runner"
  | "devServers"
  | "supabase"
  | "redis"
  | "inngest"
  | "llm"
  | "langfuse"
  // Not a backend — the board's own dispatch pipeline. It is here because the
  // 2026-08-03 deadlock was a state NO backend probe could see: every service
  // was up, and the board was still completely stopped. See `probeDispatch`.
  | "dispatch"
  // Also not a backend - the runner-resident project supervisor. Two facts an
  // operator cannot get anywhere else: whether the engine's own cron recovery is
  // still executing at all (every reaper in the system hangs off it, and on
  // 2026-08-03 they all stopped together while every backend stayed green), and
  // whether the supervisor has been repeatedly fixing the same thing - which is
  // a bug report, not routine maintenance. See `probeSupervision`.
  | "supervision";

export type ServiceHealth = {
  id: ServiceId;
  /** Human label for the UI ("Local runner", "Supabase", …). */
  label: string;
  state: ServiceState;
  /** Round-trip latency of the probe in ms, when one was performed. */
  latencyMs: number | null;
  /** One-line detail: "14ms", "no heartbeat for 3m", "configured (not pinged)". */
  detail: string | null;
  /** Optional services are shown but EXCLUDED from the overall rollup, so a
   *  missing/invalid optional dependency never reds-out the whole system. The
   *  Anthropic API-key path is optional because the default local runner uses
   *  the Claude subscription (not the API key); tracing (Langfuse) is non-blocking. */
  optional?: boolean;
  /** Where to FIX a non-ok service — usually an anchored step in the setup
   *  wizard. Rendered as a "Fix →" link by the status popover and health cards. */
  remedy?: { label: string; href: string };
};

// Services that are non-blocking for the default (subscription-runner) setup:
// the Anthropic API-key path and tracing. Still probed + shown, but they do NOT
// escalate the overall / topbar-dot status.
export const OPTIONAL_SERVICE_IDS: ReadonlySet<ServiceId> = new Set<ServiceId>(["llm", "langfuse"]);

export type SystemHealthSnapshot = {
  /** ISO timestamp the snapshot was produced server-side. */
  checkedAt: string;
  /** True when the paid LLM ping was actually performed this snapshot. */
  llmPinged: boolean;
  /** True when this tenant runs on the local runner (a Claude subscription
   *  token is configured) and therefore needs one heartbeating. False for an
   *  API-runner tenant, whose tickets run without any local runner — so the
   *  "runner not connected" UI must not nag them. Computed server-side via
   *  `tenantExpectsLocalRunner` so it survives the client polling boundary. */
  expectsLocalRunner: boolean;
  services: ServiceHealth[];
};

// "Worst" ordering so the topbar dot can reduce many services to one color.
const SEVERITY: Record<ServiceState, number> = {
  ok: 0,
  unknown: 1,
  degraded: 2,
  down: 3,
};

/** Reduce a service list to a single overall state (the worst one). An empty
 *  list means we know nothing yet → "unknown" (grey), never a false "ok". */
export function overallState(services: ServiceHealth[]): ServiceState {
  if (services.length === 0) return "unknown";
  // Optional services (LLM / tracing) are excluded from the rollup so a missing
  // or invalid optional dependency never reds-out the dot. Fall back to the full
  // list only in the degenerate case where everything is optional.
  const critical = services.filter((s) => !s.optional);
  const pool = critical.length > 0 ? critical : services;
  let worst: ServiceState = "ok";
  for (const s of pool) {
    if (SEVERITY[s.state] > SEVERITY[worst]) worst = s.state;
  }
  return worst;
}
