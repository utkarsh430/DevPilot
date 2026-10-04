// Integration smoke test for the runner's dev-server orphan-kill fix.
//
// Drives the layer immediately below the UI button — Redis queue + DB row +
// heartbeat endpoint — through start → running → stop → start → running.
// The unit smoke test in apps/runner/src/__smoke__/orphan-kill.ts proves
// the kill helper directly; this script proves the same fix works through
// the runner's message loop (dev-server-loop.ts), the heartbeat post path,
// and the DB row transitions a real UI click would observe.
//
// Run with:
//   cd apps/web
//   node --env-file=.env.local scripts/smoke-orphan-kill-integration.mjs

import { Redis } from "@upstash/redis";
import pg from "pg";
import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const QUEUE = "devpilot:jobs:dev-server:control";
const PORT = 3100;
const WORKSPACE = "/Users/ethan-hunt/.devpilot/workspaces/52187389-fd31-43f5-a7ea-a349dc3a8e42";
const SESSION_ID = "cf908b3a-a6b1-4a6f-be50-bc07335909d4";

function isPortBound(port) {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port, timeout: 500 });
    let settled = false;
    const done = (bound) => {
      if (settled) return;
      settled = true;
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      resolve(bound);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.once("timeout", () => done(false));
  });
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(500);
  }
  console.error(`[smoke] timeout: ${label}`);
  return false;
}

async function readSession(client) {
  const r = await client.query(
    "select status, status_reason, port, pid, updated_at from dev_server_sessions where id=$1",
    [SESSION_ID],
  );
  if (r.rowCount === 0) throw new Error("session row missing");
  return r.rows[0];
}

async function pushStart(redis) {
  await redis.lpush(
    QUEUE,
    JSON.stringify({
      kind: "start",
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      command: { argv0: "pnpm", argv: ["run", "dev"] },
      portHint: PORT,
      envOverrides: {},
    }),
  );
}

async function pushStop(redis, pid) {
  await redis.lpush(
    QUEUE,
    JSON.stringify({
      kind: "stop",
      sessionId: SESSION_ID,
      ...(pid ? { pid } : {}),
    }),
  );
}

async function markStarting(client) {
  await client.query(
    "update dev_server_sessions set status='starting', status_reason=null, port=null, pid=null, started_at=now(), last_heartbeat_at=now(), last_interaction_at=now(), updated_at=now() where id=$1",
    [SESSION_ID],
  );
}

const results = [];
function step(label, ok, detail) {
  results.push({ label, ok, detail });
  const mark = ok ? "✅" : "❌";
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!dbUrl || !redisUrl || !redisToken) {
    console.error("[smoke] missing DATABASE_URL or UPSTASH_REDIS_REST_* env");
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const redis = new Redis({ url: redisUrl, token: redisToken });

  let exitCode = 0;
  try {
    // ---- Baseline ----
    const baseline = !(await isPortBound(PORT));
    step("baseline: port 3100 free before test", baseline);
    if (!baseline) {
      exitCode = 1;
      return;
    }

    // ---- Cycle 1: start ----
    await markStarting(client);
    await pushStart(redis);
    step("cycle1: pushed start message to Redis", true);

    const reachedRunning1 = await waitUntil(
      async () => {
        const s = await readSession(client);
        return s.status === "running" && typeof s.port === "number" && typeof s.pid === "number";
      },
      120_000,
      "session row → running with port + pid",
    );
    const s1 = await readSession(client);
    step(
      "cycle1: row reached running",
      reachedRunning1,
      `status=${s1.status} port=${s1.port} pid=${s1.pid} reason=${s1.status_reason ?? "-"}`,
    );
    if (!reachedRunning1) {
      exitCode = 1;
      return;
    }
    const firstPid = s1.pid;

    const portBound1 = await isPortBound(s1.port);
    step("cycle1: port 3100 accepting connections", portBound1);
    if (!portBound1) {
      exitCode = 1;
      return;
    }

    // ---- Cycle 1: stop (the orphan-kill test) ----
    await pushStop(redis, firstPid);
    step("cycle1: pushed stop message to Redis", true);

    const reachedStopped = await waitUntil(
      async () => (await readSession(client)).status === "stopped",
      30_000,
      "session row → stopped",
    );
    const s2 = await readSession(client);
    step(
      "cycle1: row reached stopped",
      reachedStopped,
      `status=${s2.status} reason=${s2.status_reason ?? "-"}`,
    );

    // THE key check. Pre-fix this is where the orphan symptom appeared:
    // pnpm dev died but next-server kept port 3100. With the new
    // process-group kill, the whole tree should be gone within the
    // 5s SIGTERM→SIGKILL grace window.
    const freedAfterStop = await waitUntil(
      async () => !(await isPortBound(PORT)),
      15_000,
      "port 3100 released after stop",
    );
    step("cycle1: port 3100 released cleanly (no orphan)", freedAfterStop);
    if (!freedAfterStop) {
      exitCode = 1;
      // dump what's still holding it
      console.error("[smoke] orphan detected — see `lsof -iTCP:3100`");
      return;
    }

    // ---- Cycle 2: prove the second start works ----
    await markStarting(client);
    await pushStart(redis);
    step("cycle2: pushed start after stop", true);

    const reachedRunning2 = await waitUntil(
      async () => {
        const s = await readSession(client);
        return s.status === "running" && typeof s.port === "number" && typeof s.pid === "number";
      },
      90_000,
      "second cycle → running",
    );
    const s3 = await readSession(client);
    const samePort = s3.port === PORT;
    step(
      "cycle2: row reached running on port 3100",
      reachedRunning2 && samePort,
      `status=${s3.status} port=${s3.port} pid=${s3.pid} reason=${s3.status_reason ?? "-"}`,
    );
    if (!(reachedRunning2 && samePort)) {
      exitCode = 1;
      return;
    }
    step(
      "cycle2: new pid ≠ first cycle pid (fresh spawn)",
      s3.pid !== firstPid,
      `first=${firstPid} second=${s3.pid}`,
    );

    // ---- Cleanup ----
    await pushStop(redis, s3.pid);
    await waitUntil(
      async () => (await readSession(client)).status === "stopped",
      30_000,
      "cleanup → stopped",
    );
    const cleanupFreed = await waitUntil(
      async () => !(await isPortBound(PORT)),
      15_000,
      "cleanup port release",
    );
    step("cleanup: port released after final stop", cleanupFreed);
  } finally {
    await client.end().catch(() => undefined);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0 || exitCode !== 0) {
    console.log(`\n[smoke] FAIL — ${failed.length} failed step(s)`);
    process.exit(1);
  }
  console.log(`\n[smoke] PASS — ${results.length} steps green`);
  process.exit(0);
}

void main().catch((err) => {
  console.error("[smoke] uncaught:", err);
  process.exit(1);
});
