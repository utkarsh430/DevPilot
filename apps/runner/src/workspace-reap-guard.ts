// Runner-side reap guard: refuse to delete a workspace that still holds commits
// which exist on no remote.
//
// Why a SECOND guard
// ------------------
// The engine already declines to enqueue cleanup for a ticket with an unpushed
// `pending_pushes` row (`apps/web/lib/engine/workspace-reaper.ts`). That check
// reads the DB's *mirror* of the workspace. This one reads the workspace
// itself, and it sits directly in front of the `rm -rf`, so it also covers:
//
//   • a cleanup job that was enqueued before the work landed and popped after;
//   • a `pending_pushes` row that was never written (the tracker only runs on
//     the post-run path - a crashed or skipped tracker leaves commits with no
//     row at all, which is precisely the case the DB check cannot see);
//   • any FUTURE caller of `cleanupWorkspace`, which inherits the guard for
//     free rather than having to remember it.
//
// The predicate
// -------------
// `git log --branches --not --remotes` = every commit reachable from any local
// branch that is reachable from NO remote-tracking ref. Non-empty means the
// workspace is the only copy. That is exactly the work-loss condition, and it
// is stronger than "is HEAD pushed" (it catches commits stranded on a local
// branch that is not currently checked out).
//
// Deliberately NOT part of the predicate: uncommitted/untracked files. A
// settled workspace is full of build artifacts and node_modules, so holding on
// a dirty tree would hold every workspace forever. Committed work is the thing
// that is intentional, and it is the thing this guard protects. (`prepareWorkspace`
// separately auto-stashes an operator's uncommitted edits before it resets.)
//
// FAIL CLOSED. Every error path - not a git repo? git missing? command timed
// out? - resolves to "do not delete". Deleting is irreversible and losing a
// workspace we could have kept costs disk; keeping one we could have deleted
// costs nothing that matters.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const GIT_TIMEOUT_MS = 20_000;

export type ReapGuardVerdict =
  /** No local-only commits. Safe to delete. */
  | { safeToDelete: true }
  /** Local-only commits exist, or we could not prove they do not. Keep it. */
  | { safeToDelete: false; reason: string; unpushedCommits?: number };

/**
 * Is `workspacePath` safe to `rm -rf`?
 *
 * A path that does not exist is trivially safe (there is nothing to lose), which
 * keeps cleanup idempotent - re-running a cleanup job for an already-removed
 * workspace is still a no-op.
 */
export async function checkWorkspaceReapSafety(workspacePath: string): Promise<ReapGuardVerdict> {
  if (!(await dirExists(workspacePath))) {
    return { safeToDelete: true };
  }
  // No `.git` means no commits to strand. A bare directory of files is not
  // work-in-progress we can meaningfully protect, and the reaper is the only
  // thing that puts files here in the first place.
  if (!(await dirExists(path.join(workspacePath, ".git")))) {
    return { safeToDelete: true };
  }

  const res = await gitLines(workspacePath, [
    "log",
    "--branches",
    "--not",
    "--remotes",
    "--format=%H",
  ]);
  if (!res.ok) {
    return {
      safeToDelete: false,
      reason: `could not determine whether the workspace holds unpushed commits (${res.error}); refusing to delete`,
    };
  }
  if (res.lines.length === 0) {
    return { safeToDelete: true };
  }
  return {
    safeToDelete: false,
    reason:
      `workspace holds ${res.lines.length} commit${res.lines.length === 1 ? "" : "s"} ` +
      "that exist on no remote; deleting it would destroy them",
    unpushedCommits: res.lines.length,
  };
}

type GitLinesResult = { ok: true; lines: string[] } | { ok: false; error: string };

/** Run git and return stdout split into non-empty lines. Never throws. */
function gitLines(cwd: string, args: string[]): Promise<GitLinesResult> {
  return new Promise<GitLinesResult>((resolve) => {
    let settled = false;
    const done = (r: GitLinesResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
      done({ ok: false, error: `git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms` });
    }, GIT_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", (err) => done({ ok: false, error: err.message }));
    child.on("close", (code) => {
      if (code !== 0) {
        return done({ ok: false, error: `git ${args[0]} exited ${code}: ${stderr.trim()}` });
      }
      done({
        ok: true,
        lines: stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      });
    });
  });
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
