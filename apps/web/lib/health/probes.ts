// Server-side reachability probes for every service the engine depends on.
// Each probe is TIME-BOXED so a hung backend can't stall the whole snapshot,
// and returns the coarse ServiceHealth shape the UI renders. Probes never
// throw — they resolve to a `down` health on error so Promise.all stays intact.
//
// Cost guard (CLAUDE.md "hard ceilings"): the ONLY paid probe is the LLM ping.
// It uses the cheapest model with a 1-token cap AND is cached in Redis for 60s
// so N concurrent pollers/tabs share at most one paid call per minute. It only
// runs when the caller passes `deep: true` (the settings page / manual refresh);
// the always-on topbar dot uses `deep: false` and reports the LLM as configured
// (or the last cached ping) without spending tokens.

import { generateText } from "ai";
import { redis } from "@/lib/cache/redis";
import { supabaseService } from "@/lib/db/server";
import { modelForTenant } from "@/lib/llm/models-tenant";
import { ensurePlatformSecretsLoaded, resolveSync } from "@/lib/platform-secrets/resolver";
import { getLlmAuthMode } from "@/lib/llm/auth-mode.server";
import { apiKeyCheckAppliesForMode, type LlmAuthMode } from "@/lib/llm/auth-mode";
import { publicEnv } from "@/lib/env";
import {
  loadDispatchQueueGroups,
  dispatchRescueGraceSeconds,
} from "@/lib/engine/dispatch-rescue-store";
import { describeDispatchStall, detectDispatchStall } from "@/lib/engine/dispatch-rescue-policy";
import {
  indictmentThreshold,
  indictmentWindowSeconds,
  engineStaleSeconds,
  loadRecentSupervisorActions,
  readEngineLiveness,
} from "@/lib/engine/supervisor-store";
import { detectRepeatDefect, renderIndictment } from "@/lib/engine/supervisor-policy";
import type { ServiceHealth, ServiceId, ServiceState } from "./types";
import { interpretInngestServeProbe } from "./inngest-probe";

// Runner is "stale" past the watchdog threshold. Mirror the watchdog's env so
// the UI and the reaper agree on what "down" means. Server-only read.
export const RUNNER_STALE_SECONDS = Number(
  process.env.DEVPILOT_RUNNER_WATCHDOG_THRESHOLD_SECONDS ?? "60",
);

const PROBE_TIMEOUT_MS = 2500;
// LLM calls are slower than infra round-trips; give them more headroom.
const LLM_TIMEOUT_MS = 8000;
const LLM_CACHE_KEY = "devpilot:health:llm";
const LLM_CACHE_TTL_SECONDS = 60;

class TimeoutError extends Error {}

function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TimeoutError(`${label} timed out after ${ms}ms`)),
      ms,
    );
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Resolver-aware "is it configured?" — sees BOTH env vars and store-managed
// values (instance scope for shared infra). A store-only Langfuse key pair
// must not report "not configured" just because .env.local has no entry.
function isConfigured(name: string, tenantId: string | null = null): boolean {
  const v = resolveSync(name, { tenantId });
  return typeof v === "string" && v.length > 0;
}

// Per-service remediation targets — anchored steps in the setup wizard. The
// popover / health cards render these as "Fix →" links on any non-ok service.
const REMEDY: Partial<Record<ServiceId, ServiceHealth["remedy"]>> = {
  runner: { label: "Fix", href: "/settings/setup#runner" },
  supabase: { label: "Fix", href: "/settings/setup#supabase" },
  redis: { label: "Fix", href: "/settings/setup#redis" },
  inngest: { label: "Fix", href: "/settings/setup#inngest" },
  llm: { label: "Fix", href: "/settings/setup#llm-auth" },
  supervision: { label: "Fix", href: "/settings/setup#inngest" },
  langfuse: { label: "Fix", href: "/settings/setup#langfuse" },
};

function errDetail(e: unknown): string {
  if (e instanceof TimeoutError) return "timed out";
  if (e instanceof Error) return e.message.slice(0, 120);
  return "unreachable";
}

function svc(
  id: ServiceId,
  label: string,
  state: ServiceState,
  latencyMs: number | null,
  detail: string | null,
): ServiceHealth {
  // The remedy is attached only when it's actionable - something is actually
  // wrong (down/degraded) or plainly missing ("not configured", a detail the
  // probes themselves set). Clients render `remedy` whenever present; a
  // healthy or merely-unpinged row never carries one.
  const actionable =
    state === "down" ||
    state === "degraded" ||
    (state === "unknown" && detail === "not configured");
  const remedy = actionable ? REMEDY[id] : undefined;
  return remedy
    ? { id, label, state, latencyMs, detail, remedy }
    : { id, label, state, latencyMs, detail };
}

function formatAge(seconds: number): string {
  if (!isFinite(seconds)) return "never";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// ── Runner liveness (DB read, service-role — no RLS dependency) ──────────────

export type RunnerRow = {
  id: string;
  name: string | null;
  status: string;
  last_heartbeat_at: string | null;
};

/** Derive the runner health from already-fetched rows. Pure (no I/O) so the
 *  same rules apply whether the rows came from this probe's own service-role
 *  read or from the shell-bootstrap RPC bundle — the topbar dot seed stays
 *  identical. `latencyMs` is the round-trip that produced the rows. */
export function deriveRunnerHealth(rows: RunnerRow[], latencyMs: number): ServiceHealth {
  if (rows.length === 0) {
    return svc("runner", "Local runner", "down", latencyMs, "no runner has registered");
  }
  const now = Date.now();
  const withAge = rows.map((r) => ({
    status: r.status,
    ageSeconds: r.last_heartbeat_at
      ? (now - new Date(r.last_heartbeat_at).getTime()) / 1000
      : Infinity,
  }));
  const freshest = Math.min(...withAge.map((x) => x.ageSeconds));
  const onlineCount = withAge.filter(
    (x) => x.ageSeconds <= RUNNER_STALE_SECONDS && x.status !== "offline",
  ).length;
  if (onlineCount > 0) {
    return svc(
      "runner",
      "Local runner",
      "ok",
      latencyMs,
      `${onlineCount} online · last beat ${formatAge(freshest)} ago`,
    );
  }
  return svc(
    "runner",
    "Local runner",
    "down",
    latencyMs,
    `offline · last beat ${formatAge(freshest)} ago`,
  );
}

export async function readRunnerHealth(tenantId: string): Promise<ServiceHealth> {
  const started = Date.now();
  try {
    const { data, error } = await withTimeout(
      supabaseService()
        .from("runners")
        .select("id, name, status, last_heartbeat_at")
        .eq("tenant_id", tenantId),
      PROBE_TIMEOUT_MS,
      "runners",
    );
    const latencyMs = Date.now() - started;
    if (error) return svc("runner", "Local runner", "down", latencyMs, error.message.slice(0, 120));
    return deriveRunnerHealth((data ?? []) as RunnerRow[], latencyMs);
  } catch (e) {
    return svc("runner", "Local runner", "down", Date.now() - started, errDetail(e));
  }
}

// ── Dev-server sessions (DB read) ────────────────────────────────────────────

export type DevRow = { project_id: string; status: string };

/** Derive the dev-server health from already-fetched rows. Pure (no I/O). The
 *  rows MUST arrive ordered updated_at desc (both the service-role read below
 *  and the shell-bootstrap RPC guarantee that) so the first row seen per project
 *  is that project's current session. */
export function deriveDevServerHealth(rows: DevRow[], latencyMs: number): ServiceHealth {
  const latestByProject = new Map<string, string>();
  for (const r of rows) {
    if (!latestByProject.has(r.project_id)) latestByProject.set(r.project_id, r.status);
  }
  const statuses = [...latestByProject.values()];
  // `stopped` (and any terminal status) is a project the operator turned off —
  // neither active nor broken, so it just doesn't contribute.
  const active = statuses.filter((s) => ["running", "starting", "building"].includes(s)).length;
  const errored = statuses.filter((s) => s === "errored").length;
  const needsEnv = statuses.filter((s) => s === "needs_env").length;
  const parts: string[] = [];
  if (active) parts.push(`${active} running`);
  if (errored) parts.push(`${errored} errored`);
  if (needsEnv) parts.push(`${needsEnv} need env`);
  const state: ServiceState = errored > 0 || needsEnv > 0 ? "degraded" : "ok";
  return svc("devServers", "Dev servers", state, latencyMs, parts.join(" · ") || "none running");
}

export async function readDevServerHealth(tenantId: string): Promise<ServiceHealth> {
  const started = Date.now();
  try {
    // Look at the CURRENT (most-recently-updated) session PER PROJECT, not every
    // session ever. When a dev server's runner is restarted, the old session
    // dies on "no-heartbeat" and leaves an `errored` corpse row behind. Once a
    // fresh session is running for that project the corpse is superseded and
    // must NOT drag the whole service to "degraded". We order by updated_at desc
    // (a live server heartbeats every ~3s, so its row is always freshest) and
    // keep the first row seen per project as that project's representative.
    const { data, error } = await withTimeout(
      supabaseService()
        .from("dev_server_sessions")
        .select("project_id, status, updated_at")
        .eq("tenant_id", tenantId)
        .order("updated_at", { ascending: false })
        .limit(200),
      PROBE_TIMEOUT_MS,
      "dev_servers",
    );
    const latencyMs = Date.now() - started;
    if (error)
      return svc("devServers", "Dev servers", "down", latencyMs, error.message.slice(0, 120));
    return deriveDevServerHealth((data ?? []) as DevRow[], latencyMs);
  } catch (e) {
    return svc("devServers", "Dev servers", "down", Date.now() - started, errDetail(e));
  }
}

// ── Supabase (HEAD count on a tiny table — round-trips only, no rows) ─────────

export async function probeSupabase(): Promise<ServiceHealth> {
  const started = Date.now();
  try {
    const { error } = await withTimeout(
      supabaseService().from("tenants").select("id", { head: true, count: "exact" }).limit(1),
      PROBE_TIMEOUT_MS,
      "supabase",
    );
    const latencyMs = Date.now() - started;
    if (error) return svc("supabase", "Supabase", "down", latencyMs, error.message.slice(0, 120));
    return svc("supabase", "Supabase", "ok", latencyMs, `${latencyMs}ms`);
  } catch (e) {
    return svc("supabase", "Supabase", "down", Date.now() - started, errDetail(e));
  }
}

// ── Upstash Redis (PING) ─────────────────────────────────────────────────────

export async function probeRedis(): Promise<ServiceHealth> {
  const started = Date.now();
  if (!isConfigured("UPSTASH_REDIS_REST_URL") || !isConfigured("UPSTASH_REDIS_REST_TOKEN")) {
    return svc("redis", "Upstash Redis", "unknown", null, "not configured");
  }
  try {
    const pong = await withTimeout(redis().ping(), PROBE_TIMEOUT_MS, "redis");
    const latencyMs = Date.now() - started;
    const ok = typeof pong === "string" && pong.toUpperCase().includes("PONG");
    return svc(
      "redis",
      "Upstash Redis",
      ok ? "ok" : "degraded",
      latencyMs,
      ok ? `${latencyMs}ms` : `unexpected reply: ${String(pong)}`,
    );
  } catch (e) {
    return svc("redis", "Upstash Redis", "down", Date.now() - started, errDetail(e));
  }
}

// ── Inngest (invoke our own serve handler — confirms functions are wired) ────

export async function probeInngest(): Promise<ServiceHealth> {
  const started = Date.now();
  if (!isConfigured("INNGEST_EVENT_KEY") && !isConfigured("INNGEST_SIGNING_KEY")) {
    return svc("inngest", "Inngest", "unknown", null, "not configured");
  }
  try {
    // A self-hosted server (the local durable mode: INNGEST_BASE_URL set) has
    // a health endpoint of its own, and asking it is both the better signal
    // ("is the thing that runs our functions alive") and quieter - an
    // UNSIGNED call to our own serve handler in cloud mode is refused with a
    // logged "Signature validation failed" on every probe.
    const selfHosted = (process.env.INNGEST_BASE_URL ?? "").trim().replace(/\/+$/, "");
    if (selfHosted) {
      const res = await withTimeout(
        fetch(`${selfHosted}/health`, { method: "GET" }),
        PROBE_TIMEOUT_MS,
        "inngest",
      );
      const latencyMs = Date.now() - started;
      return svc(
        "inngest",
        "Inngest",
        res.ok ? "ok" : "degraded",
        latencyMs,
        res.ok ? `server reachable (${latencyMs}ms)` : `server HTTP ${res.status}`,
      );
    }
    // Otherwise call the /api/inngest introspection handler IN-PROCESS instead
    // of HTTP-fetching our own server: same "serve endpoint responds and the
    // functions are wired" signal, without a loopback round trip competing
    // with real requests. Dynamic import on purpose — the route module pulls
    // in the whole durable engine, which must not ride the static module
    // graph of every page that transitively imports this file.
    const base = publicEnv.APP_URL || "http://localhost:3000";
    const [{ GET: inngestServeGet }, { NextRequest }] = await Promise.all([
      import("@/app/api/inngest/route"),
      import("next/server"),
    ]);
    const res = await withTimeout(
      inngestServeGet(new NextRequest(`${base}/api/inngest`), undefined),
      PROBE_TIMEOUT_MS,
      "inngest",
    );
    const latencyMs = Date.now() - started;
    const verdict = interpretInngestServeProbe({
      status: res.status,
      ok: res.ok,
      signingKeyConfigured: isConfigured("INNGEST_SIGNING_KEY"),
      latencyMs,
    });
    return svc("inngest", "Inngest", verdict.state, latencyMs, verdict.detail);
  } catch (e) {
    return svc("inngest", "Inngest", "down", Date.now() - started, errDetail(e));
  }
}

// ── Langfuse (public health endpoint) ────────────────────────────────────────

export async function probeLangfuse(opts?: { tenantId?: string | null }): Promise<ServiceHealth> {
  const started = Date.now();
  // Langfuse keys are store-managed (instance scope / tenant override), so the
  // configured check and base URL both resolve through the platform-secrets
  // resolver — env stays the fallback.
  const tenantId = opts?.tenantId ?? null;
  await ensurePlatformSecretsLoaded(tenantId);
  if (
    !isConfigured("LANGFUSE_PUBLIC_KEY", tenantId) &&
    !isConfigured("LANGFUSE_SECRET_KEY", tenantId)
  ) {
    return svc("langfuse", "Langfuse", "unknown", null, "not configured");
  }
  try {
    const base = resolveSync("LANGFUSE_BASE_URL", { tenantId }) ?? "https://us.cloud.langfuse.com";
    const res = await withTimeout(
      fetch(`${base}/api/public/health`, { method: "GET" }),
      PROBE_TIMEOUT_MS,
      "langfuse",
    );
    const latencyMs = Date.now() - started;
    return svc(
      "langfuse",
      "Langfuse",
      res.ok ? "ok" : "degraded",
      latencyMs,
      res.ok ? `${latencyMs}ms` : `HTTP ${res.status}`,
    );
  } catch (e) {
    return svc("langfuse", "Langfuse", "down", Date.now() - started, errDetail(e));
  }
}

// ── Anthropic LLM (PAID — heavily guarded) ───────────────────────────────────

async function readLlmCache(cacheKey: string): Promise<ServiceHealth | null> {
  try {
    return (await redis().get<ServiceHealth>(cacheKey)) ?? null;
  } catch {
    return null;
  }
}

async function writeLlmCache(cacheKey: string, h: ServiceHealth): Promise<void> {
  try {
    await redis().set(cacheKey, h, { ex: LLM_CACHE_TTL_SECONDS });
  } catch {
    // Cache is best-effort; a Redis miss just means the next deep check pings.
  }
}

/** Returns the LLM health plus `pinged` — whether THIS call spent tokens. The
 *  key is resolved per-tenant (DB override » env) and the result cache is keyed
 *  per-tenant, so one tenant's ping never masks another's. */
export async function probeLlm(opts: {
  deep: boolean;
  tenantId: string | null;
  /** Optionally share an already-started auth-mode lookup (value or promise)
   *  so the caller and this probe don't each read `tenants.config`. Omitted →
   *  resolved here, exactly as before. */
  authMode?: LlmAuthMode | Promise<LlmAuthMode>;
}): Promise<ServiceHealth & { pinged: boolean }> {
  // Auth-mode aware: under the default `claude_code` mode the Anthropic API key
  // is irrelevant (agents run on the Claude Code subscription via the local
  // runner), so a missing key must report not-applicable — never "down"/
  // "degraded" — and never spend tokens. Only in `api_key` mode does the
  // API-key check apply as before.
  const mode = await (opts.authMode ?? getLlmAuthMode(opts.tenantId));
  if (!apiKeyCheckAppliesForMode(mode)) {
    return {
      ...svc("llm", "Anthropic LLM", "unknown", null, "not used (Claude Code auth)"),
      pinged: false,
    };
  }

  await ensurePlatformSecretsLoaded(opts.tenantId);
  const apiKey = resolveSync("ANTHROPIC_API_KEY", { tenantId: opts.tenantId });
  if (!apiKey) {
    return {
      ...svc("llm", "Anthropic LLM", "down", null, "ANTHROPIC_API_KEY not set"),
      pinged: false,
    };
  }

  const cacheKey = `${LLM_CACHE_KEY}:${opts.tenantId ?? "instance"}`;

  // A fresh cached ping (≤60s) is reused in BOTH modes — bounds spend to at most
  // one real call per minute per tenant regardless of how many tabs are polling.
  const cached = await readLlmCache(cacheKey);
  if (cached) return { ...cached, pinged: false };

  // Shallow mode (always-on dot): never spend tokens. Report "configured".
  if (!opts.deep) {
    return {
      ...svc("llm", "Anthropic LLM", "unknown", null, "configured (not pinged)"),
      pinged: false,
    };
  }

  // Deep mode, cache miss: make the single cheapest possible call.
  const started = Date.now();
  try {
    await withTimeout(
      generateText({ model: modelForTenant(opts.tenantId, "cheap"), prompt: "ping", maxTokens: 1 }),
      LLM_TIMEOUT_MS,
      "llm",
    );
    const health = svc(
      "llm",
      "Anthropic LLM",
      "ok",
      Date.now() - started,
      `reachable (${Date.now() - started}ms)`,
    );
    await writeLlmCache(cacheKey, health);
    return { ...health, pinged: true };
  } catch (e) {
    // Cache the failure too — avoids hammering a provider that's down/throttled.
    const health = svc("llm", "Anthropic LLM", "down", Date.now() - started, errDetail(e));
    await writeLlmCache(cacheKey, health);
    return { ...health, pinged: true };
  }
}

// ── Dispatch pipeline (DB read) ──────────────────────────────────────────────
//
// The only probe here that is not a backend. Every backend was UP during the
// 2026-08-03 deadlock — Supabase, Redis, Inngest, the runner all green — and
// the board was still completely stopped for six hours with five tickets
// holding every WIP slot and zero runs executing. Nothing put those two numbers
// next to each other, so the operator saw a full board and reasonably assumed
// progress.
//
// "At the WIP limit" and "nothing is running" are simultaneously true and
// jointly impossible. This probe is that one derivation, surfaced in the topbar
// dot on every page. The rule for what fires and what stays silent lives in the
// pure `detectDispatchStall` (lib/engine/dispatch-rescue-policy.ts) and is
// shared with the reaper that repairs it, so the alarm and the repair can never
// disagree about what a stall is.
//
// State mapping:
//   • contradiction → `down`. Not `degraded`: no ticket can start, which is a
//     total outage of the board's one job even though every dependency is fine.
//   • parked        → `ok` with a detail. A queue held by runs awaiting a human
//     is the system working as designed and the operator is the blocker;
//     reporting it as a fault is how an alarm stops being read.
//   • anything else → `ok`.

export async function probeDispatch(tenantId: string): Promise<ServiceHealth> {
  const started = Date.now();
  try {
    // Tenant-scoped IN THE QUERY. This is a service-role read (RLS off), so
    // the co-located `.eq("tenant_id", …)` inside the loader is the entire
    // boundary — filtering after the fact would put another tenant's stall on
    // this operator's dot, and a wrong reason is worse than no reason.
    const groups = await withTimeout(
      loadDispatchQueueGroups({ db: supabaseService() }, tenantId),
      PROBE_TIMEOUT_MS,
      "dispatch",
    );
    const latencyMs = Date.now() - started;
    const stall = detectDispatchStall(
      groups,
      new Date().toISOString(),
      dispatchRescueGraceSeconds(),
    );
    return svc(
      "dispatch",
      "Dispatch",
      stall.contradiction ? "down" : "ok",
      latencyMs,
      describeDispatchStall(stall),
    );
  } catch (e) {
    // A probe that cannot read the queue must not claim the board is stalled —
    // that is the one false alarm that would train the operator to ignore it.
    return svc("dispatch", "Dispatch", "unknown", Date.now() - started, errDetail(e));
  }
}

// ── Supervision (DB read) ────────────────────────────────────────────────────
//
// The second probe here that is not a backend, and it answers the two questions
// `probeDispatch` cannot.
//
// (1) IS THE ENGINE'S OWN RECOVERY STILL EXECUTING? Every reaper, sweeper and
//     watchdog in devpilot is an Inngest cron, so they share one point of
//     failure - and on 2026-08-03 that failed while every backend probe stayed
//     green. `probeInngest` above cannot see it: it calls our OWN `/api/inngest`
//     GET handler in-process and never contacts Inngest at all, so it reports
//     "serve responding" for a scheduler that is running nothing. The canary's
//     stamp is the direct measurement.
//
// (2) IS THE SUPERVISOR REPEATEDLY FIXING THE SAME THING? An operator
//     hand-swept this board roughly six times in one day; every sweep worked and
//     every sweep hid the defect underneath it. An automatic supervisor makes
//     that worse by default, so a repeated cause is surfaced HERE - in the
//     topbar dot on every page - rather than only in a log a nobody reads. That
//     is what "cannot be silently absorbed" means in practice.
//
// State mapping:
//   • repeat defect  → `degraded`. The board is being kept alive, so it is not
//     an outage; it IS something a human has to look at.
//   • crons wedged   → `down`. Nothing else in the system will self-heal.
//   • liveness unknown → `unknown`, never `down`. A never-stamped canary is what
//     a fresh install looks like, and a red dot on a healthy new instance is how
//     an indicator stops being read.

export async function probeSupervision(tenantId: string): Promise<ServiceHealth> {
  const started = Date.now();
  try {
    const db = supabaseService();
    const nowIso = new Date().toISOString();
    const windowSeconds = indictmentWindowSeconds();
    const sinceIso = new Date(Date.parse(nowIso) - windowSeconds * 1000).toISOString();

    const [liveness, actions] = await withTimeout(
      Promise.all([
        readEngineLiveness(db, nowIso, engineStaleSeconds()),
        // Tenant-scoped IN THE QUERY (service-role read, RLS off). This list
        // becomes an ACCUSATION shown to this operator; another tenant's
        // remediations folded in would both leak their activity and manufacture
        // a defect report about a board that is fine.
        loadRecentSupervisorActions(db, tenantId, sinceIso),
      ]),
      PROBE_TIMEOUT_MS,
      "supervision",
    );
    const latencyMs = Date.now() - started;

    const indictments = detectRepeatDefect(actions, nowIso, windowSeconds, indictmentThreshold());

    if (indictments.length > 0) {
      // The worst one wins the line; the rest are in the ledger. Rendered in
      // full rather than counted, because the count and the cause ARE the
      // content - "the supervisor has been busy" is exactly the reassuring
      // non-signal that let the original defect hide.
      const worst = indictments.reduce((a, b) => (b.count > a.count ? b : a));
      return svc("supervision", "Supervision", "degraded", latencyMs, renderIndictment(worst));
    }

    if (liveness.state === "wedged") {
      return svc(
        "supervision",
        "Supervision",
        "down",
        latencyMs,
        `no Inngest cron has run for ${Math.round(liveness.ageSeconds / 60)}m - every automatic ` +
          `recovery (stuck tickets, orphaned tickets, stale runs, landing, dispatch) is stopped`,
      );
    }

    if (liveness.state === "unknown") {
      return svc("supervision", "Supervision", "unknown", latencyMs, liveness.reason);
    }

    return svc(
      "supervision",
      "Supervision",
      "ok",
      latencyMs,
      `engine recovery alive (last cron ${liveness.ageSeconds}s ago)`,
    );
  } catch (e) {
    // A probe that cannot read must not claim the crons are dead - that is the
    // one false alarm that would train the operator to ignore this row.
    return svc("supervision", "Supervision", "unknown", Date.now() - started, errDetail(e));
  }
}
