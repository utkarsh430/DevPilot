"use server";

// Phase 2 / M5c — Push/Discard server actions for the review-before-push flow.
//
// Two actions are exposed:
//
//   • pushPendingChangesAction({ id, openPr }) — Runs `git push origin <branch>`
//     in the workspace tied to the `pending_pushes` row, then (optionally)
//     opens a PR via the GitHub REST client. Stamps `pushed_at` + `pushed_pr_url`
//     on success.
//
//   • discardPendingChangesAction({ id }) — Removes the row so the operator
//     stops seeing it in `/changes`. We DELIBERATELY do not wipe the workspace:
//     the operator may still want to inspect or salvage the work; the row is
//     just the review marker, not the source of truth for what's on disk.
//
// Hard rules (CLAUDE.md "Untrusted content" + the M5 plan):
//   • Never log the GitHub access token. Not in errors, not in console, not in
//     the action's return shape. The authenticated origin URL is treated as a
//     secret. We log only `<owner>/<repo>` + branch + commit count when we
//     need any trace at all.
//   • Verify tenant ownership of the pending_pushes row before doing anything.
//   • All git operations use `child_process.spawn` with explicit argv — never
//     `exec`/`shell:true`, never string interpolation into shell commands.
//   • The Inngest tracker (A5) writes pending_pushes via service-role; we read
//     via service-role too because the action runs in the trusted server boundary
//     after `requireUser`/`requireTenantId` have proved who's calling.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { loadProjectById } from "@/lib/projects/load";
import { createPullRequest, GithubApiError } from "@/lib/github/client";
import {
  logConflictEvent,
  spawnMerger,
  stampClean,
  stampConflict,
  stampRebased,
} from "@/lib/engine/conflict-audit";
// A2's M5a OAuth helper. Imported through the canonical path documented in
// the plan; A8's typecheck will hard-fail if A2's module signature drifts.
import { getGithubAccessToken } from "@/lib/github/oauth";
import { gitExec, safeStderr } from "@/lib/git/exec";
import { ensureCredentialFreeOrigin } from "@/lib/git/remote";
import { resolveWorkspaceRoot } from "@/lib/workspace-root";
import type { WorkspaceUnavailableCode } from "@/lib/dev-servers/workspace-path";
import { checkWorkspaceAvailable } from "@/lib/dev-servers/workspace-availability.server";
import { switchWorkspaceToBranch } from "@/lib/dev-servers/branch-checkout";

export type PushPendingChangesInput = {
  id: string;
  openPr: boolean;
  /** Slice IB-B — escape hatch: skip the pre-push rebase and force-push the
   *  branch as-is. Operator-driven; emits an `operator_overrode` audit
   *  event. Off by default. */
  force?: boolean;
};

export type PushPendingChangesResult =
  | { ok: true; pushed: true; prUrl?: string }
  // Slice IB-B — rebase failed; merger ticket auto-spawned. The operator
  // can either wait for the merger to land, then retry, or pass {force:true}
  // to override.
  | {
      ok: false;
      kind: "conflict";
      error: string;
      mergerTicketId: string;
      conflictedFiles: string[];
    }
  // 2026-07-11 - the workspace this row points at is unusable on this host:
  // either reaped off disk before the branch was pushed, or recorded on another
  // host. NOT a raw `spawn git ENOENT`. `recoverable` says whether the saved
  // `unified_diff` can rebuild the branch (see `recoverPendingPushAction`).
  | {
      ok: false;
      kind: "workspace_gone";
      code: WorkspaceUnavailableCode;
      error: string;
      recoverable: boolean;
    }
  | { ok: false; error: string };

export type RecoverPendingPushResult =
  | { ok: true; pushed: true; prUrl?: string; rebuiltFrom: "saved_diff" }
  | { ok: false; error: string };

export type DiscardPendingChangesResult = { ok: true } | { ok: false; error: string };

// Max time we'll let `git push` block before bailing. A 2-minute ceiling
// matches what GitHub's own docs call out for a "first push of a moderate
// repo over residential network" and still surfaces hung pushes fast enough
// to be debuggable.
const PUSH_TIMEOUT_MS = 120_000;

// Unlike the dev-server start flow there is no safe RE-DERIVATION here: the
// unpushed commits live ONLY in the exact directory the row points at, so a
// re-derived path would silently be empty/wrong. What we can do is refuse
// honestly, and offer to rebuild the branch from the saved diff
// (`recoverPendingPushAction` below). Two ways the directory can be unusable -
// recorded on another host, or reaped off disk before the branch was pushed -
// and both route through the shared classifier in
// `lib/dev-servers/workspace-path.ts`.
const WORKSPACE_ROOT = resolveWorkspaceRoot(process.env.WORKSPACE_ROOT);

// Identity on a reconstructed commit. Falls back to these only when the
// operator's account carries no email.
const COMMIT_AUTHOR_NAME = "DevPilot";
const COMMIT_AUTHOR_EMAIL = "devpilot@localhost";

type PendingPushRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  ticket_id: string | null;
  run_id: string | null;
  workspace_path: string;
  branch: string;
  unpushed_count: number | null;
  head_sha: string | null;
  pushed_at: string | null;
  /** The captured patch. The ONLY copy of the work once the workspace is gone. */
  unified_diff: string | null;
};

type TicketStub = {
  id: string;
  title: string | null;
  description: string | null;
};

// `gitExec` / `safeStderr` now live in `lib/git/exec.ts` — the WI-4 land worker
// runs the same rebase machinery, and a `"use server"` module can only export
// async server actions, so they could not be imported out of this file.

/**
 * Is the captured patch still on the row? Once the workspace is gone this is the
 * only surviving copy of the work, and the only thing a rebuild can run on.
 * (Very large diffs are elided server-side at capture time, so this is not a
 * given - an elided row is honestly unrecoverable and we say so.)
 */
function hasSavedDiff(row: PendingPushRow): boolean {
  return typeof row.unified_diff === "string" && row.unified_diff.trim().length > 0;
}

/** `git apply` rejects a patch with no trailing newline ("corrupt patch"). */
function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

async function loadPendingPushOrThrow(id: string, tenantId: string): Promise<PendingPushRow> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("pending_pushes")
    .select(
      "id, tenant_id, project_id, ticket_id, run_id, workspace_path, branch, unpushed_count, head_sha, pushed_at, unified_diff",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`pending_push lookup failed: ${error.message}`);
  if (!data) throw new Error("pending_push not found");
  const row = data as PendingPushRow;
  if (row.tenant_id !== tenantId) throw new Error("pending_push not found");
  return row;
}

async function loadTicketStub(ticketId: string | null): Promise<TicketStub | null> {
  if (!ticketId) return null;
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("tickets")
    .select("id, title, description")
    .eq("id", ticketId)
    .maybeSingle();
  if (error) return null;
  return (data as TicketStub | null) ?? null;
}

// The project's repo URL, if it is a usable https clone URL — and never with a
// credential in it.
//
// This replaces a helper that built `https://x-access-token:<token>@github.com/…`.
// That shape is the root of the stale-credential bug: it survives in argv, in
// `.git/config`, and in every error message that echoes a remote URL, long
// after the token it embeds has been rotated or revoked. Authentication is now
// supplied per-invocation through `gitExec`'s `token` option.
function httpsRepoUrl(repoUrl: string | null): string | null {
  if (!repoUrl) return null;
  if (!repoUrl.startsWith("https://")) return null;
  try {
    return new URL(repoUrl).toString();
  } catch {
    return null;
  }
}

export async function pushPendingChangesAction(
  input: PushPendingChangesInput,
): Promise<PushPendingChangesResult> {
  try {
    const user = await requireUser();
    const tenantId = await requireTenantId();
    const pending = await loadPendingPushOrThrow(input.id, tenantId);

    // Fail honestly BEFORE any `gitExec`. Every git call below passes
    // `cwd: pending.workspace_path`, and Node surfaces a missing cwd as a bare
    // `spawn git ENOENT` - the symptom operators actually hit once the reaper
    // had deleted an unpushed workspace out from under a live row.
    const availability = await checkWorkspaceAvailable({
      storedPath: pending.workspace_path,
      workspaceRoot: WORKSPACE_ROOT,
      hasSavedDiff: hasSavedDiff(pending),
    });
    if (!availability.available) {
      return {
        ok: false,
        kind: "workspace_gone",
        code: availability.code,
        error: availability.message,
        recoverable: hasSavedDiff(pending),
      };
    }

    if (pending.pushed_at) {
      return { ok: false, error: "These changes have already been pushed." };
    }
    if ((pending.unpushed_count ?? 0) <= 0) {
      return {
        ok: false,
        error: "Nothing to push — the tracker reports zero unpushed commits.",
      };
    }

    const project = await loadProjectById(pending.project_id);
    if (!project) {
      return { ok: false, error: "Project no longer exists." };
    }
    if (project.tenantId !== tenantId) {
      return { ok: false, error: "Project belongs to a different tenant." };
    }

    // Fetch the GitHub OAuth token for THIS user. We do not fall back to the
    // project owner's token: if the operator pressing Push isn't the same
    // human who connected the project, they still need their own GitHub
    // identity attached to the commit/push. The API client itself enforces
    // this by always taking the token as an argument (no env fallback).
    const token = await getGithubAccessToken(user.id);
    if (!token) {
      return {
        ok: false,
        error:
          "GitHub is not connected for your account. Connect it under Settings → GitHub integration before pushing.",
      };
    }

    // Take the credential OUT of the workspace's origin URL, then authenticate
    // each remote call below with the token resolved a moment ago.
    //
    // This used to write `https://x-access-token:<token>@github.com/…` into
    // `.git/config` instead. That fixed staleness for the next push from THIS
    // action and nowhere else — and it left the token on disk, readable by
    // anything with filesystem access, for as long as the workspace survived.
    // Git prefers a userinfo segment over any credential helper, so the strip
    // is what makes the ephemeral credential reachable at all.
    await ensureCredentialFreeOrigin(pending.workspace_path);

    // Audit-friendly trace: log only the public identifiers — never the
    // token, never the authenticated URL.
    const ownerRepo =
      project.githubOwner && project.githubRepo
        ? `${project.githubOwner}/${project.githubRepo}`
        : "<unknown>";
    console.log(
      `[changes/push] tenant=${tenantId} user=${user.id} repo=${ownerRepo} branch=${pending.branch} commits=${pending.unpushed_count}`,
    );

    // WI-10 — the dev-server branch picker can leave this workspace checked out
    // on a branch other than the change's own (the operator previewed `dev` from
    // this very page). Everything below operates on HEAD — the pre-push rebase,
    // the `reset --hard origin/<branch>` divergence repair — so running it from
    // the wrong checkout would rewrite the wrong ref. Put HEAD back on the
    // change's branch first. Non-destructive (stash → checkout → pop, no force)
    // and a no-op in the overwhelmingly common case where we're already there.
    const backOnBranch = await switchWorkspaceToBranch(pending.workspace_path, pending.branch);
    if (!backOnBranch.ok) {
      return {
        ok: false,
        error:
          `The workspace isn't on ${pending.branch} and couldn't be put back on it: ` +
          `${backOnBranch.error}. Nothing was pushed and nothing was discarded — ` +
          `stop any dev server previewing another branch in this workspace and retry.`,
      };
    }
    if (backOnBranch.switched) {
      console.log(
        `[changes/push] workspace was on another branch (dev-server preview); checked out ${pending.branch} before pushing`,
      );
    }

    // Slice IB-B — Pre-push rebase onto the integration tip. We try to
    // fast-forward the feature branch onto origin/<baseBranch> so it lands
    // cleanly. Three outcomes:
    //   • Rebase no-op (already up-to-date) → stamp 'clean', proceed to push.
    //   • Rebase replays commits → stamp 'rebased', proceed with
    //     --force-with-lease push (history rewritten locally).
    //   • Rebase fails on conflict → abort, stamp 'conflict', auto-spawn a
    //     merger ticket, RETURN with conflict outcome. Operator can either
    //     wait for the merger to land or retry with `force: true` to skip
    //     this whole block.
    const baseBranch = project.integrationBranch ?? project.defaultBranch;
    let pushUsedForceWithLease = false;
    if (!input.force) {
      let preRebaseHead: string | null = null;
      try {
        const r = await gitExec(pending.workspace_path, ["rev-parse", "--verify", "HEAD"], 15_000);
        preRebaseHead = r.stdout.trim() || null;
      } catch {
        // No HEAD on the branch yet — extremely unusual since pending pushes
        // require commits. Skip the rebase and let the push surface the issue.
      }

      // Slice IB-B / 2026-06-08 hotfix — git rebase refuses to run when the
      // working tree has uncommitted modifications ("error: cannot rebase:
      // You have unstaged changes. Please commit or stash them."). The
      // workspace re-entry path (apps/runner/src/workspace.ts) auto-stashes
      // for the same reason — mirror that pattern here so a stray
      // build-artifact or operator edit doesn't trip the rebase and falsely
      // spawn a merger ticket with zero conflicting files.
      //
      // After the rebase (success OR failure), we attempt to restore the
      // stash. If the pop conflicts (rare — the rebase rewrote the same
      // lines), we leave the stash in place and warn the operator; manual
      // recovery via `git stash list` / `git stash apply` is still possible.
      let preRebaseStashName: string | null = null;
      try {
        const status = await gitExec(pending.workspace_path, ["status", "--porcelain"], 15_000);
        if (status.stdout.trim().length > 0) {
          preRebaseStashName = `devpilot-push-pre-rebase-${pending.id}-${Date.now()}`;
          await gitExec(
            pending.workspace_path,
            ["stash", "push", "--include-untracked", "-m", preRebaseStashName],
            30_000,
          );
          console.log(
            `[changes/push] auto-stashed uncommitted edits before rebase: ${preRebaseStashName}`,
          );
        }
      } catch (err) {
        // Non-fatal — proceed without stash. If the rebase then complains
        // about unstaged changes, the operator will see it in the standard
        // error path below.
        console.warn(
          `[changes/push] pre-rebase auto-stash failed:`,
          err instanceof Error ? err.message : err,
        );
      }

      // Helper: restore the pre-rebase stash if we created one. Best-effort;
      // any pop failure is surfaced via warn (the stash is preserved for the
      // operator's manual recovery — `git stash list` shows it).
      const restoreStash = async () => {
        if (!preRebaseStashName) return;
        const popped = await gitExec(pending.workspace_path, ["stash", "pop"], 30_000).catch(
          (err) => {
            console.warn(
              `[changes/push] stash pop after rebase failed; stash kept (name=${preRebaseStashName}):`,
              err instanceof Error ? err.message : err,
            );
            return null;
          },
        );
        if (popped) {
          console.log(`[changes/push] restored pre-rebase stash: ${preRebaseStashName}`);
        }
      };

      // 2026-06-08 hotfix — sync local devpilot/<slug> with its remote
      // counterpart BEFORE rebasing against the integration branch. When
      // the workspace was re-cloned at some point and the agent's prior
      // commit only lives on `origin/devpilot/<slug>`, the local branch is
      // behind and the eventual push would be rejected non-fast-forward
      // (operator hit this on the logo branch). Four states:
      //
      //   • In sync (local == origin/<branch>) → no-op
      //   • Local strictly ahead → normal push will fast-forward, no-op here
      //   • Local strictly behind → reset --hard to origin/<branch>; push
      //     becomes a no-op (work is already on remote) but the PR still
      //     opens. This is the "workspace lost the commit" recovery path.
      //   • Diverged → rebase local onto origin/<branch>; if conflicts,
      //     fall into the merger pipeline below (same as integration
      //     conflicts).
      //
      // Fetch failures here are non-fatal — they typically mean
      // origin/<branch> doesn't exist (first push of this branch), which
      // is the normal new-ticket flow. We just skip and proceed.
      try {
        await gitExec(
          pending.workspace_path,
          ["fetch", "origin", pending.branch],
          PUSH_TIMEOUT_MS,
          { token },
        ).catch(() => undefined);
        const remoteFeatureRef = await gitExec(
          pending.workspace_path,
          ["rev-parse", `origin/${pending.branch}`],
          15_000,
        ).catch(() => null);
        if (remoteFeatureRef && preRebaseHead) {
          const remoteFeatureSha = remoteFeatureRef.stdout.trim();
          if (remoteFeatureSha && remoteFeatureSha !== preRebaseHead) {
            const aheadRes = await gitExec(
              pending.workspace_path,
              ["rev-list", "--count", `origin/${pending.branch}..HEAD`],
              15_000,
            );
            const behindRes = await gitExec(
              pending.workspace_path,
              ["rev-list", "--count", `HEAD..origin/${pending.branch}`],
              15_000,
            );
            const ahead = parseInt(aheadRes.stdout.trim(), 10) || 0;
            const behind = parseInt(behindRes.stdout.trim(), 10) || 0;
            console.log(
              `[changes/push] feature-branch sync: local ${ahead} ahead, ${behind} behind origin/${pending.branch}`,
            );
            if (behind > 0 && ahead === 0) {
              // Strict subset of remote — local lost a commit somewhere.
              // Snap local to remote. Push becomes a no-op but the PR
              // still opens.
              await gitExec(
                pending.workspace_path,
                ["reset", "--hard", `origin/${pending.branch}`],
                30_000,
              );
              preRebaseHead = remoteFeatureSha;
              console.log(
                `[changes/push] reset local ${pending.branch} to origin/${pending.branch} (${remoteFeatureSha.slice(0, 7)})`,
              );
            } else if (behind > 0 && ahead > 0) {
              // Diverged — try to rebase local onto remote. If that
              // succeeds cleanly, great. If it conflicts, this is a
              // genuine 3-way divergence between local and remote of the
              // SAME branch (typically: the agent re-ran on a re-cloned
              // workspace and produced a different commit at the same
              // logical position as the one already on remote). Funnel
              // into the same merger pipeline as integration-branch
              // conflicts so the operator gets DevPilot-native resolution
              // instead of a dead-end error.
              let rebaseOk = true;
              let rebaseErrMsg = "";
              try {
                await gitExec(
                  pending.workspace_path,
                  ["rebase", `origin/${pending.branch}`],
                  PUSH_TIMEOUT_MS,
                );
                pushUsedForceWithLease = true;
                const r = await gitExec(
                  pending.workspace_path,
                  ["rev-parse", "--verify", "HEAD"],
                  15_000,
                );
                preRebaseHead = r.stdout.trim() || preRebaseHead;
                console.log(
                  `[changes/push] reconciled diverged ${pending.branch} via rebase onto origin/${pending.branch}`,
                );
              } catch (rebErr) {
                rebaseOk = false;
                rebaseErrMsg = (rebErr as Error).message ?? "";
                await gitExec(pending.workspace_path, ["rebase", "--abort"], 30_000).catch(
                  () => undefined,
                );
              }

              if (!rebaseOk) {
                // Collect conflict markers via a re-run + abort, same
                // pattern as the integration-branch conflict path.
                let conflictedFiles: string[] = [];
                try {
                  await gitExec(
                    pending.workspace_path,
                    ["rebase", `origin/${pending.branch}`],
                    60_000,
                  ).catch(() => undefined);
                  const ls = await gitExec(
                    pending.workspace_path,
                    ["diff", "--name-only", "--diff-filter=U"],
                    15_000,
                  );
                  conflictedFiles = ls.stdout
                    .split(/\r?\n/)
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
                  await gitExec(pending.workspace_path, ["rebase", "--abort"], 30_000).catch(
                    () => undefined,
                  );
                } catch {
                  // best-effort
                }

                const remoteSha =
                  remoteFeatureRef && remoteFeatureRef.stdout
                    ? remoteFeatureRef.stdout.trim()
                    : null;
                const detail = {
                  files: conflictedFiles,
                  stderr: safeStderr(rebaseErrMsg.slice(0, 4000)),
                  base_sha: remoteSha,
                  branch_sha: preRebaseHead,
                };

                // 0 files reported — workspace probably dirty in a way
                // the stash didn't catch. Surface plain error instead of
                // dead-merger.
                if (conflictedFiles.length === 0) {
                  await restoreStash();
                  return {
                    ok: false,
                    error:
                      `Local ${pending.branch} diverged from origin/${pending.branch} ` +
                      `(local ${ahead} ahead, remote ${behind} ahead) and the ` +
                      `reconciliation rebase failed but reported no conflicting files. ` +
                      `Discard this pending push and re-run the ticket, or pull ` +
                      `origin/${pending.branch} manually.`,
                  };
                }

                await stampConflict(pending.id, detail);
                await logConflictEvent(pending.id, "detected", {
                  ...detail,
                  source: "feature-branch-divergence",
                  local_ahead: ahead,
                  remote_ahead: behind,
                });
                const sourceTicket = pending.ticket_id
                  ? await loadTicketStub(pending.ticket_id)
                  : null;
                // For divergence the "integration target" the merger
                // rebases against is origin/<feature-branch>, not the
                // project's integration branch. The merger's prompt
                // reads this from the ticket description.
                const mergerTicketId = await spawnMerger({
                  pendingPushId: pending.id,
                  sourceTicketId: pending.ticket_id ?? "",
                  tenantId,
                  projectId: pending.project_id,
                  integrationBranch: `origin/${pending.branch}`,
                  sourceBranch: pending.branch,
                  detail,
                  sourceTitle: sourceTicket?.title?.trim() ?? `branch ${pending.branch}`,
                });
                await logConflictEvent(pending.id, "merger_spawned", {
                  merger_ticket_id: mergerTicketId,
                  source: "feature-branch-divergence",
                });
                return {
                  ok: false,
                  kind: "conflict",
                  error:
                    `Local ${pending.branch} diverged from origin (${ahead} local, ` +
                    `${behind} remote). Merger ticket ${mergerTicketId} opened to reconcile.`,
                  mergerTicketId,
                  conflictedFiles,
                };
              }
            }
            // ahead > 0 && behind === 0 → normal push will fast-forward,
            // no action needed here.
          }
        }
      } catch (err) {
        console.warn(
          `[changes/push] feature-branch sync probe failed:`,
          err instanceof Error ? err.message : err,
        );
      }

      try {
        await gitExec(pending.workspace_path, ["fetch", "origin", baseBranch], PUSH_TIMEOUT_MS, {
          token,
        });
      } catch (err) {
        await restoreStash();
        return {
          ok: false,
          error: `git fetch origin ${baseBranch} failed: ${(err as Error).message}`,
        };
      }

      let baseSha: string | null = null;
      try {
        const r = await gitExec(
          pending.workspace_path,
          ["rev-parse", `origin/${baseBranch}`],
          15_000,
        );
        baseSha = r.stdout.trim() || null;
      } catch {
        // origin/<baseBranch> doesn't exist locally — e.g. integration_branch
        // was set after the workspace was cloned. Fall through to the
        // legacy push path (`git push` will surface a clearer error on the
        // remote side if there's a real problem).
        baseSha = null;
      }

      if (baseSha) {
        let rebaseOk = true;
        try {
          await gitExec(
            pending.workspace_path,
            ["rebase", `origin/${baseBranch}`],
            PUSH_TIMEOUT_MS,
          );
        } catch (err) {
          rebaseOk = false;
          // Best-effort: abort the in-progress rebase so the workspace is
          // back to a clean state on the feature branch.
          await gitExec(pending.workspace_path, ["rebase", "--abort"], 30_000).catch(
            () => undefined,
          );

          // Collect the list of files git reports as conflicted. This
          // requires the rebase to have actually paused in a conflicted
          // state; after --abort we replay the rebase silently and re-read
          // the conflict list (it'll fail again at the same spot).
          let conflictedFiles: string[] = [];
          try {
            // Re-attempt with --no-edit so we can read conflict state, then
            // immediately abort. Conflict files surface in `git diff --name-
            // only --diff-filter=U`.
            await gitExec(pending.workspace_path, ["rebase", `origin/${baseBranch}`], 60_000).catch(
              () => undefined,
            );
            const ls = await gitExec(
              pending.workspace_path,
              ["diff", "--name-only", "--diff-filter=U"],
              15_000,
            );
            conflictedFiles = ls.stdout
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await gitExec(pending.workspace_path, ["rebase", "--abort"], 30_000).catch(
              () => undefined,
            );
          } catch {
            // Best-effort — fall through with whatever we have.
          }

          const detail = {
            files: conflictedFiles,
            stderr: safeStderr(((err as Error).message ?? "").slice(0, 4000)),
            base_sha: baseSha,
            branch_sha: preRebaseHead,
          };

          // 2026-06-08 hotfix — if git reports zero conflicted files, this
          // isn't a real 3-way merge conflict (a release_engineer has
          // nothing to resolve). Common causes: workspace had uncommitted
          // changes that blocked the rebase from starting (the auto-stash
          // above should have caught it but the safety net is needed for
          // the cases it can't), or origin/<baseBranch> doesn't exist on
          // the remote. Surface the underlying error directly instead of
          // polluting the dispatcher with a dead merger ticket.
          if (conflictedFiles.length === 0) {
            await restoreStash();
            return {
              ok: false,
              error:
                `Pre-push rebase onto ${baseBranch} failed but no files are flagged conflicting. ` +
                `This usually means the workspace had uncommitted changes the auto-stash couldn't cover, ` +
                `or the rebase target doesn't exist on the remote. ` +
                `Output: ${detail.stderr.slice(0, 500)}`,
            };
          }

          await stampConflict(pending.id, detail);
          await logConflictEvent(pending.id, "detected", detail);
          const sourceTicket = pending.ticket_id ? await loadTicketStub(pending.ticket_id) : null;
          const mergerTicketId = await spawnMerger({
            pendingPushId: pending.id,
            sourceTicketId: pending.ticket_id ?? "",
            tenantId,
            projectId: pending.project_id,
            integrationBranch: baseBranch,
            sourceBranch: pending.branch,
            detail,
            sourceTitle: sourceTicket?.title?.trim() ?? `branch ${pending.branch}`,
          });
          await logConflictEvent(pending.id, "merger_spawned", {
            merger_ticket_id: mergerTicketId,
          });
          // Real conflict: don't restore the stash — the merger workflow
          // operates against the same workspace and we want it to start
          // from a clean tree. The stash ref remains in `git stash list`
          // for manual recovery if needed.
          return {
            ok: false,
            kind: "conflict",
            error: `Branch can't fast-forward onto ${baseBranch}. Merger ticket ${mergerTicketId} opened to resolve.`,
            mergerTicketId,
            conflictedFiles,
          };
        }

        if (rebaseOk) {
          // Capture the new HEAD; if it equals preRebaseHead the rebase was
          // a no-op (clean). Otherwise we replayed commits and need force-
          // with-lease since the branch history changed.
          let postRebaseHead: string | null = null;
          try {
            const r = await gitExec(
              pending.workspace_path,
              ["rev-parse", "--verify", "HEAD"],
              15_000,
            );
            postRebaseHead = r.stdout.trim() || null;
          } catch {
            // shouldn't happen post-rebase
          }
          if (postRebaseHead && postRebaseHead !== preRebaseHead) {
            await stampRebased(pending.id, postRebaseHead);
            pushUsedForceWithLease = true;
          } else {
            await stampClean(pending.id);
          }
          // Restore the stash after a successful rebase so the operator's
          // uncommitted edits aren't silently lost.
          await restoreStash();
        }
      } else {
        // No baseSha → we didn't attempt the rebase. Still need to restore
        // the stash so the workspace isn't left in a half-stashed state.
        await restoreStash();
      }
    }

    // Push. `--set-upstream` makes the local branch track origin/<branch>
    // so subsequent `git push` calls in the same workspace are a no-op
    // until new commits land. If we rebased above, swap in --force-with-
    // lease so the remote branch ref (if it exists) gets the rewritten
    // history without clobbering anyone else's push.
    try {
      const pushArgs = pushUsedForceWithLease
        ? ["push", "--force-with-lease", "--set-upstream", "origin", pending.branch]
        : ["push", "--set-upstream", "origin", pending.branch];
      await gitExec(pending.workspace_path, pushArgs, PUSH_TIMEOUT_MS, { token });
    } catch (err) {
      return {
        ok: false,
        error: `git push failed: ${(err as Error).message}`,
      };
    }

    // If the operator chose the force escape hatch, leave an audit
    // breadcrumb so the conflict timeline records the override.
    if (input.force) {
      await logConflictEvent(pending.id, "operator_overrode", {
        operator_id: user.id,
      }).catch(() => undefined);
    }

    // Optional PR creation. Only attempted when the project carries the
    // owner/repo split (i.e. it was connected via the M5a/M5b flows that
    // populate `github_owner` + `github_repo`).
    let prUrl: string | undefined;
    if (input.openPr && project.githubOwner && project.githubRepo) {
      const ticket = await loadTicketStub(pending.ticket_id);
      const title = ticket?.title?.trim().length
        ? ticket.title.trim()
        : `DevPilot: ${pending.branch}`;
      const body = ticket?.description?.trim().length
        ? ticket.description.trim()
        : "Pushed from DevPilot.";
      try {
        const pr = await createPullRequest(
          { token },
          {
            owner: project.githubOwner,
            repo: project.githubRepo,
            head: pending.branch,
            // Slice IB — when an integration branch is configured (e.g. "dev"),
            // open the PR against it instead of default_branch. A separate
            // "Promote integration → production" action handles the
            // integration_branch → default_branch step.
            base: project.integrationBranch ?? project.defaultBranch,
            title,
            body,
          },
        );
        prUrl = pr.html_url;
      } catch (err) {
        // Push already succeeded; we'd rather mark the row pushed and tell
        // the operator the PR failed than rollback the push (which we
        // can't anyway). Don't fail the whole action.
        const message =
          err instanceof GithubApiError
            ? (err.githubMessage ?? err.message)
            : (err as Error).message;
        console.warn(
          `[changes/push] PR creation failed: repo=${ownerRepo} branch=${pending.branch} message=${message}`,
        );
      }
    }

    // Stamp the row as pushed. Realtime UPDATE makes the badge tick down
    // and drops the card from the /changes list across all open tabs.
    const supabase = supabaseService();
    const { error: updateErr } = await supabase
      .from("pending_pushes")
      .update({
        pushed_at: new Date().toISOString(),
        pushed_pr_url: prUrl ?? null,
      })
      .eq("id", pending.id);
    if (updateErr) {
      // Push and PR both succeeded but we couldn't mark the row — surface
      // a partial-success so the operator knows the actual git state.
      return {
        ok: false,
        error: `Push succeeded but failed to update the pending_push row: ${updateErr.message}`,
      };
    }

    revalidatePath("/changes");
    revalidatePath(`/changes/${pending.id}`);

    // Slice IB-C — notify any ticket that `builds_on` this one. The cascade
    // function (lib/engine/builds-on-cascade.ts) posts a system comment on
    // each child + writes a breadcrumb to merge_conflict_events. The actual
    // child rebase happens organically on the operator's next push.
    if (pending.ticket_id) {
      try {
        const { sendEventBounded } = await import("@/lib/engine/send-bounded");
        await sendEventBounded({
          name: "branch/parent-landed",
          data: {
            ticketId: pending.ticket_id,
            tenantId,
            integrationBranch: project.integrationBranch ?? project.defaultBranch,
          },
        });
      } catch (err) {
        // Non-fatal: the push has already landed. Children just don't get
        // a system comment for this cycle.
        console.warn(
          `[changes/push] branch/parent-landed emit failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { ok: true, pushed: true, prUrl };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Rebuild a change whose workspace is gone, from the diff we saved before it
 * died, and push it.
 *
 * The recovery path for the data-loss bug. When the reaper deleted an unpushed
 * workspace, the commits went with it - but `pending_pushes.unified_diff` had
 * already captured the patch, so the WORK is recoverable even though the commit
 * objects are not. This replays that patch onto a fresh clone of the base branch
 * and pushes it as `pending.branch`, which is what the operator wanted in the
 * first place.
 *
 * What is faithfully restored: the tree. What is NOT: the original commit
 * history (n commits collapse into one) and the original authorship/timestamps.
 * That is the honest limit of what a stored patch can carry, and it is stated on
 * the reconstructed commit itself rather than being papered over.
 *
 * Only offered when the workspace is genuinely unusable - with a live workspace,
 * the normal push is strictly better (it preserves real history), so we refuse
 * and say so.
 */
export async function recoverPendingPushAction(input: {
  id: string;
  openPr: boolean;
}): Promise<RecoverPendingPushResult> {
  let recoveryDir: string | null = null;
  try {
    const user = await requireUser();
    const tenantId = await requireTenantId();
    const pending = await loadPendingPushOrThrow(input.id, tenantId);

    if (pending.pushed_at) {
      return { ok: false, error: "These changes have already been pushed." };
    }
    if (!hasSavedDiff(pending)) {
      return {
        ok: false,
        error:
          "No diff was saved for this change, so there is nothing to rebuild from. " +
          "The commits are not recoverable from DevPilot.",
      };
    }

    const availability = await checkWorkspaceAvailable({
      storedPath: pending.workspace_path,
      workspaceRoot: WORKSPACE_ROOT,
      hasSavedDiff: true,
    });
    if (availability.available) {
      return {
        ok: false,
        error:
          "This change's workspace is still on disk, so it can be pushed normally - " +
          "rebuilding from the saved diff would throw away its real commit history. Use Push.",
      };
    }

    const project = await loadProjectById(pending.project_id);
    if (!project) return { ok: false, error: "Project no longer exists." };
    if (project.tenantId !== tenantId) {
      return { ok: false, error: "Project belongs to a different tenant." };
    }

    const token = await getGithubAccessToken(user.id);
    if (!token) {
      return {
        ok: false,
        error:
          "GitHub is not connected for your account. Connect it under Settings → GitHub integration before rebuilding.",
      };
    }
    // The clone URL carries NO credential. It used to be
    // `https://x-access-token:<token>@…`, which put the operator's token in the
    // clone's argv — visible in `ps` to every user on the host — and then baked
    // it into the recovered workspace's `origin`, which is exactly how a
    // workspace ends up pinned to a token that later gets rotated or revoked.
    // The token reaches git through the subprocess environment instead.
    const cloneUrl = httpsRepoUrl(project.repoUrl);
    if (!cloneUrl) {
      return {
        ok: false,
        error:
          "This project has no https repo URL, so DevPilot can't clone it to rebuild the branch.",
      };
    }

    const baseBranch = project.integrationBranch ?? project.defaultBranch;

    // Clone into a fresh, LOCAL directory under this host's workspace root -
    // never back into the path the dead row names (which may be another host's).
    // Deterministic per pending push, so a retry reuses the same slot.
    recoveryDir = path.join(WORKSPACE_ROOT, `recovered-${pending.id}`);
    await fs.rm(recoveryDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(recoveryDir), { recursive: true });

    try {
      await gitExec(
        path.dirname(recoveryDir),
        ["clone", "--branch", baseBranch, "--", cloneUrl, recoveryDir],
        PUSH_TIMEOUT_MS,
        { token },
      );
    } catch (err) {
      // `gitExec` has already scrubbed the token out of this message; the argv
      // no longer carries one at all.
      return {
        ok: false,
        error: `Couldn't clone ${baseBranch} to rebuild the branch: ${(err as Error).message}`,
      };
    }

    await gitExec(recoveryDir, ["checkout", "-b", pending.branch], 30_000);

    // Apply the saved patch. `--whitespace=nowarn` keeps a noisy-but-valid diff
    // from failing; we deliberately do NOT pass `--3way` (its fallback needs the
    // original blobs, which died with the workspace) nor `--reject` (a partial,
    // silently-wrong tree is worse than an honest refusal).
    const patchPath = path.join(os.tmpdir(), `devpilot-recover-${pending.id}.patch`);
    try {
      await fs.writeFile(patchPath, ensureTrailingNewline(pending.unified_diff ?? ""), "utf8");
      await gitExec(recoveryDir, ["apply", "--whitespace=nowarn", "--", patchPath], 60_000);
    } catch (err) {
      return {
        ok: false,
        error:
          `The saved diff no longer applies cleanly to ${baseBranch} (${(err as Error).message}). ` +
          `${baseBranch} has probably moved on since the change was captured. The diff itself is ` +
          "still intact on this page - download it and apply it by hand.",
      };
    } finally {
      await fs.rm(patchPath, { force: true }).catch(() => undefined);
    }

    const ticket = await loadTicketStub(pending.ticket_id);
    const subject = ticket?.title?.trim().length
      ? ticket.title.trim()
      : `DevPilot: ${pending.branch}`;
    const commitBody = [
      "",
      "Reconstructed by DevPilot from the diff saved on this change, because the",
      "workspace holding the original commits no longer exists on the runner host.",
      "The file tree is faithful; the original commit history is not preserved.",
      "",
      `Original commits: ${pending.unpushed_count ?? "unknown"}`,
      pending.head_sha ? `Original head: ${pending.head_sha}` : null,
      `Recovered by: ${user.email ?? user.id}`,
    ]
      .filter((l): l is string => l !== null)
      .join("\n");

    await gitExec(recoveryDir, ["add", "-A"], 30_000);
    await gitExec(
      recoveryDir,
      [
        "-c",
        `user.name=${COMMIT_AUTHOR_NAME}`,
        "-c",
        `user.email=${user.email ?? COMMIT_AUTHOR_EMAIL}`,
        "commit",
        "-m",
        subject,
        "-m",
        commitBody,
      ],
      30_000,
    );

    try {
      await gitExec(
        recoveryDir,
        ["push", "--set-upstream", "origin", pending.branch],
        PUSH_TIMEOUT_MS,
        { token },
      );
    } catch (err) {
      return { ok: false, error: `git push failed: ${(err as Error).message}` };
    }

    console.log(
      `[changes/recover] tenant=${tenantId} user=${user.id} branch=${pending.branch} rebuilt from saved diff`,
    );

    let prUrl: string | undefined;
    if (input.openPr && project.githubOwner && project.githubRepo) {
      try {
        const pr = await createPullRequest(
          { token },
          {
            owner: project.githubOwner,
            repo: project.githubRepo,
            head: pending.branch,
            base: baseBranch,
            title: subject,
            body: ticket?.description?.trim().length
              ? `${ticket.description.trim()}\n\n---\n_Reconstructed from DevPilot's saved diff; original commit history was lost with the workspace._`
              : "Reconstructed from DevPilot's saved diff.",
          },
        );
        prUrl = pr.html_url;
      } catch (err) {
        const message =
          err instanceof GithubApiError
            ? (err.githubMessage ?? err.message)
            : (err as Error).message;
        console.warn(`[changes/recover] PR creation failed: branch=${pending.branch} ${message}`);
      }
    }

    // Point the row at the workspace that now actually holds the branch, so the
    // Changes page (and the Live tab, and the dev server) stop referring to a
    // directory that does not exist. Known, bounded cost: the reaper only ever
    // sweeps `<root>/<ticketId>`, so a `recovered-*` clone is never collected.
    // Recoveries are exceptional and the branch is on the remote by this point,
    // so this is a handful of MB, not a leak that grows with normal use.
    const supabase = supabaseService();
    const { error: updateErr } = await supabase
      .from("pending_pushes")
      .update({
        pushed_at: new Date().toISOString(),
        pushed_pr_url: prUrl ?? null,
        workspace_path: recoveryDir,
        updated_at: new Date().toISOString(),
      })
      .eq("id", pending.id);
    if (updateErr) {
      return {
        ok: false,
        error: `The branch was rebuilt and pushed, but the row couldn't be updated: ${updateErr.message}`,
      };
    }

    revalidatePath("/changes");
    revalidatePath(`/changes/${pending.id}`);
    return { ok: true, pushed: true, prUrl, rebuiltFrom: "saved_diff" };
  } catch (err) {
    // Leave `recoveryDir` on disk on failure: it may hold a partially-applied
    // tree the operator wants to inspect, and it is the reap guard's job (not
    // ours) to decide when a directory with commits may be deleted.
    return { ok: false, error: (err as Error).message };
  }
}

export async function discardPendingChangesAction(input: {
  id: string;
}): Promise<DiscardPendingChangesResult> {
  try {
    await requireUser();
    const tenantId = await requireTenantId();
    const pending = await loadPendingPushOrThrow(input.id, tenantId);

    // Soft-discard: only drop the row. The workspace stays on disk so the
    // operator can `cd` in and inspect the commits manually. A future M5e
    // could add a "Discard AND wipe workspace" affordance; today's call is
    // the conservative one.
    const supabase = supabaseService();
    const { error } = await supabase.from("pending_pushes").delete().eq("id", pending.id);
    if (error) return { ok: false, error: error.message };

    revalidatePath("/changes");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
