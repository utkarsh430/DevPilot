// The whole local stack as one foreground job:
//
//   pnpm dev:local                # web + Inngest dev server + runner
//   pnpm dev:local --no-runner    # web + Inngest only
//
// Preflight first — the four things that otherwise fail SILENTLY:
//   • `.env.local` missing a required key → the runner exits, or the app
//     crashes on first request. Named here, with "run pnpm setup:local".
//   • Supabase / local Redis not running → started here (Supabase inline,
//     Redis via infra/local/docker-compose.yml). Only a LOOPBACK Redis URL is
//     ever "fixed" with Docker; a real Upstash URL is reported, not touched.
//   • port 3000 or 8288 busy → `next dev` silently moves to 3001, and Inngest
//     plus the runner then point at an app that is not there. Refused.
//   • `claude` not signed in → tickets dispatch and every step fails. Warned.
//
// Then: web first, wait for /health, then Inngest and the runner together.
// Output is prefixed per child. A child that dies takes the rest down (exit 1);
// Ctrl-C stops all three cleanly (exit 0). `pnpm dev` is untouched — this is
// the all-in-one; the per-process commands in AGENTS.md remain the fallback.
//
// Decisions in `../lib/dev/supervise.ts` + `local-stack.ts` (tested); IO here.
// `node --import tsx`, relative imports only (see dev-inngest.mjs).

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { missingKeys, parseDotenv } from "../lib/dev/env-template.ts";
import {
  LOCAL_APP_URL,
  LOCAL_INNGEST_URL,
  REQUIRED_LOCAL_ENV_KEYS,
  isLocalRedisUrl,
} from "../lib/dev/local-stack.ts";
import {
  CHILD_ORDER,
  KILL_GRACE_MS,
  WEB_READY_TIMEOUT_MS,
  planOnChildExit,
  prefixLine,
} from "../lib/dev/supervise.ts";
import {
  COMPOSE_FILE,
  ENV_PATH,
  RUNNER_DIR,
  WEB_DIR,
  claudeAuth,
  dockerComposeUp,
  dockerDaemonUp,
  httpStatus,
  makeLog,
  parseArgs,
  portBusy,
  redisPing,
  supabaseStart,
  supabaseStatus,
  waitFor,
} from "./_local-stack-io.mjs";
import {
  ensureDockerDaemon,
  ensureSupabaseUp,
  installStamps,
  supabaseMigrateUp,
} from "./_local-stack-io.mjs";
import { inngestModeFor, isInstallStale, requiredLocalEnvKeysFor } from "../lib/dev/local-stack.ts";

const log = makeLog("dev-local");
const { flags } = parseArgs(process.argv.slice(2));
for (const f of flags) {
  if (!["no-runner", "no-start", "lan"].includes(f)) log.fatal(`unknown flag --${f}`);
}
const NO_RUNNER = flags.has("no-runner");
const NO_START = flags.has("no-start");
// The app binds to 127.0.0.1 unless asked otherwise: a local install signs a
// visitor in from an email alone (DEVPILOT_LOCAL_PASSWORDLESS), which is only
// acceptable while "visitor" means someone at this keyboard, not on the Wi-Fi.
const LAN = flags.has("lan");
if (LAN) {
  log.warn(
    "--lan: the app is reachable from your network, and a local install signs ANYONE in from an email alone. Use it only on a network you trust.",
  );
}

// ── Preflight ────────────────────────────────────────────────────────────────

{
  const stamps = installStamps();
  if (isInstallStale(stamps.lockMtimeMs, stamps.modulesMtimeMs)) {
    log.warn(
      "pnpm-lock.yaml is newer than your last `pnpm install` — run pnpm install first, or new/changed dependencies will be missing.",
    );
  }
}
if (!existsSync(ENV_PATH)) log.fatal("apps/web/.env.local does not exist — run: pnpm setup:local");
const env = parseDotenv(readFileSync(ENV_PATH, "utf8"));
const inngestMode = inngestModeFor(env);
if (inngestMode === "dev") {
  log.warn(
    "Inngest is in dev-server mode (INNGEST_DEV is not 0, or no keys): in-flight runs will NOT survive a restart. For the durable server: set INNGEST_DEV=0 in apps/web/.env.local and re-run pnpm setup:local.",
  );
}
const requiredForMode = requiredLocalEnvKeysFor(inngestMode);
const required = NO_RUNNER
  ? requiredForMode.filter((k) => k !== "DEVPILOT_RUNNER_TENANT_ID")
  : requiredForMode;
const missing = missingKeys(env, required);
if (missing.length > 0) {
  const tenantOnly = missing.length === 1 && missing[0] === "DEVPILOT_RUNNER_TENANT_ID";
  log.fatal(
    tenantOnly
      ? "DEVPILOT_RUNNER_TENANT_ID is blank in apps/web/.env.local, so the runner would refuse to boot. " +
          "Either: pnpm setup:local --email you@example.com   or start without it: pnpm dev:local --no-runner"
      : `apps/web/.env.local is missing: ${missing.join(", ")} — run: pnpm setup:local`,
  );
}

const supabaseHealthy = () =>
  httpStatus(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`, {
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY },
  }).then((s) => s === 200);

await ensureSupabaseUp(log, supabaseHealthy, { noStart: NO_START });
if (supabaseStatus() === null)
  log.warn("`supabase status` reports nothing; continuing on the health check.");
// `supabase start` applies nothing to an EXISTING volume, so a `git pull` that
// brought new migrations would otherwise leave the schema behind the code.
// Pending migrations only; a no-op on an up-to-date database.
if (!NO_START) {
  const code = await supabaseMigrateUp();
  if (code !== 0) {
    log.warn(
      "supabase migration up --local failed — the database schema may be behind the code (see the output above).",
    );
  }
}

// The compose file is the source of truth for the local Redis (ports, the
// Inngest state port): `up -d` is a no-op when nothing changed and recreates
// the container when it did (data is on the volume), so a pulled change to it
// takes effect on the next start rather than only when the REST ping fails.
if (isLocalRedisUrl(env.UPSTASH_REDIS_REST_URL) && !NO_START) {
  await ensureDockerDaemon(log);
  const code = await dockerComposeUp();
  if (code !== 0) log.warn(`docker compose -f ${COMPOSE_FILE} up -d exited with code ${code}`);
}
if (!(await redisPing(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN))) {
  if (!isLocalRedisUrl(env.UPSTASH_REDIS_REST_URL)) {
    log.fatal(
      `Redis REST at ${env.UPSTASH_REDIS_REST_URL} did not answer PONG and is not the local compose instance — check UPSTASH_REDIS_REST_URL/TOKEN.`,
    );
  }
  if (NO_START) log.fatal("local Redis is not answering and --no-start was given.");
  log.info("local Redis is not answering — starting infra/local/docker-compose.yml");
  const code = await dockerComposeUp();
  const ok =
    code === 0 &&
    (await waitFor(() => redisPing(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN), {
      timeoutMs: 30_000,
    }));
  if (!ok) log.fatal(`Redis never answered PONG. Inspect: docker compose -f ${COMPOSE_FILE} logs`);
}

for (const port of [3000, 8288]) {
  if (await portBusy(port)) {
    log.fatal(
      `port ${port} is in use. Next would silently move to another port and Inngest/the runner would point at the wrong app. Find it: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
    );
  }
}

switch (claudeAuth()) {
  case "logged-in":
    break;
  case "missing":
    log.warn(
      "claude CLI not found — tickets will dispatch but every step will fail until it is installed and signed in.",
    );
    break;
  case "logged-out":
    log.warn(
      "claude is not logged in — tickets will dispatch but every step will fail. Run `claude` once and sign in.",
    );
    break;
  default:
    log.warn("could not tell whether claude is logged in.");
}

// ── Spawn ────────────────────────────────────────────────────────────────────

const names = NO_RUNNER ? CHILD_ORDER.filter((n) => n !== "runner") : CHILD_ORDER;
const live = new Map();
let shuttingDown = false;
let exitCode = 0;
let killTimer = null;

function finishIfAllGone() {
  if (live.size === 0) process.exit(exitCode);
}

// Each child is spawned `detached`, i.e. as the leader of its OWN process
// group, and is signalled BY GROUP (`kill(-pid)`). Signalling the child alone
// is not enough: pnpm's `node_modules/.bin/inngest` is a `/bin/sh` shim that
// runs the Go binary WITHOUT `exec`, so killing the shim leaves the dev server
// alive on :8288 — measured on the first crash test. `next dev` and `tsx watch`
// fork grandchildren too. A group signal reaches all of them.
function signalChild(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function stopAll(signal = "SIGTERM") {
  shuttingDown = true;
  for (const child of live.values()) signalChild(child, signal);
  if (killTimer === null) {
    killTimer = setTimeout(() => {
      for (const child of live.values()) signalChild(child, "SIGKILL");
      setTimeout(() => process.exit(exitCode), 500).unref();
    }, KILL_GRACE_MS);
    killTimer.unref();
  }
}

// Registered BEFORE anything is spawned, so a Ctrl-C during the web warm-up
// is still a shutdown and not an orphaned next-dev.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    log.info("stopping");
    stopAll(sig === "SIGHUP" ? "SIGTERM" : sig);
  });
}

function start(name, cmd, args, cwd) {
  // stdin is `ignore`, not `inherit`: a detached child is outside the
  // terminal's foreground group, and one that read the TTY would be stopped
  // with SIGTTIN. None of the three needs stdin.
  const child = spawn(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    detached: true,
  });
  live.set(name, child);
  createInterface({ input: child.stdout }).on("line", (l) =>
    process.stdout.write(`${prefixLine(name, l, names)}\n`),
  );
  createInterface({ input: child.stderr }).on("line", (l) =>
    process.stderr.write(`${prefixLine(name, l, names)}\n`),
  );
  child.on("error", (e) => {
    live.delete(name);
    exitCode = 1;
    log.warn(`${name} could not start (${e.message}) — missing binary? run pnpm install`);
    stopAll();
    finishIfAllGone();
  });
  child.on("exit", (code, signal) => {
    live.delete(name);
    const plan = planOnChildExit({ name, code, signal }, shuttingDown);
    if (plan.kind === "crash") {
      exitCode = plan.exitCode;
      log.warn(plan.message);
      stopAll();
    } else {
      log.info(plan.message);
    }
    finishIfAllGone();
  });
  return child;
}

start(
  "web",
  join(WEB_DIR, "node_modules", ".bin", "next"),
  ["dev", "--port", "3000", "--hostname", LAN ? "0.0.0.0" : "127.0.0.1"],
  WEB_DIR,
);

const webReady = await waitFor(() => httpStatus(`${LOCAL_APP_URL}/health`).then((s) => s === 200), {
  timeoutMs: WEB_READY_TIMEOUT_MS,
});
if (shuttingDown) finishIfAllGone();
if (!webReady) {
  log.warn(
    `web did not answer /health within ${WEB_READY_TIMEOUT_MS / 1000}s — starting the rest anyway (they retry).`,
  );
}

if (!shuttingDown) {
  start("inngest", process.execPath, ["--import", "tsx", "scripts/dev-inngest.mjs"], WEB_DIR);
  if (!NO_RUNNER) {
    start(
      "runner",
      join(RUNNER_DIR, "node_modules", ".bin", "tsx"),
      ["watch", "--env-file=../web/.env.local", "src/index.ts"],
      RUNNER_DIR,
    );
  }
  const status = supabaseStatus() ?? {};
  log.info("");
  log.info(`  app:       ${LOCAL_APP_URL}`);
  log.info(`  inngest:   ${LOCAL_INNGEST_URL}`);
  if (status.STUDIO_URL) log.info(`  studio:    ${status.STUDIO_URL}`);
  const mail = status.MAILPIT_URL ?? status.INBUCKET_URL ?? env.NEXT_PUBLIC_LOCAL_MAIL_URL;
  if (mail) log.info(`  mailpit:   ${mail}   <- sign-in links land here`);
  log.info("  Ctrl-C stops everything.");
  log.info("");
}
