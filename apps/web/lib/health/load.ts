// Server-rendered seed for the topbar dot's first paint. We read ONLY the
// runner + dev-server liveness (cheap DB reads) here — no external pings, since
// blocking SSR on network round-trips to Supabase/Redis/Inngest/LLM would slow
// every authenticated page load. The client hook fills in the backend probes
// on its first poll a moment later.

import { readRunnerHealth, readDevServerHealth } from "./probes";
import { tenantExpectsLocalRunner } from "./runner-mode";
import type { SystemHealthSnapshot } from "./types";

export async function loadSystemHealthSnapshot(tenantId: string): Promise<SystemHealthSnapshot> {
  const [runner, devServers, expectsLocalRunner] = await Promise.all([
    readRunnerHealth(tenantId),
    readDevServerHealth(tenantId),
    tenantExpectsLocalRunner(tenantId),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    llmPinged: false,
    expectsLocalRunner,
    services: [runner, devServers],
  };
}
