"use server";

// Phase 2 / M5e — Server actions for the "Run on localhost" button.
//
// Three actions live here:
//
//   • startDevServerForProjectAction({ projectId, ticketId?, pendingPushId?,
//                                       commandOverride?, portHint? })
//       Resolves the workspace path (from the ticket, the pending push, or
//       the project's most recent pending push), picks a default command via
//       `inferDevCommand`, inserts a `dev_server_sessions` row in
//       status='starting', and emits the `dev_server.start_requested` Inngest
//       event that B1's engine function consumes.
//
//   • stopDevServerAction({ sessionId })
//       Verifies tenant ownership and emits `dev_server.stop_requested` with
//       `reason: "user"`. Bumps last_interaction_at so a racing idle reaper
//       doesn't fire a redundant stop in the same tick.
//
//   • pingDevServerInteractionAction({ sessionId })
//       Cheap UPDATE bump on `last_interaction_at`. Called by the RunPanel
//       on a heartbeat-ish interval while the operator has the panel open so
//       the 30-minute idle reaper holds off.
//
// All three actions live in the trusted server boundary AFTER `requireUser` +
// `requireTenantId` have proved who's calling — RLS is then bypassed via the
// service-role client for the cross-tenant operations we genuinely need (the
// supervisor can stop a session it didn't start so long as it shares the
// tenant). The legacy RLS reads we do for ownership-check use the same
// service-role client because we've already gated on tenantId equality
// ourselves.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { requireTenantId, requireUser } from "@/lib/auth";
import { ticketBranch } from "@/lib/git/ticket-branch";
import { resolveWorkspaceRoot } from "@/lib/workspace-root";
import { supabaseService } from "@/lib/db/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { loadProjectById } from "@/lib/projects/load";
import { fallbackDevCommand, inferDevCommand } from "@/lib/dev-servers/stack-detect";
import { DEFAULT_PROJECT_TYPE } from "@/lib/projects/project-type";
import { getGithubAccessToken } from "@/lib/github/oauth";
import { listRepoBranches } from "@/lib/github/client";
import { spawn } from "node:child_process";
import { hostWorkspacePath } from "@/lib/dev-servers/workspace-path";
import { gitExec } from "@/lib/git/exec";
import {
  BRANCH_NAME_RE,
  currentWorkspaceBranch,
  resolveRunBranch,
  switchWorkspaceToBranch,
} from "@/lib/dev-servers/branch-checkout";

export type StartDevServerInput = {
  projectId: string;
  ticketId?: string;
  pendingPushId?: string;
  // Single-line shell command override. When provided, skips `inferDevCommand`
  // entirely. Whitespace-only strings are treated as "no override" and the
  // detector runs.
  commandOverride?: string;
  // Suggested starting port for the runner's free-port probe. Defaults to
  // DEVPILOT_DEV_SERVER_PORT_START on the runner side (3100). Operator-facing UI
  // doesn't expose this today; it exists for tests/scripts.
  portHint?: number;
  // "Skip & start anyway" — bypass the required-env gate so the runner spawns
  // even when required vars from .env.example are missing (the operator chose
  // to preview without them; the app may crash, which surfaces in the terminal).
  skipEnvCheck?: boolean;
  // Explicit branch for the run. WI-9 introduced it for a project-level run
  // (no ticketId, no pendingPushId); WI-10 extended it to the ticket and
  // pending-push scopes, whose workspaces are checked out on a FEATURE branch —
  // picking another branch there checks it out non-destructively first (see
  // `switchWorkspaceToBranch`), so a preview of `dev` can never eat an unpushed
  // commit. Empty/whitespace is "no override": each scope keeps serving its own
  // branch (integrationBranch ?? defaultBranch for a project, the pending push's
  // branch, the ticket's `devpilot/<slug>`). Validated against BRANCH_NAME_RE.
  branch?: string;
};

export type StartDevServerResult = { ok: true; sessionId: string } | { ok: false; error: string };

export type StopDevServerResult = { ok: true } | { ok: false; error: string };

export type SwitchDevServerBranchInput = {
  /** The existing session to swap. Its workspace_path is reused; a new row is
   *  inserted in starting state for the new branch. */
  sessionId: string;
  /** The branch to check out in the workspace before restarting. Must exist
   *  on origin/<branch>. Validated against a conservative regex. */
  branch: string;
};

export type SwitchDevServerBranchResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string };

export type ListProjectBranchesResult =
  | { ok: true; branches: Array<{ name: string; protected: boolean }> }
  | { ok: false; error: string };

// Same shape as `getWorkspacePath` on the runner side
// (`apps/runner/src/workspace.ts#getWorkspacePath`). Mirroring it here means
// the web app can resolve the same path as the runner when neither a ticket
// nor a pending push is given — they're on the same host today.
const WORKSPACE_ROOT = resolveWorkspaceRoot(process.env.WORKSPACE_ROOT);

function workspacePathForTicket(ticketId: string): string {
  return path.join(WORKSPACE_ROOT, ticketId);
}

// Project-level (no-ticket) localhost run gets its own workspace, distinct from
// any ticket workspace under the same root. The `project-` prefix can't collide
// with a ticket UUID. The runner clones the integration branch into it.
function workspacePathForProject(projectId: string): string {
  return path.join(WORKSPACE_ROOT, `project-${projectId}`);
}

// Slug rules match `apps/runner/src/workspace.ts#slugify`. Web-side callers
// share `@/lib/slug` so future bumps stay in one place; the runner copy is
// kept separately because the two packages don't share a tsconfig at
// runtime. Default `maxLen=60` covers realistic ticket titles (was 40
// pre-C4; the bump fits "Bootstrap iOS CI pipeline with GitHub Actions" in
// full without truncation).
import { slugify } from "@/lib/slug";

type PendingPushStub = {
  workspace_path: string;
  branch: string;
  ticket_id: string | null;
};

async function loadPendingPushById(pendingPushId: string): Promise<PendingPushStub | null> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("pending_pushes")
    .select("workspace_path, branch, ticket_id")
    .eq("id", pendingPushId)
    .maybeSingle();
  if (error) {
    throw new Error(`loadPendingPushById failed: ${error.message}`);
  }
  return (data as PendingPushStub | null) ?? null;
}

export async function startDevServerForProjectAction(
  input: StartDevServerInput,
): Promise<StartDevServerResult> {
  try {
    const user = await requireUser();
    const tenantId = await requireTenantId();

    // ── 1. Project ownership check ─────────────────────────────────────
    const project = await loadProjectById(input.projectId);
    if (!project) {
      return { ok: false, error: "Project no longer exists." };
    }
    if (project.tenantId !== tenantId) {
      return { ok: false, error: "Project belongs to a different tenant." };
    }

    // ── 2. Resolve workspace_path + branch ─────────────────────────────
    // Priority: explicit ticketId > explicit pendingPushId > project's most
    // recent pending push. None ⇒ refuse (we'd have nowhere to spawn).
    let workspacePath: string;
    let branch: string;
    let ticketIdForBranch: string | undefined = input.ticketId;
    // A project-level run (no ticket, no pending push) serves the project's
    // integration branch from a project-scoped workspace.
    const isProjectScopeRun = !input.ticketId && !input.pendingPushId;

    // Every scope resolves its branch the same way (WI-10): the operator's
    // explicit pick when there is one, else the branch that scope pins. Only the
    // fallback differs, so `resolveRunBranch` (pure, unit-tested) owns the
    // validation and the empty-pick semantics for all three.
    if (input.ticketId) {
      workspacePath = workspacePathForTicket(input.ticketId);
      // C4 — branch identity is now stored on `tickets.git_branch_name` once
      // the engine has resolved it (first run on the ticket writes it back
      // with `slugify(title, {maxLen: 60})`). Fall back to slugify(ticketId)
      // for tickets that pre-date C4 and never got a first run — those keep
      // landing on `devpilot/<uuid-slug>` until the engine runs and back-writes.
      const supabase = supabaseService();
      const { data: tRow } = await supabase
        .from("tickets")
        .select("git_branch_name")
        .eq("id", input.ticketId)
        .maybeSingle();
      const storedBranch = (tRow?.git_branch_name as string | null) ?? null;
      const pinned = storedBranch
        ? ticketBranch(storedBranch)
        : ticketBranch(slugify(input.ticketId));
      const resolved = resolveRunBranch({ requested: input.branch, fallback: pinned });
      if (!resolved.ok) return resolved;
      branch = resolved.branch;
    } else if (input.pendingPushId) {
      const pending = await loadPendingPushById(input.pendingPushId);
      if (!pending) {
        return {
          ok: false,
          error: "Pending push no longer exists.",
        };
      }
      workspacePath = hostWorkspacePath(
        pending.workspace_path,
        pending.ticket_id,
        input.projectId,
        WORKSPACE_ROOT,
      );
      const resolved = resolveRunBranch({ requested: input.branch, fallback: pending.branch });
      if (!resolved.ok) return resolved;
      branch = resolved.branch;
      ticketIdForBranch = pending.ticket_id ?? undefined;
    } else {
      // Project-level run: serve the operator-picked branch when one was
      // provided (WI-9 — the idle-state branch picker), else the integration
      // branch (e.g. `dev`), falling back to the default branch when no
      // integration branch is set. Uses a project-scoped workspace; the
      // auto-recovery path below fresh-clones it (at this branch) when it's
      // missing on disk.
      const resolved = resolveRunBranch({
        requested: input.branch,
        fallback: project.integrationBranch ?? project.defaultBranch,
      });
      if (!resolved.ok) return resolved;
      branch = resolved.branch;
      workspacePath = workspacePathForProject(input.projectId);
      ticketIdForBranch = undefined;
    }

    // ── 2.5. Workspace existence check + auto-recovery hint ───────────
    // Ticket workspaces get GC'd over time but pending_pushes / sessions
    // can still reference paths that no longer exist on disk. Probe
    // explicitly so we can stamp `prepareIfMissing` on the start message
    // — the runner will fresh-clone repoUrl into workspacePath before
    // spawning, dodging the cryptic "spawn(pnpm) did not return a pid"
    // error path. If we can't even pull the project's repo_url we have
    // to bail with a clear message because the runner has nothing to
    // restore from.
    let prepareIfMissing:
      | {
          repoUrl: string;
          branch: string;
          githubToken?: string;
        }
      | undefined;
    // Resolved ONCE, up front, and used for every remote call below. A
    // workspace's `origin` no longer carries a usable credential of its own
    // (the land path strips the frozen one), so anything talking to a private
    // remote has to bring the current token with it. Best-effort: a public repo
    // needs none, and a missing one is not a reason to refuse to start.
    const githubToken = await getGithubAccessToken(user.id);
    const workspaceOnDisk = await dirExistsSafe(workspacePath);
    if (!workspaceOnDisk) {
      if (!project.repoUrl) {
        return {
          ok: false,
          error:
            "The workspace for this project's last ticket has been cleaned up and there's no repo URL on file to re-clone from. Open the project and click Refresh from GitHub, then try again.",
        };
      }
      // Passed inside the queue payload (internal Redis, never persisted).
      prepareIfMissing = {
        repoUrl: project.repoUrl,
        branch,
        githubToken: githubToken ?? undefined,
      };
    } else if (isProjectScopeRun) {
      // Existing project workspace → refresh to the integration branch tip so
      // a re-run serves the latest `dev`, not a stale checkout. Best-effort:
      // auth/divergence failures leave the current checkout in place (the
      // server still starts). Mirrors switchDevServerBranchAction's fetch flow.
      try {
        await gitExec(workspacePath, ["fetch", "origin", branch], 60_000, {
          token: githubToken,
        });
        await gitExec(workspacePath, ["checkout", branch], 30_000);
        await gitExec(workspacePath, ["pull", "origin", branch, "--ff-only"], 60_000, {
          token: githubToken,
        }).catch(() => undefined);
      } catch (err) {
        console.warn(
          `[run-actions/start] project workspace refresh failed (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
      }
    } else {
      // WI-10 — a ticket / pending-push workspace is checked out on that scope's
      // FEATURE branch, and the runner only checks a branch out when it clones.
      // So when the operator picks a different branch to preview (or comes back
      // to the feature branch after previewing one), the checkout has to happen
      // here or the session would serve the old branch under the new label.
      //
      // This workspace is the only home of any commit on a never-pushed feature
      // branch, so the checkout goes through `switchWorkspaceToBranch`: it
      // stashes uncommitted edits, never forces, and leaves the previous
      // branch's commits on their local ref. A failed checkout is FATAL here —
      // silently previewing the feature branch while the panel says `dev` is
      // worse than not starting.
      const current = await currentWorkspaceBranch(workspacePath);
      if (current !== branch) {
        const switched = await switchWorkspaceToBranch(workspacePath, branch, {
          stashLabel: `devpilot-run-start-${input.pendingPushId ?? input.ticketId}-${Date.now()}`,
          token: githubToken,
        });
        if (!switched.ok) {
          return {
            ok: false,
            error:
              `${switched.error} The workspace is still on ${current ?? "its previous branch"} ` +
              `and nothing was discarded — pick a branch that exists, or run this change on its own branch.`,
          };
        }
      }
    }

    // ── 3. Command override or detection ──────────────────────────────
    // When we're about to auto-clone (workspace missing on disk), skip
    // stack-detection from disk — we can't read package.json yet — and
    // fall back to a sensible default. Detection will retry effectively
    // because the runner's startDevServer re-runs detectStack after the
    // clone completes when no explicit command was passed in the start
    // message. To make that path safe we hand a placeholder through; the
    // runner ignores it if it detects something different. WI-11: the
    // placeholder is now the project's platform default rather than a
    // hardcoded "pnpm dev", so a mobile project doesn't start out claiming
    // a web command. The operator's override still wins over both.
    const trimmedOverride = input.commandOverride?.trim();
    const command =
      trimmedOverride && trimmedOverride.length > 0
        ? trimmedOverride
        : workspaceOnDisk
          ? await inferDevCommand(workspacePath, project.projectType)
          : fallbackDevCommand(project.projectType);

    // ── 4. Insert the session row ─────────────────────────────────────
    // status defaults to 'starting'. The runner-side dev-server loop (B2)
    // will flip it via the heartbeat HTTP endpoint once the child process
    // is up.
    const supabase = supabaseService();
    const { data: inserted, error: insertErr } = await supabase
      .from("dev_server_sessions")
      .insert({
        tenant_id: tenantId,
        project_id: input.projectId,
        ticket_id: ticketIdForBranch ?? null,
        pending_push_id: input.pendingPushId ?? null,
        workspace_path: workspacePath,
        branch,
        command,
        status: "starting",
        started_by_user_id: user.id,
      })
      .select("id")
      .single();
    if (insertErr || !inserted) {
      return {
        ok: false,
        error: insertErr?.message ?? "Failed to create dev server session.",
      };
    }
    const sessionId = (inserted as { id: string }).id;

    // ── 5. Emit the start event ───────────────────────────────────────
    // The engine function (`startDevServer` in B1's
    // `lib/engine/dev-server-control.ts`) consumes this and pushes a start
    // message onto the Redis control queue for the runner-side loop.
    await sendEventBounded({
      name: "dev_server.start_requested",
      data: {
        sessionId,
        tenantId,
        projectId: input.projectId,
        workspacePath,
        branch,
        command,
        portHint: input.portHint,
        ticketId: ticketIdForBranch,
        pendingPushId: input.pendingPushId,
        startedByUserId: user.id,
        ...(input.skipEnvCheck ? { skipEnvCheck: true } : {}),
        ...(prepareIfMissing ? { prepareIfMissing } : {}),
      },
    });

    return { ok: true, sessionId };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function stopDevServerAction(input: {
  sessionId: string;
}): Promise<StopDevServerResult> {
  try {
    await requireUser();
    const tenantId = await requireTenantId();

    // ── 1. Ownership check ────────────────────────────────────────────
    // The session belongs to a project; the project belongs to a tenant.
    // We verify tenant equality before issuing the stop event so a
    // crafted sessionId can't cross tenants.
    const supabase = supabaseService();
    const { data: row, error: loadErr } = await supabase
      .from("dev_server_sessions")
      .select("id, tenant_id, project_id")
      .eq("id", input.sessionId)
      .maybeSingle();
    if (loadErr) {
      return { ok: false, error: `Lookup failed: ${loadErr.message}` };
    }
    if (!row) {
      return { ok: false, error: "Session not found." };
    }
    const sessionRow = row as {
      id: string;
      tenant_id: string;
      project_id: string;
    };
    if (sessionRow.tenant_id !== tenantId) {
      return { ok: false, error: "Session not found." };
    }

    // ── 2. Emit the stop event ────────────────────────────────────────
    // B1's `stopDevServer` engine function consumes this and queues the
    // control message on Redis for the runner.
    await sendEventBounded({
      name: "dev_server.stop_requested",
      data: {
        sessionId: input.sessionId,
        tenantId,
        reason: "user",
      },
    });

    // ── 3. Eagerly flip status to 'stopped' so the UI updates instantly ─
    // Previously the engine waited for the runner's heartbeat to own the
    // status='stopped' transition. That left the panel stuck on "Starting"
    // / "Running" when (a) the runner was dead, (b) the runner had been
    // restarted and lost the TRACKED entry (orphan case), or (c) the
    // runner just took 5-30s to pull from Redis. The cost of flipping
    // here is one extra UPDATE; the runner's eventual 'stopped' heartbeat
    // is now idempotent. The heartbeat endpoint also skips updates on
    // already-terminal rows so a late 'running' heartbeat racing past the
    // stop click can't resurrect the row.
    // Flip EVERY active session for this project (not just the clicked one) so
    // stale siblings — e.g. rows left 'running'/'needs_env' by a runner restart
    // that lost its TRACKED entry — can't keep the panel from going idle. The
    // clicked session's child is killed via the stop event above; stale
    // siblings' children are already dead. Wider status set covers building/needs_env.
    // Tenant-scoped (`tenantId` is proven equal to this session's own tenant
    // above). This is a project-wide UPDATE, so unscoped it was a cross-tenant
    // WRITE: `dev_server_sessions`' member write policy pins only the row's own
    // `tenant_id`, so a hostile tenant could point a row at our project and have
    // our Stop click mark THEIR session stopped.
    const { error: updErr } = await supabase
      .from("dev_server_sessions")
      .update({
        status: "stopped",
        status_reason: "user-requested",
        last_interaction_at: new Date().toISOString(),
        stopped_at: new Date().toISOString(),
      })
      .eq("project_id", sessionRow.project_id)
      .eq("tenant_id", sessionRow.tenant_id)
      .in("status", ["starting", "running", "errored", "building", "needs_env"]);
    if (updErr) {
      // Non-fatal: the stop event already left the building. We log
      // server-side so an ops dashboard can spot a UI/DB skew if it
      // happens, but we don't surface a misleading error.
      console.warn(
        `[run-actions/stop] status flip failed for ${input.sessionId}: ${updErr.message}`,
      );
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Cheap interaction-bump action. Called by the RunPanel periodically (every
 * ~60s) while the operator has the panel mounted so the 30-minute idle
 * reaper holds off.
 *
 * Returns void deliberately: the panel doesn't need a result, and we don't
 * want to surface a transient DB error here when the user hasn't asked for
 * anything.
 */
export async function pingDevServerInteractionAction(input: { sessionId: string }): Promise<void> {
  try {
    await requireUser();
    const tenantId = await requireTenantId();
    const supabase = supabaseService();
    // Single UPDATE; the tenant_id check stays in WHERE so a stray sessionId
    // from another tab/tenant can't bump a row it shouldn't.
    await supabase
      .from("dev_server_sessions")
      .update({ last_interaction_at: new Date().toISOString() })
      .eq("id", input.sessionId)
      .eq("tenant_id", tenantId);
  } catch (err) {
    // Best-effort; deliberately swallow.
    console.warn(`[run-actions/ping] failed for ${input.sessionId}: ${(err as Error).message}`);
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * fs.stat-based existence check that distinguishes "is a directory" from
 * "exists as a file/link". Returns false on any stat error (the common case
 * we care about: ENOENT). Kept local to this file because the only caller
 * is the workspace check above.
 */
async function dirExistsSafe(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find every child PID under `pid` (recursively). Uses `pgrep -P <pid>`
 * which is on every Mac/Linux box. Returns an empty array on any error
 * or when the process has no children. Bounded to ~100 PIDs to prevent
 * runaways on misbehaving system state.
 */
async function findChildPids(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    const child = spawn("pgrep", ["-P", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("close", () => {
      const pids = out
        .split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      resolve(pids.slice(0, 100));
    });
    child.on("error", () => resolve([]));
  });
}

/**
 * SIGTERM `pid` and every descendant (bottom-up). The 2026-06-08 incident
 * was that the runner records `pnpm dev`'s pid in the session row, kills
 * that, but Next.js's `next-server` child (the actual port-listener)
 * survives — leaving the workspace's port still bound and the next
 * `pnpm dev` exits with "Another next dev server is already running."
 * Killing the tree catches all descendants so the workspace is fully
 * freed before we re-spawn.
 */
async function killProcessTree(pid: number): Promise<void> {
  const children = await findChildPids(pid);
  for (const c of children) {
    await killProcessTree(c);
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    // ESRCH = no such process — already dead, treat as success.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      console.warn(
        `[run-actions/killTree] SIGTERM ${pid} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Find every PID listening on `port` via `lsof -ti :<port>`. Used as a
 * belt-and-suspenders kill target in case `session.pid` is null (e.g. the
 * session errored before the runner could record the pid) but a stale
 * `next-server` is still bound to the port.
 */
async function findPidsOnPort(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    const child = spawn("lsof", ["-ti", `:${port}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("close", () => {
      const pids = out
        .split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      resolve(Array.from(new Set(pids)));
    });
    child.on("error", () => resolve([]));
    // Bound the lsof call so a hang can't stall a branch switch.
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve([]);
    }, 3000);
  });
}

/**
 * Wait up to `timeoutMs` for every pid in `pids` to be dead. Polls every
 * 100ms via `process.kill(pid, 0)`. Returns the list of pids STILL alive
 * after the timeout (caller can SIGKILL them).
 */
async function waitForPidsDead(pids: number[], timeoutMs: number): Promise<number[]> {
  const start = Date.now();
  let alive = pids.slice();
  while (alive.length > 0 && Date.now() - start < timeoutMs) {
    alive = alive.filter((p) => {
      try {
        process.kill(p, 0);
        return true; // still alive
      } catch {
        return false; // dead
      }
    });
    if (alive.length === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return alive;
}

// ─── branch picker actions ─────────────────────────────────────────────────

/**
 * List the branches available on the project's GitHub repo. Used by the
 * dev-server branch picker dropdown. The first call may take a few hundred
 * ms (GitHub API round-trip); the UI caches results client-side until the
 * dropdown is reopened.
 *
 * Resolves the GitHub token via the project owner's identity (consistent
 * with how the runner and push action resolve tokens for the same repo).
 */
export async function listProjectBranchesAction(input: {
  projectId: string;
}): Promise<ListProjectBranchesResult> {
  try {
    await requireUser();
    const tenantId = await requireTenantId();
    const project = await loadProjectById(input.projectId);
    if (!project) return { ok: false, error: "Project not found." };
    if (project.tenantId !== tenantId) return { ok: false, error: "Project not found." };
    if (!project.githubOwner || !project.githubRepo) {
      return {
        ok: false,
        error: "Project isn't connected to a GitHub repo.",
      };
    }
    if (!project.createdBy) {
      return { ok: false, error: "Project has no owner identity." };
    }
    const token = await getGithubAccessToken(project.createdBy);
    if (!token) {
      return { ok: false, error: "GitHub token not available." };
    }
    const branches = await listRepoBranches(
      { token },
      {
        owner: project.githubOwner,
        repo: project.githubRepo,
      },
    );
    return {
      ok: true,
      branches: branches.map((b) => ({
        name: b.name,
        protected: b.protected,
      })),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Switch the workspace of an existing dev-server session to a different
 * branch and restart the server. Four-step flow:
 *
 *   1. Auto-stash any uncommitted edits in the workspace (so the checkout
 *      doesn't lose operator work; mirrors workspace.ts re-entry stash).
 *   2. `git fetch origin <branch>` + `git checkout <branch>` + `git pull
 *      --ff-only` so the workspace lands on the remote tip.
 *   3. Stop the current session (eager status flip + Inngest stop event).
 *   4. Insert a new `dev_server_sessions` row pointed at the SAME workspace
 *      with the new branch label, then emit `dev_server.start_requested`.
 *
 * Returns the new session id so the panel can subscribe to it. The old
 * session row stays in the DB with status='stopped' as audit trail.
 *
 * Caveat: the new row's ticket_id is null because the workspace is no
 * longer tied to its original ticket's branch. If the original ticket
 * dispatches a new run, the runner's re-entry logic will switch the
 * workspace BACK to devpilot/<slug> automatically — at which point this dev
 * server would mis-render (stale branch label vs reality). Operator
 * should stop the manual-branch session before re-dispatching the ticket.
 */
export async function switchDevServerBranchAction(
  input: SwitchDevServerBranchInput,
): Promise<SwitchDevServerBranchResult> {
  try {
    const user = await requireUser();
    const tenantId = await requireTenantId();

    if (!BRANCH_NAME_RE.test(input.branch)) {
      return {
        ok: false,
        error: "Branch name must be ASCII letters/digits/`.`/`_`/`/`/`-` (max 200 chars).",
      };
    }

    const supabase = supabaseService();
    const { data: sessRow, error: sessErr } = await supabase
      .from("dev_server_sessions")
      .select("id, tenant_id, project_id, ticket_id, workspace_path, branch, command, pid")
      .eq("id", input.sessionId)
      .maybeSingle();
    if (sessErr) return { ok: false, error: `Lookup failed: ${sessErr.message}` };
    if (!sessRow) return { ok: false, error: "Session not found." };
    if ((sessRow as { tenant_id: string }).tenant_id !== tenantId) {
      return { ok: false, error: "Session not found." };
    }
    const session = sessRow as {
      id: string;
      tenant_id: string;
      project_id: string;
      ticket_id: string | null;
      workspace_path: string;
      branch: string;
      command: string;
      pid: number | null;
    };
    // Same bug class as the start action above — `workspace_path` may have
    // been persisted by a different host. Re-derive it for THIS host before
    // touching disk so a foreign row fails with the clear "no longer exists"
    // message below instead of surfacing a raw git ENOENT deeper in the flow.
    session.workspace_path = hostWorkspacePath(
      session.workspace_path,
      session.ticket_id,
      session.project_id,
      WORKSPACE_ROOT,
    );

    if (session.branch === input.branch) {
      return {
        ok: false,
        error: `Session is already on ${input.branch}.`,
      };
    }

    // Workspace must exist on disk for the checkout to work.
    const exists = await dirExistsSafe(session.workspace_path);
    if (!exists) {
      return {
        ok: false,
        error:
          `Workspace directory ${session.workspace_path} no longer exists on disk. ` +
          `Stop the session and start a new one to re-clone.`,
      };
    }

    // 0. Synchronously kill the current dev server AND every descendant
    //    BEFORE we touch the workspace. The runner-side stop event is
    //    emitted below for housekeeping; we can't wait for it
    //    asynchronously because the new `pnpm dev` will refuse to start
    //    if any descendant of the old one is still bound to the workspace
    //    ("Another next dev server is already running" exit:1).
    //
    //    Strategy:
    //      (a) Tree-kill session.pid + descendants. Catches the
    //          pnpm-wrapper → next-CLI → next-server chain.
    //      (b) Belt-and-suspenders: find any pid listening on session.port
    //          (the previous Next.js's actual port-binder) and SIGTERM
    //          it. Catches the case where (a) skipped the orphan because
    //          the recorded pid was already dead but the orphan child
    //          survived.
    //      (c) Pull ALL recent non-stopped sessions for the same
    //          workspace and SIGTERM their recorded pids too. Defends
    //          against the picker being invoked from a stale errored
    //          session whose pid column is null while an EARLIER session
    //          still holds the port.
    //
    //    Then poll up to 5s, SIGKILL anything still alive.
    const toKillSet = new Set<number>();
    if (session.pid && session.pid > 0) toKillSet.add(session.pid);

    // (c) other sessions on the same workspace
    // Tenant-scoped, and this is the worst one in the file: the pids this
    // returns are then SIGTERM'd/SIGKILL'd. Unscoped, a planted row naming our
    // project and workspace_path could hand us an arbitrary pid to kill.
    // `session.tenant_id` is proven equal to the caller's tenant above.
    const { data: siblingSessions } = await supabase
      .from("dev_server_sessions")
      .select("pid, port")
      .eq("project_id", session.project_id)
      .eq("tenant_id", session.tenant_id)
      .eq("workspace_path", session.workspace_path)
      .neq("id", session.id)
      .in("status", ["starting", "running", "errored"]);
    if (siblingSessions) {
      for (const s of siblingSessions as Array<{ pid: number | null; port: number | null }>) {
        if (s.pid && s.pid > 0) toKillSet.add(s.pid);
        if (s.port && s.port > 0) {
          const onPort = await findPidsOnPort(s.port);
          for (const p of onPort) toKillSet.add(p);
        }
      }
    }

    // (b) port-listener probe on session's own port
    if (session.command) {
      // best-effort: scan a small port range that the runner picks
      // from. DEVPILOT_DEV_SERVER_PORT_START defaults to 3100.
      for (let port = 3100; port <= 3110; port++) {
        const onPort = await findPidsOnPort(port);
        for (const p of onPort) toKillSet.add(p);
      }
    }

    // Filter out our own pid so we don't accidentally SIGTERM the web
    // server's own node process while serving this request.
    toKillSet.delete(process.pid);

    if (toKillSet.size > 0) {
      console.log(
        `[run-actions/switch] killing ${toKillSet.size} pid(s) before checkout: ${[...toKillSet].join(",")}`,
      );
      for (const pid of toKillSet) {
        await killProcessTree(pid);
      }
      const stillAlive = await waitForPidsDead([...toKillSet], 5000);
      if (stillAlive.length > 0) {
        console.warn(
          `[run-actions/switch] ${stillAlive.length} pid(s) still alive after SIGTERM, sending SIGKILL: ${stillAlive.join(",")}`,
        );
        for (const pid of stillAlive) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    // 1+2. Auto-stash, fetch, checkout, pull --ff-only, restore stash — the one
    //      non-destructive checkout seam, shared with the start path
    //      (`switchWorkspaceToBranch`). The fetch is best-effort inside it so a
    //      never-pushed feature branch (`devpilot/<slug>`, which has no
    //      `origin/<branch>`) can still be checked out — that's the return trip
    //      after previewing `dev` from the Changes page, and a fatal fetch used
    //      to strand the operator on the previewed branch.
    const switched = await switchWorkspaceToBranch(session.workspace_path, input.branch, {
      stashLabel: `devpilot-branch-switch-${input.sessionId}-${Date.now()}`,
      // Best-effort, and freshly resolved: the workspace's own remote carries
      // no credential to fall back on.
      token: await getGithubAccessToken(user.id),
    });
    if (!switched.ok) {
      return {
        ok: false,
        error: `Branch switch failed: ${switched.error}`,
      };
    }

    // 2.5. Reinstall dependencies. Different branches can have different
    //      package.json / pnpm-lock.yaml — the 2026-06-08 incident was
    //      switching from a branch without `next-themes` to one with it,
    //      which left node_modules stale and the dev server build-errored
    //      on `Module not found: 'next-themes'`.
    //
    //      We run unconditionally because pnpm's content-addressable
    //      store makes a no-op install fast (~3-10s on a warm cache),
    //      and detecting "lockfile actually changed" via git diff is
    //      noise relative to that cost. Failures here are surfaced as a
    //      warning, NOT fatal — the operator may want to debug + retry
    //      manually if their lockfile is in a weird state.
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("pnpm", ["install"], {
          cwd: session.workspace_path,
          stdio: ["ignore", "ignore", "pipe"],
          env: { ...process.env, CI: "1" }, // silence pnpm interactive UI
        });
        let stderr = "";
        child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
          reject(new Error("pnpm install timed out after 5 minutes"));
        }, 300_000);
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`pnpm install exited ${code}: ${stderr.slice(0, 400)}`));
        });
      });
      console.log(`[run-actions/switch] pnpm install completed in ${session.workspace_path}`);
    } catch (err) {
      console.warn(
        `[run-actions/switch] pnpm install failed (continuing — dev server may build-error):`,
        err instanceof Error ? err.message : err,
      );
    }

    // 3. Stop the current session. Idempotent — the engine + runner both
    //    tolerate stop-on-stopped no-ops.
    await sendEventBounded({
      name: "dev_server.stop_requested",
      data: {
        sessionId: session.id,
        tenantId,
        reason: "user",
      },
    });
    await supabase
      .from("dev_server_sessions")
      .update({
        status: "stopped",
        status_reason: "branch-switch",
        last_interaction_at: new Date().toISOString(),
        stopped_at: new Date().toISOString(),
      })
      .eq("id", session.id)
      .in("status", ["starting", "running", "errored"]);

    // 4. Insert a new session row for the new branch.
    //    ticket_id is null because the workspace is now operator-controlled,
    //    not bound to the original ticket's lifecycle.
    // Reuse the session's own command when it has one; only fall back to
    // detection otherwise. The session row carries no platform, so that fallback
    // resolves it from the project the session belongs to (`project_id` comes
    // off the already tenant-verified row above). Loaded lazily — the common
    // path keeps its existing command and must not pay an extra round trip. A
    // missing project (hard-deleted mid-session) degrades to the no-steering
    // default rather than failing the branch switch.
    async function detectCommandForSession(): Promise<string> {
      const sessionProject = await loadProjectById(session.project_id);
      return inferDevCommand(
        session.workspace_path,
        sessionProject?.projectType ?? DEFAULT_PROJECT_TYPE,
      );
    }
    const command =
      session.command && session.command.trim().length > 0
        ? session.command
        : await detectCommandForSession();
    const { data: inserted, error: insertErr } = await supabase
      .from("dev_server_sessions")
      .insert({
        tenant_id: tenantId,
        project_id: session.project_id,
        ticket_id: null,
        pending_push_id: null,
        workspace_path: session.workspace_path,
        branch: input.branch,
        command,
        status: "starting",
        started_by_user_id: user.id,
      })
      .select("id")
      .single();
    if (insertErr || !inserted) {
      return {
        ok: false,
        error: insertErr?.message ?? "Failed to insert new dev_server_sessions row.",
      };
    }
    const newSessionId = (inserted as { id: string }).id;

    await sendEventBounded({
      name: "dev_server.start_requested",
      data: {
        sessionId: newSessionId,
        tenantId,
        projectId: session.project_id,
        workspacePath: session.workspace_path,
        branch: input.branch,
        command,
        startedByUserId: user.id,
      },
    });

    return { ok: true, sessionId: newSessionId };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
