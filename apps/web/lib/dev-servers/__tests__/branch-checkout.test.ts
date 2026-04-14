import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gitExec } from "@/lib/git/exec";
import {
  BRANCH_NAME_RE,
  currentWorkspaceBranch,
  resolveRunBranch,
  switchWorkspaceToBranch,
} from "../branch-checkout";

describe("resolveRunBranch", () => {
  it("falls back to the scope's pinned branch when no pick was made", () => {
    expect(resolveRunBranch({ fallback: "devpilot/my-ticket" })).toEqual({
      ok: true,
      branch: "devpilot/my-ticket",
    });
    expect(resolveRunBranch({ requested: "", fallback: "dev" })).toEqual({
      ok: true,
      branch: "dev",
    });
    expect(resolveRunBranch({ requested: "   ", fallback: "dev" })).toEqual({
      ok: true,
      branch: "dev",
    });
    expect(resolveRunBranch({ requested: null, fallback: "dev" })).toEqual({
      ok: true,
      branch: "dev",
    });
  });

  it("honours an explicit pick, trimming surrounding whitespace", () => {
    expect(resolveRunBranch({ requested: " uat ", fallback: "devpilot/my-ticket" })).toEqual({
      ok: true,
      branch: "uat",
    });
  });

  it("rejects a branch name outside the allowed character set", () => {
    for (const bad of ["a branch", "feat;rm -rf /", "$(whoami)", "a".repeat(201), "b`c`"]) {
      expect(resolveRunBranch({ requested: bad, fallback: "dev" })).toEqual({
        ok: false,
        error: "Invalid branch name.",
      });
    }
  });

  it("shares one validator with the switch path", () => {
    expect(BRANCH_NAME_RE.test("devpilot/fix-the-thing")).toBe(true);
    expect(BRANCH_NAME_RE.test("release/1.2.3_rc-4")).toBe(true);
    expect(BRANCH_NAME_RE.test("has space")).toBe(false);
  });
});

// ── Real-git tests ─────────────────────────────────────────────────────────
// A pending-push workspace is the ONLY home of the commits on its feature
// branch until they're pushed. These drive the actual helper against a real
// clone to prove a branch-override run can't eat them.

async function git(cwd: string, args: string[]) {
  return gitExec(cwd, args, 30_000);
}

let tmpRoot: string;
let origin: string;
let workspace: string;
/** SHA of the unpushed commit on the feature branch. */
let featureSha: string;

const FEATURE_BRANCH = "devpilot/wi10-feature";

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devpilot-branch-checkout-"));
  origin = path.join(tmpRoot, "origin.git");
  workspace = path.join(tmpRoot, "workspace");

  await fs.mkdir(origin, { recursive: true });
  await git(tmpRoot, ["init", "--bare", "--initial-branch=main", origin]);

  // Seed origin with `main` and `dev` from a throwaway checkout.
  const seed = path.join(tmpRoot, "seed");
  await git(tmpRoot, ["clone", origin, seed]);
  await git(seed, ["config", "user.email", "test@devpilot.local"]);
  await git(seed, ["config", "user.name", "DevPilot Test"]);
  await fs.writeFile(path.join(seed, "README.md"), "base\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-m", "base"]);
  await git(seed, ["push", "-u", "origin", "main"]);
  await git(seed, ["checkout", "-b", "dev"]);
  await fs.writeFile(path.join(seed, "dev-only.txt"), "dev\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-m", "dev commit"]);
  await git(seed, ["push", "-u", "origin", "dev"]);

  // The workspace: a feature branch with ONE COMMIT THAT WAS NEVER PUSHED,
  // plus an uncommitted (untracked) edit on top — exactly the state the
  // Changes page shows a pending push in.
  await git(tmpRoot, ["clone", origin, workspace]);
  await git(workspace, ["config", "user.email", "test@devpilot.local"]);
  await git(workspace, ["config", "user.name", "DevPilot Test"]);
  await git(workspace, ["checkout", "-b", FEATURE_BRANCH]);
  await fs.writeFile(path.join(workspace, "feature.txt"), "precious unpushed work\n");
  await git(workspace, ["add", "-A"]);
  await git(workspace, ["commit", "-m", "unpushed feature commit"]);
  featureSha = (await git(workspace, ["rev-parse", "HEAD"])).stdout.trim();
  await fs.writeFile(path.join(workspace, "scratch.txt"), "uncommitted scratch\n");
}, 60_000);

afterAll(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("switchWorkspaceToBranch", () => {
  it("does not clobber an unpushed feature commit when an override run picks another branch", async () => {
    // Pre-condition: the commit exists only here (no remote ref for it).
    await expect(
      git(workspace, ["rev-parse", "--verify", `origin/${FEATURE_BRANCH}`]),
    ).rejects.toThrow();
    expect(await currentWorkspaceBranch(workspace)).toBe(FEATURE_BRANCH);

    // The branch-override start: operator picks `dev` on a pending-push scope.
    const res = await switchWorkspaceToBranch(workspace, "dev");
    expect(res).toEqual({ ok: true, switched: true, stashed: true });
    expect(await currentWorkspaceBranch(workspace)).toBe("dev");

    // The dev checkout is real…
    expect(await fs.readFile(path.join(workspace, "dev-only.txt"), "utf8")).toBe("dev\n");

    // …and the unpushed commit is still here, on its branch, unmodified.
    const stillThere = (await git(workspace, ["rev-parse", `${FEATURE_BRANCH}`])).stdout.trim();
    expect(stillThere).toBe(featureSha);
    const blob = (await git(workspace, ["show", `${FEATURE_BRANCH}:feature.txt`])).stdout;
    expect(blob).toBe("precious unpushed work\n");

    // The uncommitted edit rode along via the auto-stash, not the bin.
    expect(await fs.readFile(path.join(workspace, "scratch.txt"), "utf8")).toBe(
      "uncommitted scratch\n",
    );
  }, 60_000);

  it("switches back to the feature branch even though it was never pushed", async () => {
    const res = await switchWorkspaceToBranch(workspace, FEATURE_BRANCH);
    expect(res.ok).toBe(true);
    expect(await currentWorkspaceBranch(workspace)).toBe(FEATURE_BRANCH);
    expect((await git(workspace, ["rev-parse", "HEAD"])).stdout.trim()).toBe(featureSha);
    expect(await fs.readFile(path.join(workspace, "feature.txt"), "utf8")).toBe(
      "precious unpushed work\n",
    );
  }, 60_000);

  it("no-ops when the workspace is already on the requested branch", async () => {
    const res = await switchWorkspaceToBranch(workspace, FEATURE_BRANCH);
    expect(res).toEqual({ ok: true, switched: false, stashed: false });
  }, 30_000);

  it("reports a failed checkout instead of forcing it, leaving the workspace untouched", async () => {
    const res = await switchWorkspaceToBranch(workspace, "no-such-branch");
    expect(res.ok).toBe(false);
    expect(await currentWorkspaceBranch(workspace)).toBe(FEATURE_BRANCH);
    expect((await git(workspace, ["rev-parse", "HEAD"])).stdout.trim()).toBe(featureSha);
  }, 60_000);

  it("rejects an invalid branch name before touching the workspace", async () => {
    const res = await switchWorkspaceToBranch(workspace, "bad branch; rm -rf /");
    expect(res.ok).toBe(false);
    expect(await currentWorkspaceBranch(workspace)).toBe(FEATURE_BRANCH);
  });
});
