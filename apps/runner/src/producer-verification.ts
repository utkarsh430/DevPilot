// L1 (ticket-speed audit, §L1 / §#1) — record whether a producer role's step
// actually passes its verification command before the ticket reaches QA.
//
// This module is pure logic only (no child_process, no network) so it can run
// under the bare-`main()` convention this package uses instead of a test
// runner (see connect-retry.test.ts / poll-backoff.test.ts). The runner's
// index.ts supplies the actual command executor (tools/run-command.ts's
// `runCommand`) via dependency injection.

/**
 * Roles whose `onSuccessStatus` (apps/web/lib/roles/*.ts) is NOT `"in_review"`
 * — i.e. roles that are not handed off to QA for review, so a QA/build
 * verification command after their step is meaningless. This mirrors
 * `applyReviewerAwareness`'s gate (apps/web/lib/roles/reviewer-awareness.ts)
 * from the runner side, where the actual `onSuccessStatus` field is never
 * projected into the job payload (see AGENTS.md's reviewer-awareness note).
 *
 * `qa` / `verifier` / `release_engineer` self-drive to `done`; `pm` moves
 * tickets to `ready`; `triage` moves to `in_progress`. Every other built-in
 * role — and any custom JD-synthesized role not in this set — defaults to
 * `in_review` and is treated as a producer here. A custom role that sets its
 * own `onSuccessStatus: "done"` (a self-driving reviewer-type custom role)
 * will be misclassified as a producer; the runner has no way to see that
 * field today. Acceptable false-positive (an extra, harmless test run) over a
 * false-negative (skipping verification of a real producer).
 */
const NON_PRODUCER_ROLES: ReadonlySet<string> = new Set([
  "qa",
  "verifier",
  "release_engineer",
  "pm",
  "triage",
]);

/** True when `role` is a producer role whose output should be verified before
 *  a QA hand-off. Null/undefined (role-less / ticket-less runs) is never a
 *  producer — there's no reviewer awaiting this output. */
export function isProducerRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return !NON_PRODUCER_ROLES.has(role);
}

/** Split a shell-ish command string into `spawn(cmd, args)` argv, WITHOUT a
 *  shell (matches tools/run-command.ts's no-shell-interpolation guarantee).
 *  Supports basic single/double quoting so commands like
 *  `pnpm test -- --grep "some name"` tokenize as expected. Returns null for
 *  blank/whitespace-only input. */
export function parseCommandString(command: string): { cmd: string; args: string[] } | null {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  const [cmd, ...args] = tokens;
  if (!cmd) return null;
  return { cmd, args };
}

export type VerificationCommand = { label: string; command: string };

export type VerificationOutcome = {
  /** Which configured command this outcome came from ("qa" / "build"). Not part
   *  of the posted record (whose shape is fixed by the engine-side contract) -
   *  it exists so the runner's log line disambiguates two commands that are
   *  both variants of `pnpm <x>`. */
  label: string;
  command: string;
  exitCode: number;
  outputTail: string;
};

/** Minimal shape of tools/run-command.ts's `runCommand` this module depends
 *  on — injected so this file stays free of child_process/network imports. */
export type RunCommandFn = (input: {
  cwd: string;
  cmd: string;
  args: string[];
  timeoutMs?: number;
}) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;

const OUTPUT_TAIL_MAX_CHARS = 8_000;
export const VERIFICATION_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** Every `outputTail` this module produces goes through here: the posted record
 *  is contractually bounded at `OUTPUT_TAIL_MAX_CHARS`, so keep the LAST chars
 *  (where a failure's cause lives) and never exceed the bound. */
function clampTail(text: string): string {
  return text.length > OUTPUT_TAIL_MAX_CHARS
    ? text.slice(text.length - OUTPUT_TAIL_MAX_CHARS)
    : text;
}

/** Last `OUTPUT_TAIL_MAX_CHARS` of the command's output, INCLUDING any marker —
 *  the marker eats into the budget rather than pushing the record past the bound. */
function buildOutputTail(stdout: string, stderr: string, timedOut: boolean): string {
  const marker = timedOut
    ? `\n…[command timed out after ${VERIFICATION_COMMAND_TIMEOUT_MS}ms]`
    : "";
  const budget = Math.max(0, OUTPUT_TAIL_MAX_CHARS - marker.length);
  const combined = `${stdout}${stderr}`.trim();
  const tail = combined.length > budget ? combined.slice(combined.length - budget) : combined;
  return `${tail}${marker}`;
}

/**
 * Run each configured command in `cwd`, in order, fail-fast: the first
 * non-zero exit stops the sequence and IS the record (contract: "a non-zero
 * from either is a fail — record the failing command + code"). If every
 * command passes, the record is the last command run.
 *
 * `exitCode` is -1 for every "couldn't determine" outcome - timeout, spawn
 * failure (`execFn` rejects when the binary isn't on PATH), or a configured
 * value that isn't a runnable command at all (e.g. `''`). Never a fabricated
 * 0/1: an unverifiable step must read as unverified to the engine-side gate,
 * not as a pass.
 *
 * Returns null when NOTHING ran - every entry was blank, so there is no
 * verification to record and the caller must skip the POST rather than write a
 * record claiming a command it never executed succeeded.
 */
export async function runVerificationCommands(
  cwd: string,
  commands: readonly VerificationCommand[],
  execFn: RunCommandFn,
): Promise<VerificationOutcome | null> {
  let last: VerificationOutcome | null = null;
  for (const { label, command } of commands) {
    // Blank/whitespace-only means "not configured" - indistinguishable from the
    // caller's no-command escape, so skip rather than record anything.
    if (command.trim().length === 0) continue;
    const parsed = parseCommandString(command);
    if (!parsed) {
      // Non-blank yet unrunnable (e.g. `''`). Something WAS configured, so this
      // is a misconfiguration to surface, not a silent skip.
      return {
        label,
        command,
        exitCode: -1,
        outputTail: clampTail(`[not a runnable command: ${command}]`),
      };
    }
    let result: Awaited<ReturnType<RunCommandFn>>;
    try {
      result = await execFn({
        cwd,
        cmd: parsed.cmd,
        args: parsed.args,
        timeoutMs: VERIFICATION_COMMAND_TIMEOUT_MS,
      });
    } catch (err) {
      return {
        label,
        command,
        exitCode: -1,
        outputTail: clampTail(
          `[failed to start: ${err instanceof Error ? err.message : String(err)}]`,
        ),
      };
    }
    const exitCode = result.timedOut ? -1 : (result.exitCode ?? -1);
    last = {
      label,
      command,
      exitCode,
      outputTail: buildOutputTail(result.stdout, result.stderr, result.timedOut),
    };
    if (exitCode !== 0) return last;
  }
  return last;
}
