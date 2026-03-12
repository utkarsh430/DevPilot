// Focused test for the IPv6-wildcard port-probe fix.
//
// Pre-fix: `findFreePort` bound on '127.0.0.1' (IPv4 explicit), which
// does NOT conflict with a process listening on the IPv6 wildcard '::'
// (Next.js's default). The probe falsely reported the port free and
// startDevServer told the child to bind it → EADDRINUSE.
//
// This test simulates the exact pre-fix failure mode: bind on '::3100',
// then ask findFreePort to allocate from 3100. With the fix the probe
// must return 3101+ (skipping the busy 3100).

import { createServer } from "node:net";
import { findFreePort } from "../dev-server.js";

const HINT = 3100;

async function main(): Promise<void> {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.once("listening", () => resolve());
    // No host arg → '::' on IPv6-capable hosts (Next.js's default binding).
    blocker.listen(HINT);
  });
  const addr = blocker.address();
  console.log(
    `[smoke] blocker bound on ${typeof addr === "string" ? addr : `${addr?.address}:${addr?.port}`}`,
  );

  try {
    const allocated = await findFreePort(HINT);
    console.log(`[smoke] findFreePort(${HINT}) → ${allocated}`);
    if (allocated === HINT) {
      console.log(
        `[smoke] FAIL — probe didn't detect the IPv6-wildcard listener (returned ${allocated})`,
      );
      process.exit(1);
    }
    if (allocated < HINT + 1) {
      console.log(`[smoke] FAIL — got ${allocated}, expected ${HINT + 1} or higher`);
      process.exit(1);
    }
    console.log(`[smoke] PASS — skipped busy ${HINT}, allocated ${allocated}`);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
  process.exit(0);
}

void main().catch((err) => {
  console.error("[smoke] uncaught:", err);
  process.exit(1);
});
