// Runner watchdog — engine-side cron that detects dead runners and frees the
// runs they were executing within ~60 seconds (vs the 15-minute stale-run
// reaper's window for the deep-stall fallback case).
//
// Why a separate cron from stale-run-reaper
// ─────────────────────────────────────────
// The stale reaper looks at `runs.last_event_at` — a passive signal that only
// updates when a run row writes a step. A runner that crashes during a long
// `claude -p` call (think 5–10 minutes) doesn't trip the reaper for ages.
// The watchdog looks at the ACTIVE signal: `runners.last_heartbeat_at` (15s
// interval). When that signal goes silent for 60s the runner is dead, and we
// can fail every run it was attributing to itself immediately + transition
// their tickets to `paused` so the operator gets the "click Resume" affordance
// right away.
//
// Pre-req: `runs.runner_id` must actually be populated. The new
// `/api/runs/[id]/claim` endpoint (apps/runner/src/index.ts calls it after
// rpop) stamps it. Runs without a runner_id are invisible to this watchdog
// and fall through to the 15-minute reaper.
//
// Tunables
// ────────
//   DEVPILOT_RUNNER_WATCHDOG=0             — disable the cron entirely.
//   DEVPILOT_RUNNER_WATCHDOG_THRESHOLD_SECONDS=60 — heartbeat staleness window.
//   DEVPILOT_RUNNER_WATCHDOG_BATCH=50      — per-tick stale-runner cap.

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { pauseTicket } from "@/lib/engine/pause-resume";
import { failForwardDevServerSession } from "@/lib/engine/dev-server-control";
import {
  decideDevServerReconcile,
  RECONCILABLE_DEV_SERVER_STATUSES,
  type DevServerReconcileRow,
} from "@/lib/engine/dev-server-reconcile-policy";

const WATCHDOG_ENABLED = (process.env.DEVPILOT_RUNNER_WATCHDOG ?? "1") !== "0";
const STALE_THRESHOLD_SECONDS = Number(
  process.env.DEVPILOT_RUNNER_WATCHDOG_THRESHOLD_SECONDS ?? "60",
);
const BATCH_LIMIT = Number(process.env.DEVPILOT_RUNNER_WATCHDOG_BATCH ?? "50");
// The dev-server heartbeat (3s cadence) is the authoritative liveness signal
// for a session — distinct from the runner registration heartbeat that trips
// this watchdog. Only fail-forward an owned session whose OWN heartbeat has
// also gone stale, so a still-heartbeating session a runner is spawning is
// never reaped on a registration-heartbeat blip. Shared default with the reaper.
const DEV_SERVER_HEARTBEAT_TIMEOUT_SECONDS = Number(
  process.env.DEVPILOT_DEV_SERVER_HEARTBEAT_TIMEOUT_SECONDS ?? "90",
);

// The dead runner is, by definition, not live — so the reconcile policy sees any
// session it owns as owned-by-a-dead-runner and yields reason "runner-disconnected"
// once (and only once) that session's own heartbeat is stale.
const NO_LIVE_RUNNERS: ReadonlySet<string> = new Set();

// idx=99_995 is the watchdog's distinct audit-step marker. Below 99_996
// (stale-reaper) and 99_998 (cascade-kill); above 99_993 (user-pause). See
// pause-resume.ts for the full registry.
const WATCHDOG_AUDIT_STEP_IDX = 99_995;

type StaleRunnerRow = {
  id: string;
  tenant_id: string;
  name: string | null;
  last_heartbeat_at: string | null;
};

type OwnedActiveRunRow = {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  ticket_id: string | null;
  fan_out_group: string | null;
  fan_out_role: string | null;
};

export const runnerWatchdog = inngest.createFunction(
  { id: "runner-watchdog", retries: 1 },
  // Cron every minute. The 60s threshold + per-minute tick means a dead
  // runner is detected within 60–120s of its last heartbeat. Sufficient
  // for "I closed my laptop" recovery latency; the 15-min reaper remains
  // the safety net for the runner-claim-failed edge.
  [{ cron: "* * * * *" }, { event: "internal/runner-watchdog" }],
  async ({ step }) => {
    if (!WATCHDOG_ENABLED) {
      return { skipped: "DEVPILOT_RUNNER_WATCHDOG=0" };
    }

    const cutoffIso = await step.run("compute-cutoff", async () => {
      return new Date(Date.now() - STALE_THRESHOLD_SECONDS * 1000).toISOString();
    });

    // ── 1. Find runners whose heartbeat went silent ─────────────────────
    // We exclude rows already marked offline so each runner's death is
    // reaped exactly once. `last_heartbeat_at IS NULL` (never heartbeated)
    // is also stale by definition; the OR-clause catches it.
    const staleRunners = await step.run("scan-stale-runners", async () => {
      const supabase = supabaseService();
      const { data, error } = await supabase
        .from("runners")
        .select("id, tenant_id, name, last_heartbeat_at")
        .neq("status", "offline")
        .or(`last_heartbeat_at.lt.${cutoffIso},last_heartbeat_at.is.null`)
        .limit(BATCH_LIMIT);
      if (error) throw new Error(`scan-stale-runners: ${error.message}`);
      return (data ?? []) as StaleRunnerRow[];
    });

    if (staleRunners.length === 0) {
      return { cutoffIso, staleRunners: 0, reapedRuns: 0, pausedTickets: 0 };
    }

    let reapedRuns = 0;
    let pausedTickets = 0;
    let reapedDevServers = 0;

    for (const runner of staleRunners) {
      // ── 2. Mark runner offline (idempotent — only flips non-offline) ─
      await step.run(`offline-${runner.id}`, async () => {
        const supabase = supabaseService();
        const { error } = await supabase
          .from("runners")
          .update({ status: "offline" })
          .eq("id", runner.id)
          .neq("status", "offline");
        if (error) {
          // Non-fatal; a concurrent watchdog tick may have raced. The next
          // step's conditional UPDATEs are the real safety.
          console.warn(
            `[runner-watchdog] offline UPDATE failed for runner ${runner.id}: ${error.message}`,
          );
        }
      });

      // ── 3. List owned active runs ───────────────────────────────────
      // The partial index `runs_runner_active_idx` (PR1 migration) makes
      // this O(active-runs-for-this-runner) instead of a full table scan.
      const ownedRuns = await step.run(`list-owned-${runner.id}`, async () => {
        const supabase = supabaseService();
        // NOT tenant-scoped, deliberately. This is a PLATFORM-INTERNAL reap:
        // "every run this dead runner was executing", which is a question about
        // COMPUTE, not about a tenant's data — there is no owning tenant to scope
        // it to. Runners are shared, so a runner's in-flight runs legitimately
        // span tenants (see CROSS_TENANT_BY_DESIGN, lib/security/tenant-scope-scan.ts).
        //
        // An `.eq("tenant_id", runner.tenant_id)` was added here once and is the
        // exact inverse of a hardening: it hides precisely the cross-tenant runs
        // this loop exists to reap, so they stay `running` forever behind a dead
        // runner and nothing ever fails them. Each row's own `tenant_id` is
        // selected and carried into the per-run fail below, which is what keeps
        // the writes attributed correctly without narrowing the scan.
        const { data, error } = await supabase
          .from("runs")
          .select("id, tenant_id, agent_id, ticket_id, fan_out_group, fan_out_role")
          .eq("runner_id", runner.id)
          .eq("status", "running");
        if (error) {
          throw new Error(`list owned runs for ${runner.id}: ${error.message}`);
        }
        return (data ?? []) as OwnedActiveRunRow[];
      });

      // ── 4. Per-run: fail + audit + drain + auto-pause ticket ────────
      for (const run of ownedRuns) {
        const claimed = await step.run(`reap-${run.id}`, async () => {
          const supabase = supabaseService();
          // Conditional UPDATE — bow out if the row already moved on
          // (cascade-kill, user-pause, supervisor restart).
          const { data: rows, error } = await supabase
            .from("runs")
            .update({
              status: "failed",
              status_reason: "runner-disconnected",
              last_event_at: new Date().toISOString(),
            })
            .eq("id", run.id)
            .eq("status", "running")
            .select("id");
          if (error) {
            throw new Error(`reap update failed for ${run.id}: ${error.message}`);
          }
          if (!rows || rows.length === 0) return false;

          const { error: stepErr } = await supabase.from("run_steps").insert({
            run_id: run.id,
            idx: WATCHDOG_AUDIT_STEP_IDX,
            kind: "system",
            payload: {
              kind: "runner-watchdog-reaped",
              runner_id: runner.id,
              runner_name: runner.name,
              last_heartbeat_at: runner.last_heartbeat_at,
              threshold_seconds: STALE_THRESHOLD_SECONDS,
            },
          });
          if (stepErr) {
            // Audit-step write failure is non-fatal — the run is already
            // marked failed and the drain event below still fires.
            console.warn(
              `[runner-watchdog] audit step write failed for run ${run.id}: ${stepErr.message}`,
            );
          }
          return true;
        });
        if (!claimed) continue;

        reapedRuns += 1;

        // Drain dispatch_queue. Per the existing convention in stale-run-
        // reaper + run-agent.ts, agent/run.completed with status='failed'
        // is what the WIP-drain listener consumes.
        await step.sendEvent(`emit-${run.id}`, {
          name: "agent/run.completed",
          data: {
            runId: run.id,
            tenantId: run.tenant_id as string,
            ticketId: (run.ticket_id as string | null) ?? undefined,
            agentId: (run.agent_id as string | null) ?? undefined,
            role: (run.fan_out_role as string | null) ?? undefined,
            status: "failed" as const,
            fanOutGroup: (run.fan_out_group as string | null) ?? undefined,
          },
        });

        // ── 5. Auto-pause the owning ticket ──────────────────────────
        // pauseTicket is idempotent (conditional UPDATE on tickets.status)
        // and gates itself on pausable statuses, so calling it for a
        // ticket already in done/failed/paused/backlog/ready is a no-op.
        // input_required IS pausable per the FSM, but per the PR2 decision
        // we leave those alone — the agent is genuinely waiting for human
        // input and the watchdog shouldn't conflate "runner died" with
        // "agent escalated." The 15-min stale reaper catches the
        // input_required case as the deeper fallback.
        if (run.ticket_id) {
          await step.run(`pause-${run.ticket_id}`, async () => {
            try {
              // Pre-flight gate: skip input_required + already-terminal
              // tickets BEFORE we acquire the conditional UPDATE — saves a
              // round-trip and keeps the audit clean.
              const supabase = supabaseService();
              const { data: ticket } = await supabase
                .from("tickets")
                .select("status")
                .eq("id", run.ticket_id!)
                .maybeSingle();
              const status = (ticket?.status as string | undefined) ?? null;
              if (
                status === "input_required" ||
                status === "done" ||
                status === "failed" ||
                status === "paused" ||
                status === "backlog" ||
                status === "ready"
              ) {
                return { skipped: status };
              }
              const res = await pauseTicket({
                ticketId: run.ticket_id!,
                tenantId: run.tenant_id as string,
                reason: "runner-disconnected",
              });
              if (res.ok && !("alreadyAtState" in res)) {
                pausedTickets += 1;
              }
              return res;
            } catch (err) {
              // Non-fatal — the run is already marked failed and the queue
              // drained. Failing to auto-pause just means the ticket sits
              // in its prior state until the operator notices.
              console.warn(
                `[runner-watchdog] pause ticket ${run.ticket_id} failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              return { skipped: "pause-threw" };
            }
          });
        }
      }

      // ── 6. Fail-forward the runner's stranded dev-server sessions ────
      // A dead runner can't heartbeat its dev servers either, so any session
      // it claimed (runner_id = this runner) whose OWN dev-server heartbeat has
      // also gone stale is stranded — the operator's RunPanel would spin on
      // "Starting…"/"Running" forever. Transition each to `errored` now (fast
      // path) rather than waiting out the dev-server reaper's next 5-min tick.
      // We gate on the session's own heartbeat via the shared reconcile policy:
      // the runner's registration heartbeat can blip for >60s (tripping this
      // watchdog) while it keeps heartbeating an actively-spawning session every
      // ~3s, and that session must NOT be reaped. The reaper remains the backstop
      // for never-claimed sessions (runner_id = null), which no per-runner scan
      // can see. `failForwardDevServerSession` guards the transition with a
      // compare-and-set, so this can't race the reaper into a double-move.
      const ownedSessions = await step.run(`list-dev-servers-${runner.id}`, async () => {
        const supabase = supabaseService();
        // Not tenant-scoped, same reason as the owned-runs read above: a dead
        // runner's dev-server sessions are its own regardless of whose tenant
        // each session belongs to, and filtering would strand the cross-tenant
        // ones in `starting`/`running` with the RunPanel spinning forever.
        const { data, error } = await supabase
          .from("dev_server_sessions")
          .select("id, status, runner_id, last_heartbeat_at, updated_at, started_at")
          .eq("runner_id", runner.id)
          .in("status", RECONCILABLE_DEV_SERVER_STATUSES as unknown as string[]);
        if (error) {
          throw new Error(`list dev servers for ${runner.id}: ${error.message}`);
        }
        return (data ?? []) as DevServerReconcileRow[];
      });
      for (const session of ownedSessions) {
        const failed = await step.run(`fail-dev-server-${session.id}`, async () => {
          const nowMs = Date.now();
          const heartbeatTimeoutMs = DEV_SERVER_HEARTBEAT_TIMEOUT_SECONDS * 1000;
          const decision = decideDevServerReconcile({
            row: session,
            liveRunnerIds: NO_LIVE_RUNNERS,
            nowMs,
            heartbeatTimeoutMs,
          });
          if (decision.action !== "fail") return false;
          // Re-confirm staleness atomically at write time (same cutoff the
          // policy just judged against), so a session that received a fresh
          // heartbeat between the list scan and this step is left alone.
          const staleCutoffIso = new Date(nowMs - heartbeatTimeoutMs).toISOString();
          return failForwardDevServerSession(session.id, decision.reason, staleCutoffIso);
        });
        if (failed) reapedDevServers += 1;
      }
    }

    return {
      cutoffIso,
      staleRunners: staleRunners.length,
      reapedRuns,
      pausedTickets,
      reapedDevServers,
    };
  },
);
