// L1 (ticket-speed audit) — env-free git primitives shared by workspace.ts
// (the runner's main process, which DOES import env.ts), index.ts's
// verification hook, and mcp/server.ts (the stdio MCP relay subprocess, which
// deliberately does NOT - see that file's header comment: it lists only
// LOCAL_CC_ENGINE_URL and DEVPILOT_RUNNER_REGISTRATION_KEY as required env, and
// importing anything that pulls in env.ts's `required()` checks would risk a
// hard `process.exit(1)` inside a live MCP subprocess over env vars the relay
// never needed before).
//
// Every function here takes `cwd` explicitly and touches nothing but the
// equally env-free process-tree.ts, which owns the spawn/timeout/kill machinery
// this module only wraps — no engine calls, no env.ts, no filesystem writes.

import { spawnTracked } from "./process-tree.js";

/** Per-stream capture cap. Git's porcelain output is tiny; this only exists so
 *  a pathological repo can't balloon the runner's heap. */
const MAX_STREAM_CHARS = 64 * 1024;

/**
 * Git env that can never block on an interactive credential prompt. Several of
 * these calls (`fetch`) run on the critical path before `postStepResult`, and a
 * repo whose origin URL carries no embedded token would otherwise have git ask
 * for a username on /dev/tty - which never returns when the runner is detached
 * or living inside a tmux pane, wedging the step forever.
 *
 * Deliberately does NOT set `GIT_ASKPASS`. Git resolves its askpass helper from
 * `GIT_ASKPASS`, then `core.askpass`, then `SSH_ASKPASS`, stopping at the first
 * one that is *set* - so forcing `GIT_ASKPASS=""` would suppress an operator's
 * exported helper AND their `core.askpass` config, breaking every clone/push on
 * an askpass-authenticated HTTPS remote (same defect class `resolveGitSshCommand`
 * below avoids for `GIT_SSH_COMMAND`). It is also unnecessary: with no helper
 * configured anywhere, the chain lands on `SSH_ASKPASS=""` and git skips askpass
 * entirely, then `GIT_TERMINAL_PROMPT=0` kills the terminal fallback.
 * `SSH_ASKPASS_REQUIRE=never` pins askpass off for ssh itself. A configured
 * helper that never answers is bounded by the per-call `timeoutMs`.
 */
function baseGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
  };
}

/** Non-interactive default for `ssh://` remotes (ssh does its own prompting,
 *  which `GIT_TERMINAL_PROMPT` does not reach). */
const BATCH_MODE_SSH_COMMAND = "ssh -oBatchMode=yes";

/**
 * Which `GIT_SSH_COMMAND` (if any) this process should inject.
 *
 * Git resolves the ssh binary from `GIT_SSH_COMMAND` first and only falls back
 * to `core.sshCommand` when that env var is unset - so injecting a default
 * unconditionally would silently override an operator's configured deploy key
 * (`core.sshCommand = ssh -i ~/.ssh/deploy_key`) and break every clone/push on
 * an ssh remote. Inject the batch-mode default only when the operator has
 * expressed no preference at all; otherwise honour theirs untouched and rely on
 * the per-call `timeoutMs` to bound a prompt that never answers.
 *
 * Returns undefined when nothing should be injected.
 */
export function resolveGitSshCommand(
  envSshCommand: string | undefined,
  coreSshCommand: string | null,
): string | undefined {
  if (envSshCommand && envSshCommand.length > 0) return undefined;
  if (coreSshCommand && coreSshCommand.length > 0) return undefined;
  return BATCH_MODE_SSH_COMMAND;
}

/** `core.sshCommand` is repo-scoped (with global/system fallback), so it is
 *  resolved per cwd. Bounded: a long-lived runner sees one entry per workspace. */
const coreSshCommandCache = new Map<string, string | null>();
const CORE_SSH_COMMAND_CACHE_MAX = 256;

async function readCoreSshCommand(cwd: string): Promise<string | null> {
  const cached = coreSshCommandCache.get(cwd);
  if (cached !== undefined) return cached;
  // Purely local config read - spawned with the base env so it can't recurse
  // back into this resolver.
  const { code, stdout } = await spawnGit(
    cwd,
    ["config", "--get", "core.sshCommand"],
    baseGitEnv(),
    {
      timeoutMs: LOCAL_GIT_TIMEOUT_MS,
    },
  );
  const value = code === 0 ? stdout.trim() : "";
  const resolved = value.length > 0 ? value : null;
  if (coreSshCommandCache.size >= CORE_SSH_COMMAND_CACHE_MAX) coreSshCommandCache.clear();
  coreSshCommandCache.set(cwd, resolved);
  return resolved;
}

async function nonInteractiveGitEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  const env = baseGitEnv();
  const envSshCommand = process.env.GIT_SSH_COMMAND;
  // Skip the config read entirely when the env already decides it.
  const coreSshCommand = envSshCommand ? null : await readCoreSshCommand(cwd);
  const sshCommand = resolveGitSshCommand(envSshCommand, coreSshCommand);
  if (sshCommand) env.GIT_SSH_COMMAND = sshCommand;
  return env;
}

export type GitRunOptions = {
  /** Kill the git process after this many ms. Omitted = no timeout (correct for
   *  `clone` of an arbitrarily large repo); pass one for anything that talks to
   *  a remote on a latency-sensitive path. */
  timeoutMs?: number;
};

type GitExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn-level failure (git not on PATH, cwd doesn't exist, …). */
  error: Error | null;
};

/** Spawn `git <args>` in `cwd` with an explicit env and resolve with the
 *  outcome. Never rejects - spawn failures and timeouts are reported through
 *  the result. Output capping is all this adds over `spawnTracked`. */
async function spawnGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: GitRunOptions = {},
): Promise<GitExecResult> {
  let stdout = "";
  let stderr = "";
  const { code, timedOut, error } = await spawnTracked("git", args, {
    cwd,
    env,
    timeoutMs: opts.timeoutMs,
    onStdout: (chunk) => {
      if (stdout.length < MAX_STREAM_CHARS) stdout += chunk;
    },
    onStderr: (chunk) => {
      if (stderr.length < MAX_STREAM_CHARS) stderr += chunk;
    },
  });
  return { code, stdout, stderr, timedOut, error };
}

/** `spawnGit` with the non-interactive env this module guarantees. */
async function execGit(
  cwd: string,
  args: string[],
  opts: GitRunOptions = {},
): Promise<GitExecResult> {
  return spawnGit(cwd, args, await nonInteractiveGitEnv(cwd), opts);
}

/** Run a git subcommand; throws on non-zero exit with stderr in the message.
 *  Callers (workspace.ts) match on the `exited <code>` shape - keep it. */
export async function runGit(cwd: string, args: string[], opts?: GitRunOptions): Promise<void> {
  const { code, stderr, timedOut, error } = await execGit(cwd, args, opts);
  if (error) throw error;
  if (timedOut) {
    throw new Error(`git ${args.join(" ")} timed out after ${opts?.timeoutMs}ms`);
  }
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr.slice(0, 800).trim()}`);
  }
}

/** Like `runGit` but returns false on non-zero exit instead of throwing. */
export async function tryRunGit(
  cwd: string,
  args: string[],
  opts?: GitRunOptions,
): Promise<boolean> {
  try {
    await runGit(cwd, args, opts);
    return true;
  } catch {
    return false;
  }
}

/** Purely local plumbing - should answer in milliseconds. */
const LOCAL_GIT_TIMEOUT_MS = 15_000;
/** Talks to the remote. Bounded because `isHeadPushedToOrigin` sits on the
 *  critical path before every `postStepResult`. */
const REMOTE_GIT_TIMEOUT_MS = 60_000;

/** Read a single-line git value; null on any failure (non-zero, spawn error,
 *  timeout, empty output). */
async function readGitLine(
  cwd: string,
  args: string[],
  opts?: GitRunOptions,
): Promise<string | null> {
  const { code, stdout, timedOut, error } = await execGit(cwd, args, opts);
  if (error || timedOut || code !== 0) return null;
  const value = stdout.trim();
  return value.length > 0 ? value : null;
}

/** Full 40-char HEAD sha for the verification record. Returns null on unborn
 *  HEAD or any error. */
export async function readGitFullHeadSha(cwd: string): Promise<string | null> {
  return readGitLine(cwd, ["rev-parse", "HEAD"], { timeoutMs: LOCAL_GIT_TIMEOUT_MS });
}

/** Abbreviated HEAD sha, for the dev-server file-watcher heartbeat's
 *  "operator committed locally" signal. Null on unborn HEAD or any error. */
export async function readGitShortHeadSha(cwd: string): Promise<string | null> {
  return readGitLine(cwd, ["rev-parse", "--short", "HEAD"], { timeoutMs: LOCAL_GIT_TIMEOUT_MS });
}

/** Current branch name (`git rev-parse --abbrev-ref HEAD`). Null on detached
 *  HEAD or any error. Read fresh at verification time (not cached from
 *  workspace-prepare time) so a branch switch mid-run is reflected. */
export async function readGitCurrentBranch(cwd: string): Promise<string | null> {
  const name = await readGitLine(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], {
    timeoutMs: LOCAL_GIT_TIMEOUT_MS,
  });
  // Detached HEAD reports the literal `HEAD`; treat as null.
  return name === "HEAD" ? null : name;
}

/**
 * Is the workspace's current HEAD reachable from `origin/<branch>`? Fetches
 * the branch first so a push earlier in the same step is reflected, then
 * checks ancestry rather than exact sha equality (origin may be ahead by
 * commits from another actor). Returns false (never throws) on any failure —
 * missing remote branch, network error, timeout, or unborn HEAD are all
 * "not pushed".
 *
 * NOTE (L1 v1): this is NOT on the verification hot path in v1 — the captain's
 * O2 decision defers `pushed`-blocking and forbids a `git fetch` on the
 * critical path. `isHeadPushedToOriginLocal` (below, fetch-free) records the
 * `pushed` field instead. This function is kept for the deferred O2 follow-up
 * (block on unpushed) which will opt into the network round-trip deliberately,
 * and for git-utils.test.ts's coverage of the accurate cross-actor semantics.
 */
export async function isHeadPushedToOrigin(cwd: string, branch: string): Promise<boolean> {
  const fetched = await tryRunGit(cwd, ["fetch", "origin", branch], {
    timeoutMs: REMOTE_GIT_TIMEOUT_MS,
  });
  if (!fetched) return false;
  return tryRunGit(cwd, ["merge-base", "--is-ancestor", "HEAD", `origin/${branch}`], {
    timeoutMs: LOCAL_GIT_TIMEOUT_MS,
  });
}

/**
 * Fetch-FREE variant used by the L1 verification hook (v1). Answers "is HEAD an
 * ancestor of the LOCAL `origin/<branch>` remote-tracking ref?" with no network
 * round-trip — the check runs before every `postStepResult`, and O2 forbids a
 * `git fetch` there. This is accurate for the case that matters: the agent's
 * OWN `git push` during the step updates the local `origin/<branch>` tracking
 * ref, so a commit this run pushed reads back as `pushed: true` immediately. It
 * does NOT see pushes made by other actors since the last clone/fetch — exactly
 * the cross-actor ambiguity O2 defers. Returns false (never throws) on any
 * failure, including a missing local remote-tracking ref or an unborn HEAD.
 */
export async function isHeadPushedToOriginLocal(cwd: string, branch: string): Promise<boolean> {
  return tryRunGit(cwd, ["merge-base", "--is-ancestor", "HEAD", `origin/${branch}`], {
    timeoutMs: LOCAL_GIT_TIMEOUT_MS,
  });
}

/**
 * L1 / B2 (empty delivery) — how many commits are on HEAD that are NOT on
 * `origin/<baseBranch>`? I.e. "does the work this ticket claims to have
 * delivered actually exist on this branch?"
 *
 * This is a DIFFERENT question from the record's `base_sha === head_sha`, which
 * asks only "did THIS run commit". The two diverge on the case that matters
 * most: a QA-reject retry starts with the ticket branch tip as its base, so a
 * retry run that commits nothing has `base_sha === head_sha` even though the
 * ticket's earlier work is real and present. Gating on the run-scoped pair
 * alone would refuse that legitimate hand-off; gating on this count does not.
 *
 * Fetch-FREE, like `isHeadPushedToOriginLocal` and for the same reason (O2
 * forbids a `git fetch` on this critical path). The local `origin/<baseBranch>`
 * tracking ref is written by the clone, which is exactly the base the ticket
 * branch was cut from — the correct comparison point.
 *
 * Returns null (never 0) on ANY inability to answer: a missing tracking ref, an
 * unborn HEAD, a bad branch name, a git error, or unparseable output. Null means
 * "could not determine" and the gate fails OPEN on it — inventing a 0 here would
 * refuse a hand-off on the strength of a git failure, which is precisely the
 * fail-closed behaviour this gate must never have.
 */
export async function readGitCommitsAhead(cwd: string, baseBranch: string): Promise<number | null> {
  const branch = baseBranch.trim();
  if (branch.length === 0) return null;
  const raw = await readGitLine(cwd, ["rev-list", "--count", `origin/${branch}..HEAD`], {
    timeoutMs: LOCAL_GIT_TIMEOUT_MS,
  });
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The working tree's uncommitted state as `git status --porcelain` lines, for
 * the empty-delivery nudge (`empty-delivery.ts`).
 *
 * An EMPTY array is a meaningful answer — "nothing uncommitted on disk" — and
 * is what distinguishes the two cases the nudge must never confuse: a run that
 * WROTE work and failed to commit it (nudgeable, and the measured defect) from
 * one that produced nothing at all (not nudgeable; the QA gate refuses it and
 * the ticket parks for a human in one pass).
 *
 * Returns null (never `[]`) on ANY inability to answer — a git error, a
 * timeout, a spawn failure, a directory that is not a repository. Null is
 * fail-open at the caller, exactly like `readGitCommitsAhead`'s null: an
 * unreadable worktree must never be inferred to be a clean one, because that
 * inference is what would turn a git failure into a skipped nudge on a run that
 * genuinely needed it.
 *
 * `--porcelain` (v1) is a STABLE, script-facing format by git's own contract,
 * and it already excludes ignored files — including the `.env.local`
 * `prepareWorkspace` writes and adds to `.git/info/exclude`, so the blanket
 * `git add -A` the nudge recommends cannot stage the project's secrets.
 * Untracked files ARE listed (as `??`), which is the whole point: #86's new
 * fixtures directory was untracked, and a check blind to those would have read
 * that workspace as clean.
 */
export async function readGitWorkingTreeStatus(cwd: string): Promise<string[] | null> {
  const { code, stdout, timedOut, error } = await execGit(cwd, ["status", "--porcelain"], {
    timeoutMs: LOCAL_GIT_TIMEOUT_MS,
  });
  if (error || timedOut || code !== 0) return null;
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
