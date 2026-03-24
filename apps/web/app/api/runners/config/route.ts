// GET /api/runners/config
//
// Phase 5 of the platform-secrets system — the runner pulls its per-tenant
// config from the engine instead of relying solely on its own .env.local. This
// lets an operator rotate (e.g.) the Engineer repo or QA command for one tenant
// in the UI and have the runner pick it up on its next refresh, without a redeploy.
//
// The runner's OWN env stays the floor: anything we don't return here (or any
// fetch failure) leaves the runner reading its env exactly as today. Bootstrap
// vars that the runner needs to even reach the queue/engine (registration key,
// Upstash creds, DEVPILOT_RUNNER_TENANT_ID, LOCAL_CC_ENGINE_URL) are NEVER returned —
// the runner must have those locally before it can call this endpoint at all.
//
// Auth: x-devpilot-runner-key (registration secret, same as every other runner route)
// plus x-devpilot-runner-tenant identifying which tenant's overrides to resolve. We
// validate the tenant actually exists before returning anything.

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { RUNNER_TENANT_HEADER, readRunnerHeader } from "@/lib/runners/headers";
import { ensurePlatformSecretsLoaded, resolveSync } from "@/lib/platform-secrets/resolver";

export const dynamic = "force-dynamic";

// Allow-list of keys the runner is permitted to receive. Deliberately narrow:
// only the runner-relevant subset of catalog secrets. Bootstrap/instance vars
// (DEVPILOT_RUNNER_REGISTRATION_KEY, UPSTASH_REDIS_*, DEVPILOT_RUNNER_TENANT_ID,
// LOCAL_CC_ENGINE_URL) are intentionally absent — see the file header.
const RUNNER_CONFIG_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ENGINEER_REPO_URL",
  "ENGINEER_QA_COMMAND",
] as const;

// How long the runner may trust a fetched value before re-fetching. Mirrors the
// resolver's own TTL so a rotation propagates within roughly one window.
const TTL_SECONDS = Math.max(
  5,
  Number(process.env.DEVPILOT_PLATFORM_SECRETS_TTL_SECONDS ?? "60") || 60,
);

/** Confirm the tenant id maps to a real tenant (or a registered runner for it)
 *  before resolving anything for it. Returns true when the id is recognised. */
async function tenantExists(tenantId: string): Promise<boolean> {
  const supabase = supabaseService();
  const { count, error } = await supabase
    .from("tenants")
    .select("id", { head: true, count: "exact" })
    .eq("id", tenantId);
  if (error) {
    console.warn(`[runners/config] tenant lookup failed: ${error.message}`);
    return false;
  }
  if ((count ?? 0) > 0) return true;
  // Fall back to the runners table — a runner that registered for this tenant
  // is also sufficient proof the id is real (covers any tenant-table RLS/shape
  // drift without widening what we expose).
  const { count: runnerCount, error: runnerErr } = await supabase
    .from("runners")
    .select("id", { head: true, count: "exact" })
    .eq("tenant_id", tenantId);
  if (runnerErr) {
    console.warn(`[runners/config] runner lookup failed: ${runnerErr.message}`);
    return false;
  }
  return (runnerCount ?? 0) > 0;
}

export async function GET(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: 401, headers: noStore });
  }

  // Dual-accept during the rename — see lib/runners/headers.ts.
  const tenantId = readRunnerHeader(request, RUNNER_TENANT_HEADER)?.trim();
  if (!tenantId) {
    return NextResponse.json(
      { error: `missing ${RUNNER_TENANT_HEADER} header` },
      { status: 400, headers: noStore },
    );
  }
  if (!(await tenantExists(tenantId))) {
    return NextResponse.json({ error: "unknown tenant" }, { status: 404, headers: noStore });
  }

  // Warm the resolver for this tenant at this async boundary, then read
  // synchronously. With the feature flag off (or a cold cache) resolveSync
  // returns process.env — the engine's env — which is a safe no-op for keys
  // the engine doesn't carry; the runner's own env stays the real floor.
  await ensurePlatformSecretsLoaded(tenantId);
  const secrets: Record<string, string> = {};
  for (const key of RUNNER_CONFIG_KEYS) {
    const value = resolveSync(key, { tenantId });
    // Include a key ONLY when it resolves to a non-empty value, so an unset key
    // never clobbers the runner's own env floor (the runner treats a missing
    // key as "keep my env value").
    if (value && value.length > 0) secrets[key] = value;
  }

  return NextResponse.json({ secrets, ttlSeconds: TTL_SECONDS }, { headers: noStore });
}

const noStore = { "cache-control": "no-store" } as const;
