// Regression coverage for the workspace reap guard (workspace-reap-guard.ts)
// and for `cleanupWorkspace`'s refusal to destroy unpushed commits.
//
// The bug this locks down: the reaper deleted a ticket's workspace when the
// ticket went terminal, EVEN IF the branch had never been pushed. Those commits
// existed nowhere else, so they were gone - silently, while the ticket read
// `done`. See apps/web/lib/workspace/unpushed-work.ts for the engine-side half.
//
// NOT a vitest suite - the runner has no test runner wired up, so this follows
// the same bare-`main()` convention as git-utils.test.ts / poll-backoff.test.ts.
// Exercises real git against a throwaway bare "origin" + clones under
// os.tmpdir(): no network, no Redis, no engine.
//
//   cd apps/runner
//   npx tsx src/workspace-reap-guard.test.ts

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkWorkspaceReapSafety } from "./workspace-reap-guard.js";

const execFileP = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileP("git", args, { cwd });
}

/** A bare repo to act as `origin`, plus a clone of it. */
async function makeOriginAndClone(
  base: string,
  cloneName: string,
): Promise<{ origin: string; clone: string }> {
  const origin = path.join(base, "origin.git");
  await fs.mkdir(origin, { recursive: true });
  await git(origin, ["init", "--bare", "--initial-branch=main"]);

  const seed = path.join(base, "seed");
  await fs.mkdir(seed, { recursive: true });
  await git(seed, ["init", "--initial-branch=main"]);
  await git(seed, ["config", "user.email", "test@devpilot.local"]);
  await git(seed, ["config", "user.name", "DevPilot Test"]);
  await fs.writeFile(path.join(seed, "README.md"), "seed\n", "utf8");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-m", "seed"]);
  await git(seed, ["remote", "add", "origin", origin]);
  await git(seed, ["push", "-u", "origin", "main"]);

  const clone = path.join(base, cloneName);
  await git(base, ["clone", origin, clone]);
  await git(clone, ["config", "user.email", "test@devpilot.local"]);
  await git(clone, ["config", "user.name", "DevPilot Test"]);
  return { origin, clone };
}

/** Commit a file on a new `devpilot/<name>` branch. Does NOT push. */
async function commitOnBranch(cwd: string, branch: string, file: string): Promise<void> {
  await git(cwd, ["checkout", "-b", branch]);
  await fs.writeFile(path.join(cwd, file), "agent work that exists nowhere else\n", "utf8");
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", `work on ${branch}`]);
}

async function testFreshCloneIsSafe(base: string): Promise<void> {
  const { clone } = await makeOriginAndClone(path.join(base, "fresh"), "ws");
  const verdict = await checkWorkspaceReapSafety(clone);
  assert.equal(verdict.safeToDelete, true, "a clone with no local-only commits is safe to reap");
  console.log("✓ fresh clone (nothing local-only) is safe to reap");
}

async function testUnpushedCommitsAreHeld(base: string): Promise<void> {
  const { clone } = await makeOriginAndClone(path.join(base, "unpushed"), "ws");
  await commitOnBranch(clone, "devpilot/unpushed-work", "feature.ts");

  const verdict = await checkWorkspaceReapSafety(clone);
  assert.equal(verdict.safeToDelete, false, "a workspace with an unpushed commit must be HELD");
  assert.ok(!verdict.safeToDelete && verdict.unpushedCommits === 1, "counts the stranded commit");
  assert.match(
    (verdict as { reason: string }).reason,
    /exist on no remote/,
    "the reason names the actual hazard",
  );
  console.log("✓ workspace with unpushed commits is held (not reaped)");
}

async function testPushedCommitsAreSafe(base: string): Promise<void> {
  const { clone } = await makeOriginAndClone(path.join(base, "pushed"), "ws");
  await commitOnBranch(clone, "devpilot/pushed-work", "feature.ts");
  await git(clone, ["push", "-u", "origin", "devpilot/pushed-work"]);

  const verdict = await checkWorkspaceReapSafety(clone);
  assert.equal(
    verdict.safeToDelete,
    true,
    "once the branch is on the remote the workspace is redundant and IS reapable",
  );
  console.log("✓ workspace whose commits are all pushed is safe to reap");
}

async function testCommitStrandedOnNonCheckedOutBranchIsHeld(base: string): Promise<void> {
  // The commit lives on `devpilot/side`, but HEAD is back on `main`. A guard that
  // only asked "is HEAD pushed?" would happily delete this workspace.
  const { clone } = await makeOriginAndClone(path.join(base, "stranded"), "ws");
  await commitOnBranch(clone, "devpilot/side", "feature.ts");
  await git(clone, ["checkout", "main"]);

  const verdict = await checkWorkspaceReapSafety(clone);
  assert.equal(
    verdict.safeToDelete,
    false,
    "a commit stranded on a non-checked-out local branch must still hold the workspace",
  );
  console.log("✓ commit on a non-checked-out branch still holds the workspace");
}

async function testMissingPathIsSafe(base: string): Promise<void> {
  const verdict = await checkWorkspaceReapSafety(path.join(base, "does-not-exist"));
  assert.equal(
    verdict.safeToDelete,
    true,
    "nothing on disk = nothing to lose (keeps reap idempotent)",
  );
  console.log("✓ missing workspace path is safe (cleanup stays idempotent)");
}

async function testNonGitDirIsSafe(base: string): Promise<void> {
  const dir = path.join(base, "not-a-repo");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "stuff.txt"), "x", "utf8");
  const verdict = await checkWorkspaceReapSafety(dir);
  assert.equal(verdict.safeToDelete, true, "no .git = no commits to strand");
  console.log("✓ non-git directory is safe to reap");
}

async function testUnreadableRepoFailsClosed(base: string): Promise<void> {
  // A `.git` that git cannot read: the guard must NOT interpret "I don't know"
  // as "go ahead and delete".
  const dir = path.join(base, "corrupt");
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  await fs.writeFile(path.join(dir, ".git", "HEAD"), "garbage\n", "utf8");

  const verdict = await checkWorkspaceReapSafety(dir);
  assert.equal(verdict.safeToDelete, false, "an unreadable repo must FAIL CLOSED (keep the data)");
  assert.match(
    (verdict as { reason: string }).reason,
    /could not determine/,
    "the reason says we could not prove safety",
  );
  console.log("✓ unreadable git repo fails closed (refuses to delete)");
}

/**
 * End-to-end through `cleanupWorkspace` itself - the function that actually
 * runs the `rm -rf`. This is the assertion that would have caught the bug:
 * the directory must still be on disk afterwards.
 */
async function testCleanupWorkspaceRefusesToDestroyUnpushedWork(base: string): Promise<void> {
  const workspaceRoot = path.join(base, "e2e-root");
  await fs.mkdir(workspaceRoot, { recursive: true });

  // `env.ts` validates on import, so seed the vars it requires before pulling
  // `workspace.js` in. WORKSPACE_ROOT is the only one this test path reads.
  process.env.UPSTASH_REDIS_REST_URL ??= "http://localhost:0";
  process.env.UPSTASH_REDIS_REST_TOKEN ??= "test-token";
  process.env.DEVPILOT_RUNNER_REGISTRATION_KEY ??= "test-key";
  process.env.DEVPILOT_RUNNER_TENANT_ID ??= "00000000-0000-0000-0000-000000000000";
  process.env.WORKSPACE_ROOT = workspaceRoot;
  const { cleanupWorkspace } = await import("./workspace.js");

  // --- a ticket whose workspace holds unpushed commits: NOT reaped ---------
  const heldTicket = "11111111-1111-1111-1111-111111111111";
  const heldStage = path.join(base, "held-stage");
  await fs.mkdir(heldStage, { recursive: true });
  const held = await makeOriginAndClone(heldStage, "clone");
  await commitOnBranch(held.clone, "devpilot/unpushed", "feature.ts");
  const heldWs = path.join(workspaceRoot, heldTicket);
  await fs.rename(held.clone, heldWs);

  const heldResult = await cleanupWorkspace({ ticketId: heldTicket });
  assert.equal(
    heldResult.removed,
    false,
    "cleanupWorkspace must REFUSE a workspace with unpushed work",
  );
  assert.equal(
    await dirExists(heldWs),
    true,
    "THE BUG: the workspace holding the only copy of the commits was deleted",
  );
  console.log("✓ cleanupWorkspace refuses a workspace with unpushed commits (dir survives)");

  // --- a ticket whose work is fully pushed: reaped normally ----------------
  const reapTicket = "22222222-2222-2222-2222-222222222222";
  const reapStage = path.join(base, "reap-stage");
  await fs.mkdir(reapStage, { recursive: true });
  const reapable = await makeOriginAndClone(reapStage, "clone");
  await commitOnBranch(reapable.clone, "devpilot/pushed", "feature.ts");
  await git(reapable.clone, ["push", "-u", "origin", "devpilot/pushed"]);
  const reapWs = path.join(workspaceRoot, reapTicket);
  await fs.rename(reapable.clone, reapWs);

  const reapResult = await cleanupWorkspace({ ticketId: reapTicket });
  assert.equal(reapResult.removed, true, "a fully-pushed workspace is still reaped");
  assert.equal(await dirExists(reapWs), false, "the reaped workspace is gone from disk");
  console.log("✓ cleanupWorkspace still reaps a workspace whose commits are all pushed");

  // --- the DELIBERATE-DISCARD override: force wipes unpushed work ------------
  //
  // `cleanupWorkspace({ force: true })` — set ONLY by the operator "Discard &
  // restart from dev" action — wipes a workspace even when it holds unpushed
  // commits. This is the sanctioned release of the data-loss hold. The SAME
  // workspace with the default (no force) call must still be REFUSED, proving the
  // guard is intact for the reaper / safe restart and the override is reachable
  // only via the explicit flag. Reuses this test's `workspaceRoot` because
  // `env.WORKSPACE_ROOT` is frozen at the first `workspace.js` import.
  const forceTicket = "33333333-3333-3333-3333-333333333333";
  const forceStage = path.join(base, "force-stage");
  await fs.mkdir(forceStage, { recursive: true });
  const forceHeld = await makeOriginAndClone(forceStage, "clone");
  await commitOnBranch(forceHeld.clone, "devpilot/unpushed", "feature.ts");
  const forceWs = path.join(workspaceRoot, forceTicket);
  await fs.rename(forceHeld.clone, forceWs);

  // Default call: the guard REFUSES (the workspace holds the only copy).
  const forceHeldResult = await cleanupWorkspace({ ticketId: forceTicket });
  assert.equal(forceHeldResult.removed, false, "default cleanup must REFUSE unpushed work");
  assert.equal(await dirExists(forceWs), true, "the guarded workspace survives the default call");

  // Forced call: the same workspace is wiped — the operator confirmed the discard.
  const forced = await cleanupWorkspace({ ticketId: forceTicket, force: true });
  assert.equal(forced.removed, true, "force discard must wipe the workspace");
  assert.equal(await dirExists(forceWs), false, "the forced-discard workspace is gone from disk");
  console.log(
    "✓ cleanupWorkspace({ force }) overrides the guard; the default call on the same dir still refuses",
  );
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "devpilot-reap-guard-"));
  try {
    await testFreshCloneIsSafe(base);
    await testUnpushedCommitsAreHeld(base);
    await testPushedCommitsAreSafe(base);
    await testCommitStrandedOnNonCheckedOutBranchIsHeld(base);
    await testMissingPathIsSafe(base);
    await testNonGitDirIsSafe(base);
    await testUnreadableRepoFailsClosed(base);
    await testCleanupWorkspaceRefusesToDestroyUnpushedWork(base);
    console.log("\nAll workspace-reap-guard tests passed.");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
