// Dev-server session reconcile policy — the pure decision core for self-healing
// `dev_server_sessions` rows that strand in a non-terminal state.
//
// Why this exists
// ───────────────
// A dev server is spawned by the local-cc runner in response to a start
// request dispatched via the Redis dev-server control queue. On spawn the
// runner heartbeats the session (`last_heartbeat_at`, and — post this change —
// `runner_id`). If the owning runner dies in the handoff window (killed while a
// start request is in flight), the queue message is lost and NO live runner
// ever claims the session: the row sits `status='starting'`, `runner_id=null`,
// `pid=null`, `port=null` with its `last_heartbeat_at` frozen at insert time.
// A freshly-registered runner does not reclaim it, so the UI spins on
// "Starting…" indefinitely.
//
// This module is the pure, side-effect-free brain the engine's dev-server
// reaper and the runner-watchdog both consult to decide whether a session is
// orphaned/stuck and must be failed-forward to a terminal state. Keeping it
// pure (no Supabase / Next imports) mirrors `reconcile-policy.ts` so it loads
// and is exhaustively unit-testable under Vitest.
//
// Design choice: fail-forward, not reclaim-and-spawn
// ──────────────────────────────────────────────────
// A dev server's workspace lives on a specific runner host (`~/.devpilot/workspaces/
// project-<id>/`); spawning it from a different runner is exactly the risky
// cross-runner case the task flags. Rather than reclaim-and-spawn, we transition
// the stranded session to a terminal `errored` state with a clear reason. The
// RunPanel already renders `errored` sessions with the reason + a Restart
// button, giving the operator a clean, one-click retry — and fail-forward
// structurally cannot double-spawn, since it never spawns.

/** The subset of a `dev_server_sessions` row this policy reasons about. */
export type DevServerReconcileRow = {
  id: string;
  status: string;
  /** Which runner claimed the session (stamped on the first heartbeat). Null
   *  for a never-claimed session — the exact shape of the stranded prod row. */
  runner_id: string | null;
  /** Bumped every ~3s while a runner owns the session. NOT NULL in the schema
   *  (defaults to now() at insert), so a never-claimed row carries its insert
   *  time here — frozen, never advancing. Treated defensively as nullable. */
  last_heartbeat_at: string | null;
  /** Set to the start-request time; a proxy for "when the spawn was asked
   *  for" that, like last_heartbeat_at, never advances for a stranded row. */
  updated_at: string | null;
  /** Session creation time — the final liveness fallback. */
  started_at: string | null;
};

/** Non-terminal statuses a session can strand in. `needs_env` is deliberately
 *  excluded: it is a parked state waiting on operator-supplied env vars, not a
 *  stranded spawn, and auto-failing it would destroy the operator's prompt. */
export const RECONCILABLE_DEV_SERVER_STATUSES = ["starting", "running", "building"] as const;

export type DevServerReconcileDecision =
  | { action: "none"; reason: string }
  | { action: "fail"; toStatus: "errored"; reason: string };

export type DevServerReconcileInput = {
  row: DevServerReconcileRow;
  /** Ids of runners whose registration heartbeat is fresh (same liveness notion
   *  the runner-watchdog uses). Used ONLY to pick a diagnostic reason once a
   *  session is already judged stale — never to fail-forward a fresh session.
   *  The registration heartbeat (15s cadence, 60s window) is a distinct signal
   *  from the dev-server heartbeat (3s cadence); trusting it to override a fresh
   *  dev-server heartbeat would falsely reap a session a live runner is actively
   *  spawning whenever the two signals diverge. */
  liveRunnerIds: ReadonlySet<string>;
  nowMs: number;
  /** How long a session may go without a heartbeat before it is considered
   *  stranded. Doubles as the stuck-`starting` timeout: a never-claimed row's
   *  frozen liveness timestamp trips this bound. */
  heartbeatTimeoutMs: number;
};

/** Parse an ISO timestamp to epoch ms, or null if absent/unparseable. */
function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Decide whether a non-terminal dev-server session is stranded and must be
 * failed-forward.
 *
 * The dev-server heartbeat (3s cadence) is the SINGLE authoritative liveness
 * signal. A session is stranded IFF its most-recent sign of life —
 * `max(last_heartbeat_at, updated_at, started_at)` — is older than
 * `heartbeatTimeoutMs` (covers the never-claimed row, whose frozen insert-time
 * liveness eventually ages out, AND a session whose owning runner died mid-run
 * and stopped heartbeating).
 *
 * Runner liveness (`liveRunnerIds`) is consulted ONLY to pick a diagnostic
 * reason once a session is already judged stale — never as an independent
 * fail-forward trigger. A session with a FRESH heartbeat is left alone even if
 * its `runner_id` is absent from `liveRunnerIds`: the registration heartbeat
 * that populates that set is a separate signal (15s cadence, 60s window) from
 * the dev-server heartbeat, and can blip for >60s while the runner keeps
 * heartbeating the session every ~3s. Failing such a session forward would
 * falsely reap a dev server a live runner is actively spawning.
 *
 * Crucially, a HEALTHY session a live runner is actively spawning is NOT
 * disturbed: the runner posts an optimistic `starting` heartbeat the moment it
 * claims the message and keeps heartbeating every ~3s (including through a long
 * `pnpm install`), so its liveness timestamp stays fresh.
 */
export function decideDevServerReconcile(
  input: DevServerReconcileInput,
): DevServerReconcileDecision {
  const { row, liveRunnerIds, nowMs, heartbeatTimeoutMs } = input;

  if (!(RECONCILABLE_DEV_SERVER_STATUSES as readonly string[]).includes(row.status)) {
    return { action: "none", reason: `status-${row.status}-not-reconcilable` };
  }

  // Most-recent evidence of life. `max` (not `min`) so ANY recent signal — a
  // late heartbeat, a re-stamped updated_at from a retry — protects the row.
  const liveness = Math.max(
    toMs(row.last_heartbeat_at) ?? Number.NEGATIVE_INFINITY,
    toMs(row.updated_at) ?? Number.NEGATIVE_INFINITY,
    toMs(row.started_at) ?? Number.NEGATIVE_INFINITY,
  );

  // A parseable, fresh liveness timestamp keeps the session — regardless of
  // whether its runner is currently in the live set. The heartbeat is the
  // authoritative signal; a healthy actively-spawning session is never reaped.
  const stale = !Number.isFinite(liveness) || nowMs - liveness > heartbeatTimeoutMs;
  if (!stale) {
    return { action: "none", reason: "fresh" };
  }

  // Stale — fail-forward. Ownership only selects a diagnostic reason:
  //   • runner_id set but not live  → the runner had it then disconnected
  //   • runner_id null              → never claimed (the stranded-handoff shape)
  //   • runner_id set and live      → a live runner simply stopped heartbeating
  const reason =
    row.runner_id !== null && !liveRunnerIds.has(row.runner_id)
      ? "runner-disconnected"
      : row.runner_id === null
        ? "orphaned-never-claimed"
        : "no-heartbeat";
  return { action: "fail", toStatus: "errored", reason };
}
