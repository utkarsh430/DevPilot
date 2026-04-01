// Phase 2 / M5e — Dev-server launcher (runner-side).
//
// Detects the workspace's stack, allocates a free port, spawns the dev
// command as a child process, captures stdout/stderr into a bounded ring
// buffer, and exposes start/stop/kill-all primitives plus a snapshot tail
// for periodic heartbeats. Children run in their own POSIX process group
// (spawned with `detached: true` → setsid) so SIGTERM can be delivered to
// the entire descendant tree via `kill(-pgid, signal)`. Without this,
// `pnpm dev` would exit but its grand-child `next-server` would detach and
// keep the port — exactly the orphan we hit on dev_server_sessions.
// `killAllDevServers()` is also called from the SIGTERM hook in `index.ts`
// to give children a graceful 5s window before SIGKILL.
//
// Design notes:
//   - Port probe uses `net.createServer().listen(port, '127.0.0.1')` walking
//     upward from a hint, skipping well-known ports. We bind+close to verify
//     the port is free; there's a tiny window between close and the child's
//     bind, but in practice dev servers either bind immediately (Next/Vite)
//     or fail loud — and the heartbeat surface will mark the session
//     'errored' if the child exits non-zero quickly.
//   - stdout/stderr capture is a per-session ring buffer capped at 8 KiB
//     (FIFO truncate from the head). The full stream is also forwarded to
//     the optional `onLog` callback so the loop can append in real time.
//   - `TRACKED` is module-local. The only handles out are `killDevServer`,
//     `killAllDevServers`, and `snapshotLogTail`.
//   - Never logs secrets: `envOverrides` is consumed but not echoed.

import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type StackDetectResult = {
  argv0: string;
  argv: string[];
  /** Human-readable label for the detected stack: 'next', 'vite', 'fastapi', 'go', 'cargo', 'unknown' */
  kind: string;
  /** Build command to run before serving, when a build is needed. Undefined
   *  for dev commands that compile on the fly (next dev / vite / cargo run). */
  build?: { argv0: string; argv: string[] };
  /** Build-output dirs that, when ALL absent, indicate the project isn't built
   *  (e.g. ['.next'], ['dist']). Empty/undefined ⇒ no artifact gating. */
  artifactDirs?: string[];
  /** True when the run command is a production `start` that requires a prior
   *  build (so we always build — artifacts may be stale). */
  isProdStart?: boolean;
};

const RING_BUFFER_BYTES = 8 * 1024; // 8 KiB per session
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_PORT_PROBE_HORIZON = 200;
const PORT_PROBE_DEFAULT_START = 3100;
const WELL_KNOWN_PORTS = new Set([
  3000, // Next dev server (DevPilot web app itself)
  5432, // Postgres
  6379, // Redis
  8000, // common Python dev default
  8080, // common Java/Go dev default
  8288, // Inngest dev server
  9229, // Node inspector
]);

/**
 * Inspect workspace files and return the canonical dev command.
 * Priority:
 *   package.json with scripts.dev   → ("pnpm", ["run", "dev"])
 *   package.json with scripts.start → ("pnpm", ["run", "start"])
 *   pyproject.toml (FastAPI/uvicorn detection) → ("uv", ["run", "uvicorn", "main:app", "--reload"])
 *                                     or fallback ("python", ["main.py"])
 *   Cargo.toml → ("cargo", ["run"])
 *   go.mod → ("go", ["run", "."])
 *   fallback → ("pnpm", ["run", "dev"])
 *
 * Defensive: read failures fall back to pnpm dev rather than throw. The
 * scaffolder's stack vocabulary in `lib/roles/project_scaffolder.ts` is the
 * other half of this mapping; keep them in sync.
 */
export async function detectStack(workspacePath: string): Promise<StackDetectResult> {
  // package.json — also distinguish next / vite from the deps.
  const pkgPath = path.join(workspacePath, "package.json");
  try {
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const kind = deps["next"]
      ? "next"
      : deps["vite"]
        ? "vite"
        : scripts.dev
          ? "node"
          : scripts.start
            ? "node"
            : "unknown";
    if (scripts.dev) {
      // Dev mode compiles on the fly — never pre-build.
      return {
        argv0: "pnpm",
        argv: ["run", "dev"],
        kind,
        artifactDirs: [],
        isProdStart: false,
      };
    }
    if (scripts.start) {
      // Production start — needs a prior build. Build artifacts by stack so we
      // can detect "not built". `pnpm run build` only when a build script exists.
      const artifactDirs = deps["next"] ? [".next"] : deps["vite"] ? ["dist"] : ["dist", "build"];
      const build = scripts.build ? { argv0: "pnpm", argv: ["run", "build"] } : undefined;
      return {
        argv0: "pnpm",
        argv: ["run", "start"],
        kind,
        build,
        artifactDirs,
        isProdStart: true,
      };
    }
    // package.json exists but has neither dev nor start — fall through to
    // the safe default.
  } catch {
    // No package.json (or unreadable); continue probing other stacks.
  }

  // pyproject.toml — distinguish FastAPI/uvicorn vs. plain main.py.
  const pyProjectPath = path.join(workspacePath, "pyproject.toml");
  try {
    const raw = await fs.readFile(pyProjectPath, "utf8");
    // Lightweight TOML probe — full parser is overkill. We're just looking
    // for fastapi/uvicorn mentions OR a [project.scripts] section.
    const lower = raw.toLowerCase();
    const looksFastapi = lower.includes("fastapi") || lower.includes("uvicorn");
    if (looksFastapi) {
      return {
        argv0: "uv",
        argv: ["run", "uvicorn", "main:app", "--reload"],
        kind: "fastapi",
      };
    }
    // pyproject.toml present without FastAPI — assume an entrypoint.
    const mainPyExists = await fileExists(path.join(workspacePath, "main.py"));
    if (mainPyExists) {
      return { argv0: "python", argv: ["main.py"], kind: "python" };
    }
  } catch {
    // No pyproject.toml; continue.
  }

  // Cargo.toml — Rust.
  const cargoPath = path.join(workspacePath, "Cargo.toml");
  if (await fileExists(cargoPath)) {
    return { argv0: "cargo", argv: ["run"], kind: "cargo" };
  }

  // go.mod — Go.
  const goModPath = path.join(workspacePath, "go.mod");
  if (await fileExists(goModPath)) {
    return { argv0: "go", argv: ["run", "."], kind: "go" };
  }

  // Nothing matched — fall back to pnpm dev (most common scaffolder output).
  return { argv0: "pnpm", argv: ["run", "dev"], kind: "unknown" };
}

/**
 * Probe upward from `startFrom` for the first port that binds on 127.0.0.1.
 * Skips well-known ports (3000, 8288, 8000, 8080, 5432, 6379, 9229) so we
 * never clobber the DevPilot web app or other infra. Throws after 200 attempts.
 */
export async function findFreePort(startFrom: number = PORT_PROBE_DEFAULT_START): Promise<number> {
  for (let offset = 0; offset < DEFAULT_PORT_PROBE_HORIZON; offset++) {
    const candidate = startFrom + offset;
    if (WELL_KNOWN_PORTS.has(candidate)) continue;
    if (await isPortFree(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `findFreePort: no free port in [${startFrom}, ${startFrom + DEFAULT_PORT_PROBE_HORIZON})`,
  );
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Two-step probe.
    //
    // 1. Connect to 127.0.0.1:port. If anything accepts, the port is busy.
    //    Cheap and unambiguous: tests the actual symptom (can someone reach
    //    the port) rather than relying on Node's bind-conflict heuristics.
    //
    // 2. If the connect was refused, also try to bind on the IPv6 wildcard
    //    (`server.listen(port)` defaults to '::' on dual-stack systems).
    //    This catches IPv6-wildcard listeners that wouldn't have answered
    //    an IPv4 connect — e.g. a Next dev server bound to '::' alongside
    //    a stale TIME_WAIT slot blocking incoming connects.
    //
    // Pre-fix the probe bound on '127.0.0.1' only, which let `*:port`
    // IPv6 listeners (Next.js's default) slip through as "free" and caused
    // a downstream EADDRINUSE when the actual server tried to bind.

    const probe = createConnection({ host: "127.0.0.1", port, timeout: 300 });
    let connectSettled = false;
    const connectDone = (busy: boolean) => {
      if (connectSettled) return;
      connectSettled = true;
      try {
        probe.destroy();
      } catch {
        /* ignore */
      }
      if (busy) {
        resolve(false);
        return;
      }
      // Connect refused / timed out — try to bind on the dual-stack wildcard.
      const server = createServer();
      let bindSettled = false;
      const bindDone = (free: boolean) => {
        if (bindSettled) return;
        bindSettled = true;
        try {
          server.close();
        } catch {
          /* ignore */
        }
        resolve(free);
      };
      server.once("error", () => bindDone(false));
      server.once("listening", () => bindDone(true));
      try {
        // No host arg → '::' on IPv6-capable hosts (dual-stack). Conflicts
        // with both IPv4 and IPv6 listeners on the same port.
        server.listen(port);
      } catch {
        bindDone(false);
      }
    };
    probe.once("connect", () => connectDone(true));
    probe.once("error", () => connectDone(false));
    probe.once("timeout", () => connectDone(false));
  });
}

export type StartedDevServer = {
  sessionId: string;
  pid: number;
  port: number;
  url: string;
  kind: string;
};

/**
 * Spawn the dev command in `workspacePath` on a free port. Captures
 * stdout/stderr into a per-session ring buffer; the live stream is also
 * forwarded to the optional `onLog` callback. Tracks the child in the
 * module-local Map so `killDevServer`/`killAllDevServers` can find it.
 *
 * The child is spawned in its own POSIX process group (`detached: true`),
 * so `killProcessGroup` can deliver signals to every descendant including
 * the grand-child `next-server` / `vite` that would otherwise detach and
 * keep the port. The runner's own SIGTERM hook still calls
 * `killAllDevServers` for the graceful TERM→KILL window.
 */
export async function startDevServer(opts: {
  sessionId: string;
  workspacePath: string;
  command?: { argv0: string; argv: string[] };
  portHint?: number;
  envOverrides?: Record<string, string>;
  /** "Skip & start anyway" — bypass the required-env gate (operator chose to
   *  preview even with required vars missing). */
  skipEnvCheck?: boolean;
  onLog?: (chunk: string) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  /** Fires when startup enters a long-running substage so the caller can
   *  re-heartbeat with a more accurate `statusReason`. `"installing-deps"`,
   *  `"cloning-repo"`, and `"building"` fire today; new stages can be added
   *  without changing the call sites that don't care. */
  onStage?: (stage: "installing-deps" | "cloning-repo" | "building") => void;
  /** Fires once per start with the full set of env keys the project declares
   *  in `.env.example` (required/optional + description). The loop forwards
   *  this to the engine so the project Secrets card can render every declared
   *  key. Independent of the required-env gate below — reported even when all
   *  vars are satisfied. */
  onEnvCatalog?: (catalog: EnvCatalogEntry[]) => void;
  /** Recovery: when the workspace dir doesn't exist (cleaned up between
   *  the original prep run and this Run-on-localhost click) and a
   *  `prepareIfMissing` block is provided, clone the repo into the
   *  workspace path before spawning. Public repos can omit `githubToken`;
   *  private repos must supply one or the clone will be denied. The
   *  injected token is rewritten into the origin URL after clone so
   *  subsequent fetches/pushes don't need it re-supplied. */
  prepareIfMissing?: {
    repoUrl: string;
    branch: string;
    githubToken?: string;
  };
}): Promise<StartedDevServer> {
  // 0. Workspace pre-check. spawn() with a missing cwd returns a child
  //    with no pid + emits 'error' asynchronously — the symptom is the
  //    cryptic "spawn(pnpm) did not return a pid". Detect up front and
  //    either recover (clone) or fail with a human-readable error.
  ensureBuffer(opts.sessionId);
  const workspaceExists = await dirExists(opts.workspacePath);
  if (!workspaceExists) {
    if (!opts.prepareIfMissing) {
      throw new Error(
        `Workspace directory missing at ${opts.workspacePath}. ` +
          "The on-disk workspace was cleaned up; ask the engine to re-prepare it or file a fresh ticket against this project.",
      );
    }
    await cloneWorkspace({
      sessionId: opts.sessionId,
      workspacePath: opts.workspacePath,
      repoUrl: opts.prepareIfMissing.repoUrl,
      branch: opts.prepareIfMissing.branch,
      githubToken: opts.prepareIfMissing.githubToken,
      onLog: opts.onLog,
      onStage: opts.onStage,
    });
  }
  // 0.5 Allocate the port up front. We used to do this just before spawn, but
  //     the auto-fill below (Step 0.7) needs to know the port so it can write
  //     `http://localhost:${port}` for self-referencing URL vars before the
  //     required-env gate runs. Allocating early is otherwise inert: the port
  //     is only bound when the child spawns, and findFreePort always probes a
  //     fresh one on the next start, so a gate-throw doesn't leak the port.
  const port = await findFreePort(opts.portHint ?? PORT_PROBE_DEFAULT_START);

  // 0.6 Parse the declared env catalog (.env.example) ONCE, report it to the
  //     engine (so the Secrets card can show every declared key + its
  //     required/optional label + description), then gate on the missing
  //     REQUIRED subset.
  //
  //     Required-env gate: park the session in `needs_env` (via NeedsEnvError)
  //     ONLY when a REQUIRED env var is missing — optional vars (marked
  //     `optional` in .env.example) never block a start. When we do park, we
  //     still surface the optional missing vars so the operator can fill them
  //     if they want; the UI lets them skip those. Optional keys are encoded
  //     with a trailing `?` for the UI (secret keys are UPPER_SNAKE, never `?`).
  //     "Skip & start anyway" bypasses the gate but still reports the catalog.
  const envCatalog = await parseEnvCatalog(opts.workspacePath);
  if (envCatalog.length > 0 && opts.onEnvCatalog) {
    try {
      opts.onEnvCatalog(envCatalog);
    } catch {
      // never let catalog reporting break a start
    }
  }

  // 0.7 Localhost auto-fill. For vars whose example value is obviously a
  //     localhost default (postgres://localhost:5432/…, NEXT_PUBLIC_BASE_URL,
  //     etc.), fill them in before the gate so the operator isn't prompted
  //     to retype the example. Auto-fills are start-time only; we do NOT
  //     persist them to the project secrets vault (the runtime port can
  //     differ across starts). See {@link computeEnvAutofills}.
  const baseEnv: Record<string, string | undefined> = {
    ...process.env,
    ...(opts.envOverrides ?? {}),
    PORT: String(port),
  };
  const autoFills = envCatalog.length > 0 ? computeEnvAutofills(envCatalog, port, baseEnv) : {};
  const autoFillKeys = Object.keys(autoFills);
  if (autoFillKeys.length > 0) {
    const msg = `[dev-server] auto-filled ${autoFillKeys.length} env var(s) from localhost defaults: ${autoFillKeys.join(", ")}\n`;
    appendToBuffer(opts.sessionId, msg);
    if (opts.onLog) {
      try {
        opts.onLog(msg);
      } catch {
        // never let log emit break a start
      }
    }
  }

  if (!opts.skipEnvCheck && envCatalog.length > 0) {
    const merged: Record<string, string | undefined> = {
      ...baseEnv,
      ...autoFills,
    };
    const missing = envCatalog.filter((e) => {
      const v = merged[e.key];
      return v === undefined || v === "";
    });
    if (missing.some((m) => m.required)) {
      throw new NeedsEnvError(missing.map((m) => (m.required ? m.key : `${m.key}?`)));
    }
  }

  // 1. Resolve command. Workspace has already been verified (or freshly
  //    cloned) above, so detectStack will see a real package.json/etc.
  let argv0: string;
  let argv: string[];
  let kind: string;
  if (opts.command && opts.command.argv0) {
    argv0 = opts.command.argv0;
    argv = opts.command.argv ?? [];
    // Best-effort label: re-detect just for the `kind` field so the UI can
    // still show "Next" / "Vite" badges when the operator override the cmd.
    try {
      const detected = await detectStack(opts.workspacePath);
      kind = detected.kind;
    } catch {
      kind = "unknown";
    }
  } else {
    const detected = await detectStack(opts.workspacePath);
    argv0 = detected.argv0;
    argv = detected.argv;
    kind = detected.kind;
  }

  // 1.5 Auto-install Node deps if package.json is present but node_modules is
  //     missing. Pipes install output into the same ring buffer so the UI's
  //     "starting" log tail shows progress. Cargo/Go/uv handle their own deps
  //     on first run, so we only probe for Node here. Throws on non-zero exit
  //     — startDevServer's caller (the loop) converts that into an `errored`
  //     heartbeat with the failure reason.
  // ensureBuffer already called at workspace pre-check above.
  await ensureNodeDepsInstalled({
    workspacePath: opts.workspacePath,
    sessionId: opts.sessionId,
    onLog: opts.onLog,
    onStage: opts.onStage,
  });

  // 1.6 Build the project if needed (prod `start`, or build artifacts missing).
  //     Dev commands compile on the fly → skipped (detectStack returns no
  //     build command for them). detectStack re-reads package.json (cheap) so
  //     we have the full build info even when the run command was overridden.
  const buildInfo = await detectStack(opts.workspacePath).catch(() => null);
  if (buildInfo) {
    await buildIfNeeded({
      workspacePath: opts.workspacePath,
      sessionId: opts.sessionId,
      detected: buildInfo,
      onLog: opts.onLog,
      onStage: opts.onStage,
    });
  }

  // 2. Spawn the child. We layer envOverrides on top of process.env so the
  //    child inherits PATH/HOME — required for `pnpm`, `uv`, `cargo`, `go`
  //    to find their toolchains. Order:
  //      process.env → autoFills → envOverrides → PORT
  //    autoFills fill gaps process.env didn't cover; envOverrides (the
  //    operator's project secrets vault) always wins over both. PORT is
  //    appended last so callers can't accidentally override the port we just
  //    allocated up at Step 0.5.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...autoFills,
    ...(opts.envOverrides ?? {}),
    PORT: String(port),
  };

  const child = spawn(argv0, argv, {
    cwd: opts.workspacePath,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    // detached:true on POSIX → child gets its own process group (setsid).
    // We deliberately do NOT call child.unref() — the runner still awaits
    // the child for exit-code reporting via the `exit`/`error` handlers
    // below. The detach is only used so we can kill(-pgid, signal) and
    // catch grand-children like next-server in the same sweep.
    detached: process.platform !== "win32",
  });

  // 4. Hook stdout/stderr into the per-session ring buffer + onLog.
  ensureBuffer(opts.sessionId);
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    appendToBuffer(opts.sessionId, chunk);
    if (opts.onLog) {
      try {
        opts.onLog(chunk);
      } catch {
        // never let a logger throw kill the loop
      }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    appendToBuffer(opts.sessionId, chunk);
    if (opts.onLog) {
      try {
        opts.onLog(chunk);
      } catch {
        // ignore
      }
    }
  });

  // 5. Exit hook. We swallow callback exceptions; the loop is responsible
  //    for posting the terminal heartbeat.
  child.on("exit", (code, signal) => {
    TRACKED.delete(opts.sessionId);
    if (opts.onExit) {
      try {
        opts.onExit(code, signal);
      } catch {
        // ignore
      }
    }
  });

  // Spawn errors (binary not found, cwd missing, etc.) — surface as an exit
  // with code null + a synthetic log line so the operator sees the reason.
  child.on("error", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    appendToBuffer(opts.sessionId, `[devpilot-runner] dev-server spawn error: ${msg}\n`);
    TRACKED.delete(opts.sessionId);
    if (opts.onExit) {
      try {
        opts.onExit(null, null);
      } catch {
        // ignore
      }
    }
  });

  if (child.pid == null) {
    // spawn returned without a pid — extremely rare; treat as immediate
    // failure so the caller doesn't get a phantom session.
    throw new Error(
      `startDevServer: spawn(${argv0}) did not return a pid (workspace=${opts.workspacePath})`,
    );
  }

  TRACKED.set(opts.sessionId, child);

  return {
    sessionId: opts.sessionId,
    pid: child.pid,
    port,
    url: `http://localhost:${port}`,
    kind,
  };
}

// Module-local registry of live children. Only accessible via the kill
// functions and snapshotLogTail.
const TRACKED: Map<string, ChildProcess> = new Map();

/**
 * Send `signal` to the entire process group led by `pid`. On POSIX this is
 * `kill(-pid, signal)` — required because dev-server children spawn detached
 * grandchildren (`next-server`, `vite`, etc.) that don't get the signal when
 * only the immediate child is targeted. If the negative-pid call fails
 * (typically because the child wasn't spawned with `detached: true` and so
 * isn't a group leader, or the group is already gone), fall back to a
 * single-pid kill so we at least try to stop the tracked process.
 *
 * Windows lacks POSIX process groups; fall straight through to single-pid.
 *
 * ESRCH ("no such process") is swallowed everywhere — the kill is best-effort
 * and the caller already polls the child's `exit` event for liveness.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      process.kill(pid, signal);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw err;
    }
    return;
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM => not a group leader (orphan spawned pre-fix, or detach failed).
    // ESRCH => group is already gone.
    // Either way, try the single-pid path so we at least signal the tracked pid.
    if (code === "EPERM" || code === "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch (err2) {
        const code2 = (err2 as NodeJS.ErrnoException).code;
        if (code2 !== "ESRCH") throw err2;
      }
      return;
    }
    throw err;
  }
}

/**
 * SIGTERM the child + grace window (default 5000ms). If still alive after
 * grace, SIGKILL. Signals are delivered to the child's whole process group
 * (see `killProcessGroup`) so grand-children like `next-server` and `vite`
 * don't survive as orphans bound to the port. Always removes from TRACKED.
 */
export async function killDevServer(
  sessionId: string,
  opts?: { graceMs?: number },
): Promise<{ killed: boolean; pid?: number }> {
  const child = TRACKED.get(sessionId);
  if (!child) return { killed: false };
  const pid = child.pid ?? undefined;
  const graceMs = opts?.graceMs ?? DEFAULT_KILL_GRACE_MS;

  // Promise that resolves when the child actually exits.
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.once("close", () => resolve());
  });

  if (typeof pid === "number" && pid > 0) {
    try {
      killProcessGroup(pid, "SIGTERM");
    } catch {
      // best-effort; the exit watcher below decides whether SIGKILL is needed
    }
  } else {
    // No pid (very rare — spawn returned without one). Fall back to the
    // ChildProcess API; still better than doing nothing.
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  const settled = await Promise.race([
    exited.then(() => "exited" as const),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs)),
  ]);

  if (settled === "timeout") {
    if (typeof pid === "number" && pid > 0) {
      try {
        killProcessGroup(pid, "SIGKILL");
      } catch {
        // ignore
      }
    } else {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    // give the OS a moment to register the kill
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 1_000))]);
  }

  TRACKED.delete(sessionId);
  return { killed: true, pid };
}

/**
 * Iterate TRACKED, kill each in parallel. Used by index.ts on SIGTERM.
 */
export async function killAllDevServers(opts?: { graceMs?: number }): Promise<void> {
  const sessionIds = Array.from(TRACKED.keys());
  if (sessionIds.length === 0) return;
  await Promise.all(sessionIds.map((id) => killDevServer(id, opts).catch(() => undefined)));
}

// ---- Ring buffer ----------------------------------------------------------

// Per-session ring buffer. We store chunks in order; total bytes capped at
// RING_BUFFER_BYTES. On overflow we drop the head (oldest) chunks until the
// total fits.
type RingBuffer = {
  chunks: string[];
  bytes: number;
};
const LOG_BUFFERS: Map<string, RingBuffer> = new Map();

function ensureBuffer(sessionId: string): RingBuffer {
  let buf = LOG_BUFFERS.get(sessionId);
  if (!buf) {
    buf = { chunks: [], bytes: 0 };
    LOG_BUFFERS.set(sessionId, buf);
  }
  return buf;
}

function appendToBuffer(sessionId: string, chunk: string): void {
  if (chunk.length === 0) return;
  const buf = ensureBuffer(sessionId);
  // If a single chunk is larger than the buffer, keep only its tail.
  if (chunk.length >= RING_BUFFER_BYTES) {
    buf.chunks = [chunk.slice(chunk.length - RING_BUFFER_BYTES)];
    buf.bytes = buf.chunks[0]!.length;
    return;
  }
  buf.chunks.push(chunk);
  buf.bytes += chunk.length;
  // Drop oldest chunks until we fit.
  while (buf.bytes > RING_BUFFER_BYTES && buf.chunks.length > 1) {
    const dropped = buf.chunks.shift()!;
    buf.bytes -= dropped.length;
  }
  // If a single remaining chunk still overflows (chunk == buffer), trim it.
  if (buf.bytes > RING_BUFFER_BYTES && buf.chunks.length === 1) {
    const only = buf.chunks[0]!;
    const trimmed = only.slice(only.length - RING_BUFFER_BYTES);
    buf.chunks = [trimmed];
    buf.bytes = trimmed.length;
  }
}

/**
 * Returns the current tail buffer for a session, capped at `maxBytes`. The
 * default 8 KiB matches the ring buffer size. Returns "" if the session is
 * unknown.
 */
export function snapshotLogTail(sessionId: string, maxBytes: number = RING_BUFFER_BYTES): string {
  const buf = LOG_BUFFERS.get(sessionId);
  if (!buf) return "";
  const full = buf.chunks.join("");
  if (full.length <= maxBytes) return full;
  return full.slice(full.length - maxBytes);
}

// ---- Auto-install --------------------------------------------------------

/**
 * If the workspace has `package.json` but no `node_modules`, run an install
 * before the dev command. Lockfile presence picks the package manager
 * (pnpm > yarn > npm > bun), falling back to pnpm when none are present —
 * DevPilot's scaffolder is a pnpm shop. Output is piped into the per-session ring
 * buffer so the UI's "starting" log tail shows the install progress, and the
 * install child is tracked under the same session id so a Stop click during
 * install kills it. On non-zero exit (or spawn failure) this throws; the
 * loop's catch block translates that into an `errored` heartbeat with the
 * exit reason.
 *
 * Non-Node stacks (uv, cargo, go) install their own deps lazily on first
 * run, so we deliberately skip them here rather than try to special-case
 * every toolchain.
 */
async function ensureNodeDepsInstalled(args: {
  workspacePath: string;
  sessionId: string;
  onLog?: (chunk: string) => void;
  onStage?: (stage: "installing-deps") => void;
}): Promise<void> {
  const pkgPath = path.join(args.workspacePath, "package.json");
  if (!(await fileExists(pkgPath))) return;
  const nodeModulesPath = path.join(args.workspacePath, "node_modules");
  const haveNodeModules = await dirExists(nodeModulesPath);
  // Reinstall not only when node_modules is absent, but also when the manifest
  // changed since the last install — an agent (or a branch refresh / `git pull`)
  // may have added a dependency the stale tree is missing. Without this, the dev
  // server boots against an out-of-date node_modules and the project 500s with
  // "Module not found" for the new package (e.g. next-themes added on `dev`).
  if (haveNodeModules && !(await depsAreStale(args.workspacePath))) return;

  const installCmd = await pickInstallCommand(args.workspacePath);
  appendToBuffer(
    args.sessionId,
    `[devpilot-runner] ${haveNodeModules ? "dependencies changed" : "node_modules missing"} — running ${installCmd.argv0} ${installCmd.argv.join(" ")}\n`,
  );
  args.onStage?.("installing-deps");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(installCmd.argv0, installCmd.argv, {
      cwd: args.workspacePath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      // See spawn-of-dev-server above. Install also forks subprocesses
      // (lifecycle scripts, native-build node-gyp, etc.) we want killable
      // as a group if the operator clicks Stop mid-install.
      detached: process.platform !== "win32",
    });

    // Track the install child under the session id so a Stop click during
    // install kills it via killDevServer. Untracked on exit; the subsequent
    // dev-server spawn re-tracks under the same key.
    TRACKED.set(args.sessionId, child);

    const forward = (chunk: string) => {
      appendToBuffer(args.sessionId, chunk);
      if (args.onLog) {
        try {
          args.onLog(chunk);
        } catch {
          // never let a logger throw kill the install
        }
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", forward);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", forward);

    child.on("error", (err) => {
      TRACKED.delete(args.sessionId);
      const msg = err instanceof Error ? err.message : String(err);
      appendToBuffer(args.sessionId, `[devpilot-runner] install spawn error: ${msg}\n`);
      reject(new Error(`install spawn failed: ${msg}`));
    });
    child.on("exit", (code, signal) => {
      TRACKED.delete(args.sessionId);
      if (code === 0) {
        appendToBuffer(args.sessionId, `[devpilot-runner] install complete\n`);
        resolve();
        return;
      }
      const reason = signal ? `signal:${signal}` : `exit:${code ?? "unknown"}`;
      reject(new Error(`${installCmd.argv0} install failed (${reason})`));
    });
  });
}

/**
 * Decide whether an existing `node_modules` is stale relative to the manifest.
 * Returns true when `package.json` or a lockfile has a newer mtime than the
 * package manager's install marker (pnpm's `.modules.yaml`, npm's
 * `.package-lock.json`, …) — i.e. dependencies changed since the last install.
 *
 * Why mtime and not a content hash: a git checkout / `pull` only bumps the
 * mtime of files that actually changed, so "manifest newer than marker" is a
 * precise deps-changed signal, and the common nothing-changed case stays a
 * couple of cheap stats with no reinstall. A 1s skew tolerance absorbs a fresh
 * clone that stamps every file in the same second. Best-effort: if no marker is
 * found at all we reinstall (safe); a missing manifest reads as not-stale.
 */
async function depsAreStale(workspacePath: string): Promise<boolean> {
  const mtimeMs = async (rel: string): Promise<number | null> => {
    try {
      return (await fs.stat(path.join(workspacePath, rel))).mtimeMs;
    } catch {
      return null;
    }
  };
  const newest = (xs: Array<number | null>): number =>
    xs.reduce<number>((m, t) => (t !== null && t > m ? t : m), 0);

  // "Deps changed" signal: the manifest or any lockfile.
  const manifest = newest(
    await Promise.all([
      mtimeMs("package.json"),
      mtimeMs("pnpm-lock.yaml"),
      mtimeMs("package-lock.json"),
      mtimeMs("yarn.lock"),
      mtimeMs("bun.lockb"),
    ]),
  );
  if (manifest === 0) return false; // no manifest to compare against

  // "Last install" marker each package manager rewrites on a completed install,
  // falling back to the node_modules dir's own mtime.
  const marker = newest(
    await Promise.all([
      mtimeMs("node_modules/.modules.yaml"), // pnpm
      mtimeMs("node_modules/.package-lock.json"), // npm
      mtimeMs("node_modules/.yarn-state.yml"), // yarn (node-modules linker)
      mtimeMs("node_modules"),
    ]),
  );
  if (marker === 0) return true; // node_modules present but no marker → reinstall

  return manifest > marker + 1000;
}

// ---- Build (when needed) -------------------------------------------------

/**
 * Build the project before serving, but ONLY when needed: a production `start`
 * command (which requires a prior build — artifacts may be stale) OR a build
 * command exists and none of the stack's artifact dirs are present on disk.
 * Dev commands (which compile on the fly) never reach here — detectStack
 * returns `build: undefined` for them. Mirrors ensureNodeDepsInstalled: streams
 * output to the ring buffer + onLog, tracked under the session so a Stop click
 * mid-build kills it, throws on non-zero exit (→ the loop reports `errored`).
 */
async function buildIfNeeded(args: {
  workspacePath: string;
  sessionId: string;
  detected: StackDetectResult;
  onLog?: (chunk: string) => void;
  onStage?: (stage: "building") => void;
}): Promise<void> {
  const build = args.detected.build;
  if (!build) return; // nothing we can build
  const artifactDirs = args.detected.artifactDirs ?? [];
  const artifactsMissing =
    artifactDirs.length > 0 && !(await anyDirExists(args.workspacePath, artifactDirs));
  if (args.detected.isProdStart !== true && !artifactsMissing) return;

  appendToBuffer(
    args.sessionId,
    `[devpilot-runner] building — running ${build.argv0} ${build.argv.join(" ")}\n`,
  );
  args.onStage?.("building");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(build.argv0, build.argv, {
      cwd: args.workspacePath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    TRACKED.set(args.sessionId, child);
    const forward = (chunk: string) => {
      appendToBuffer(args.sessionId, chunk);
      if (args.onLog) {
        try {
          args.onLog(chunk);
        } catch {
          // never let a logger throw kill the build
        }
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", forward);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", forward);
    child.on("error", (err) => {
      TRACKED.delete(args.sessionId);
      const msg = err instanceof Error ? err.message : String(err);
      appendToBuffer(args.sessionId, `[devpilot-runner] build spawn error: ${msg}\n`);
      reject(new Error(`build spawn failed: ${msg}`));
    });
    child.on("exit", (code, signal) => {
      TRACKED.delete(args.sessionId);
      if (code === 0) {
        appendToBuffer(args.sessionId, `[devpilot-runner] build complete\n`);
        resolve();
        return;
      }
      const reason = signal ? `signal:${signal}` : `exit:${code ?? "unknown"}`;
      reject(new Error(`build failed (${reason})`));
    });
  });
}

async function anyDirExists(workspacePath: string, dirs: string[]): Promise<boolean> {
  for (const d of dirs) {
    if (await dirExists(path.join(workspacePath, d))) return true;
  }
  return false;
}

// ---- Required-env detection ----------------------------------------------

/** Thrown by startDevServer when the workspace's `.env.example` lists required
 *  keys not satisfied by the merged env. The loop catches it and parks the
 *  session in `needs_env` (no spawn) carrying the missing keys for the UI. */
export class NeedsEnvError extends Error {
  constructor(public readonly keys: string[]) {
    super(`missing required env vars: ${keys.join(", ")}`);
    this.name = "NeedsEnvError";
  }
}

const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template"];

export type MissingEnvVar = {
  key: string;
  /** A var is OPTIONAL only when its `.env.example` line (or the comment block
   *  immediately above it) contains the word "optional"; everything else is
   *  REQUIRED. Value presence is NOT a signal — placeholders like
   *  `KEY=re_your_api_key_here` look like values but aren't real defaults. */
  required: boolean;
};

/** A single declared env key from `.env.example`, with the human-readable
 *  description scraped from the comment block immediately above it (or a
 *  trailing same-line comment). Reported to the engine so the Secrets card can
 *  render the project's full "bring your own keys" catalog. */
export type EnvCatalogEntry = {
  key: string;
  required: boolean;
  description: string | null;
  /** The raw value declared on the right of `=` in `.env.example`, with any
   *  trailing `# comment` stripped, outer quotes removed, whitespace trimmed.
   *  Empty string when the example has `KEY=` with nothing after `=`. Used by
   *  {@link computeEnvAutofills} to auto-fill obvious localhost defaults
   *  (NEXT_PUBLIC_BASE_URL, postgres://localhost:5432/…, etc.) so the runner
   *  doesn't gate on a `needs_env` prompt the operator would just paste the
   *  example into. Not persisted to the project catalog — purely a hint for
   *  start-time defaulting. */
  exampleValue: string;
};

const ENV_DESCRIPTION_MAX = 200;

/**
 * Parse the workspace's `.env.example` (or .sample/.template) into the full
 * catalog of DECLARED env keys — each classified required/optional and carrying
 * the description scraped from the comment block immediately above it (falling
 * back to a trailing same-line comment). Comment/blank lines never register as
 * keys. First declaration of a key wins (dedup). Returns [] when no example
 * file exists.
 *
 * "Optional" is detected case-insensitively in the key's comment context;
 * everything else is REQUIRED (placeholder values like `KEY=changeme` are NOT
 * treated as satisfied — only the comment classifies).
 */
export async function parseEnvCatalog(workspacePath: string): Promise<EnvCatalogEntry[]> {
  let raw: string | null = null;
  for (const f of ENV_EXAMPLE_FILES) {
    raw = await fs.readFile(path.join(workspacePath, f), "utf8").catch(() => null);
    if (raw != null) break;
  }
  if (raw == null) return [];

  const out: EnvCatalogEntry[] = [];
  const seen = new Set<string>();
  let commentBuf: string[] = []; // contiguous comment lines above a key (original case)
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trimStart();
    if (t.length === 0) {
      commentBuf = [];
      continue;
    }
    if (t.startsWith("#")) {
      const cleaned = t.replace(/^#+\s?/, "").trim();
      if (cleaned.length > 0) commentBuf.push(cleaned);
      continue;
    }
    const m = /^([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(t);
    if (m && m[1] && !seen.has(m[1])) {
      seen.add(m[1]);
      const rest = m[2] ?? "";
      const hashIdx = rest.indexOf("#");
      const trailing = hashIdx >= 0 ? rest.slice(hashIdx + 1).trim() : "";
      const valuePart = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
      const exampleValue = valuePart.trim().replace(/^["']|["']$/g, "");
      const ctx = (commentBuf.join(" ") + " " + trailing).toLowerCase();
      const descRaw = commentBuf.length > 0 ? commentBuf.join(" ") : trailing;
      const description =
        descRaw.length === 0
          ? null
          : descRaw.length > ENV_DESCRIPTION_MAX
            ? descRaw.slice(0, ENV_DESCRIPTION_MAX - 1) + "…"
            : descRaw;
      out.push({
        key: m[1],
        required: !/\boptional\b/.test(ctx),
        description,
        exampleValue,
      });
    }
    commentBuf = [];
  }
  return out;
}

/**
 * The missing subset of {@link parseEnvCatalog}: declared keys NOT satisfied by
 * the merged env (process.env + the project secrets injected as envOverrides).
 * A key present but empty-string counts as missing. Returns [] when no example
 * file exists.
 */
export async function detectMissingEnv(args: {
  workspacePath: string;
  envOverrides?: Record<string, string>;
}): Promise<MissingEnvVar[]> {
  const catalog = await parseEnvCatalog(args.workspacePath);
  if (catalog.length === 0) return [];
  const merged: Record<string, string | undefined> = {
    ...process.env,
    ...(args.envOverrides ?? {}),
  };
  const missing: MissingEnvVar[] = [];
  for (const d of catalog) {
    const v = merged[d.key];
    if (v === undefined || v === "") missing.push({ key: d.key, required: d.required });
  }
  return missing;
}

// ---- Localhost auto-fill --------------------------------------------------
//
// Operators kept hitting the `needs_env` gate for vars whose example value was
// already a localhost URL (`NEXT_PUBLIC_BASE_URL=http://localhost:3000`,
// `DATABASE_URL=postgres://localhost:5432/dev`, etc.). The honest answer for
// every one of those was "use the example value verbatim" — which is exactly
// what we do here, before the gate runs. Two rules:
//
//   1. Self-referencing URL keys (BASE_URL / APP_URL / SITE_URL / NEXTAUTH_URL
//      and their NEXT_PUBLIC_ variants) → `http://localhost:${port}`. The
//      runtime port supersedes whatever the example wrote because the dev
//      server allocates a fresh port each start (3100, 3101…) — pinning to the
//      example's 3000 would point the app at the wrong URL.
//   2. Any other key whose example value starts with a known scheme followed
//      by `localhost` → use the example value verbatim. Covers Postgres,
//      Redis, Mongo, MySQL, WebSockets, etc. on their standard local ports.
//
// Both rules SKIP when the key is already set in process.env or envOverrides —
// the operator's explicit secret always wins. Returned map is `key → value`
// for the keys we filled.

const SELF_REF_URL_RE = /(^|_)(BASE|APP|SITE|PUBLIC|SERVER|FRONTEND|AUTH|NEXTAUTH)_?URL$/;
// Matches scheme://[user[:pass]@](localhost|127.0.0.1)[:port][/?#…] — covers
// the common dev-service shapes: postgres://postgres:postgres@localhost:5432/db,
// redis://localhost:6379, mongodb://localhost:27017, http://localhost:3000/api.
const LOCALHOST_URL_RE =
  /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(?:localhost|127\.0\.0\.1)(:\d+)?(\/|$|\?|#)/i;

/**
 * Compute auto-fill values for the gaps in `baseEnv` per the rules above.
 * Returns only the keys we want to fill — keys already satisfied by baseEnv
 * are skipped so the operator's explicit setting always wins.
 */
export function computeEnvAutofills(
  catalog: EnvCatalogEntry[],
  port: number,
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of catalog) {
    const existing = baseEnv[entry.key];
    if (existing !== undefined && existing !== "") continue;
    const ex = entry.exampleValue;
    if (SELF_REF_URL_RE.test(entry.key)) {
      out[entry.key] = `http://localhost:${port}`;
      continue;
    }
    if (ex.length > 0 && LOCALHOST_URL_RE.test(ex)) {
      out[entry.key] = ex;
    }
  }
  return out;
}

/** Pick a Node package manager from lockfile presence. Falls back to pnpm. */
async function pickInstallCommand(
  workspacePath: string,
): Promise<{ argv0: string; argv: string[] }> {
  if (await fileExists(path.join(workspacePath, "pnpm-lock.yaml"))) {
    return { argv0: "pnpm", argv: ["install"] };
  }
  if (await fileExists(path.join(workspacePath, "yarn.lock"))) {
    return { argv0: "yarn", argv: ["install"] };
  }
  if (await fileExists(path.join(workspacePath, "package-lock.json"))) {
    return { argv0: "npm", argv: ["install"] };
  }
  if (await fileExists(path.join(workspacePath, "bun.lockb"))) {
    return { argv0: "bun", argv: ["install"] };
  }
  return { argv0: "pnpm", argv: ["install"] };
}

// ---- Helpers --------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// ---- Auto-clone (recovery path) ------------------------------------------

/**
 * Fresh-clone `repoUrl` into `workspacePath` and checkout `branch`. Used by
 * `startDevServer` when its `prepareIfMissing` opt is set and the workspace
 * dir doesn't exist (typical case: the ticket workspace was GC'd between
 * the original agent run and the operator's "Run on localhost" click).
 *
 * Token handling mirrors `prepareWorkspace` in `workspace.ts`:
 *   - Clone with the token embedded in the URL (`x-access-token:<token>@`)
 *     so private repos work
 *   - After clone, rewrite `origin` to embed the same token so subsequent
 *     fetch/push from the dev workspace also work — but we never log or
 *     leak the resulting URL
 *
 * If `branch` doesn't exist on the remote, fall back to whatever the
 * default branch is. Public-repo case: `githubToken` may be omitted.
 */
async function cloneWorkspace(args: {
  sessionId: string;
  workspacePath: string;
  repoUrl: string;
  branch: string;
  githubToken?: string;
  onLog?: (chunk: string) => void;
  onStage?: (stage: "installing-deps" | "cloning-repo") => void;
}): Promise<void> {
  args.onStage?.("cloning-repo");
  // Don't log the tokenized URL — log only the origin form.
  appendToBuffer(
    args.sessionId,
    `[devpilot-runner] cloning ${args.repoUrl} into ${args.workspacePath}\n`,
  );

  // Ensure the parent dir exists; clean any stale leaf so git clone doesn't
  // refuse on "destination path already exists and is not empty".
  await fs.mkdir(path.dirname(args.workspacePath), { recursive: true });
  if (await pathExists(args.workspacePath)) {
    await fs.rm(args.workspacePath, { recursive: true, force: true });
  }

  // Build the auth'd URL when a token is available. The runner accepts the
  // public-repo case without one.
  const cloneUrl = (() => {
    if (!args.githubToken) return args.repoUrl;
    if (!args.repoUrl.startsWith("https://")) return args.repoUrl;
    try {
      const u = new URL(args.repoUrl);
      u.username = "x-access-token";
      u.password = args.githubToken;
      return u.toString();
    } catch {
      return args.repoUrl;
    }
  })();

  try {
    await runGit(path.dirname(args.workspacePath), ["clone", "--", cloneUrl, args.workspacePath]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Strip any token that leaked into the error from git's own output.
    const safeMsg = args.githubToken ? msg.split(args.githubToken).join("<token>") : msg;
    appendToBuffer(args.sessionId, `[devpilot-runner] clone failed: ${safeMsg}\n`);
    throw new Error(`git clone failed: ${safeMsg}`);
  }

  // Rewrite origin to embed the token for subsequent fetches/pushes. Skip
  // for public repos (no token).
  if (args.githubToken && args.repoUrl.startsWith("https://")) {
    const u = new URL(args.repoUrl);
    u.username = "x-access-token";
    u.password = args.githubToken;
    await runGit(args.workspacePath, ["remote", "set-url", "origin", u.toString()]);
  }

  // Try to checkout the requested branch. If it doesn't exist on the
  // remote we'll already have HEAD on the default branch from clone, so
  // log + carry on rather than erroring (the dev server only needs *some*
  // working tree to spawn).
  const switched = await tryGit(args.workspacePath, ["checkout", args.branch]);
  if (!switched) {
    appendToBuffer(
      args.sessionId,
      `[devpilot-runner] branch '${args.branch}' not found on remote — staying on default\n`,
    );
  }
  appendToBuffer(args.sessionId, `[devpilot-runner] clone complete\n`);
}

async function runGit(cwd: string, gitArgs: string[]): Promise<void> {
  // 60s timeout caps a hung clone (auth prompt, slow network). The
  // dev-server-loop's outer timeouts catch the rest.
  await execFileP("git", gitArgs, { cwd, timeout: 60_000 });
}

async function tryGit(cwd: string, gitArgs: string[]): Promise<boolean> {
  try {
    await runGit(cwd, gitArgs);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
