// Phase 1 / M0 — `devpilot_run_command` primitive (Wave 1, runner-side only).
//
// Library function the runner's main loop will call to execute a single
// command inside an Engineer/QA workspace. NOT exposed as a CLI binary in
// Wave 1; Wave 2 surfaces it via MCP and wires it into the role prompts.
//
// Security/durability properties:
//   - Uses `child_process.spawn` with explicit args (NO shell). Caller passes
//     `cmd` + `args` separately; we never interpolate user strings into a
//     shell command line.
//   - Captures stdout/stderr up to MAX_OUTPUT_BYTES each, then truncates
//     with a clear marker. This keeps tool-result payloads bounded.
//   - Enforces `timeoutMs` (default 5 minutes). On timeout: SIGTERM → grace
//     period → SIGKILL, both against the child's whole process group, because
//     the commands we run (`pnpm test`) do their real work in grandchildren.
//     Always resolves; the caller inspects `timedOut`.
//   - Returns even on non-zero exit; non-zero is data, not an exception.

import { spawnTracked } from "../process-tree.js";

export type RunCommandInput = {
  cwd: string;
  cmd: string;
  args: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
};

export type RunCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1_024 * 1_024; // 1 MiB per stream
const TRUNCATION_MARKER = "\n…[truncated: output exceeded 1 MiB]\n";

/** A capped sink: appends until MAX_OUTPUT_BYTES, then marks and stops. */
function cappedSink(): { append: (chunk: string) => void; read: () => string } {
  let buffer = "";
  let bytes = 0;
  let truncated = false;
  return {
    append: (chunk: string) => {
      if (truncated) return;
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (chunk.length >= remaining) {
        buffer += chunk.slice(0, remaining) + TRUNCATION_MARKER;
        bytes = MAX_OUTPUT_BYTES;
        truncated = true;
      } else {
        buffer += chunk;
        bytes += chunk.length;
      }
    },
    read: () => buffer,
  };
}

/**
 * Run a single command and return a structured result. Never throws on
 * non-zero exit; throws only if spawn itself fails (e.g. cmd not found).
 *
 * The spawn/timeout/group-kill/settle machinery lives in `process-tree.ts` and
 * is shared with `git-utils.ts`; this adds output capping and result shaping.
 */
export async function runCommand(input: RunCommandInput): Promise<RunCommandResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  // Merge env: if caller provides `env`, layer it on top of process.env so we
  // don't accidentally strip $PATH, $HOME, etc. (which would break common
  // tools like `git`, `pnpm`). To run with a totally clean env, caller can
  // pass a fully-populated dict and we still merge — Wave 1 favors safety
  // over isolation; sandboxing is a later concern (E2B / Phase 2).
  const procEnv: NodeJS.ProcessEnv = input.env
    ? { ...process.env, ...input.env }
    : { ...process.env };

  const stdout = cappedSink();
  const stderr = cappedSink();

  const { code, timedOut, error } = await spawnTracked(input.cmd, input.args, {
    cwd: input.cwd,
    env: procEnv,
    timeoutMs,
    onStdout: stdout.append,
    onStderr: stderr.append,
  });
  if (error) throw error;

  return {
    exitCode: code,
    stdout: stdout.read(),
    stderr: stderr.read(),
    durationMs: Date.now() - startedAt,
    timedOut,
  };
}
