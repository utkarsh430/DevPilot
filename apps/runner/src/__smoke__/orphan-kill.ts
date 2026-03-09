// Direct smoke test for the orphan-kill fix.
//
// Spawns the dev server in a known workspace, polls for it to bind port 3100,
// then calls killDevServer(). After the kill grace window, probes port 3100
// — if anything is still bound (next-server orphan), the fix regressed.
//
// Run with:
//   pnpm tsx --env-file=../web/.env.local src/__smoke__/orphan-kill.ts
//
// Reuses the workspace at the ticket id we hit the bug on. Keep this file
// alongside the runner source so it imports the same module code under test;
// the __smoke__ dir is excluded from production builds via tsconfig include.

import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { killDevServer, startDevServer } from "../dev-server.js";

const WORKSPACE = "/Users/ethan-hunt/.devpilot/workspaces/52187389-fd31-43f5-a7ea-a349dc3a8e42";
const SESSION_ID = "smoke-orphan-kill";
const PORT = 3100;
const READY_TIMEOUT_MS = 60_000;
const PORT_FREE_TIMEOUT_MS = 15_000;

// Probe by *connecting*, not by binding. Next.js binds on the IPv6 wildcard
// `::`, which on macOS lets an IPv4 listen on the same port succeed
// independently — making a bind probe an unreliable "is anyone listening"
// signal. A successful TCP handshake to 127.0.0.1:<port> is unambiguous.
async function isPortBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port, timeout: 500 });
    let settled = false;
    const done = (bound: boolean) => {
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

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(500);
  }
  console.error(`[smoke] timeout waiting for: ${label}`);
  return false;
}

async function main(): Promise<void> {
  if (await isPortBound(PORT)) {
    console.error(`[smoke] port ${PORT} already bound before test; aborting`);
    process.exit(2);
  }

  console.log("[smoke] spawning dev server…");
  const started = await startDevServer({
    sessionId: SESSION_ID,
    workspacePath: WORKSPACE,
    portHint: PORT,
    onLog: (chunk) => {
      // Forward to stderr so the test result stays parseable on stdout.
      process.stderr.write(chunk);
    },
  });
  console.log(`[smoke] spawned pid=${started.pid} port=${started.port}`);

  const bound = await waitFor(
    () => isPortBound(started.port),
    READY_TIMEOUT_MS,
    `port ${started.port} bound`,
  );
  if (!bound) {
    console.error("[smoke] FAIL: dev server never bound");
    await killDevServer(SESSION_ID).catch(() => undefined);
    process.exit(1);
  }
  console.log(`[smoke] port ${started.port} is bound`);

  console.log("[smoke] killing session…");
  const t0 = Date.now();
  await killDevServer(SESSION_ID, { graceMs: 3_000 });
  console.log(`[smoke] killDevServer returned in ${Date.now() - t0}ms`);

  const freed = await waitFor(
    async () => !(await isPortBound(started.port)),
    PORT_FREE_TIMEOUT_MS,
    `port ${started.port} freed`,
  );
  if (!freed) {
    console.error(`[smoke] FAIL — port ${started.port} still bound after kill (orphan leak)`);
    process.exit(1);
  }

  console.log("[smoke] PASS — port released, no orphan");
  process.exit(0);
}

void main().catch((err) => {
  console.error("[smoke] uncaught:", err);
  process.exit(1);
});
