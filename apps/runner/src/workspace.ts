// Phase 1 / M0 — Engineer git workspace lifecycle (Wave 1, runner-side only).
//
// One working copy per TICKET — keyed by `(ticketId)` only — so every run on
// the same ticket (PM, Engineer, QA, Engineer-retry, …) shares the same
// branch `devpilot/<ticketSlug>` and the same on-disk tree. Sequential by
// construction: the dispatcher only fans out *reviewer* roles concurrently
// (M6), and reviewers don't modify the workspace.
//
// Why one-per-ticket and not one-per-run: a QA rejection retry needs the
// engineer to see (and iterate on) its previous commit. Keying by runId
// gives every retry a virgin clone, so the engineer either restarts the
// work from scratch or — worse — hallucinates completion against an empty
// branch (which is exactly the failure mode QA was catching in the
// password-reset ticket: "verbatim copies of pre-rejection summaries").
//
// On re-entry the previous run's uncommitted leftovers are discarded with
// `git reset --hard HEAD` + `git clean -fdx`. Committed work is preserved.
// A `runId` is still accepted in the input for backwards compat (and is
// echoed back in logs) but does not affect the path or branch.
//
// All git ops use `child_process.spawn` with explicit args (no shell). All
// filesystem ops use `node:fs/promises`.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";
import { postSystemCommentToTicket } from "./engine-client.js";
import { checkWorkspaceReapSafety } from "./workspace-reap-guard.js";
// One implementation of the git primitives, shared with the verification hook.
// `readGitCurrentBranch` detects whether an existing workspace is already on a
// per-ticket branch (C4 back-compat); `git`/`tryGit` keep their local names so
// the ~15 call sites below read unchanged.
import { runGit as git, tryRunGit as tryGit, readGitCurrentBranch } from "./git-utils.js";
import { isTicketBranch, ticketBranch } from "./ticket-branch.js";

export type PrepareWorkspaceInput = {
  ticketId: string;
  runId: string;
  repoUrl?: string;
  branchName?: string;
  /** Optional ticket slug to make the branch name human-readable. Falls back to ticketId. */
  ticketSlug?: string;
  /** Phase 2 / M5a — GitHub OAuth access token for the project owner. When
   *  supplied alongside an `https://` repoUrl, we rewrite the `origin` remote
   *  to embed `https://x-access-token:<token>@github.com/…` so the runner can
   *  push private repos without an SSH key. NEVER log this; the rewritten URL
   *  is treated as a secret in all log statements below. */
  githubToken?: string;
  /** Phase 2 / M5a — `git config user.name` for commits produced in this
   *  workspace. Falls back to "DevPilot Engineer". */
  gitAuthorName?: string;
  /** Phase 2 / M5a — `git config user.email` for commits produced in this
   *  workspace. Falls back to "engineer@devpilot.internal". */
  gitAuthorEmail?: string;
  /** Slice A — serialised JSON of per-project encrypted env values
   *  ({"DATABASE_URL":"…", "STRIPE_API_KEY":"…"}) or undefined when the
   *  project has no secrets. We write `<workspacePath>/.env.local` AND
   *  append `.env.local` to `.git/info/exclude` so the agent can never
   *  accidentally commit it. NEVER log this value. */
  projectSecretsJson?: string;
  /** Slice IB — base branch the workspace's `devpilot/<slug>` should branch
   *  from. Resolved upstream to `project.integration_branch ?? project.
   *  default_branch ?? "main"`. Undefined falls back to the repo's
   *  default branch (whatever `git clone` picks), preserving legacy
   *  behavior for jobs that pre-date this field. */
  baseBranch?: string;
  /** WI-5.2 — the exact commit on `baseBranch` to cut `devpilot/<slug>` from.
   *  Set only for a `builds_on` child whose parent has LANDED on the integration
   *  branch: the child is rooted at the parent's `landed_sha` rather than at
   *  whatever the tip happens to be when we clone, so a stacked ticket gets a
   *  tree that provably contains its parent's work and nothing that landed after
   *  it. Undefined = branch from the tip (every other job). */
  baseSha?: string;
};

export type PrepareWorkspaceOutput = {
  path: string;
  branch: string;
};

export type CleanupWorkspaceInput = {
  ticketId: string;
  runId?: string;
  /**
   * DELIBERATE-DISCARD override. When true, skip the reap guard and delete the
   * workspace even if it holds commits that exist on no remote. This is set ONLY
   * by the operator "Discard & restart from dev" flow (an explicit, confirmed,
   * human-initiated discard); the reaper and the safe "Restart from dev" never
   * pass it, so their refuse-on-unpushed protection is fully intact. Default
   * (absent/false) preserves the guard byte-for-byte.
   */
  force?: boolean;
};

/**
 * Pure path computation; does not touch the filesystem.
 *
 * Keyed by ticketId only — every run on a ticket shares the same workspace
 * directory so retries can iterate on prior commits. The `runId` parameter
 * is accepted for backwards compatibility but is intentionally ignored.
 *
 * Slice IB-B — when a merger ticket (release_engineer) inherits the source
 * ticket's workspace, the caller passes the source ticketId here (via the
 * `workspaceTicketId` field on the runner job) and the merger writes into
 * the same on-disk tree the conflict was detected in.
 */
export function getWorkspacePath(params: { ticketId: string; runId?: string }): string {
  return path.join(env.WORKSPACE_ROOT, params.ticketId);
}

/**
 * Clone `repoUrl` into the workspace dir for `(ticketId, runId)` and check
 * out a fresh branch. Idempotent — if the workspace already has a `.git`
 * dir, we `git fetch` and `git checkout` instead of re-cloning. Throws with
 * a clear error if neither `repoUrl` nor `ENGINEER_REPO_URL` is set.
 */
export async function prepareWorkspace(
  input: PrepareWorkspaceInput,
): Promise<PrepareWorkspaceOutput> {
  const repoUrl = input.repoUrl ?? env.ENGINEER_REPO_URL;
  if (!repoUrl) {
    throw new Error(
      "prepareWorkspace: no repoUrl provided and ENGINEER_REPO_URL is unset. " +
        "Set ENGINEER_REPO_URL in the runner env or pass `repoUrl` explicitly.",
    );
  }

  const workspacePath = getWorkspacePath({ ticketId: input.ticketId });
  // Branch name is keyed by ticket only — every run on this ticket lands on
  // the same branch so QA / retries see the engineer's prior commits.
  //
  // C4 — `input.ticketSlug` carries the engine-resolved title slug. Falls
  // through to slugify(ticketId) when absent (pre-C4 jobs + ad-hoc tests).
  let branch = input.branchName ?? ticketBranch(slugify(input.ticketSlug ?? input.ticketId));

  await fs.mkdir(path.dirname(workspacePath), { recursive: true });

  const existingGitDir = await dirExists(path.join(workspacePath, ".git"));

  if (existingGitDir) {
    // Re-entry: refresh refs, switch to (or create) the ticket branch, and
    // discard any uncommitted leftovers from a previous run that crashed
    // mid-iteration. We KEEP committed history so a QA-rejection retry can
    // iterate on the engineer's prior commit.
    await git(workspacePath, ["fetch", "--all", "--prune"]);

    // C4 backwards-compat — if the existing workspace is already on a
    // per-ticket branch (typically the pre-C4 UUID slug like
    // `devpilot/30153ef9-…`) and that branch differs from the new title-derived
    // slug, KEEP the existing branch. Otherwise an in-flight ticket would
    // suddenly fork onto a new branch mid-loop and the engineer's prior commits
    // would be stranded. The engine separately back-writes the actual branch
    // name into tickets.git_branch_name on the next run-agent dispatch, so the
    // next iteration's `ticketSlug` will already match.
    //
    // ⚠️ `isTicketBranch` matches BOTH `devpilot/` and the pre-rename `ace/`, and
    // the `ace` half is LOAD-BEARING here, not dead code: every workspace cut
    // before the rename is still sitting on an `ace/<slug>` branch. Narrow it to
    // `devpilot/` only and we `checkout -b` a fresh branch on top of one of
    // those, stranding the engineer's prior commits on a branch nothing points
    // at any more — and in some of these workspaces those commits were never
    // pushed, so the workspace is their only copy. See ticket-branch.ts.
    const currentBranch = await readGitCurrentBranch(workspacePath);
    if (currentBranch && isTicketBranch(currentBranch) && currentBranch !== branch) {
      branch = currentBranch;
    }

    const switched = await tryGit(workspacePath, ["checkout", branch]);
    if (!switched) {
      await git(workspacePath, ["checkout", "-b", branch]);
    }
    // Hard-reset working tree to the branch HEAD and drop untracked files.
    // Committed work on the branch is preserved; only uncommitted garbage
    // from a previous crashed iteration disappears. Skip the reset when
    // HEAD is unborn (no commits on the branch yet) — typically the case
    // on the second-and-later runs of a ticket whose remote was empty and
    // whose first run (e.g. PM) didn't commit. Re-cloning would be wrong;
    // the engineer's about to land the first commit on this branch.
    const hasCommit = await tryGit(workspacePath, ["rev-parse", "--verify", "HEAD"]);
    if (hasCommit) {
      // Slice C — auto-stash operator's uncommitted edits before the hard
      // reset clobbers them. Operators routinely open the workspace in
      // local VS Code (via the new "Open in VS Code" affordance) to drop
      // scaffolding files or tweak config the agent missed. Without this
      // stash, the next agent run silently destroys those edits. Stashing
      // is non-destructive: `git stash list` shows it; `git stash apply`
      // (or `pop`) restores. We also drop a breadcrumb comment on the
      // ticket so the recovery hint is visible in the timeline, not just
      // in the local reflog.
      const dirty = await readGitStatusPorcelain(workspacePath);
      if (dirty.length > 0) {
        const stashMsg = `devpilot-operator-edits-${input.ticketId}-${new Date().toISOString()}`;
        const stashed = await tryGit(workspacePath, [
          "stash",
          "push",
          "--include-untracked",
          "-m",
          stashMsg,
        ]);
        if (stashed) {
          console.warn(
            `[workspace] auto-stashed ${dirty.length} uncommitted operator edit(s) before reset (ticket=${input.ticketId})`,
          );
          // Best-effort breadcrumb. Fire-and-forget; the call wraps its
          // own try/catch and never throws, so we don't await failures.
          void postSystemCommentToTicket({
            ticketId: input.ticketId,
            body: `Auto-stashed ${dirty.length} uncommitted local edit${dirty.length === 1 ? "" : "s"} before agent run. Recover with \`git stash apply\` in the workspace (or \`git stash list\` to see the ref). Stash ref: \`${stashMsg}\`.`,
          });
        } else {
          console.warn(
            `[workspace] auto-stash failed (ticket=${input.ticketId}); proceeding with hard reset anyway`,
          );
        }
      }
      await git(workspacePath, ["reset", "--hard", "HEAD"]);
    }
    await git(workspacePath, ["clean", "-fdx"]);
  } else {
    // Ensure the leaf doesn't exist as a non-git directory (would confuse clone).
    if (await pathExists(workspacePath)) {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
    // Slice IB — when an `integration_branch` (e.g. "dev") is configured on
    // the project, clone that branch as the workspace's starting point so
    // the `devpilot/<slug>` branch we cut next is rooted at the integration
    // tip rather than at `main`. The promote-integration action later
    // moves work from integration_branch → default_branch as a separate
    // step. Undefined baseBranch preserves the legacy "clone the repo's
    // default branch" behavior.
    //
    // Fallback: if the configured base branch doesn't exist on the remote
    // (`exit 128: fatal: Remote branch <X> not found in upstream origin`),
    // re-attempt the clone WITHOUT --branch and then create the missing
    // integration branch locally from whatever HEAD ended up being. This
    // catches projects that were created outside the "Create new repo"
    // flow (which auto-seeds `dev`) and recovers transparently rather
    // than failing the agent step with a cryptic git exit code.
    async function tryClone(includeBranch: boolean): Promise<{ ok: boolean; err?: Error }> {
      const args = ["clone"];
      if (includeBranch && input.baseBranch) args.push("--branch", input.baseBranch);
      args.push("--", repoUrl, workspacePath);
      try {
        await git(path.dirname(workspacePath), args);
        return { ok: true };
      } catch (err) {
        return { ok: false, err: err instanceof Error ? err : new Error(String(err)) };
      }
    }
    const first = await tryClone(true);
    if (!first.ok) {
      const msg = first.err?.message ?? "";
      const looksLikeMissingBranch =
        /Remote branch .* not found in upstream origin/i.test(msg) || /exited 128/.test(msg);
      if (!input.baseBranch || !looksLikeMissingBranch) {
        // Either there was no baseBranch hint (so the failure isn't about
        // --branch) or the error doesn't smell like a missing-branch case.
        // Surface the original error.
        throw first.err;
      }
      // Clean up any partial clone the failed attempt left behind, then
      // retry without --branch.
      if (await pathExists(workspacePath)) {
        await fs.rm(workspacePath, { recursive: true, force: true });
      }
      console.warn(
        `[workspace] base branch '${input.baseBranch}' not on remote — falling back to default branch and seeding '${input.baseBranch}' locally`,
      );
      const second = await tryClone(false);
      if (!second.ok) throw second.err;
      // Create the integration branch off the cloned HEAD so the ticket
      // branch we cut next still roots at the expected ref. We do NOT
      // push it — that's the operator's call via `git push -u origin
      // <integration_branch>` once they're ready to consolidate. Workspaces
      // can run their work on this local-only branch; promote-integration
      // will discover it missing remotely and surface a clear error.
      await git(workspacePath, ["checkout", "-b", input.baseBranch]);
    }

    // WI-5.2 — cut the ticket branch from a specific commit when the engine
    // resolved one (a landed builds_on parent's sha). The clone above is full
    // history, so the sha is present. Validated as a hex object name before it
    // reaches git: it comes from our own DB, but it is still a ref we are
    // interpolating into an argv, and the `backfill` sentinel the migration
    // writes for historical tickets is deliberately not a resolvable sha.
    const cutFrom = input.baseSha && /^[0-9a-f]{7,40}$/.test(input.baseSha) ? input.baseSha : null;
    if (cutFrom) {
      try {
        await git(workspacePath, ["checkout", "-b", branch, cutFrom]);
      } catch (err) {
        // The sha isn't reachable (a force-push rewrote it, a shallow clone).
        // The tip still contains the parent's work in every normal case, so fall
        // back rather than failing the whole step.
        console.warn(
          `[workspace] base sha '${cutFrom}' not resolvable — cutting '${branch}' from the tip of '${input.baseBranch ?? "default"}' instead: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await git(workspacePath, ["checkout", "-b", branch]);
      }
    } else {
      await git(workspacePath, ["checkout", "-b", branch]);
    }
  }

  // Phase 2 / M5a — inject GitHub OAuth token into the origin URL so the
  // runner can `git push` private repos without an SSH key. Uses GitHub's
  // documented `x-access-token` username convention. We rewrite EVERY time
  // (not just on clone) so re-entry on an existing workspace gets a fresh
  // token if it was rotated. NEVER log the resulting URL — it embeds the
  // bearer credential in the userinfo segment.
  if (input.githubToken && repoUrl.startsWith("https://")) {
    const u = new URL(repoUrl);
    u.username = "x-access-token";
    u.password = input.githubToken;
    await git(workspacePath, ["remote", "set-url", "origin", u.toString()]);
  }

  // Phase 2 / M5a — set the commit author identity to either the project
  // owner's GitHub identity (engine-resolved) or the DevPilot Engineer default.
  // Local-only config (not --global) so we don't pollute the operator's
  // workstation git config.
  const authorName = input.gitAuthorName ?? "DevPilot Engineer";
  const authorEmail = input.gitAuthorEmail ?? "engineer@devpilot.internal";
  await git(workspacePath, ["config", "user.name", authorName]);
  await git(workspacePath, ["config", "user.email", authorEmail]);

  // Slice A — write per-project secrets to <workspacePath>/.env.local AND
  // make sure the file is excluded from the repo's index via
  // .git/info/exclude (workspace-local; never pushed). This makes `pnpm
  // dev` / `pnpm build` Just Work without leaking values into the repo.
  // No-op when the operator hasn't configured any secrets.
  if (input.projectSecretsJson) {
    try {
      await writeProjectEnvLocal(workspacePath, input.projectSecretsJson);
      await ensureLocalGitignore(workspacePath, ".env.local");
    } catch (err) {
      console.warn(
        `[workspace] failed to write .env.local for ticket=${input.ticketId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { path: workspacePath, branch };
}

/**
 * Slice A — write a `.env.local` from the per-project secrets payload.
 *
 * Each KEY=value line is single-quoted to handle special characters; values
 * that contain literal single-quotes are emitted using the standard
 * shell-escape pattern (`'foo'"'"'bar'`). File is written with 0o600 perms.
 *
 * If a `.env.local` already exists (e.g. from a previous run on the same
 * ticket, or one the operator hand-edited via the Open-in-VS-Code path),
 * we OVERWRITE it. The vault is the source of truth at dispatch time.
 */
async function writeProjectEnvLocal(cwd: string, json: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `projectSecretsJson is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const lines: string[] = [
    "# Auto-generated by DevPilot runner from project_secrets vault.",
    "# DO NOT EDIT — overwritten on every dispatch. Manage secrets in the",
    "# project's Secrets tab in the DevPilot UI.",
  ];
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") continue;
    const escaped = value.replace(/'/g, `'"'"'`);
    lines.push(`${key}='${escaped}'`);
  }
  const target = path.join(cwd, ".env.local");
  await fs.writeFile(target, `${lines.join("\n")}\n`, { mode: 0o600 });
}

/**
 * Slice A — append `pattern` to `.git/info/exclude` if not already present.
 *
 * `.git/info/exclude` is the workspace-local equivalent of `.gitignore`; it
 * never gets pushed to the remote. We use it (not the repo's `.gitignore`)
 * so the operator's project can keep its own `.gitignore` policies and we
 * still guarantee the agent won't accidentally `git add .env.local`.
 */
async function ensureLocalGitignore(cwd: string, pattern: string): Promise<void> {
  const excludePath = path.join(cwd, ".git", "info", "exclude");
  let existing = "";
  try {
    existing = await fs.readFile(excludePath, "utf8");
  } catch {
    // File may not exist on a freshly-cloned repo; we'll create it.
  }
  const lines = existing.split(/\r?\n/);
  if (lines.includes(pattern)) return;
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const updated =
    existing.endsWith("\n") || existing.length === 0
      ? `${existing}${pattern}\n`
      : `${existing}\n${pattern}\n`;
  await fs.writeFile(excludePath, updated, "utf8");
}

/**
 * Remove the workspace dir for `ticketId`. The runId parameter is accepted
 * for backwards compatibility but is intentionally ignored — workspaces are
 * keyed per-ticket, not per-run, so an individual run can't safely clean
 * its "own" workspace (a sibling run on the same ticket would still need it).
 * Cleanup happens once, when the ticket reaches a terminal state and the
 * reaper fires. Safe on missing paths.
 *
 * REFUSES to delete a workspace that still holds commits reachable from no
 * remote - that workspace is the only copy of them, and deleting it is silent,
 * irreversible work loss (see `workspace-reap-guard.ts`). The guard lives HERE,
 * in front of the `rm`, rather than in the caller, so every present and future
 * caller inherits it. The returned verdict tells the caller what happened;
 * `removed: false` is a normal outcome, not an error.
 *
 * The ONE exception is `input.force === true`: the operator "Discard & restart
 * from dev" flow, an explicit and human-confirmed discard, deliberately overrides
 * the guard to wipe the workspace it just chose to throw away. That is the ONLY
 * caller that ever sets `force`; the reaper and the safe restart never do, so the
 * guard is fully intact for them. This is a sanctioned release of the data-loss
 * hold, not a weakening of it.
 */
export async function cleanupWorkspace(
  input: CleanupWorkspaceInput,
): Promise<{ removed: boolean; reason?: string }> {
  const target = path.join(env.WORKSPACE_ROOT, input.ticketId);
  if (!input.force) {
    const verdict = await checkWorkspaceReapSafety(target);
    if (!verdict.safeToDelete) {
      return { removed: false, reason: verdict.reason };
    }
  }
  await fs.rm(target, { recursive: true, force: true });
  return { removed: true };
}

// --- helpers ---------------------------------------------------------------

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      // C4 — bumped from 40 → 60 to fit realistic ticket titles (was
      // truncating "Bootstrap iOS CI pipeline with GitHub Actions" partway).
      // Web-side `@/lib/slug.ts` mirrors this default.
      .slice(0, 60) || "ticket"
  );
}

/**
 * Slice C — read `git status --porcelain` and return one line per change.
 *
 * Empty array means a clean working tree. Used by the auto-stash path in
 * `prepareWorkspace` to decide whether to call `git stash push`, and also
 * exported for the dev-server-loop's file watcher to compute the
 * `workspaceDirtyFileCount` heartbeat field.
 */
export async function readGitStatusPorcelain(cwd: string): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const child = spawn("git", ["status", "--porcelain"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.resume();
    child.on("error", () => resolve([]));
    child.on("close", (code) => {
      if (code !== 0) return resolve([]);
      const lines = stdout
        .split(/\r?\n/)
        .map((s) => s.trimEnd())
        .filter((s) => s.length > 0);
      resolve(lines);
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}
