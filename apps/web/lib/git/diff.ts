// Server-side git helpers for the Phase 2 / M5c review-before-push flow.
//
// Every operation shells out to the `git` binary via `node:child_process.spawn`
// with `shell: false` so workspace paths / branch names are never interpreted
// by a shell (no command injection surface even if a future caller forgets to
// validate). The functions intentionally don't throw on non-zero exit codes:
// callers (the pending-push tracker) have richer fallback logic — e.g. an
// "unborn upstream" exit-128 from `git log origin/<branch>..HEAD` is normal
// for a freshly-scaffolded project and means "treat the whole HEAD history as
// unpushed". Mapping that into an exception class would just push the same
// recovery code one frame up.
//
// All stdout capture is bounded: the unified diff defaults to a 2 MB cap with
// a clear truncation marker so the UI can show something useful without us
// pulling a multi-gigabyte rename into memory.

import { spawn } from "node:child_process";

/** Single entry in the files-changed list. Mirrors the `pending_pushes.files_changed` JSONB shape. */
export type ChangedFile = {
  path: string;
  /**
   * Git name-status codes from `git diff --name-status`. The full alphabet
   * (A/M/D/R/C/T/U/X/B) is supported so a future renaming or copying agent
   * doesn't crash the tracker with an unexpected status letter.
   */
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X" | "B";
  additions: number;
  deletions: number;
};

/** Default cap for the captured unified diff. Sized for "render in browser without OOM". */
const DEFAULT_DIFF_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
/** Cap for short metadata stdout (commit lists, numstat, etc.). Generous; matches `git log` output for thousand-commit branches. */
const META_MAX_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Internal helper. Wraps `child_process.spawn("git", args, { cwd, shell: false })`
 * and captures stdout (capped at `maxBytes`) + stderr. Does NOT throw on
 * non-zero exit codes — callers decide whether a failure is recoverable.
 */
async function runGit(
  cwd: string,
  args: string[],
  opts: { maxBytes?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const maxBytes = opts.maxBytes ?? META_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = maxBytes - stdoutBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncated = true;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // stderr cap is hard-coded small — git's error output is always tiny.
      if (stderrChunks.reduce((n, b) => n + b.length, 0) < 64 * 1024) {
        stderrChunks.push(chunk);
      }
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      let stdout = Buffer.concat(stdoutChunks).toString("utf8");
      if (truncated) {
        stdout += "\n... [truncated at 2MB; full diff available via git show] ...\n";
      }
      resolve({
        stdout,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code ?? -1,
      });
    });
  });
}

/**
 * Returns the SHAs of commits on HEAD that aren't on `origin/<branch>`, newest
 * first. If `origin/<branch>` doesn't exist (unborn upstream — common right
 * after a project scaffold against an empty GitHub repo), falls back to
 * `git log HEAD` so every commit on the branch is treated as unpushed.
 * Returns `[]` for a branch with zero commits.
 */
export async function getUnpushedCommits(workspacePath: string, branch: string): Promise<string[]> {
  // First attempt: the normal case where the remote tracking branch exists.
  const primary = await runGit(workspacePath, [
    "log",
    `origin/${branch}..HEAD`,
    "--pretty=format:%H",
  ]);
  if (primary.exitCode === 0) {
    return primary.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  // Fallback: unborn upstream. `git log` against just HEAD returns every
  // commit reachable from the current tip. Failure here (e.g. HEAD itself
  // doesn't exist — branch is empty) is mapped to an empty list.
  const fallback = await runGit(workspacePath, ["log", "HEAD", "--pretty=format:%H"]);
  if (fallback.exitCode !== 0) return [];
  return fallback.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Returns the per-file change list between `origin/<branch>` and `HEAD`,
 * combining `git diff --name-status` (path + status letter) with
 * `git diff --numstat` (additions + deletions). When the upstream is unborn,
 * diffs against the empty tree (`git diff <emptyTreeSha>..HEAD`) so a brand
 * new project still surfaces every scaffolded file.
 */
export async function getFilesChanged(
  workspacePath: string,
  branch: string,
): Promise<ChangedFile[]> {
  // Determine the diff base. Try `origin/<branch>..HEAD` first; if the
  // upstream is unborn we'll use the empty-tree SHA instead.
  let nameStatus = await runGit(workspacePath, ["diff", "--name-status", `origin/${branch}..HEAD`]);
  let numstat = await runGit(workspacePath, ["diff", "--numstat", `origin/${branch}..HEAD`]);

  if (nameStatus.exitCode !== 0 || numstat.exitCode !== 0) {
    // Resolve the empty-tree SHA (deterministic, but ask git so we don't hard
    // code a constant and silently break on a future hash-algorithm change).
    const emptyTreeRes = await runGit(workspacePath, ["hash-object", "-t", "tree", "/dev/null"]);
    const emptyTree = emptyTreeRes.stdout.trim();
    if (!emptyTree) return [];
    nameStatus = await runGit(workspacePath, ["diff", "--name-status", `${emptyTree}..HEAD`]);
    numstat = await runGit(workspacePath, ["diff", "--numstat", `${emptyTree}..HEAD`]);
    if (nameStatus.exitCode !== 0 || numstat.exitCode !== 0) return [];
  }

  // Parse --numstat: "<additions>\t<deletions>\t<path>". Binary files are
  // reported as "-\t-\t<path>".
  const numstatMap = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addRaw, delRaw, ...pathParts] = parts;
    const path = pathParts.join("\t");
    const additions = addRaw === "-" ? 0 : Number.parseInt(addRaw ?? "", 10) || 0;
    const deletions = delRaw === "-" ? 0 : Number.parseInt(delRaw ?? "", 10) || 0;
    numstatMap.set(path, { additions, deletions });
  }

  // Parse --name-status: "<status>\t<path>" or "<status>\t<oldPath>\t<newPath>"
  // for R/C entries (rename/copy). We attribute the line counts to the new
  // path so the UI can scroll to it directly.
  const valid = new Set(["A", "M", "D", "R", "C", "T", "U", "X", "B"]);
  const out: ChangedFile[] = [];
  for (const line of nameStatus.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    // R100 / C90 etc. include a similarity score after the letter; strip it.
    const letter = (parts[0] ?? "").charAt(0).toUpperCase();
    if (!valid.has(letter)) continue;
    const status = letter as ChangedFile["status"];
    const path = (status === "R" || status === "C") && parts.length >= 3 ? parts[2]! : parts[1]!;
    const counts = numstatMap.get(path) ?? { additions: 0, deletions: 0 };
    out.push({ path, status, additions: counts.additions, deletions: counts.deletions });
  }
  return out;
}

/**
 * Returns the unified diff between `origin/<branch>` and `HEAD`. If the
 * upstream is unborn, diffs against the empty tree. Truncated at
 * `opts.maxBytes` (default 2 MB) with an explicit marker the UI can detect.
 */
export async function getUnifiedDiff(
  workspacePath: string,
  branch: string,
  opts: { maxBytes?: number } = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? DEFAULT_DIFF_MAX_BYTES;
  const primary = await runGit(workspacePath, ["diff", "--unified=3", `origin/${branch}..HEAD`], {
    maxBytes,
  });
  if (primary.exitCode === 0) return primary.stdout;
  // Unborn upstream — fall back to the empty tree.
  const emptyTreeRes = await runGit(workspacePath, ["hash-object", "-t", "tree", "/dev/null"]);
  const emptyTree = emptyTreeRes.stdout.trim();
  if (!emptyTree) return "";
  const fallback = await runGit(workspacePath, ["diff", "--unified=3", `${emptyTree}..HEAD`], {
    maxBytes,
  });
  if (fallback.exitCode !== 0) return "";
  return fallback.stdout;
}

/** Returns the SHA of HEAD. Returns null for an unborn branch (no commits yet). */
export async function getHeadSha(workspacePath: string): Promise<string | null> {
  const res = await runGit(workspacePath, ["rev-parse", "HEAD"]);
  if (res.exitCode !== 0) return null;
  const sha = res.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/** Returns the current branch name. Throws if the workspace isn't a git repo. */
export async function getCurrentBranch(workspacePath: string): Promise<string> {
  const res = await runGit(workspacePath, ["branch", "--show-current"]);
  if (res.exitCode !== 0) {
    throw new Error(
      `git branch --show-current failed in ${workspacePath}: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
    );
  }
  const branch = res.stdout.trim();
  if (!branch) {
    // Detached HEAD: --show-current returns empty. Treat as a hard error
    // because the pending-push flow is meaningless without a branch name
    // to push to.
    throw new Error(`workspace ${workspacePath} is on a detached HEAD`);
  }
  return branch;
}
