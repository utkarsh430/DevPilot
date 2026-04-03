// Phase 2 / M5e — Parallel Redis pull loop for dev-server control messages.
//
// Runs alongside the existing claude job loop (see index.ts). Drains
// `devpilot:jobs:dev-server:control` for `{ kind: 'start' | 'stop', ... }`
// messages and either spawns/kills children via `./dev-server`. Every
// 3s, posts a heartbeat per running session back to the engine's
// `/api/runners/dev-servers/:sessionId/heartbeat` endpoint so the UI's
// realtime subscription can light up the badge/port/url/logs panel.
//
// Concurrency boundary: gated by `env.DEVPILOT_DEV_SERVER_MAX`. When at cap
// we skip pulling and sleep 1s. Each start is fire-and-forget — the
// child runs until either it exits or we receive a `stop` message.

import { Redis } from "@upstash/redis";
import { env } from "./env.js";
import {
  killAllDevServers,
  killDevServer,
  killProcessGroup,
  NeedsEnvError,
  snapshotLogTail,
  startDevServer,
} from "./dev-server.js";
// Slice C — workspace state probes for the heartbeat-driven file-watcher.
// We sample `git rev-parse --short HEAD` and `git status --porcelain` on
// every 3s heartbeat tick rather than running a true fs.watch loop, which
// is unreliable across platforms (recursive watching is opt-in on Linux
// and the file-descriptor budget on macOS is unfriendly to large repos).
// 3s latency on the "Workspace updated" pill is fine UX.
import { readGitStatusPorcelain } from "./workspace.js";
import { readGitShortHeadSha } from "./git-utils.js";
import { nextIdleDelayMs, POLL_BASE_MS, POLL_IDLE_CAP_MS } from "./poll-backoff.js";

export const DEV_SERVER_CONTROL_QUEUE = "devpilot:jobs:dev-server:control";

const HEARTBEAT_INTERVAL_MS = 3_000;

type StartMessage = {
  kind: "start";
  sessionId: string;
  workspacePath: string;
  command: string;
  portHint?: number;
  envOverrides?: Record<string, string>;
  /** "Skip & start anyway" — bypass the required-env gate (operator chose to
   *  preview even with required .env.example vars missing). */
  skipEnvCheck?: boolean;
  /** Optional recovery hint. When the workspace dir is missing on disk
   *  (typical when the original ticket workspace was cleaned up after the
   *  agent finished), the runner clones repoUrl + checks out branch into
   *  workspacePath before spawning. The token is short-lived and embedded
   *  in the clone URL via x-access-token. */
  prepareIfMissing?: {
    repoUrl: string;
    branch: string;
    githubToken?: string;
  };
};

type StopMessage = {
  kind: "stop";
  sessionId: string;
  /** Process id last reported by a heartbeat for this session. When the
   *  runner's in-memory TRACKED map doesn't know about the session (e.g. the
   *  runner restarted while the child kept running, leaving an orphan), the
   *  stop handler falls back to `process.kill(pid)` so we can still kill the
   *  orphan rather than leaving it bound to the port. */
  pid?: number;
};

type ControlMessage = StartMessage | StopMessage;

type DevServerStatus = "starting" | "running" | "stopped" | "errored" | "building" | "needs_env";

type DevHeartbeatPayload = {
  sessionId: string;
  status: DevServerStatus;
  /** This runner's id, so the engine can stamp `dev_server_sessions.runner_id`
   *  and its self-heal reconcilers can attribute (and fail-forward) a session
   *  whose owning runner dies. Injected centrally in `postHeartbeat` from its
   *  opts, so individual call sites don't repeat it. */
  runnerId?: string;
  port?: number;
  url?: string;
  pid?: number;
  statusReason?: string;
  logTail?: string;
  /** Required env var keys the runner detected as missing (status=needs_env). */
  missingEnvKeys?: string[];
  // Slice C — workspace file-watcher signal. UI compares the SHA against
  // pending_pushes.head_sha to surface a "Workspace updated — refresh"
  // pill; the dirty count drives an "N uncommitted edits" badge.
  workspaceHeadSha?: string | null;
  workspaceDirtyFileCount?: number | null;
};

const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
});

// Per-session tracking for the heartbeat ticker. Mirrors the dev-server
// module's TRACKED map but holds session metadata the heartbeat needs
// (port/url/pid). The dev-server module is the source of truth for
// process lifecycle; this is purely a heartbeat shadow.
type SessionMeta = {
  sessionId: string;
  status: DevServerStatus;
  port?: number;
  url?: string;
  pid?: number;
  /** Slice C — absolute path on the runner host. Captured from the start
   *  message so the heartbeat ticker can sample HEAD SHA + dirty file
   *  count without needing to re-query the engine. */
  workspacePath?: string;
};
const SESSION_META: Map<string, SessionMeta> = new Map();

// ---- Live-log streaming ---------------------------------------------------
// Batch the dev command's stdout/stderr and POST to the engine's log-ingest
// endpoint every ~250ms (or when the buffer fills), in PARALLEL with the 3s
// heartbeat that owns `last_log_tail`. The engine XADDs each batch to a Redis
// Stream that the SSE route (`/api/dev-servers/:id/logs/stream`) tails for a
// near-live terminal view. Fire-and-forget — losing a chunk is cosmetic.
const LOG_FLUSH_MS = 250;
const LOG_FLUSH_BYTES = 16 * 1024;
type LogBatch = { buf: string; timer: NodeJS.Timeout | null };
const LOG_BATCHERS: Map<string, LogBatch> = new Map();

function appendDevLog(
  opts: { engineUrl: string; registrationKey: string },
  sessionId: string,
  chunk: string,
): void {
  if (!chunk) return;
  let b = LOG_BATCHERS.get(sessionId);
  if (!b) {
    b = { buf: "", timer: null };
    LOG_BATCHERS.set(sessionId, b);
  }
  b.buf += chunk;
  if (b.buf.length >= LOG_FLUSH_BYTES) {
    flushDevLog(opts, sessionId);
    return;
  }
  if (!b.timer) {
    b.timer = setTimeout(() => flushDevLog(opts, sessionId), LOG_FLUSH_MS);
  }
}

/** Flush the pending batch now. `done=true` also drops the batcher (call on
 *  session exit/stop so we don't leak timers). */
function flushDevLog(
  opts: { engineUrl: string; registrationKey: string },
  sessionId: string,
  done = false,
): void {
  const b = LOG_BATCHERS.get(sessionId);
  if (!b) return;
  if (b.timer) {
    clearTimeout(b.timer);
    b.timer = null;
  }
  const chunk = b.buf;
  b.buf = "";
  if (done) LOG_BATCHERS.delete(sessionId);
  if (chunk.length === 0) return;
  void postDevServerLog(opts, sessionId, chunk);
}

async function postDevServerLog(
  opts: { engineUrl: string; registrationKey: string },
  sessionId: string,
  chunk: string,
): Promise<void> {
  const url = `${opts.engineUrl}/api/runners/dev-servers/${encodeURIComponent(sessionId)}/logs`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-devpilot-runner-key": opts.registrationKey,
      },
      body: JSON.stringify({ chunk }),
    });
  } catch {
    // best-effort; the heartbeat's last_log_tail is the fallback
  }
}

/** Report the parsed `.env.example` catalog to the engine, which persists it on
 *  the owning project. Fired once per start; best-effort (the catalog is a
 *  convenience surface, never required for the run itself). */
async function postEnvCatalog(
  opts: { engineUrl: string; registrationKey: string },
  sessionId: string,
  catalog: Array<{ key: string; required: boolean; description: string | null }>,
): Promise<void> {
  const url = `${opts.engineUrl}/api/runners/dev-servers/${encodeURIComponent(sessionId)}/env-catalog`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-devpilot-runner-key": opts.registrationKey,
      },
      body: JSON.stringify({ catalog }),
    });
  } catch {
    // best-effort; the card just won't show the catalog until the next start
  }
}

/**
 * Drain the control queue. Loops until `getStopping()` returns true.
 * Each `start` spawns a child via `dev-server.ts` and posts a `running`
 * heartbeat (or `errored` if spawn fails). Each `stop` kills the child
 * and posts a `stopped` heartbeat.
 */
export async function devServerPullLoop(opts: {
  runnerId: string;
  engineUrl: string;
  registrationKey: string;
  getStopping: () => boolean;
}): Promise<void> {
  // Idle backoff: ramp the empty-poll cadence 1s→5s so an idle runner stops
  // burning Upstash request quota, and snap back to 1s the moment work arrives.
  let idleMs = POLL_BASE_MS;
  while (!opts.getStopping()) {
    // Concurrency cap: don't pull more starts than we can run. This branch
    // doesn't touch Redis, so keep it at the fast base cadence — we want to
    // resume pulling promptly once a session frees up.
    if (SESSION_META.size >= env.DEVPILOT_DEV_SERVER_MAX) {
      await sleep(POLL_BASE_MS);
      continue;
    }

    let raw: string | null = null;
    try {
      raw = (await redis.rpop(DEV_SERVER_CONTROL_QUEUE)) as string | null;
    } catch (err) {
      // Throttle straight to the cap on a pop error — the error that broke this
      // hand-off in the first place was Upstash's request-limit rejection, and
      // hammering an over-quota / down Redis only makes it worse.
      console.warn(`[devpilot-runner] dev-server queue pop failed:`, err);
      idleMs = POLL_IDLE_CAP_MS;
      await sleep(idleMs);
      continue;
    }
    if (!raw) {
      await sleep(idleMs);
      idleMs = nextIdleDelayMs(idleMs);
      continue;
    }
    // Work arrived — reset to the fast cadence so a burst of starts is drained
    // without the backoff getting in the way.
    idleMs = POLL_BASE_MS;

    let msg: ControlMessage;
    try {
      msg = typeof raw === "string" ? (JSON.parse(raw) as ControlMessage) : (raw as ControlMessage);
    } catch (e) {
      console.warn(`[devpilot-runner] dev-server bad payload, skipping:`, e);
      continue;
    }

    if (msg.kind === "start") {
      void handleStart(msg, opts);
    } else if (msg.kind === "stop") {
      void handleStop(msg, opts);
    } else {
      console.warn(
        `[devpilot-runner] dev-server unknown msg kind:`,
        (msg as { kind?: string }).kind,
      );
    }
  }
}

async function handleStart(
  msg: StartMessage,
  opts: { engineUrl: string; registrationKey: string; runnerId?: string },
): Promise<void> {
  // Argv parsing: split by whitespace. We deliberately do NOT use a shell
  // and we don't try to be clever with quoting — the engine-side action
  // is responsible for handing us already-tokenized commands. If a quoted
  // string sneaks through it gets treated literally; that's a UI bug to
  // fix upstream, not something to paper over here.
  const tokens = msg.command
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const [argv0Raw, ...argvRaw] = tokens;
  const argv0 = argv0Raw ?? "pnpm";
  const argv = argv0Raw ? argvRaw : ["run", "dev"];

  // Observability: the dev-server path used to log only on failure, so a spawn
  // that stalled inside startDevServer was indistinguishable from one that
  // never started. Log the lifecycle (start → up → exit) so a future stuck
  // spawn is diagnosable from the runner log alone rather than by inference.
  console.log(
    `[devpilot-runner] dev-server start requested session=${msg.sessionId} ` +
      `command=${JSON.stringify(msg.command)} workspace=${msg.workspacePath}`,
  );

  // Optimistic 'starting' heartbeat so the UI flips to spinner immediately.
  SESSION_META.set(msg.sessionId, { sessionId: msg.sessionId, status: "starting" });
  void postHeartbeat(opts, {
    sessionId: msg.sessionId,
    status: "starting",
    logTail: snapshotLogTail(msg.sessionId),
  });

  try {
    const started = await startDevServer({
      sessionId: msg.sessionId,
      workspacePath: msg.workspacePath,
      command: { argv0, argv },
      portHint: msg.portHint,
      envOverrides: msg.envOverrides,
      skipEnvCheck: msg.skipEnvCheck,
      prepareIfMissing: msg.prepareIfMissing,
      // Stream each chunk live to the engine (debounced ~250ms) for the SSE
      // log tail. The ring buffer in dev-server.ts still captures the bytes for
      // the heartbeat's last_log_tail snapshot — this is the live overlay.
      onLog: (chunk) => appendDevLog(opts, msg.sessionId, chunk),
      // Report the project's declared env catalog (parsed from .env.example)
      // once per start so the Secrets card can render every key + its
      // required/optional label. Best-effort, fire-and-forget.
      onEnvCatalog: (catalog) => void postEnvCatalog(opts, msg.sessionId, catalog),
      // Surface long-running startup substages as a statusReason so the UI's
      // spinner caption is accurate. The 3s ticker would eventually carry the
      // log tail anyway, but firing immediately on transition avoids the gap
      // where the user sees "Probing port and spawning…" while we're actually
      // running `pnpm install`.
      onStage: (stage) => {
        if (stage === "installing-deps") {
          void postHeartbeat(opts, {
            sessionId: msg.sessionId,
            status: "starting",
            statusReason: "installing dependencies",
            logTail: snapshotLogTail(msg.sessionId),
          });
        } else if (stage === "cloning-repo") {
          void postHeartbeat(opts, {
            sessionId: msg.sessionId,
            status: "starting",
            statusReason: "cloning repo",
            logTail: snapshotLogTail(msg.sessionId),
          });
        } else if (stage === "building") {
          void postHeartbeat(opts, {
            sessionId: msg.sessionId,
            status: "building",
            statusReason: "building",
            logTail: snapshotLogTail(msg.sessionId),
          });
        }
      },
      onExit: (code, signal) => {
        // Terminal heartbeat. If we receive a signal we treat it as a
        // requested stop (clean exit code 0 → 'stopped', anything else →
        // 'errored'). Either way the session leaves SESSION_META so the
        // cap can refill.
        const status: "stopped" | "errored" = code === 0 ? "stopped" : "errored";
        const statusReason = signal
          ? `signal:${signal}`
          : code != null
            ? `exit:${code}`
            : "exit:unknown";
        console.log(
          `[devpilot-runner] dev-server exited session=${msg.sessionId} status=${status} reason=${statusReason}`,
        );
        SESSION_META.delete(msg.sessionId);
        // Flush any buffered tail then drop the batcher.
        flushDevLog(opts, msg.sessionId, true);
        void postHeartbeat(opts, {
          sessionId: msg.sessionId,
          status,
          statusReason,
          logTail: snapshotLogTail(msg.sessionId),
        });
      },
    });
    console.log(
      `[devpilot-runner] dev-server up session=${msg.sessionId} pid=${started.pid} ` +
        `port=${started.port} url=${started.url}`,
    );
    SESSION_META.set(msg.sessionId, {
      sessionId: msg.sessionId,
      status: "running",
      port: started.port,
      url: started.url,
      pid: started.pid,
      workspacePath: msg.workspacePath,
    });
    void postHeartbeat(opts, {
      sessionId: msg.sessionId,
      status: "running",
      port: started.port,
      url: started.url,
      pid: started.pid,
      logTail: snapshotLogTail(msg.sessionId),
    });
  } catch (err) {
    SESSION_META.delete(msg.sessionId);
    flushDevLog(opts, msg.sessionId, true);
    // Required env missing → park as needs_env (not errored) with the keys so
    // the UI can prompt for them and re-trigger the run.
    if (err instanceof NeedsEnvError) {
      console.warn(
        `[devpilot-runner] dev-server needs env session=${msg.sessionId} keys=${err.keys.join(",")}`,
      );
      void postHeartbeat(opts, {
        sessionId: msg.sessionId,
        status: "needs_env",
        statusReason: "missing required env",
        missingEnvKeys: err.keys,
        logTail: snapshotLogTail(msg.sessionId),
      });
      return;
    }
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[devpilot-runner] dev-server start failed for ${msg.sessionId}:`, reason);
    void postHeartbeat(opts, {
      sessionId: msg.sessionId,
      status: "errored",
      statusReason: reason.slice(0, 500),
      logTail: snapshotLogTail(msg.sessionId),
    });
  }
}

async function handleStop(
  msg: StopMessage,
  opts: { engineUrl: string; registrationKey: string; runnerId?: string },
): Promise<void> {
  let killedViaTracked = false;
  try {
    const res = await killDevServer(msg.sessionId);
    killedViaTracked = res.killed;
  } catch (err) {
    console.warn(`[devpilot-runner] dev-server kill failed for ${msg.sessionId}:`, err);
  }

  // Fallback: TRACKED didn't have the session (typical when the runner
  // restarted while the child kept running, orphaning the process). The
  // engine includes the last-known pid in the stop message; we try a process-
  // group kill so descendants like next-server also die. Orphans spawned by
  // a pre-fix runner won't be group leaders; killProcessGroup falls back to
  // a single-pid kill in that case.
  if (!killedViaTracked && typeof msg.pid === "number" && msg.pid > 0) {
    try {
      killProcessGroup(msg.pid, "SIGTERM");
      // Grace window for clean shutdown; then SIGKILL if still alive.
      await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
      try {
        // process.kill with signal=0 is a liveness probe — throws ESRCH if gone.
        process.kill(msg.pid, 0);
        killProcessGroup(msg.pid, "SIGKILL");
      } catch {
        // already dead — good
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ESRCH = no such process (already gone); EPERM = not ours to kill.
      if (code !== "ESRCH") {
        console.warn(
          `[devpilot-runner] orphan pid kill failed for ${msg.sessionId} pid=${msg.pid}: ${code ?? err}`,
        );
      }
    }
  }

  SESSION_META.delete(msg.sessionId);
  flushDevLog(opts, msg.sessionId, true);
  void postHeartbeat(opts, {
    sessionId: msg.sessionId,
    status: "stopped",
    statusReason: "user-requested",
    logTail: snapshotLogTail(msg.sessionId),
  });
}

/**
 * Periodic heartbeat ticker. Fires every 3s. For each running session in
 * SESSION_META, POSTs a heartbeat with the current log tail so the engine
 * can update `last_heartbeat_at` and the UI realtime channel picks up new
 * stdout chunks.
 */
export function startHeartbeatTicker(opts: {
  engineUrl: string;
  registrationKey: string;
  runnerId?: string;
  getStopping: () => boolean;
}): NodeJS.Timeout {
  return setInterval(() => {
    if (opts.getStopping()) return;
    // Snapshot the keys to avoid mutation-during-iteration races if a
    // child exits mid-tick.
    const sessions = Array.from(SESSION_META.values());
    for (const meta of sessions) {
      // Only heartbeat live sessions; terminal states already got their
      // final heartbeat from the start/stop handlers.
      if (meta.status !== "running" && meta.status !== "starting") continue;
      // Slice C — fire-and-forget: sample workspace state in parallel with
      // the heartbeat post. Both reads are fast (`git rev-parse` and `git
      // status --porcelain` complete in single-digit ms on warm git dirs).
      // We swallow probe failures and just omit the fields — the UI
      // gracefully renders without the badge when the values are null.
      void (async () => {
        let sha: string | null = null;
        let dirtyCount: number | null = null;
        if (meta.workspacePath) {
          try {
            const [s, d] = await Promise.all([
              readGitShortHeadSha(meta.workspacePath),
              readGitStatusPorcelain(meta.workspacePath),
            ]);
            sha = s;
            dirtyCount = d.length;
          } catch {
            // best-effort
          }
        }
        await postHeartbeat(opts, {
          sessionId: meta.sessionId,
          status: meta.status,
          port: meta.port,
          url: meta.url,
          pid: meta.pid,
          logTail: snapshotLogTail(meta.sessionId),
          workspaceHeadSha: sha,
          workspaceDirtyFileCount: dirtyCount,
        });
      })();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Re-export for the index.ts SIGTERM hook. Kept here so callers only need
 * to import from one module.
 */
export { killAllDevServers };

// ---- HTTP heartbeat -------------------------------------------------------

async function postHeartbeat(
  opts: { engineUrl: string; registrationKey: string; runnerId?: string },
  payload: DevHeartbeatPayload,
): Promise<void> {
  const url = `${opts.engineUrl}/api/runners/dev-servers/${encodeURIComponent(payload.sessionId)}/heartbeat`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-devpilot-runner-key": opts.registrationKey,
      },
      // Inject this runner's id centrally so every heartbeat stamps ownership
      // without threading it through each call site's payload.
      body: JSON.stringify({ runnerId: opts.runnerId, ...payload }),
    });
    if (!res.ok) {
      // Non-fatal: log status + a redacted URL. We never echo the
      // registration key. Truncate the engine URL host to first 4 chars
      // when logging since the deployment URL itself may be sensitive in
      // a managed-cloud context.
      const safeUrl = redactUrl(url);
      console.warn(`[devpilot-runner] dev-server heartbeat ${res.status} → ${safeUrl}`);
    }
  } catch (err) {
    const safeUrl = redactUrl(url);
    console.warn(`[devpilot-runner] dev-server heartbeat failed → ${safeUrl}:`, err);
  }
}

function redactUrl(u: string): string {
  // Mask anything that looks like a token in path/query: keep the first 4
  // chars of the session id and the rest of the path skeleton. We don't
  // log query params at all today, but be defensive.
  try {
    const parsed = new URL(u);
    return `${parsed.origin}${parsed.pathname.replace(/[a-f0-9-]{8,}/gi, (s) => s.slice(0, 4) + "…")}`;
  } catch {
    return u.slice(0, 60) + "…";
  }
}

// ---- helpers --------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
