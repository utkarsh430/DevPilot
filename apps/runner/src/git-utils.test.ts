// L1 (ticket-speed audit) — regression coverage for git-utils.ts.
//
// NOT a jest/vitest suite — the runner has no test runner wired up, so this
// follows the same bare-`main()` convention as connect-retry.test.ts /
// poll-backoff.test.ts / workspace.test.ts. Exercises real git operations
// against a throwaway bare "origin" + clone under os.tmpdir() — no network,
// no env vars needed (git-utils.ts deliberately has no env.ts dependency).
//
//   cd apps/runner
//   npx tsx src/git-utils.test.ts

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readGitFullHeadSha,
  readGitCurrentBranch,
  readGitShortHeadSha,
  isHeadPushedToOrigin,
  resolveGitSshCommand,
  runGit,
  tryRunGit,
  readGitWorkingTreeStatus,
} from "./git-utils.js";

const execFileP = promisify(execFile);

function testResolveGitSshCommand(): void {
  assert.equal(
    resolveGitSshCommand(undefined, null),
    "ssh -oBatchMode=yes",
    "with no operator preference, inject the non-interactive default",
  );
  assert.equal(
    resolveGitSshCommand("", null),
    "ssh -oBatchMode=yes",
    "an empty env var is no preference at all",
  );
  assert.equal(
    resolveGitSshCommand("ssh -i /keys/from-env", null),
    undefined,
    "an operator's GIT_SSH_COMMAND must pass through untouched",
  );
  assert.equal(
    resolveGitSshCommand(undefined, "ssh -i ~/.ssh/deploy_key"),
    undefined,
    "core.sshCommand must not be clobbered by the injected default",
  );
  console.log("✓ resolveGitSshCommand defers to GIT_SSH_COMMAND and core.sshCommand");
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileP("git", args, { cwd });
}

async function main(): Promise<void> {
  testResolveGitSshCommand();

  const base = await fs.mkdtemp(path.join(os.tmpdir(), "devpilot-git-utils-test-"));
  const originDir = path.join(base, "origin.git");
  const workDir = path.join(base, "work");

  await git(base, ["init", "--bare", "-q", originDir]);
  await execFileP("git", ["clone", "-q", originDir, workDir]);
  await git(workDir, ["config", "user.email", "test@test.com"]);
  await git(workDir, ["config", "user.name", "test"]);
  await fs.writeFile(path.join(workDir, "file.txt"), "hello\n");
  await git(workDir, ["add", "."]);
  await git(workDir, ["commit", "-q", "-m", "init"]);
  await git(workDir, ["checkout", "-q", "-b", "feature-branch"]);
  await git(workDir, ["push", "-q", "-u", "origin", "feature-branch"]);

  const branch = await readGitCurrentBranch(workDir);
  assert.equal(branch, "feature-branch");
  console.log("✓ readGitCurrentBranch returns the checked-out branch");

  const pushedBeforeCommit = await isHeadPushedToOrigin(workDir, "feature-branch");
  assert.equal(pushedBeforeCommit, true, "HEAD should already be pushed at this point");

  await fs.appendFile(path.join(workDir, "file.txt"), "unpushed change\n");
  await git(workDir, ["add", "."]);
  await git(workDir, ["commit", "-q", "-m", "unpushed commit"]);

  const shaBeforePush = await readGitFullHeadSha(workDir);
  assert.match(shaBeforePush ?? "", /^[a-f0-9]{40}$/, "expected a full 40-char sha");

  const pushedBefore = await isHeadPushedToOrigin(workDir, "feature-branch");
  assert.equal(pushedBefore, false, "unpushed commit must report pushed:false");
  console.log("✓ isHeadPushedToOrigin correctly reports false before pushing");

  await git(workDir, ["push", "-q", "origin", "feature-branch"]);
  const pushedAfter = await isHeadPushedToOrigin(workDir, "feature-branch");
  assert.equal(pushedAfter, true, "must report pushed:true after pushing");
  console.log("✓ isHeadPushedToOrigin correctly reports true after pushing");

  const shaAfterPush = await readGitFullHeadSha(workDir);
  assert.equal(shaAfterPush, shaBeforePush, "HEAD sha should be unchanged by the push itself");

  const missingBranchPushed = await isHeadPushedToOrigin(workDir, "no-such-branch");
  assert.equal(
    missingBranchPushed,
    false,
    "a nonexistent remote branch must report pushed:false, not throw",
  );
  console.log("✓ isHeadPushedToOrigin returns false (never throws) for a missing remote branch");

  const shortSha = await readGitShortHeadSha(workDir);
  assert.ok(shortSha && shortSha.length >= 7, `expected an abbreviated sha, got ${shortSha}`);
  assert.ok(
    (await readGitFullHeadSha(workDir))?.startsWith(shortSha),
    "the short sha must be a prefix of the full one",
  );
  console.log("✓ readGitShortHeadSha abbreviates the same HEAD readGitFullHeadSha reports");

  const badCwdSha = await readGitFullHeadSha(path.join(base, "not-a-repo"));
  assert.equal(badCwdSha, null, "a non-git cwd must resolve null, not throw");
  const badCwdBranch = await readGitCurrentBranch(path.join(base, "not-a-repo"));
  assert.equal(badCwdBranch, null);
  const badCwdShort = await readGitShortHeadSha(path.join(base, "not-a-repo"));
  assert.equal(badCwdShort, null);
  console.log("✓ all helpers resolve null/false (never throw) against a non-git cwd");

  // workspace.ts's `looksLikeMissingBranch` matches on `/exited 128/` - keep
  // runGit's error message shape stable or that fallback silently stops firing.
  // A missing remote ref is git's 128, the same code `clone --branch <missing>`
  // returns in the case workspace.ts is actually guarding.
  await assert.rejects(
    () => runGit(workDir, ["fetch", "origin", "no-such-branch"]),
    /exited 128/,
    "runGit must throw `git <args> exited <code>: <stderr>`",
  );
  console.log("✓ runGit throws with the `exited <code>` shape workspace.ts matches on");

  assert.equal(await tryRunGit(workDir, ["checkout", "no-such-branch"]), false);
  assert.equal(await tryRunGit(workDir, ["rev-parse", "--verify", "HEAD"]), true);
  console.log("✓ tryRunGit reports non-zero as false instead of throwing");

  // A remote that can never answer must FAIL rather than hang on a credential
  // prompt: isHeadPushedToOrigin runs before every postStepResult.
  await git(workDir, ["remote", "add", "unreachable", "https://127.0.0.1:1/nope.git"]);
  const startedAt = Date.now();
  const hung = await tryRunGit(workDir, ["fetch", "unreachable", "main"], { timeoutMs: 20_000 });
  assert.equal(hung, false, "an unreachable remote must report false, not hang");
  assert.ok(
    Date.now() - startedAt < 20_000,
    "an unreachable remote must fail fast, never block on an interactive prompt",
  );
  console.log("✓ git calls are non-interactive and bounded (no credential-prompt hang)");

  await testCoreSshCommandIsHonoured(base);
  await testWorkingTreeStatus(base);
  await testCoreAskpassIsHonoured(base);

  await fs.rm(base, { recursive: true, force: true });
  console.log("\nAll git-utils tests passed.");
}

/** An operator who authenticates an HTTPS remote through an askpass helper must
 *  still have it invoked: forcing `GIT_ASKPASS=""` would suppress both their env
 *  var and their `core.askpass`, breaking every clone/push on such a remote.
 *  Proven against a local server that always answers 401 Basic. */
async function testCoreAskpassIsHonoured(base: string): Promise<void> {
  if (process.platform === "win32" || process.env.GIT_ASKPASS) {
    console.log("↷ skipped core.askpass test (win32 or ambient GIT_ASKPASS)");
    return;
  }
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    // A cwd git-utils has never seen, so its per-cwd config cache is cold.
    const dir = path.join(base, "askpass-repo");
    const marker = path.join(base, "fake-askpass-was-invoked");
    const fakeAskpass = path.join(base, "fake-askpass.sh");
    await fs.writeFile(fakeAskpass, `#!/bin/sh\ntouch "${marker}"\necho nobody\n`, { mode: 0o755 });

    await fs.mkdir(dir, { recursive: true });
    await git(dir, ["init", "-q"]);
    await git(dir, ["config", "core.askpass", fakeAskpass]);
    // Reset any inherited credential-helper chain, which would answer before
    // git ever reaches the askpass helper this test is about.
    await git(dir, ["config", "credential.helper", ""]);
    await git(dir, ["remote", "add", "origin", `http://127.0.0.1:${port}/nope.git`]);

    const fetched = await tryRunGit(dir, ["fetch", "origin", "main"], { timeoutMs: 20_000 });
    assert.equal(fetched, false, "the server only ever answers 401, so the fetch must fail");
    await assert.doesNotReject(
      () => fs.access(marker),
      "git must have invoked the operator's core.askpass, not a forced-empty GIT_ASKPASS",
    );
    console.log("✓ core.askpass is honoured (never shadowed by a forced-empty GIT_ASKPASS)");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** An operator who pins a deploy key via `core.sshCommand` must still have it
 *  used: the non-interactive env may not inject a GIT_SSH_COMMAND that shadows
 *  it. Proven by a fake ssh binary that leaves a marker when git invokes it. */
async function testCoreSshCommandIsHonoured(base: string): Promise<void> {
  if (process.platform === "win32" || process.env.GIT_SSH_COMMAND) {
    console.log("↷ skipped core.sshCommand test (win32 or ambient GIT_SSH_COMMAND)");
    return;
  }
  // A cwd git-utils has never seen, so its per-cwd config cache is cold.
  const sshDir = path.join(base, "ssh-repo");
  const marker = path.join(base, "fake-ssh-was-invoked");
  const fakeSsh = path.join(base, "fake-ssh.sh");
  await fs.writeFile(fakeSsh, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });

  await fs.mkdir(sshDir, { recursive: true });
  await git(sshDir, ["init", "-q"]);
  await git(sshDir, ["config", "core.sshCommand", fakeSsh]);
  await git(sshDir, ["remote", "add", "origin", "ssh://git@127.0.0.1/nope.git"]);

  const fetched = await tryRunGit(sshDir, ["fetch", "origin", "main"], { timeoutMs: 20_000 });
  assert.equal(fetched, false, "the fake ssh exits 1, so the fetch must fail");
  await assert.doesNotReject(
    () => fs.access(marker),
    "git must have invoked the operator's core.sshCommand, not an injected GIT_SSH_COMMAND",
  );
  console.log("✓ core.sshCommand is honoured (never shadowed by the injected default)");
}

/**
 * `readGitWorkingTreeStatus` — the empty-delivery seam's "is there work on disk
 * to commit?" read, against REAL git.
 *
 * Every claim here is a claim about git's behaviour, not about our code shape,
 * so a fixture would only confirm what we already assumed. Two of them are
 * load-bearing in opposite directions and a test asserting only one passes for
 * an implementation with the other backwards:
 *
 *   • a CLEAN tree must be `[]`, never null — that is what routes the
 *     "produced nothing" case to a single QA-gate refusal instead of a nudge.
 *   • a NON-REPO must be null, never `[]` — an unreadable worktree inferred to
 *     be clean would silently skip a nudge on the run that needed it.
 */
async function testWorkingTreeStatus(base: string): Promise<void> {
  const dir = path.join(base, "status-repo");
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@test.com"]);
  await git(dir, ["config", "user.name", "test"]);
  await fs.writeFile(path.join(dir, "tracked.txt"), "one\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "init"]);

  const clean = await readGitWorkingTreeStatus(dir);
  assert.deepEqual(clean, [], "a clean tree must be [] — the meaningful negative, not null");

  // #27/#88's shape: tracked files the agent edited and never committed.
  await fs.appendFile(path.join(dir, "tracked.txt"), "two\n");
  const modified = await readGitWorkingTreeStatus(dir);
  assert.ok(modified !== null && modified.length === 1, "expected one modified entry");
  assert.match((modified ?? [])[0] ?? "", /tracked\.txt$/);

  // #86's shape, and the reason `git commit -a` would have lost the deliverable:
  // a brand-new UNTRACKED directory. It must be reported.
  await fs.mkdir(path.join(dir, "fixtures"), { recursive: true });
  await fs.writeFile(path.join(dir, "fixtures", "sample.json"), "{}\n");
  const withUntracked = await readGitWorkingTreeStatus(dir);
  assert.ok(
    (withUntracked ?? []).some((l) => l.startsWith("??") && l.includes("fixtures")),
    "an untracked new directory must be reported — this is exactly what `-a` misses",
  );

  // `prepareWorkspace` writes the project's secrets to `<ws>/.env.local` and adds
  // it to `.git/info/exclude`. That is what makes the blanket `git add -A` the
  // nudge recommends safe, so prove --porcelain honours the exclusion rather
  // than assuming it.
  await fs.appendFile(path.join(dir, ".git", "info", "exclude"), "\n.env.local\n");
  await fs.writeFile(path.join(dir, ".env.local"), "SECRET=shh\n");
  const withSecret = await readGitWorkingTreeStatus(dir);
  assert.ok(
    !(withSecret ?? []).some((l) => l.includes(".env.local")),
    "an excluded .env.local must never be offered to the agent as something to commit",
  );

  const notARepo = path.join(base, "not-a-repo");
  await fs.mkdir(notARepo, { recursive: true });
  assert.equal(
    await readGitWorkingTreeStatus(notARepo),
    null,
    "an unreadable worktree must be null (fail-open), never [] (inferred clean)",
  );
  console.log(
    "✓ readGitWorkingTreeStatus: clean=[], untracked reported, excluded hidden, error=null",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
