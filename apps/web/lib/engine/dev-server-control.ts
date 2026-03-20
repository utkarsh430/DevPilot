// Dev-server control — Phase 2 / M5e.
//
// Engine-side glue between the UI (which clicks Run / Stop) and the runner-
// side dev-server loop (B2) which actually spawns child processes on the
// runner host. The data substrate is `dev_server_sessions` (one row per
// spawn attempt) + a Redis control queue `devpilot:jobs:dev-server:control` that
// the runner-side loop pulls from.
//
// Three durable functions live here:
//
//   1. `startDevServer` — reacts to `dev_server.start_requested`. Pushes a
//      `{kind:"start", …}` message onto the Redis control queue and stamps
//      the session row to status='starting'. The runner consumes the
//      message, probes for a free port, spawns the child, and starts
//      heartbeat-ing back.
//
//   2. `stopDevServer` — reacts to `dev_server.stop_requested`. Pushes a
//      `{kind:"stop", …}` message onto the same queue. The runner kills the
//      child via process-group SIGTERM and its next heartbeat will flip the
//      row to status='stopped'. We optimistically stamp `status_reason`
//      here so the UI tooltip ("stopping — user requested") updates without
//      waiting for the heartbeat round-trip.
//
//   3. `devServerReaper` — cron `*/5 * * * *` plus the matching opt-out env
//      `DEVPILOT_DEV_SERVER_REAPER=0`. Handles three jobs:
//        (a) Heartbeat timeout: if `last_heartbeat_at` is older than 90s
//            for a starting/running session, mark it errored. The runner
//            either crashed or the host went away — there is no point
//            waiting longer.
//        (b) Idle stop: if `last_interaction_at` is older than 30 min and
//            status is still 'running', emit `dev_server.stop_requested`
//            with reason='idle'. We don't UPDATE here — the dedicated stop
//            function owns that transition.
//        (c) GC: DELETE rows whose `stopped_at` is older than 24h. The row
//            has done its job as audit; long-term history lives in the
//            trace UI.
//
// Hard boundaries:
//   • Engine NEVER spawns processes. Only the runner does that. This file
//     only writes to Postgres + Redis.
//   • Engine NEVER reads the runner's filesystem. workspace_path is opaque
//     metadata that's round-tripped through the queue.
//   • This file does NOT register itself in `app/api/inngest/route.ts`.
//     B5 (the orchestrator agent) owns that wiring.

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { redis } from "@/lib/cache/redis";
// Slice A — per-project encrypted secrets vault. Read at session-start to
// thread the operator's env values into `pnpm dev`'s child.
import { loadProjectSecretsJson } from "@/lib/projects/secrets";
// Self-heal — pure policy deciding whether a non-terminal session is stranded
// (never claimed by any runner, or owned by a dead one) and must be
// failed-forward. Kept side-effect-free so it's unit-testable under Vitest.
import {
  decideDevServerReconcile,
  RECONCILABLE_DEV_SERVER_STATUSES,
  type DevServerReconcileRow,
} from "@/lib/engine/dev-server-reconcile-policy";

// Redis list the runner-side dev-server loop pulls from. Single queue for
// both start and stop messages; the runner discriminates on `kind`.
const DEV_SERVER_CONTROL_QUEUE = "devpilot:jobs:dev-server:control";

// Reaper tunables. Numeric env overrides exist to make acceptance tests
// snappier; production keeps the defaults.
const REAPER_ENABLED = (process.env.DEVPILOT_DEV_SERVER_REAPER ?? "1") !== "0";
const HEARTBEAT_TIMEOUT_SECONDS = Number(
  process.env.DEVPILOT_DEV_SERVER_HEARTBEAT_TIMEOUT_SECONDS ?? "90",
);
const IDLE_STOP_MINUTES = Number(process.env.DEVPILOT_DEV_SERVER_IDLE_STOP_MINUTES ?? "30");
const STOPPED_GC_HOURS = Number(process.env.DEVPILOT_DEV_SERVER_STOPPED_GC_HOURS ?? "24");
const REAPER_BATCH_LIMIT = Number(process.env.DEVPILOT_DEV_SERVER_REAPER_BATCH ?? "100");
// A runner is "live" if its registration heartbeat landed within this window —
// the same liveness notion the runner-watchdog uses (shared env var, 60s
// default). A session whose runner_id is absent from the live set is owned by a
// dead runner and can be failed-forward without waiting out the full
// heartbeat timeout.
const RUNNER_LIVENESS_SECONDS = Number(
  process.env.DEVPILOT_RUNNER_WATCHDOG_THRESHOLD_SECONDS ?? "60",
);
// Explicit cap on the live-runner scan so PostgREST's implicit 1000-row default
// can't silently drop live runners from the set — a live runner missing from the
// set would only downgrade a STALE session's reason to "runner-disconnected"
// (fresh sessions are protected by their own heartbeat now), but we keep the
// authoritative set complete anyway. Set well above any realistic fleet size.
const LIVE_RUNNER_SCAN_LIMIT = Number(
  process.env.DEVPILOT_DEV_SERVER_LIVE_RUNNER_SCAN_LIMIT ?? "10000",
);

// ---------------------------------------------------------------------------
// 1. startDevServer
// ---------------------------------------------------------------------------

export const startDevServer = inngest.createFunction(
  { id: "dev-server-start", retries: 1 },
  { event: "dev_server.start_requested" },
  async ({ event, step }) => {
    const { sessionId, workspacePath, command, portHint, prepareIfMissing, skipEnvCheck } =
      event.data;

    // Slice A — resolve the per-project secrets vault for this session
    // and pass it through as envOverrides so `pnpm dev` / `pnpm start`
    // see the operator-provided env values. Lookup goes through the
    // dev_server_sessions row (which carries project_id) rather than
    // requiring the caller to pass project_id explicitly in the event —
    // keeps the event surface stable and matches how the rest of the
    // dev-server pipeline reads context from the row.
    const sessionEnvOverrides = await step.run("resolve-project-env", async () => {
      const supabase = supabaseService();
      // `tenant_id` is selected alongside `project_id` so the secrets read below
      // is scoped to THIS session's tenant. The session is looked up by primary
      // key, so its own tenant is DB truth and the right authority here.
      const { data, error } = await supabase
        .from("dev_server_sessions")
        .select("project_id, tenant_id")
        .eq("id", sessionId)
        .maybeSingle();
      if (error || !data?.project_id || !data?.tenant_id) return {} as Record<string, string>;
      const json = await loadProjectSecretsJson(String(data.project_id), String(data.tenant_id));
      if (!json) return {} as Record<string, string>;
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") out[k] = v;
        }
        return out;
      } catch {
        return {} as Record<string, string>;
      }
    });

    // Push the start message first. If Redis is down we want to surface
    // that before mutating the row — the operator sees an errored start
    // rather than a stuck "starting…" pill that never resolves.
    await step.run("push-start-message", async () => {
      await redis().lpush(
        DEV_SERVER_CONTROL_QUEUE,
        JSON.stringify({
          kind: "start" as const,
          sessionId,
          workspacePath,
          command,
          portHint,
          // Slice A — per-project secrets get merged into the child's
          // env BEFORE PORT (which the dev-server-loop appends last to
          // prevent overrides). The runner's stack-detection ladder
          // (pnpm dev / vite / uv / cargo / go) inherits these natively.
          // Empty {} when the project has no secrets configured.
          envOverrides: sessionEnvOverrides,
          // "Skip & start anyway" — bypass the runner's required-env gate.
          ...(skipEnvCheck ? { skipEnvCheck: true } : {}),
          // Recovery: when the action stamped this, the runner clones
          // the repo into workspacePath before spawning. Absent for the
          // steady-state path. The github token is short-lived and
          // travels inside Redis only (queue is internal). Never logged.
          ...(prepareIfMissing ? { prepareIfMissing } : {}),
        }),
      );
    });

    // Stamp the row to 'starting' so the UI immediately shows the
    // intermediate state. The runner's first heartbeat will flip to
    // 'running' once the port probe succeeds and the child is up.
    await step.run("mark-session-starting", async () => {
      const supabase = supabaseService();
      const { error } = await supabase
        .from("dev_server_sessions")
        .update({
          status: "starting",
          status_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionId);
      if (error) {
        throw new Error(`dev_server_sessions update failed for ${sessionId}: ${error.message}`);
      }
    });

    return { sessionId, queued: true };
  },
);

// ---------------------------------------------------------------------------
// 2. stopDevServer
// ---------------------------------------------------------------------------

export const stopDevServer = inngest.createFunction(
  { id: "dev-server-stop", retries: 1 },
  { event: "dev_server.stop_requested" },
  async ({ event, step }) => {
    const { sessionId, reason } = event.data;

    // Read the last-known pid so the runner can fall back to a plain
    // process.kill if its in-memory TRACKED map doesn't have the session
    // (the typical orphan case: runner restarted while the child kept
    // running). Best-effort — a null pid just means the runner relies on
    // TRACKED.
    const pid = await step.run("read-pid", async () => {
      const supabase = supabaseService();
      const { data } = await supabase
        .from("dev_server_sessions")
        .select("pid")
        .eq("id", sessionId)
        .maybeSingle();
      return (data as { pid: number | null } | null)?.pid ?? null;
    });

    await step.run("push-stop-message", async () => {
      await redis().lpush(
        DEV_SERVER_CONTROL_QUEUE,
        JSON.stringify({
          kind: "stop" as const,
          sessionId,
          pid: pid ?? undefined,
        }),
      );
    });

    // Optimistically stamp the status_reason so the UI tooltip
    // ("stopping — idle timeout") updates without waiting for the
    // heartbeat round-trip. We deliberately don't set status='stopped'
    // here — only the runner's heartbeat owns that transition, after the
    // child has actually exited. If the runner is dead, devServerReaper
    // will flip to 'errored' on the next tick.
    await step.run("mark-stop-reason", async () => {
      const supabase = supabaseService();
      const { error } = await supabase
        .from("dev_server_sessions")
        .update({
          status_reason: `stopping: ${reason}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionId)
        .in("status", ["starting", "running", "building", "needs_env"]);
      if (error) {
        throw new Error(`dev_server_sessions update failed for ${sessionId}: ${error.message}`);
      }
    });

    // Drop the live-log Redis Stream (the SSE tail's source). Best-effort —
    // the 1h TTL set on each XADD is the backstop if this is missed.
    await step.run("del-log-stream", async () => {
      await redis()
        .del(`devpilot:devlog:${sessionId}`)
        .catch(() => undefined);
    });

    return { sessionId, reason, queued: true };
  },
);

// ---------------------------------------------------------------------------
// 3. devServerReaper
// ---------------------------------------------------------------------------

type ActiveSessionRow = {
  id: string;
  tenant_id: string;
  status: string;
  runner_id: string | null;
  last_heartbeat_at: string | null;
  last_interaction_at: string;
  started_at: string | null;
  updated_at: string | null;
};

/**
 * Fail-forward a stranded dev-server session to `errored` with a diagnostic
 * reason. Guarded by a compare-and-set on status (`IN (starting,running,
 * building)`) so two concurrent reconcilers — or a reaper tick racing the
 * runner-watchdog — can never double-transition, and a session a live runner
 * revived in the meantime (already flipped to running/stopped) is left alone.
 *
 * Returns true iff THIS call performed the transition. Shared by the periodic
 * reaper (heartbeat-timeout backstop) and the runner-watchdog (fast dead-runner
 * path) so both routes emit the same terminal state + audit shape.
 *
 * `staleCutoffIso` (when given) re-verifies staleness ATOMICALLY at write time,
 * not just at scan time. Staleness is decided from the `scan-active` snapshot
 * and acted on in a separate later step; if the session received a fresh
 * heartbeat and recovered in that gap (status still non-terminal, but
 * `last_heartbeat_at` now fresh), a status-only CAS would still fire and error
 * a healthy session — permanently, now that the heartbeat route treats
 * `errored` as terminal. Adding `.lt("last_heartbeat_at", staleCutoffIso)` makes
 * the recovered row no longer match (0 rows → returns false), while a frozen
 * never-claimed row (last_heartbeat_at at insert time) still matches.
 */
export async function failForwardDevServerSession(
  sessionId: string,
  reason: string,
  staleCutoffIso?: string | null,
): Promise<boolean> {
  const supabase = supabaseService();
  const nowIso = new Date().toISOString();
  let query = supabase
    .from("dev_server_sessions")
    .update({
      status: "errored",
      status_reason: reason,
      stopped_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", sessionId)
    .in("status", RECONCILABLE_DEV_SERVER_STATUSES as unknown as string[]);
  if (staleCutoffIso) {
    query = query.lt("last_heartbeat_at", staleCutoffIso);
  }
  const { data, error } = await query.select("id");
  if (error) {
    throw new Error(`fail-forward dev-server ${sessionId}: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}

export const devServerReaper = inngest.createFunction(
  { id: "dev-server-reaper", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    if (!REAPER_ENABLED) {
      return { skipped: "DEVPILOT_DEV_SERVER_REAPER=0" };
    }

    // 1. Compute the cutoff timestamps in one step so retries see a
    //    consistent snapshot of "now". The reaper's worst-case retry is a
    //    duplicate scan; the conditional UPDATE in (a) is idempotent.
    const cutoffs = await step.run("compute-cutoffs", async () => {
      const now = Date.now();
      return {
        nowMs: now,
        heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_SECONDS * 1000,
        // Staleness cutoff re-checked atomically at fail-forward time so a
        // session that got a fresh heartbeat between this scan and its
        // per-row mark-errored step is not wrongly terminalized.
        heartbeatCutoffIso: new Date(now - HEARTBEAT_TIMEOUT_SECONDS * 1000).toISOString(),
        runnerLivenessCutoffIso: new Date(now - RUNNER_LIVENESS_SECONDS * 1000).toISOString(),
        idleCutoffIso: new Date(now - IDLE_STOP_MINUTES * 60_000).toISOString(),
        gcCutoffIso: new Date(now - STOPPED_GC_HOURS * 60 * 60_000).toISOString(),
      };
    });

    // 2. Scan all non-terminal sessions — INCLUDING `building` (a session that
    //    reached the build stage then lost its runner would otherwise slip
    //    through, as the old scan only covered starting/running). `needs_env`
    //    is excluded: it's parked on operator input, not stranded. The partial
    //    index `dev_server_sessions_active_idx` keeps this cheap.
    const active = await step.run("scan-active", async () => {
      const supabase = supabaseService();
      const { data, error } = await supabase
        .from("dev_server_sessions")
        .select(
          "id, tenant_id, status, runner_id, last_heartbeat_at, last_interaction_at, started_at, updated_at",
        )
        .in("status", RECONCILABLE_DEV_SERVER_STATUSES as unknown as string[])
        .limit(REAPER_BATCH_LIMIT);
      if (error) throw new Error(`scan-active failed: ${error.message}`);
      return (data ?? []) as ActiveSessionRow[];
    });

    // 2b. Resolve the set of live runner ids so the policy can fail-forward a
    //     session owned by a runner that's already gone, without waiting out
    //     the full heartbeat timeout. Throws on error like scan-active above,
    //     so a transient DB hiccup just retries the tick (retries:1) or waits
    //     the next 5-min cron — the heartbeat-age signal still catches
    //     everything on the following run regardless.
    const liveRunnerIds = await step.run("scan-live-runners", async () => {
      const supabase = supabaseService();
      const { data, error } = await supabase
        .from("runners")
        .select("id")
        .neq("status", "offline")
        .gte("last_heartbeat_at", cutoffs.runnerLivenessCutoffIso)
        .limit(LIVE_RUNNER_SCAN_LIMIT);
      if (error) throw new Error(`scan-live-runners failed: ${error.message}`);
      return (data ?? []).map((r) => (r as { id: string }).id);
    });
    const liveRunnerSet = new Set(liveRunnerIds);

    let heartbeatErrored = 0;
    let idleStopsEmitted = 0;

    for (const row of active) {
      const decision = decideDevServerReconcile({
        row: row as DevServerReconcileRow,
        liveRunnerIds: liveRunnerSet,
        nowMs: cutoffs.nowMs,
        heartbeatTimeoutMs: cutoffs.heartbeatTimeoutMs,
      });
      const idle = row.status === "running" && row.last_interaction_at <= cutoffs.idleCutoffIso;

      // (a) Stranded — never claimed, or its owning runner crashed / went
      //     silent. Fail-forward to `errored` with a diagnostic reason. The
      //     guarded compare-and-set means concurrent reaper ticks, the
      //     runner-watchdog, and a live runner's revival heartbeat can't
      //     race-trample each other.
      if (decision.action === "fail") {
        const claimed = await step.run(`mark-errored-${row.id}`, () =>
          failForwardDevServerSession(row.id, decision.reason, cutoffs.heartbeatCutoffIso),
        );
        if (claimed) heartbeatErrored += 1;
        // Skip the idle check — the session is already errored.
        continue;
      }

      // (b) Idle stop — emit a stop_requested. Don't UPDATE the row here;
      //     stopDevServer owns that transition. Idempotent: emitting twice
      //     just pushes two stop messages onto the queue, and the runner's
      //     stop handler no-ops if the child is already gone.
      if (idle) {
        await step.sendEvent(`emit-idle-stop-${row.id}`, {
          name: "dev_server.stop_requested",
          data: {
            sessionId: row.id,
            tenantId: row.tenant_id,
            reason: "idle" as const,
          },
        });
        idleStopsEmitted += 1;
      }
    }

    // (c) Garbage-collect old stopped/errored sessions. Audit history lives
    //     in the trace UI; the table itself is a working set.
    const gcDeleted = await step.run("gc-old-stopped", async () => {
      const supabase = supabaseService();
      const { data, error } = await supabase
        .from("dev_server_sessions")
        .delete()
        .lt("stopped_at", cutoffs.gcCutoffIso)
        .in("status", ["stopped", "errored"])
        .select("id");
      if (error) {
        throw new Error(`gc-old-stopped failed: ${error.message}`);
      }
      // Drop any lingering live-log streams for the GC'd sessions (TTL is the
      // primary cleanup; this catches sessions that errored without a stop).
      for (const row of data ?? []) {
        await redis()
          .del(`devpilot:devlog:${row.id as string}`)
          .catch(() => undefined);
      }
      return data?.length ?? 0;
    });

    return {
      cutoffs,
      activeScanned: active.length,
      heartbeatErrored,
      idleStopsEmitted,
      gcDeleted,
    };
  },
);
