// Shared IO for `setup-local.mjs` and `dev-local.mjs` — processes, sockets
// and files. Every DECISION lives in `../lib/dev/*.ts` (pure, unit-tested);
// this file only carries them out. Import it like `_legacy-env.mjs`:
// a leading underscore marks a helper, not an entry point.
//
// Runs under `node --import tsx` so the `.ts` modules resolve; imports must be
// RELATIVE (`@/` does not resolve under bare tsx — the dev-inngest.mjs rule).

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyClaudeAuth,
  classifySupabaseContainer,
  decideSupabaseBringUp,
  isPong,
  parseSupabaseStatus,
} from "../lib/dev/local-stack.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = resolve(HERE, "..");
export const REPO_DIR = resolve(WEB_DIR, "../..");
export const RUNNER_DIR = join(REPO_DIR, "apps", "runner");
export const ENV_PATH = join(WEB_DIR, ".env.local");
export const ENV_TEMPLATE_PATH = join(REPO_DIR, ".env.example");
export const COMPOSE_FILE = join(REPO_DIR, "infra", "local", "docker-compose.yml");

// ── Logging ──────────────────────────────────────────────────────────────────

export function makeLog(prefix) {
  const tag = `[${prefix}]`;
  return {
    info: (msg) => process.stdout.write(`${tag} ${msg}\n`),
    warn: (msg) => process.stderr.write(`${tag} WARNING: ${msg}\n`),
    /** Print and exit 1. Never returns. */
    fatal: (msg) => {
      process.stderr.write(`${tag} ${msg}\n`);
      process.exit(1);
    },
  };
}

// ── Flags ────────────────────────────────────────────────────────────────────

/** `--flag`, `--key value` and `--key=value`. Unknown flags are reported by the
 *  caller; this just collects. */
export function parseArgs(argv, { valued = [] } = {}) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (valued.includes(name)) {
      values[name] = eq === -1 ? (argv[++i] ?? "") : a.slice(eq + 1);
    } else {
      flags.add(name);
    }
  }
  return { flags, values };
}

// ── Processes ────────────────────────────────────────────────────────────────

/** Run to completion, capture output. `error` is set when the binary is missing. */
export function runCapture(cmd, args, { cwd = REPO_DIR } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: process.env });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

/** Run with the terminal attached (progress visible, Ctrl-C reaches it). stdin
 *  is `ignore` by default: `supabase start` asks "overwrite bucket? [Y/n]" on
 *  a re-run and takes the default when stdin is not a TTY, which is what a
 *  non-interactive bootstrap wants. Resolves with the exit code. */
export function runInherit(cmd, args, { cwd = REPO_DIR, stdin = "ignore" } = {}) {
  return new Promise((resolveExit) => {
    const child = spawn(cmd, args, { cwd, stdio: [stdin, "inherit", "inherit"], env: process.env });
    child.on("error", () => resolveExit(127));
    child.on("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
}

export function commandExists(cmd, versionArgs = ["--version"]) {
  const r = runCapture(cmd, versionArgs);
  return !(r.error && r.error.code === "ENOENT");
}

// ── Network ──────────────────────────────────────────────────────────────────

export async function httpStatus(url, { headers = {}, timeoutMs = 3000 } = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    return res.status;
  } catch {
    return null;
  }
}

export async function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  } catch (e) {
    return { status: null, body: e instanceof Error ? e.message : String(e) };
  }
}

/** True when something accepts a TCP connection on `port` at 127.0.0.1. */
export function portBusy(port, host = "127.0.0.1") {
  return new Promise((resolveBusy) => {
    const sock = connect({ port, host });
    const done = (busy) => {
      sock.destroy();
      resolveBusy(busy);
    };
    sock.setTimeout(1000, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export async function waitFor(check, { timeoutMs, intervalMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── Files ────────────────────────────────────────────────────────────────────

/** Temp file in a private dir beside the target, then rename — the same shape
 *  as `lib/setup/env-file.ts`, so a crash mid-write leaves the old file. An
 *  existing file keeps its mode; a new one is 0600 (it holds secrets). */
export function writeFileAtomic0600(path, content) {
  const exists = existsSync(path);
  const tmpDir = mkdtempSync(join(dirname(path), ".env-write-"));
  const tmpFile = join(tmpDir, "env.tmp");
  try {
    writeFileSync(tmpFile, content, { mode: exists ? statSync(path).mode : 0o600 });
    renameSync(tmpFile, path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── The local services ───────────────────────────────────────────────────────

export function dockerDaemonUp() {
  const r = runCapture("docker", ["info"]);
  return !r.error && r.status === 0;
}

/** True once the daemon answers. On macOS a stopped Docker Desktop is the
 *  normal state after a reboot, and `open -a Docker` is exactly what the
 *  operator would type, so do it for them and wait (the daemon takes 20-60s
 *  to come up). Elsewhere the daemon is a system service and the message says
 *  how to start it. */
export async function ensureDockerDaemon(log) {
  if (dockerDaemonUp()) return true;
  if (process.platform !== "darwin") {
    log.fatal(
      "Docker is not running. Start it (systemctl start docker, or Docker Desktop) and re-run.",
    );
  }
  log.info("Docker is not running — starting Docker Desktop (open -a Docker)");
  const opened = runCapture("open", ["-a", "Docker"]);
  if (opened.error || opened.status !== 0) {
    log.fatal(
      "Docker is not running and `open -a Docker` failed — install Docker Desktop and re-run.",
    );
  }
  // Re-issue the `open` every 30s while waiting: an `open -a Docker` sent while
  // Docker Desktop is still SHUTTING DOWN (quit a moment ago) is swallowed by
  // the exiting instance and nothing launches - measured as a two-minute wait
  // ending in "did not come up". A repeat once it has exited starts it. The
  // ceiling is generous because the engine VM can take over a minute on a
  // cold machine.
  //
  // One escalation, once: a Docker Desktop whose processes are running but
  // whose engine has not answered after two minutes is WEDGED, not slow -
  // measured: its backend sat on an outbound fetch (`desktop.docker.com …
  // context deadline exceeded`) and no number of `open`s helped, while a
  // kill-and-reopen had the engine up in four seconds. That is what the
  // operator would do by hand after staring at the whale; doing it for them
  // is what makes "reboot, then pnpm dev:local" hold.
  const started = Date.now();
  const deadline = started + 240_000;
  let nextOpen = started + 30_000;
  let restarted = false;
  while (!dockerDaemonUp()) {
    if (Date.now() >= deadline) {
      log.fatal(
        "Docker Desktop did not come up within 4 minutes — open it by hand, wait for the whale to settle, and re-run.",
      );
    }
    if (!restarted && Date.now() - started >= 120_000) {
      restarted = true;
      log.warn(
        "Docker Desktop has been starting for 2 minutes with no engine — it looks stuck; restarting it (kill + open)",
      );
      runCapture("pkill", ["-f", "Docker Desktop"]);
      runCapture("pkill", ["-f", "com.docker.backend"]);
      await new Promise((r) => setTimeout(r, 5000));
      runCapture("open", ["-a", "Docker"]);
      nextOpen = Date.now() + 30_000;
    } else if (Date.now() >= nextOpen) {
      runCapture("open", ["-a", "Docker"]);
      nextOpen = Date.now() + 30_000;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log.info(`Docker is up (${Math.round((Date.now() - started) / 1000)}s)`);
  return true;
}

export function dockerComposeAvailable() {
  const r = runCapture("docker", ["compose", "version"]);
  return !r.error && r.status === 0;
}

export function dockerComposeUp() {
  return runInherit("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d"]);
}

/** Parsed `supabase status -o json`, or null when the stack is not running. */
export function supabaseStatus() {
  const r = runCapture("supabase", ["status", "-o", "json"]);
  if (r.error || r.status !== 0) return null;
  try {
    return parseSupabaseStatus(r.stdout);
  } catch {
    return null;
  }
}

export function supabaseStart() {
  return runInherit("supabase", ["start"]);
}

/** `docker ps -a` status of the local Supabase database container, or null
 *  when it does not exist. The project id is read from supabase/config.toml so
 *  a renamed project is still found. */
export function supabaseDbContainerStatus() {
  let projectId = "ace-engine";
  try {
    const m = /^project_id\s*=\s*"([^"]+)"/m.exec(
      readFileSync(join(REPO_DIR, "supabase", "config.toml"), "utf8"),
    );
    if (m) projectId = m[1];
  } catch {
    // fall back to the default id
  }
  const r = runCapture("docker", [
    "ps",
    "-a",
    "--filter",
    `name=^supabase_db_${projectId}$`,
    "--format",
    "{{.Status}}",
  ]);
  if (r.error || r.status !== 0) return null;
  const line = r.stdout.trim().split("\n")[0] ?? "";
  return line.length > 0 ? line : null;
}

/**
 * Bring the local Supabase to a point where `isHealthy()` answers true, or
 * die with a message. Encodes the reboot race (see `decideSupabaseBringUp`):
 * containers Docker restarted on its own are WAITED for, not `supabase
 * start`ed into; a `supabase start` that exits non-zero is still a success
 * if the API comes up right after (the CLI reports "not ready: starting" and
 * exits 1 while the database is booting).
 */
export async function ensureSupabaseUp(log, isHealthy, { noStart = false } = {}) {
  if (await isHealthy()) return;
  if (noStart) log.fatal("Supabase is not answering and --no-start was given (`supabase start`).");
  await ensureDockerDaemon(log);
  const state = classifySupabaseContainer(supabaseDbContainerStatus());
  if (decideSupabaseBringUp(state) === "wait-then-start") {
    log.info("Supabase containers are running but not answering yet (booting) — waiting");
    if (await waitFor(isHealthy, { timeoutMs: 120_000, intervalMs: 3000 })) return;
    log.info("still not answering after 2 minutes — running `supabase start`");
  } else {
    log.info("Supabase is not running — running `supabase start`");
  }
  const code = await supabaseStart();
  if (await waitFor(isHealthy, { timeoutMs: 180_000, intervalMs: 3000 })) {
    if (code !== 0) log.info("(`supabase start` exited non-zero, but the API is up — carrying on)");
    return;
  }
  log.fatal(
    `supabase start exited with code ${code} and the auth API still does not answer after 3 minutes — see the output above (usually Docker resources or ports 54321-54327 in use).`,
  );
}

export function supabaseStop() {
  return runInherit("supabase", ["stop"]);
}

/** Apply migrations that arrived since the local database was created (a
 *  `git pull` with new files under supabase/migrations). `supabase start` on
 *  an EXISTING volume applies nothing, so without this the app runs against a
 *  schema the code no longer matches. Idempotent: pending migrations only. */
export function supabaseMigrateUp() {
  return runInherit("supabase", ["migration", "up", "--local"]);
}

export const SUPABASE_DOTENV_PATH = join(REPO_DIR, "supabase", ".env");

/** mtimes for the install-staleness check; null when a file is absent. */
export function installStamps() {
  const mtime = (p) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return null;
    }
  };
  return {
    lockMtimeMs: mtime(join(REPO_DIR, "pnpm-lock.yaml")),
    modulesMtimeMs: mtime(join(REPO_DIR, "node_modules", ".modules.yaml")),
  };
}

/** Upstash REST ping in the `POST / ["PING"]` form, which both Upstash and the
 *  local serverless-redis-http shim answer. (The path form `GET /ping` is
 *  Upstash-only — the shim returns "Endpoint not found" for it.) */
export async function redisPing(url, token) {
  const { body } = await httpJson(url.replace(/\/+$/, "") + "/", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(["PING"]),
  });
  return isPong(body);
}

/** `claude auth status` → logged-in | logged-out | unknown | missing. */
export function claudeAuth() {
  const r = runCapture("claude", ["auth", "status"]);
  if (r.error && r.error.code === "ENOENT") return "missing";
  return classifyClaudeAuth(`${r.stdout}\n${r.stderr}`);
}
