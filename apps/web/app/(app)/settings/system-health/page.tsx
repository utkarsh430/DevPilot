// Settings ▸ System health — the deep-dive companion to the topbar dot.
// Per-service cards with status, latency, and last-heartbeat detail, polling
// the deep probe (incl. the cached live LLM ping) every ~10s + manual refresh.

import { getCurrentTenantId } from "@/lib/auth";
import { loadSystemHealthSnapshot } from "@/lib/health/load";
import type { SystemHealthSnapshot } from "@/lib/health/types";
import { SystemHealthClient } from "./system-health-client";

export const dynamic = "force-dynamic";

export default async function SystemHealthPage() {
  const tenantId = await getCurrentTenantId();
  const initial: SystemHealthSnapshot = tenantId
    ? await loadSystemHealthSnapshot(tenantId)
    : {
        checkedAt: new Date().toISOString(),
        llmPinged: false,
        expectsLocalRunner: false,
        services: [],
      };

  return <SystemHealthClient initial={initial} />;
}
