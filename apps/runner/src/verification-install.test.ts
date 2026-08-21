// L1 (ticket-speed audit) — regression coverage for verification-install.ts.
//
// THE DEFECT (measured 2026-08-06, olympussai board): DevPilot-8 and DevPilot-9
// both parked asking a human to adjudicate a `pnpm test` failure. Re-running
// the EXACT gate command in each workspace passed clean (311/311 both times).
// The runner log for both runs shows `verification … command="pnpm test"
// exit=1 …` and contains ZERO `pnpm install` invocations anywhere in its
// history — `node_modules` was simply never installed before the gate ran, so
// the "failure" was `Cannot find module`, not a real test failure.
//
// This is NOT a jest/vitest suite — the runner has no test runner wired up, so
// it follows the same bare-`main()` convention as producer-verification.test.ts
// / git-utils.test.ts. Some cases are pure (no fs); the rest drive a real
// temp directory, matching git-utils.test.ts's convention of testing real
// filesystem/git behaviour rather than mocking it.
//
//   cd apps/runner
//   npx tsx src/verification-install.test.ts

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  pickInstallPlan,
  formatInstallCommand,
  resolveInstallCommand,
  type LockfilePresence,
} from "./verification-install.js";

const noLockfiles: LockfilePresence = { pnpm: false, yarn: false, npm: false, bun: false };

function testPickInstallPlanNoPackageJson(): void {
  // THE CONTROL: a repo with no package.json at all (a non-Node project, e.g.
  // scoursh) must resolve to "nothing to install" — never guess a command for
  // a stack that was never asked for.
  assert.equal(pickInstallPlan(false, noLockfiles), null);
  assert.equal(
    pickInstallPlan(false, { ...noLockfiles, pnpm: true }),
    null,
    "no package.json means not a Node project, even if a stray lockfile exists",
  );
  console.log("✓ pickInstallPlan — no package.json → null (not a Node project)");
}

function testPickInstallPlanPerManager(): void {
  assert.deepEqual(pickInstallPlan(true, { ...noLockfiles, pnpm: true }), {
    argv0: "pnpm",
    argv: ["install", "--frozen-lockfile"],
  });
  assert.deepEqual(pickInstallPlan(true, { ...noLockfiles, yarn: true }), {
    argv0: "yarn",
    argv: ["install", "--frozen-lockfile"],
  });
  assert.deepEqual(pickInstallPlan(true, { ...noLockfiles, npm: true }), {
    argv0: "npm",
    argv: ["ci"],
  });
  assert.deepEqual(pickInstallPlan(true, { ...noLockfiles, bun: true }), {
    argv0: "bun",
    argv: ["install", "--frozen-lockfile"],
  });
  console.log("✓ pickInstallPlan — each lockfile picks its own frozen/ci install");
}

function testPickInstallPlanNoLockfileFallsBackToPnpm(): void {
  // package.json exists but no lockfile at all — nothing to freeze against, so
  // fall back to a plain (non-frozen) pnpm install, mirroring dev-server.ts's
  // convention that DevPilot's scaffolder is a pnpm shop.
  assert.deepEqual(pickInstallPlan(true, noLockfiles), { argv0: "pnpm", argv: ["install"] });
  console.log("✓ pickInstallPlan — package.json with no lockfile falls back to plain pnpm install");
}

function testPickInstallPlanPriority(): void {
  // pnpm > yarn > npm > bun when more than one lockfile is present.
  assert.deepEqual(pickInstallPlan(true, { pnpm: true, yarn: true, npm: true, bun: true }), {
    argv0: "pnpm",
    argv: ["install", "--frozen-lockfile"],
  });
  assert.deepEqual(pickInstallPlan(true, { pnpm: false, yarn: true, npm: true, bun: true }), {
    argv0: "yarn",
    argv: ["install", "--frozen-lockfile"],
  });
  assert.deepEqual(pickInstallPlan(true, { pnpm: false, yarn: false, npm: true, bun: true }), {
    argv0: "npm",
    argv: ["ci"],
  });
  console.log("✓ pickInstallPlan — priority pnpm > yarn > npm > bun");
}

function testFormatInstallCommand(): void {
  assert.equal(
    formatInstallCommand({ argv0: "pnpm", argv: ["install", "--frozen-lockfile"] }),
    "pnpm install --frozen-lockfile",
  );
  assert.equal(formatInstallCommand({ argv0: "npm", argv: ["ci"] }), "npm ci");
  console.log("✓ formatInstallCommand");
}

// ---- fs-integration cases --------------------------------------------------

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devpilot-verify-install-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function testResolveInstallCommandNonNodeRepo(): Promise<void> {
  // THE CONTROL THAT MATTERS: `scoursh` and other non-Node projects must gate
  // normally, never fail because there's no lockfile to install from.
  await withTempDir(async (dir) => {
    const cmd = await resolveInstallCommand(dir);
    assert.equal(cmd, "", "a repo with no package.json must resolve to no install at all");
  });
  console.log("✓ resolveInstallCommand — a non-Node repo (no package.json) skips cleanly");
}

async function testResolveInstallCommandMissingNodeModules(): Promise<void> {
  // THE DEFECT, reproduced: package.json + a lockfile, no node_modules at all.
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const cmd = await resolveInstallCommand(dir);
    assert.equal(cmd, "pnpm install --frozen-lockfile");
  });
  console.log("✓ resolveInstallCommand — missing node_modules installs (the measured defect)");
}

async function testResolveInstallCommandAlreadyInstalledIsNoop(): Promise<void> {
  // A workspace that already has its dependencies must not pay a full install
  // on every producer step.
  await withTempDir(async (dir) => {
    const now = Date.now() / 1000;
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    await fs.utimes(path.join(dir, "package.json"), now, now);
    await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await fs.utimes(path.join(dir, "pnpm-lock.yaml"), now, now);
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    // pnpm's own "last install" marker, stamped AFTER the manifest.
    const marker = path.join(dir, "node_modules", ".modules.yaml");
    await fs.writeFile(marker, "");
    await fs.utimes(marker, now + 5, now + 5);

    const cmd = await resolveInstallCommand(dir);
    assert.equal(cmd, "", "dependencies are already current — nothing to install");
  });
  console.log("✓ resolveInstallCommand — already-installed workspace is a no-op");
}

async function testResolveInstallCommandStaleReinstalls(): Promise<void> {
  // node_modules exists but the manifest changed since the last install — an
  // agent added a dependency the stale tree is missing. Must reinstall, or the
  // gate would fail with "Cannot find module" for the WRONG reason again.
  await withTempDir(async (dir) => {
    const t0 = Date.now() / 1000;
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    const marker = path.join(dir, "node_modules", ".modules.yaml");
    await fs.writeFile(marker, "");
    await fs.utimes(marker, t0, t0);

    // package.json edited well AFTER the last install marker.
    await fs.writeFile(path.join(dir, "package.json"), '{"dependencies":{"left-pad":"1.0.0"}}\n');
    await fs.utimes(path.join(dir, "package.json"), t0 + 10, t0 + 10);
    await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await fs.utimes(path.join(dir, "pnpm-lock.yaml"), t0 + 10, t0 + 10);

    const cmd = await resolveInstallCommand(dir);
    assert.equal(cmd, "pnpm install --frozen-lockfile", "a stale node_modules must reinstall");
  });
  console.log(
    "✓ resolveInstallCommand — stale node_modules (dep added since last install) reinstalls",
  );
}

async function testResolveInstallCommandNoLockfilePlainInstall(): Promise<void> {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    const cmd = await resolveInstallCommand(dir);
    assert.equal(cmd, "pnpm install", "no lockfile to freeze against — plain install");
  });
  console.log("✓ resolveInstallCommand — package.json with no lockfile plans a plain install");
}

async function testResolveInstallCommandNpm(): Promise<void> {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    await fs.writeFile(path.join(dir, "package-lock.json"), "{}\n");
    const cmd = await resolveInstallCommand(dir);
    assert.equal(cmd, "npm ci");
  });
  console.log("✓ resolveInstallCommand — npm lockfile picks `npm ci`");
}

async function main(): Promise<void> {
  testPickInstallPlanNoPackageJson();
  testPickInstallPlanPerManager();
  testPickInstallPlanNoLockfileFallsBackToPnpm();
  testPickInstallPlanPriority();
  testFormatInstallCommand();
  await testResolveInstallCommandNonNodeRepo();
  await testResolveInstallCommandMissingNodeModules();
  await testResolveInstallCommandAlreadyInstalledIsNoop();
  await testResolveInstallCommandStaleReinstalls();
  await testResolveInstallCommandNoLockfilePlainInstall();
  await testResolveInstallCommandNpm();
  console.log("\nAll verification-install tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
