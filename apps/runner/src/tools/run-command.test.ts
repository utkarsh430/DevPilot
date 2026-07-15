// Regression coverage for run-command.ts's timeout escalation.
//
// NOT a jest/vitest suite — the runner has no test runner wired up, so this
// follows the same bare-`main()` convention as connect-retry.test.ts /
// poll-backoff.test.ts / git-utils.test.ts.
//
//   cd apps/runner
//   npx tsx src/tools/run-command.test.ts

import assert from "node:assert/strict";
import { runCommand } from "./run-command.js";
import { CLOSE_AFTER_EXIT_GRACE_MS, KILL_GRACE_MS, killAllSpawnedTrees } from "../process-tree.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A child that ignores SIGTERM must still be force-killed after the grace
 * period. The escalation cannot be gated on `child.killed` — Node sets that as
 * soon as a signal is *sent* — or `runCommand` never resolves, hanging every
 * caller that awaits it (producer verification runs on the critical path before
 * `postStepResult`).
 */
async function testSigtermIgnoringChildIsForceKilled(): Promise<void> {
  const startedAt = Date.now();
  const result = await runCommand({
    cwd: process.cwd(),
    cmd: process.execPath,
    args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    timeoutMs: 500,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.timedOut, true, "the run must be reported as timed out");
  assert.ok(
    elapsed < 20_000,
    `a SIGTERM-ignoring child must be SIGKILLed after the grace period (took ${elapsed}ms)`,
  );
  console.log(`✓ runCommand force-kills a SIGTERM-ignoring child (resolved in ${elapsed}ms)`);
}

/**
 * The real target is `pnpm test`, which forks the test runner as a grandchild
 * inheriting the piped stdio. Killing only the direct child leaves that
 * grandchild holding the pipe write ends, so `close` never fires. The timeout
 * must reap the whole process group.
 */
async function testGrandchildIsReapedWithTheGroup(): Promise<void> {
  const child = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  const startedAt = Date.now();
  const result = await runCommand({
    cwd: process.cwd(),
    cmd: process.execPath,
    args: ["-e", child],
    timeoutMs: 500,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.timedOut, true);
  assert.ok(
    elapsed < 20_000,
    `a surviving grandchild must not keep runCommand pending (took ${elapsed}ms)`,
  );
  console.log(`✓ runCommand reaps the whole process group on timeout (resolved in ${elapsed}ms)`);
}

/**
 * A descendant that escapes the group entirely (spawns itself `detached`) can
 * still hold the pipes open, so `close` never fires even though the child is
 * gone. `exit` must therefore be a sufficient resolution signal on its own —
 * `timeoutMs` is worthless if the promise can hang before it even elapses.
 */
async function testEscapedDescendantDoesNotBlockResolution(): Promise<void> {
  const child = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
      stdio: 'inherit',
      detached: true,
    }).unref();
    process.stdout.write('child-done');
  `;
  const startedAt = Date.now();
  const result = await runCommand({
    cwd: process.cwd(),
    cmd: process.execPath,
    args: ["-e", child],
    timeoutMs: 60_000,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.timedOut, false, "the child exited cleanly, well inside its timeout");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "child-done", "output drained before exit must still be captured");
  assert.ok(
    elapsed < 15_000,
    `must settle off \`exit\`, not wait for \`close\` (took ${elapsed}ms)`,
  );
  console.log(`✓ runCommand settles on exit when a pipe-holder escapes the group (${elapsed}ms)`);
}

/**
 * The two timeout tests above both use a direct child that traps SIGTERM, which
 * keeps the spawn pending until the SIGKILL lands. The dangerous shape is the
 * inverse, and it is the real `pnpm test`: the direct child OBEYS SIGTERM while
 * a descendant traps it and holds the piped stdio. Then `exit` fires, the
 * caller is resolved off the `close` backstop — and the SIGKILL escalation must
 * still fire against the survivor afterwards. Settling the promise is not
 * evidence the tree is dead, so it must not cancel the force-kill (the grace
 * windows make `CLOSE_AFTER_EXIT_GRACE_MS < KILL_GRACE_MS` deterministic, not
 * racy), nor deregister the tree from the shutdown reaper. Otherwise a stranded
 * test runner keeps writing to a workspace the next iteration `git clean -fdx`es.
 */
async function testSigtermTrappingDescendantIsForceKilledAfterSettle(): Promise<void> {
  if (process.platform === "win32") {
    console.log("↷ skipped descendant force-kill test (no process groups on win32)");
    return;
  }
  assert.ok(
    CLOSE_AFTER_EXIT_GRACE_MS < KILL_GRACE_MS,
    "this test only covers the bug while the promise settles before the SIGKILL",
  );
  const grandchild =
    "process.on('SIGTERM', () => {}); process.stdout.write('gpid:' + process.pid + '\\n'); setInterval(() => {}, 1000);";
  // The direct child leaves SIGTERM at its default disposition, so the group
  // SIGTERM kills it while the grandchild soldiers on holding the pipes.
  const child = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' });
    setInterval(() => {}, 1000);
  `;
  const startedAt = Date.now();
  const result = await runCommand({
    cwd: process.cwd(),
    cmd: process.execPath,
    args: ["-e", child],
    timeoutMs: 500,
  });
  const settledAt = Date.now() - startedAt;

  assert.equal(result.timedOut, true);
  assert.ok(
    settledAt < KILL_GRACE_MS,
    `the caller must settle off \`exit\`, before the SIGKILL (took ${settledAt}ms)`,
  );

  const gpid = Number(/gpid:(\d+)/.exec(result.stdout)?.[1]);
  assert.ok(Number.isInteger(gpid), `expected the grandchild pid in stdout, got ${result.stdout}`);
  assert.equal(isAlive(gpid), true, "the grandchild must outlive the settle — that is the setup");
  assert.equal(
    killAllSpawnedTrees("SIGCONT"),
    1,
    "a settled-but-unreaped tree must stay registered for the shutdown reaper",
  );

  // SIGTERM landed at ~500ms, so the escalation is due at ~500ms + KILL_GRACE_MS.
  const deadline = startedAt + 500 + KILL_GRACE_MS + 5_000;
  while (Date.now() < deadline && isAlive(gpid)) await sleep(100);
  assert.equal(
    isAlive(gpid),
    false,
    "a SIGTERM-trapping descendant must still be SIGKILLed after the grace period",
  );
  assert.equal(killAllSpawnedTrees("SIGCONT"), 0, "the reaped tree must deregister itself");
  console.log(
    `✓ runCommand force-kills a SIGTERM-trapping descendant after settling (${settledAt}ms)`,
  );
}

async function testCleanExitIsNotTimedOut(): Promise<void> {
  const result = await runCommand({
    cwd: process.cwd(),
    cmd: process.execPath,
    args: ["-e", "process.stdout.write('hi')"],
    timeoutMs: 30_000,
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hi");
  console.log("✓ runCommand reports a clean exit without timing out");
}

/**
 * `detached: true` takes every spawn out of the runner's process group, so a
 * shutdown (Ctrl-C, restart, tmux pane teardown on cancel) no longer reaches
 * them. The tracked-tree reaper is the only thing that does — it must kill the
 * whole tree, grandchildren included, and let the pending `runCommand` settle.
 */
async function testKillAllSpawnedTreesReapsALiveTree(): Promise<void> {
  if (process.platform === "win32") {
    console.log("↷ skipped killAllSpawnedTrees test (no process groups on win32)");
    return;
  }
  const child = `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    process.stdout.write('gpid:' + g.pid + '\\n');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  const pending = runCommand({
    cwd: process.cwd(),
    cmd: process.execPath,
    args: ["-e", child],
    timeoutMs: 10 * 60 * 1000,
  });
  await sleep(1_000); // let the grandchild come up and report its pid

  const startedAt = Date.now();
  assert.equal(killAllSpawnedTrees("SIGKILL"), 1, "the live spawn must be tracked");
  const result = await pending;
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 10_000, `the reaped spawn must settle promptly (took ${elapsed}ms)`);
  assert.equal(result.timedOut, false, "reaped, not timed out");

  const gpid = Number(/gpid:(\d+)/.exec(result.stdout)?.[1]);
  assert.ok(Number.isInteger(gpid), `expected the grandchild pid in stdout, got ${result.stdout}`);
  for (let i = 0; i < 40 && isAlive(gpid); i++) await sleep(50);
  assert.equal(isAlive(gpid), false, "the grandchild must be reaped along with the group");

  // Deregistration is EVENTUAL, and waiting for it is the correct assertion rather than a
  // retry papered over a flake. There is no event for "this process group is now empty" -
  // the only sound test is `kill(-pgid, 0)`, which has to be sampled - so the moment the
  // tree is still up when the caller settles, the handback can only come from a later
  // sample (see `watchForReap`). Demanding it synchronously asserted the FAST path (tree
  // already gone at settle, reaped inline) as though it were the contract: true on an idle
  // laptop, false on a contended CI runner, and the reason this test read as flaky.
  // The loop above already concedes the same point for process death itself.
  for (let i = 0; i < 100 && killAllSpawnedTrees("SIGCONT") > 0; i++) await sleep(50);
  assert.equal(killAllSpawnedTrees("SIGKILL"), 0, "a settled spawn must deregister itself");
  console.log(`✓ killAllSpawnedTrees reaps a live tree and its grandchild (${elapsed}ms)`);
}

/**
 * A tree that is STILL ALIVE at the moment its caller settles must still be
 * deregistered once it later dies.
 *
 * This is the regression guard for the bug that made `@devpilot/runner#test`
 * fail on Linux CI while passing on every Mac: `reapIfTreeIsGone` is sampled
 * exactly once, from `settle`, so a group that was mid-death at that instant
 * was never handed back — it lingered in `liveTrees` for the life of the
 * process, and `killAllSpawnedTrees` went on signalling that pid long after it
 * had been recycled.
 *
 * Deliberately NOT written as "kill the group and hope the race lands", which
 * is what made the original symptom machine-speed dependent and invisible on an
 * idle laptop. The grandchild here is in the SAME group and holds the inherited
 * pipes, so the shape is forced rather than raced: `close` cannot fire, the
 * caller settles off the `exit` backstop while the group is provably still up,
 * and the grandchild then exits on its own.
 */
async function testTreeAliveAtSettleIsStillDeregistered(): Promise<void> {
  if (process.platform === "win32") {
    console.log("↷ skipped settle-time reap test (no process groups on win32)");
    return;
  }
  const baseline = killAllSpawnedTrees("SIGCONT");
  const child = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'inherit' });
    process.exit(0);
  `;
  const result = await runCommand({
    cwd: process.cwd(),
    cmd: process.execPath,
    args: ["-e", child],
    timeoutMs: 10 * 60 * 1000, // long: no kill timer fires, so settle is the only sample
  });
  assert.equal(result.timedOut, false, "the child exited cleanly; this is not a timeout path");
  assert.equal(
    killAllSpawnedTrees("SIGCONT"),
    baseline + 1,
    "the tree outlived the settle, so it must still be registered here",
  );

  // The grandchild exits on its own; the group is then genuinely empty.
  for (let i = 0; i < 100 && killAllSpawnedTrees("SIGCONT") > baseline; i++) await sleep(100);
  assert.equal(
    killAllSpawnedTrees("SIGCONT"),
    baseline,
    "a tree that died after its caller settled must still deregister itself",
  );
  console.log("✓ a tree still alive at settle is deregistered once it dies");
}

async function main(): Promise<void> {
  await testSigtermIgnoringChildIsForceKilled();
  await testGrandchildIsReapedWithTheGroup();
  await testSigtermTrappingDescendantIsForceKilledAfterSettle();
  await testEscapedDescendantDoesNotBlockResolution();
  await testCleanExitIsNotTimedOut();
  await testKillAllSpawnedTreesReapsALiveTree();
  await testTreeAliveAtSettleIsStillDeregistered();
  console.log("\nAll run-command tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
