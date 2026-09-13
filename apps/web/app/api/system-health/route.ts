// GET /api/system-health — one-shot snapshot of every service the engine
// depends on. Auth-guarded + tenant-scoped; all probes run SERVER-SIDE so no
// secrets ever reach the browser (only coarse status + latency are returned).
//
// `?deep=1` enables the paid Anthropic LLM ping (still Redis-cached ≤60s); the
// always-on topbar dot calls with deep=0 and gets the LLM as a free config
// check. The settings page / manual refresh call deep=1.

import { NextResponse } from "next/server";
import { getUser, getCurrentTenantId } from "@/lib/auth";
import {
  readRunnerHealth,
  readDevServerHealth,
  probeSupabase,
  probeRedis,
  probeInngest,
  probeLangfuse,
  probeLlm,
  probeDispatch,
  probeSupervision,
} from "@/lib/health/probes";
import { localRunnerExpectedForMode } from "@/lib/health/runner-mode";
import { getLlmAuthMode } from "@/lib/llm/auth-mode.server";
import { redis as redisClient } from "@/lib/cache/redis";
import { OPTIONAL_SERVICE_IDS } from "@/lib/health/types";
import type { ServiceHealth, SystemHealthSnapshot } from "@/lib/health/types";

export const dynamic = "force-dynamic";

// Shallow (deep=0) snapshots are shared across pollers/tabs through Redis for
// a short TTL: every open tab's topbar dot polls this route, and the probe
// batch costs ~0.5-1s of backend round trips — one tenant needs at most one
// batch per TTL window. Deep checks (settings page / manual refresh) always
// bypass so "Check again" stays a real re-probe. States/remedies are computed
// exactly as before; the dot just tolerates a snapshot up to ~20s old.
const SNAPSHOT_CACHE_TTL_SECONDS = 20;
const snapshotCacheKey = (tenantId: string) => `devpilot:health:snapshot:${tenantId}`;

async function readSnapshotCache(tenantId: string): Promise<SystemHealthSnapshot | null> {
  try {
    return (await redisClient().get<SystemHealthSnapshot>(snapshotCacheKey(tenantId))) ?? null;
  } catch {
    return null; // Redis missing/down → every poll probes, exactly as before.
  }
}

async function writeSnapshotCache(tenantId: string, s: SystemHealthSnapshot): Promise<void> {
  try {
    await redisClient().set(snapshotCacheKey(tenantId), s, { ex: SNAPSHOT_CACHE_TTL_SECONDS });
  } catch {
    // Best-effort; a miss just means the next poll probes again.
  }
}

export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tenantId = await getCurrentTenantId();
  if (!tenantId) return NextResponse.json({ error: "no tenant" }, { status: 401 });

  const deep = new URL(request.url).searchParams.get("deep") === "1";

  if (!deep) {
    const cached = await readSnapshotCache(tenantId);
    if (cached) {
      return NextResponse.json(cached, { headers: { "cache-control": "no-store" } });
    }
  }

  // The LLM probe and expectsLocalRunner both derive from the tenant's LLM
  // auth-mode — resolve it ONCE and share (it's a `tenants.config` read).
  const authMode = getLlmAuthMode(tenantId);

  // Every probe is internally try/caught and resolves to a health value, so a
  // single failing backend can't reject the whole batch.
  const [runner, devServers, supabase, redis, inngest, langfuse, llm, dispatch, supervision, mode] =
    await Promise.all([
      readRunnerHealth(tenantId),
      readDevServerHealth(tenantId),
      probeSupabase(),
      probeRedis(),
      probeInngest(),
      probeLangfuse({ tenantId }),
      probeLlm({ deep, tenantId, authMode }),
      // Not a backend: the board's own pipeline. Every service below can be
      // green while the board is completely stopped — that is exactly what
      // happened on 2026-08-03 and what nothing here could see.
      probeDispatch(tenantId),
      // Also not a backend: whether the engine's own cron recovery is still
      // executing, and whether the supervisor has been repeatedly fixing the
      // same thing. `probeInngest` above cannot answer the first - it calls our
      // own serve handler in-process and never contacts Inngest.
      probeSupervision(tenantId),
      authMode,
    ]);
  const expectsLocalRunner = localRunnerExpectedForMode(mode);

  const { pinged, ...llmHealth } = llm;
  const services: ServiceHealth[] = [
    runner,
    devServers,
    supabase,
    redis,
    inngest,
    langfuse,
    llmHealth,
    dispatch,
    supervision,
  ].map((s) => (OPTIONAL_SERVICE_IDS.has(s.id) ? { ...s, optional: true } : s));

  const snapshot: SystemHealthSnapshot = {
    checkedAt: new Date().toISOString(),
    llmPinged: pinged,
    expectsLocalRunner,
    services,
  };

  if (!deep) {
    await writeSnapshotCache(tenantId, snapshot);
  }

  return NextResponse.json(snapshot, { headers: { "cache-control": "no-store" } });
}
