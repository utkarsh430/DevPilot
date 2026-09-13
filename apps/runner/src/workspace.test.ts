// Phase 1 / M0 — Workspace + runCommand smoke harness (opt-in).
//
// NOT a jest/vitest suite. A bare `main()` you invoke directly:
//
//   cd apps/runner
//   WORKSPACE_ROOT=/tmp tsx --env-file=../web/.env.local src/workspace.test.ts
//
// What it does:
//   1. Picks a fresh /tmp/devpilot-test-<random>/ workspace root.
//   2. Calls prepareWorkspace() against octocat/Hello-World (public).
//   3. Runs `git log -1 --oneline` via runCommand() inside the workspace.
//   4. Asserts exitCode === 0 and stdout matches /^[a-f0-9]{7,}/.
//   5. Calls cleanupWorkspace() and verifies the dir is gone.
//
// Notes:
//   - This file is NOT picked up by any test runner; running it requires the
//     same Upstash/registration env as `pnpm dev` because env.ts validates
//     those on import. Override WORKSPACE_ROOT via the shell env before
//     invocation; env.ts will pick it up.
//   - Wave 1 keeps this file as a manual sanity check. Wave 2 may upgrade
//     to a proper integration test once the runner has a test harness.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareWorkspace, cleanupWorkspace, getWorkspacePath } from "./workspace.js";
import { runCommand } from "./tools/run-command.js";

const REPO = "https://github.com/octocat/Hello-World.git";

async function main(): Promise<void> {
  const root = path.join(os.tmpdir(), `devpilot-test-${Math.random().toString(36).slice(2, 10)}`);
  // env.ts already read WORKSPACE_ROOT at import time; for the harness we
  // pass an explicit repoUrl/branchName and only rely on getWorkspacePath
  // to compute under the env's WORKSPACE_ROOT — so we override the env's
  // default by setting WORKSPACE_ROOT before launch (see header comment).
  console.log(`[smoke] env.WORKSPACE_ROOT base = (see runtime); fallback temp root = ${root}`);

  const ticketId = "smoke-ticket";
  const runId = "abcdef1234567890";

  console.log("[smoke] prepareWorkspace …");
  const ws = await prepareWorkspace({ ticketId, runId, repoUrl: REPO });
  console.log(`[smoke] cloned → ${ws.path} (branch=${ws.branch})`);

  console.log("[smoke] runCommand git log -1 --oneline …");
  const res = await runCommand({
    cwd: ws.path,
    cmd: "git",
    args: ["log", "-1", "--oneline"],
  });
  console.log(`[smoke] exit=${res.exitCode} duration=${res.durationMs}ms`);
  console.log(`[smoke] stdout: ${res.stdout.trim()}`);

  if (res.exitCode !== 0) throw new Error(`expected exit 0, got ${res.exitCode}`);
  if (!/^[a-f0-9]{7,}/.test(res.stdout.trim())) {
    throw new Error(`stdout did not match expected sha pattern: ${res.stdout.slice(0, 80)}`);
  }

  console.log("[smoke] cleanupWorkspace …");
  await cleanupWorkspace({ ticketId });
  const stillExists = await fs
    .stat(getWorkspacePath({ ticketId, runId }))
    .then(() => true)
    .catch(() => false);
  if (stillExists) throw new Error("cleanup did not remove the workspace dir");

  console.log("[smoke] OK");
}

main().catch((err) => {
  console.error("[smoke] FAIL", err);
  process.exit(1);
});
