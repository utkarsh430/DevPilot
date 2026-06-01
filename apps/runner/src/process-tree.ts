// Process-tree termination + a resolution guarantee for piped spawns.
//
// `spawnTracked` below is the ONE implementation of that machinery. Both
// `tools/run-command.ts` (producer verification: `pnpm test`, `pnpm build`) and
// `git-utils.ts` (`git fetch` → `git-remote-https`/`ssh`) sit on it as thin
// wrappers that only cap output and shape their own result type; neither owns a
// second copy of the timeout/kill/settle state machine.
//
// The commands both wrappers run fork their real work into grandchildren. Two
// consequences, both fatal on the critical path before `postStepResult`:
//
//   1. `child.kill()` signals ONLY the direct child. SIGKILLing `pnpm` leaves
//      the test runner alive. So a timeout must reap the whole process group.
//   2. Node emits `close` only once every piped stdio stream hits EOF. A
//      surviving grandchild inherits the write ends, so `close` never fires and
//      the spawn promise never settles — even after the child is dead. `exit`
//      always fires, so it is the only sound resolution signal; `close` is
//      merely the preferred one because it guarantees all output is drained.
//
// `detached: true` buys (1) at a cost: the child leaves the spawning process's
// group, so it no longer inherits the group-wide signals that used to reap it —
// Ctrl-C in dev, a tmux pane teardown on cancel, or a runner restart. Nothing
// else would clean it up, stranding up to a full `VERIFICATION_COMMAND_TIMEOUT_MS`
// of `pnpm test` (or an unbounded `git clone`) against a workspace the next
// iteration reuses and `git clean -fdx`es. So every spawn registers itself here
// and both spawning processes — the runner (`index.ts`) and the stdio MCP relay
// (`mcp/server.ts`) — reap the survivors on their way out via
// `killAllSpawnedTrees`.
//
// Env-free (`node:child_process` types only), so `git-utils.ts` and the stdio
// MCP relay can both import it without pulling in `env.ts`.

import { spawn, type ChildProcess } from "node:child_process";

/** Windows has no `process.kill(-pid)` process-group semantics, and `detached`
 *  there means "new console", not "new group". Group-kill is POSIX-only. */
export const SUPPORTS_PROCESS_GROUPS = process.platform !== "win32";

/** Spawn options that make the child a process-group leader, so `killProcessTree`
 *  can reap its descendants. Merge into every `spawn()` whose command may fork. */
export const processGroupSpawnOptions: { detached: boolean } = {
  detached: SUPPORTS_PROCESS_GROUPS,
};

/**
 * How long to wait for `close` after `exit` before settling with whatever
 * output was drained. Only elapses when a descendant outlived the group kill
 * (or escaped it, e.g. by detaching itself) and still holds the stdio pipes.
 */
export const CLOSE_AFTER_EXIT_GRACE_MS = 2_000;

/** Grace period between the SIGTERM and the SIGKILL of a timed-out spawn. */
export const KILL_GRACE_MS = 5_000;

/**
 * How often to re-check a tree that was still alive when its caller settled.
 * See `watchForReap` - the settle-time check is a single sample, and a tree
 * that dies just after it would otherwise never be deregistered.
 */
export const REAP_POLL_MS = 250;

/**
 * Signal the child's entire process group, falling back to the direct child
 * when no group exists (Windows, or a spawn that predates the group). Never
 * throws: an already-reaped process makes `kill` raise ESRCH, which is success.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const { pid } = child;
  if (pid === undefined) return;
  if (SUPPORTS_PROCESS_GROUPS) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // No such group (child already reaped, or never became a leader) — fall
      // through and try the child directly.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

/**
 * Does any member of the child's process group still exist? Signal 0 performs
 * the permission/existence check without delivering anything.
 *
 * This is the only sound "is the tree gone" test. `close` is not: it fires once
 * every piped stream hits EOF, which a surviving descendant can trigger by
 * simply closing its inherited fds. Nor is the direct child's own exit: by the
 * time Node emits `exit` it has already reaped that pid, so a group that still
 * answers here is one that outlived its leader — precisely the survivor we care
 * about. A descendant that escaped into its own group answers ESRCH, correctly,
 * since no signal we can send would ever reach it again.
 */
function isProcessTreeAlive(child: ChildProcess): boolean {
  const { pid } = child;
  if (pid === undefined) return false;
  if (SUPPORTS_PROCESS_GROUPS) {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (err) {
      // EPERM means the group exists but is not ours to signal — still alive.
      return (err as NodeJS.ErrnoException)?.code === "EPERM";
    }
  }
  return child.exitCode === null && child.signalCode === null;
}

/** Live detached spawns of THIS process. An entry is removed once its tree is
 *  gone or beyond reach — NOT when its spawn promise settles. The two differ: a
 *  descendant holding the pipes outlives `exit`, so `spawnTracked` resolves its
 *  caller off a grace timer while the tree is still running. Deregistering
 *  there would hide exactly the survivor this set exists to reap. */
const liveTrees = new Set<ChildProcess>();

/**
 * Register a freshly-spawned detached child. Returns the deregister callback;
 * call it exactly once, and only once the tree is gone (its process group is
 * empty) or beyond reach (a SIGKILL to that group has already been sent).
 * Calling it on any other outcome strands survivors; never calling it leaks.
 */
export function trackSpawnedTree(child: ChildProcess): () => void {
  liveTrees.add(child);
  return () => {
    liveTrees.delete(child);
  };
}

/**
 * Signal every still-running tracked tree. Synchronous and non-throwing, so it
 * is safe from a `process.on("exit")` handler — which is the only hook that
 * still fires after `process.exit()`.
 *
 * Deliberately does NOT clear the set: a SIGTERM sweep during graceful shutdown
 * leaves survivors registered for the SIGKILL sweep on exit.
 */
export function killAllSpawnedTrees(signal: NodeJS.Signals): number {
  for (const child of liveTrees) killProcessTree(child, signal);
  return liveTrees.size;
}

export type SpawnTrackedOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Reap the process tree after this many ms. Omitted (or <= 0) means no
   *  timeout - correct for a `git clone` of an arbitrarily large repo, wrong
   *  for anything on a latency-sensitive path. */
  timeoutMs?: number;
  /** Called with every utf8 chunk. Callers cap their own buffers; this module
   *  never retains output. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type SpawnTrackedResult = {
  code: number | null;
  timedOut: boolean;
  /** Spawn-level failure (command not on PATH, cwd doesn't exist, …). Callers
   *  decide whether that is a thrown error or a reported outcome. */
  error: Error | null;
};

/**
 * Spawn `cmd` as a process-group leader with piped stdio, stream its output to
 * the caller, and resolve exactly once with the outcome. Never rejects: a spawn
 * failure arrives as `error`, a timeout as `timedOut`.
 *
 * Resolution is guaranteed. `close` is preferred (all output drained) but only
 * fires once every piped stream hits EOF, which a grandchild that outlived the
 * group kill holds open forever. `exit` always fires, so it arms a short
 * backstop - the promise must not depend on descendants we do not control.
 *
 * On timeout the whole group is signalled (`pnpm test` and `git fetch` both do
 * their real work in a grandchild that survives a direct `child.kill()`), then
 * escalated to SIGKILL after `KILL_GRACE_MS`.
 *
 * Resolving the promise and reaping the tree are separate lifecycles, and the
 * first finishes FIRST by design: when a descendant traps SIGTERM and keeps the
 * pipes open, the direct child's `exit` settles the caller after
 * `CLOSE_AFTER_EXIT_GRACE_MS` while that descendant is still running. So the
 * escalation is gated on `reaped` - never on `settled` (2s < 5s would cancel
 * every force-kill it exists for) and never on `child.killed` (Node sets that
 * the moment a signal is *sent*, so it is already true by then).
 */
export function spawnTracked(
  cmd: string,
  args: string[],
  opts: SpawnTrackedOptions,
): Promise<SpawnTrackedResult> {
  return new Promise<SpawnTrackedResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        ...processGroupSpawnOptions,
      });
    } catch (err) {
      resolve({
        code: null,
        timedOut: false,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    const untrack = trackSpawnedTree(child);

    let timedOut = false;
    let settled = false;
    let reaped = false;
    let killTimer: NodeJS.Timeout | null = null;
    let closeTimer: NodeJS.Timeout | null = null;
    let reapWatcher: NodeJS.Timeout | null = null;

    /** Hand the tree back: it is gone, or a SIGKILL has already been sent to
     *  its group and nothing further we can send would land. Idempotent. */
    const reap = () => {
      if (reaped) return;
      reaped = true;
      if (killTimer) clearTimeout(killTimer);
      if (reapWatcher) clearInterval(reapWatcher);
      untrack();
    };

    /** Deregister only once the group is actually empty. Called on every settle
     *  so a spawn whose tree died normally does not linger in `liveTrees`. */
    const reapIfTreeIsGone = () => {
      if (!isProcessTreeAlive(child)) reap();
    };

    /**
     * The tree was still up when the caller settled, so `reapIfTreeIsGone` -
     * which fires exactly once, from `settle` - declined to deregister it. That
     * single sample is not enough: the group is routinely still dying at that
     * instant (a SIGKILLed grandchild the kernel has not finished reaping), and
     * with nothing re-checking, the entry lingered in `liveTrees` for the rest
     * of the process's life. Two costs, and the second is the dangerous one:
     * `killAllSpawnedTrees` kept reporting a phantom live tree, and it went on
     * signalling that pid long after it died - straight into the RECYCLED-pid
     * hazard the SIGKILL escalation already guards against with `if (reaped)`.
     *
     * So keep sampling until the group is genuinely empty. Deliberately
     * unbounded: a descendant that never dies MUST stay registered, because the
     * shutdown reaper is the only thing that can still reach it. `unref`ed so
     * an outstanding watcher never holds the process open.
     */
    const watchForReap = () => {
      if (reaped || reapWatcher) return;
      reapWatcher = setInterval(reapIfTreeIsGone, REAP_POLL_MS);
      reapWatcher.unref();
    };

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcessTree(child, "SIGTERM");
            killTimer = setTimeout(() => {
              // Gated on `reaped`, never on `settled`: a SIGTERM-trapping
              // descendant leaves the group alive long after the caller was
              // resolved off the `close` backstop. Skipping an already-reaped
              // tree also keeps the SIGKILL off a recycled pid.
              if (reaped) return;
              killProcessTree(child, "SIGKILL");
              reap();
            }, KILL_GRACE_MS);
          }, opts.timeoutMs)
        : null;

    const settle = (result: SpawnTrackedResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (closeTimer) clearTimeout(closeTimer);
      // A descendant that escaped the group kill can still hold the pipes; stop
      // reading so it cannot grow the caller's buffers after we have resolved.
      child.stdout?.destroy();
      child.stderr?.destroy();
      reapIfTreeIsGone();
      // Still alive: hand it to the watcher rather than abandoning it here.
      watchForReap();
      resolve(result);
    };

    // Attach unconditionally, even with no sink: an unread pipe fills its
    // buffer and blocks the child on its next write.
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => opts.onStdout?.(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => opts.onStderr?.(chunk));

    child.on("error", (error) => {
      // The spawn never happened (ENOENT, bad cwd) — there is no tree at all.
      reap();
      settle({ code: null, timedOut, error });
    });

    child.on("exit", (code) => {
      if (settled || closeTimer) return;
      closeTimer = setTimeout(
        () => settle({ code, timedOut, error: null }),
        CLOSE_AFTER_EXIT_GRACE_MS,
      );
    });

    child.on("close", (code) => settle({ code, timedOut, error: null }));
  });
}
