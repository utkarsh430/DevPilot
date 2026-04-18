// The non-fast-forward land, against a REAL git binary and a REAL bare remote.
//
// Every claim here is a claim about GIT, not about our code shape, so a mocked
// `spawn` would prove nothing - the rule `credentials.test.ts` established. It
// matters more than usual for this defect: the broken push argv was sitting in
// `lib/engine/land-worker.ts` in plain sight the whole time, and that module
// reaches `server-only` so nothing could ever execute it.
//
// The first test REPRODUCES the production failure verbatim before the fix is
// applied to it - a plain `git push` refused `(non-fast-forward)` - so the
// remaining tests are not asserting against a world in which the bug never
// existed.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  reconcileWithRemoteBranch,
  isAncestor,
  mergeWouldChangeNothing,
  revParse,
} from "@/lib/git/reconcile-branch";

const BRANCH = "devpilot/land-a-thing";

function git(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "DevPilot Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "DevPilot Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

async function gitOk(cwd: string, args: string[]) {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.err || r.out}`);
  return r;
}

async function commit(repo: string, file: string, body: string, message: string) {
  await writeFile(path.join(repo, file), body, "utf8");
  await gitOk(repo, ["add", file]);
  await gitOk(repo, ["commit", "-m", message]);
}

let root: string;
/** The bare "GitHub". */
let remote: string;
/** The land worker's workspace. */
let workspace: string;
/** A second checkout, standing in for the other host that pushed. */
let other: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "devpilot-reconcile-"));
  remote = path.join(root, "remote.git");
  workspace = path.join(root, "workspace");
  other = path.join(root, "other");

  await gitOk(root, ["init", "--bare", "-b", "main", remote]);

  // Seed `main` from a scratch clone.
  const seed = path.join(root, "seed");
  await gitOk(root, ["clone", remote, seed]);
  await commit(seed, "README.md", "# repo\n", "initial");
  await gitOk(seed, ["push", "-u", "origin", "main"]);

  await gitOk(root, ["clone", remote, workspace]);
  await gitOk(root, ["clone", remote, other]);

  // The workspace carries a repo-local identity, exactly as the runner's
  // `prepareWorkspace` stamps on every real workspace (apps/runner/src/
  // workspace.ts). It matters here because `reconcileWithRemoteBranch` REBASES,
  // and a rebase writes new commits through the library's own `gitExec`, which
  // inherits only `process.env` - not this file's `git()` helper env. On a
  // developer machine a global `user.email` hides the gap; on CI there is none,
  // and the rebase fails with "Committer identity unknown", which read as a
  // phantom `kind: "error"` from the function under test.
  await gitOk(workspace, ["config", "user.name", "DevPilot Test"]);
  await gitOk(workspace, ["config", "user.email", "test@example.invalid"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Put the workspace and the remote branch into the production shape: the remote
 * carries a commit the workspace does not have.
 *
 * `staleTrackingRef` picks which of git's TWO rejection messages the push
 * produces, and they are the same defect wearing two hats:
 *
 *   • tracking ref up to date  → `(non-fast-forward)`  ← the string recorded on
 *                                                        #42 and #45
 *   • tracking ref never fetched → `(fetch first)`
 *
 * Both are covered by the reconcile and by `explainPushFailure`'s wording; only
 * matching one of them would leave half the shape untested.
 */
async function divergeRemoteAhead(opts: { sameFile: boolean; staleTrackingRef?: boolean }) {
  // The workspace cuts the ticket branch and pushes it.
  await gitOk(workspace, ["checkout", "-b", BRANCH]);
  await commit(workspace, "app.ts", "export const a = 1;\n", "ticket work");
  await gitOk(workspace, ["push", "-u", "origin", BRANCH]);

  // Somewhere else - another host, a re-clone, a merger's fix-up push - the
  // branch moves on.
  await gitOk(other, ["fetch", "origin", BRANCH]);
  await gitOk(other, ["checkout", "-b", BRANCH, `origin/${BRANCH}`]);
  await commit(
    other,
    opts.sameFile ? "app.ts" : "other.ts",
    opts.sameFile ? "export const a = 999;\n" : "export const b = 2;\n",
    "work from elsewhere",
  );
  await gitOk(other, ["push", "origin", BRANCH]);

  // The workspace may or may not have seen that push land in its
  // remote-tracking ref. Both states occur in production - a workspace re-enters
  // between dispatches and fetches for all sorts of reasons - and they change
  // git's rejection message but not the cause.
  if (!opts.staleTrackingRef) await gitOk(workspace, ["fetch", "origin", BRANCH]);

  // …and the workspace, unaware, commits on top of its own stale tip.
  await commit(
    workspace,
    opts.sameFile ? "app.ts" : "local.ts",
    opts.sameFile ? "export const a = 111;\n" : "export const c = 3;\n",
    "more ticket work",
  );
}

describe("the production failure, reproduced", () => {
  it("a plain push is refused (non-fast-forward) when the remote is ahead", async () => {
    await divergeRemoteAhead({ sameFile: false });
    const r = await git(workspace, ["push", "--set-upstream", "origin", BRANCH]);
    expect(r.code).not.toBe(0);
    // The exact stderr recorded on `last_error` for #42 and #45, three times each.
    expect(`${r.err}${r.out}`).toMatch(/non-fast-forward/);
  });

  it("…and (fetch first) when the tracking ref never saw the remote move", async () => {
    await divergeRemoteAhead({ sameFile: false, staleTrackingRef: true });
    const r = await git(workspace, ["push", "--set-upstream", "origin", BRANCH]);
    expect(r.code).not.toBe(0);
    expect(`${r.err}${r.out}`).toMatch(/fetch first/);
  });

  // The same workspace, the same divergence, reconciled: proves the fix covers
  // the stale-tracking-ref half too, which is the half the explicit refspec in
  // `reconcileWithRemoteBranch` exists for.
  it("reconciles the stale-tracking-ref shape just the same", async () => {
    await divergeRemoteAhead({ sameFile: false, staleTrackingRef: true });
    const result = await reconcileWithRemoteBranch({
      workspacePath: workspace,
      branch: BRANCH,
      token: "ghs_notarealtokenatallxxxxxxxx",
    });
    expect(result).toMatchObject({ kind: "ok", reconciled: true });
    expect((await git(workspace, ["push", "--set-upstream", "origin", BRANCH])).code).toBe(0);
  });
});

describe("reconcile, then push", () => {
  it("incorporates the remote commits and makes the push a fast-forward", async () => {
    await divergeRemoteAhead({ sameFile: false });

    const result = await reconcileWithRemoteBranch({
      workspacePath: workspace,
      branch: BRANCH,
      token: "ghs_notarealtokenatallxxxxxxxx",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.reconciled).toBe(true);

    // THE DATA-LOSS INVARIANT. The remote's commit is now in our history, not
    // discarded - that is the whole reason this is a rebase and not a force.
    const remoteHead = (await gitOk(other, ["rev-parse", "HEAD"])).out.trim();
    expect(await isAncestor(workspace, remoteHead, "HEAD")).toBe(true);

    // …and our own commit survived the replay.
    const log = (await gitOk(workspace, ["log", "--format=%s"])).out;
    expect(log).toContain("more ticket work");
    expect(log).toContain("work from elsewhere");
    expect(log).toContain("ticket work");

    // Both files are present, so neither side's content was lost.
    const files = await readdir(workspace);
    expect(files).toContain("other.ts");
    expect(files).toContain("local.ts");

    // The push the worker was going to make now succeeds, with NO force.
    const push = await git(workspace, ["push", "--set-upstream", "origin", BRANCH]);
    expect(push.code).toBe(0);
  });

  it("is a no-op when the remote head is already in the branch", async () => {
    await gitOk(workspace, ["checkout", "-b", BRANCH]);
    await commit(workspace, "app.ts", "export const a = 1;\n", "ticket work");
    await gitOk(workspace, ["push", "-u", "origin", BRANCH]);
    // A local commit on top: we are AHEAD of the remote, which is the ordinary
    // healthy shape and must rewrite nothing.
    await commit(workspace, "more.ts", "export const d = 4;\n", "more");
    const before = await revParse(workspace, "HEAD");

    const result = await reconcileWithRemoteBranch({
      workspacePath: workspace,
      branch: BRANCH,
      token: "ghs_notarealtokenatallxxxxxxxx",
    });
    expect(result).toEqual({
      kind: "ok",
      reconciled: false,
      reason: "remote head already in this branch",
    });
    expect(await revParse(workspace, "HEAD")).toBe(before);
  });

  it("does nothing when the branch is not on the remote yet", async () => {
    await gitOk(workspace, ["checkout", "-b", BRANCH]);
    await commit(workspace, "app.ts", "export const a = 1;\n", "ticket work");
    const before = await revParse(workspace, "HEAD");

    const result = await reconcileWithRemoteBranch({
      workspacePath: workspace,
      branch: BRANCH,
      token: "ghs_notarealtokenatallxxxxxxxx",
    });
    expect(result).toEqual({
      kind: "ok",
      reconciled: false,
      reason: "no remote branch to reconcile with",
    });
    expect(await revParse(workspace, "HEAD")).toBe(before);
  });
});

describe("a dirty reconcile is a real conflict, and destroys nothing", () => {
  it("reports the conflicting files and leaves the workspace clean", async () => {
    await divergeRemoteAhead({ sameFile: true });
    const remoteHeadBefore = (await gitOk(other, ["rev-parse", "HEAD"])).out.trim();

    const result = await reconcileWithRemoteBranch({
      workspacePath: workspace,
      branch: BRANCH,
      token: "ghs_notarealtokenatallxxxxxxxx",
    });
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") throw new Error("unreachable");
    expect(result.files).toEqual(["app.ts"]);
    expect(result.remoteHead).toBe(remoteHeadBefore);

    // The workspace is NOT left mid-rebase - a merger runs in this very
    // directory and must be able to work in it.
    const status = await git(workspace, ["status", "--porcelain"]);
    expect(status.out.trim()).toBe("");
    const rebaseInProgress = await git(workspace, ["rev-parse", "--verify", "REBASE_HEAD"]);
    expect(rebaseInProgress.code).not.toBe(0);

    // Nothing was pushed, forced or deleted: the remote branch is exactly where
    // it was, and our local commit is still ours.
    const remoteNow = (await gitOk(remote, ["rev-parse", `refs/heads/${BRANCH}`])).out.trim();
    expect(remoteNow).toBe(remoteHeadBefore);
    expect((await gitOk(workspace, ["log", "--format=%s"])).out).toContain("more ticket work");
    expect(await readFile(path.join(workspace, "app.ts"), "utf8")).toBe("export const a = 111;\n");
  });

  it("reports an error, not a conflict, when there are no conflicting files", async () => {
    await divergeRemoteAhead({ sameFile: false });
    // An uncommitted change blocks the rebase without producing any conflict
    // markers - a merger would have nothing to resolve, so this must not spawn
    // one.
    await writeFile(path.join(workspace, "other.ts"), "dirty\n", "utf8");

    const result = await reconcileWithRemoteBranch({
      workspacePath: workspace,
      branch: BRANCH,
      token: "ghs_notarealtokenatallxxxxxxxx",
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.error).toContain("no conflicting files");
  });
});

describe("isAncestor answers git's question, including the error case", () => {
  it("is false for an unrelated or unknown rev rather than throwing", async () => {
    expect(await isAncestor(workspace, "0".repeat(40), "HEAD")).toBe(false);
    expect(await isAncestor(workspace, "not-a-ref", "HEAD")).toBe(false);
  });
});

// ── already on the integration branch ──────────────────────────────────────
//
// THE MEASURED SHAPE, and the reason this needs its own detector. On `scoursh`,
// #69/#76/#77 were `done` with `landed_sha IS NULL`, no queue row, real branches
// and real commits - and their content was already on `dev`, landed earlier
// through pull requests #39/#42/#44. Those were SQUASH merges, which rewrite the
// commits, so the branch still looks completely unmerged to every cheap signal.
// Handing one to an ordinary land is how a shipped ticket acquires a conflict, a
// merger ticket and a `failed` row.

/** Squash-merge `BRANCH` into `main` from a second checkout, exactly as GitHub
 *  would: one new commit on `main` carrying the branch's whole diff, sharing no
 *  commit object with the branch. */
async function squashMergeIntoMain() {
  await gitOk(other, ["fetch", "origin", BRANCH]);
  await gitOk(other, ["checkout", "main"]);
  await gitOk(other, ["merge", "--squash", `origin/${BRANCH}`]);
  await gitOk(other, ["commit", "-m", "Land the thing (#39)"]);
  await gitOk(other, ["push", "origin", "main"]);
  await gitOk(workspace, ["fetch", "origin", "main"]);
}

describe("work already on the integration branch is a SUCCESS, not an error", () => {
  it("detects a squash-merged branch as changing nothing", async () => {
    await gitOk(workspace, ["checkout", "-b", BRANCH]);
    await commit(workspace, "app.ts", "export const a = 1;\n", "ticket work");
    await commit(workspace, "more.ts", "export const b = 2;\n", "more ticket work");
    await gitOk(workspace, ["push", "-u", "origin", BRANCH]);
    await squashMergeIntoMain();

    // Every cheaper signal says NOT landed, which is exactly why this detector
    // exists. Ancestry: the squash rewrote the commits.
    const branchHead = (await gitOk(workspace, ["rev-parse", "HEAD"])).out.trim();
    expect(await isAncestor(workspace, branchHead, "origin/main")).toBe(false);
    // Commit count: the branch is still "ahead" of main by its own two commits.
    const ahead = (await gitOk(workspace, ["rev-list", "--count", "origin/main..HEAD"])).out.trim();
    expect(Number(ahead)).toBe(2);

    // …and yet merging it would change nothing at all.
    expect(await mergeWouldChangeNothing(workspace, "main")).toBe(true);
  });

  it("still detects it once the base has moved on afterwards", async () => {
    await gitOk(workspace, ["checkout", "-b", BRANCH]);
    await commit(workspace, "app.ts", "export const a = 1;\n", "ticket work");
    await gitOk(workspace, ["push", "-u", "origin", BRANCH]);
    await squashMergeIntoMain();
    // Another ticket lands on top - so a plain tree comparison of main vs the
    // branch is NOT equal, and must not be what this rests on.
    await commit(other, "unrelated.ts", "export const z = 26;\n", "someone else's ticket");
    await gitOk(other, ["push", "origin", "main"]);
    await gitOk(workspace, ["fetch", "origin", "main"]);

    expect(await mergeWouldChangeNothing(workspace, "main")).toBe(true);
  });

  it("says NO for a branch that genuinely has work to land", async () => {
    await gitOk(workspace, ["checkout", "-b", BRANCH]);
    await commit(workspace, "app.ts", "export const a = 1;\n", "ticket work");
    await gitOk(workspace, ["fetch", "origin", "main"]);
    expect(await mergeWouldChangeNothing(workspace, "main")).toBe(false);
  });

  it("says NO for a branch that is only PARTLY landed", async () => {
    // The dangerous near-miss: one commit shipped, a later one did not. Reading
    // this as "already landed" would stamp a landing over unshipped work.
    await gitOk(workspace, ["checkout", "-b", BRANCH]);
    await commit(workspace, "app.ts", "export const a = 1;\n", "ticket work");
    await gitOk(workspace, ["push", "-u", "origin", BRANCH]);
    await squashMergeIntoMain();
    await commit(workspace, "late.ts", "export const c = 3;\n", "a later commit nobody landed");

    expect(await mergeWouldChangeNothing(workspace, "main")).toBe(false);
  });

  it("is INDETERMINATE, never a yes or a no, when the base does not resolve", async () => {
    await gitOk(workspace, ["checkout", "-b", BRANCH]);
    await commit(workspace, "app.ts", "export const a = 1;\n", "ticket work");
    expect(await mergeWouldChangeNothing(workspace, "no-such-branch")).toBe(null);
  });

  it("writes no ref and leaves the working tree untouched", async () => {
    await gitOk(workspace, ["checkout", "-b", BRANCH]);
    await commit(workspace, "app.ts", "export const a = 1;\n", "ticket work");
    await gitOk(workspace, ["push", "-u", "origin", BRANCH]);
    await squashMergeIntoMain();

    const headBefore = await revParse(workspace, "HEAD");
    const mainBefore = await revParse(workspace, "origin/main");
    await mergeWouldChangeNothing(workspace, "main");
    expect(await revParse(workspace, "HEAD")).toBe(headBefore);
    expect(await revParse(workspace, "origin/main")).toBe(mainBefore);
    expect((await git(workspace, ["status", "--porcelain"])).out.trim()).toBe("");
  });
});
