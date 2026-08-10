// L1 (ticket-speed audit, §L1 / §#1) - the single implementation of "run a
// producer role's verification commands and record the result", shared by BOTH
// hooks of the two-hook contract:
//
//   hook (i)  - mcp/server.ts, mid-step, when a tool-driven role calls
//               `devpilot_move_ticket(status: "in_review")` itself.
//   hook (ii) - index.ts's `handleJob`, before every `postStepResult`, because
//               `applyRolePostProcess`/the reconciler fire engine-side the
//               moment step-result lands and the built-in `engineer` role never
//               calls `devpilot_move_ticket` at all.
//
// Running both for the same run is safe and intentional: the ingest route
// upserts on `run_id`, so whichever POST lands second overwrites the first with
// the run's final head - which is also what makes retries work.
//
// This module is env.ts-free ON PURPOSE. mcp/server.ts is a standalone stdio
// subprocess spawned by `claude -p`; importing env.ts there would risk a hard
// `process.exit(1)` inside a live MCP server over env vars the relay never
// needed. Every input - engine URL, registration key, tenant, commands - is
// passed in explicitly by the caller, which reads it from wherever it lives
// (index.ts: the fetched runner config » env floor; mcp/server.ts: the
// `process.env` the runner already injects into every `claude -p` child).

import {
  isProducerRole,
  runVerificationCommands,
  type VerificationCommand,
} from "./producer-verification.js";
import { resolveInstallCommand } from "./verification-install.js";
import { runCommand } from "./tools/run-command.js";
import {
  readGitFullHeadSha,
  readGitCurrentBranch,
  isHeadPushedToOriginLocal,
  readGitCommitsAhead,
} from "./git-utils.js";
import { shouldVerifyHead, markVerifiedHead } from "./verification-dedup.js";

/**
 * Record shape for a producer role's verification run. Matches the shared
 * contract with the `l1-gate-enforce` sibling exactly (minus `ran_at`, which
 * the engine stamps server-side). `exit_code` is -1 for "couldn't determine"
 * (spawn failure, timeout, or an unrunnable configured command), never a
 * fabricated 0/1.
 *
 * `base_sha` (contract addendum) is the workspace's HEAD sha at run start,
 * before the agent did any work this run — "did THIS run produce a new
 * commit", not "does this differ from the default branch". Optional and
 * purely additive: omitting it (when we couldn't determine it — no
 * workspace, or an unborn HEAD) leaves the gate's prior behavior unchanged;
 * the enforce seam only uses it to no-op the gate for comment-only/non-code
 * roles that produce no commit once it's present.
 */
export type VerificationResultBody = {
  command: string;
  exit_code: number;
  head_sha: string;
  pushed: boolean;
  output_tail: string;
  base_sha?: string;
  /**
   * L1 / B2 (empty delivery) — commits on HEAD that are NOT on the base branch.
   * `0` is the positive assertion "this branch delivers nothing"; omitted means
   * we could not determine it and the gate must fall back to its prior
   * behaviour. Never send a fabricated 0 — see `readGitCommitsAhead`.
   */
  commits_ahead?: number;
};

/** Log sinks. The runner writes to stdout/stderr; the MCP relay must keep
 *  stdout clean for JSON-RPC frames and writes both to stderr. */
export type VerificationLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type VerificationHookInput = {
  runId: string;
  /**
   * L1 recording switch (`ENGINEER_QA_VERIFY_ENABLED`). Both hooks pass it so
   * gating lives in ONE place: false records nothing, leaving runner behaviour
   * byte-for-byte unchanged. index.ts reads `env.ENGINEER_QA_VERIFY_ENABLED`;
   * mcp/server.ts reads its own `process.env` (the runner injects the resolved
   * value into every `claude -p` child). Default off — see env.ts.
   */
  verifyEnabled: boolean;
  /** Dispatched role slug. Non-producer roles never hand off to a reviewer. */
  role: string | null | undefined;
  /** The prepared ticket workspace. Null/absent means there is no checkout to
   *  run commands against - never fall back to the runner's own cwd. */
  cwd: string | null | undefined;
  /** Workspace HEAD sha at run start, before the agent did any work this run.
   *  See `VerificationResultBody.base_sha`. Null/absent when it couldn't be
   *  determined; simply omitted from the POST body then. */
  baseSha?: string | null;
  /** L1 / B2 — the integration/base branch the workspace was cut from, used to
   *  count commits the ticket branch adds on top of it. Null/absent simply
   *  omits `commits_ahead` from the record. */
  baseBranch?: string | null;
  qaCommand: string | null | undefined;
  buildCommand: string | null | undefined;
  engineUrl: string;
  registrationKey: string;
  tenantId: string;
  log: VerificationLogger;
};

/**
 * How long the record POST may take before it is abandoned. Both hooks await it
 * on the critical path - hook (ii) blocks `postStepResult`, hook (i) blocks the
 * `devpilot_move_ticket` relay - so it is bounded like every other call there (the
 * git reads, the `git fetch`, the verification commands themselves). Node's
 * undici default would otherwise let a stalled engine hold the step for ~300s.
 * Generous relative to a single insert, tight relative to that fallback.
 */
const VERIFICATION_POST_TIMEOUT_MS = 30_000;

/**
 * POST the verification record to the engine. The receiving route
 * (`/api/runs/[runId]/verification`) is owned by the `l1-gate-enforce` sibling
 * and may not be merged yet - degrade gracefully on 404/any error: log and
 * swallow, never throw. Recording is additive and must never fail the run.
 */
async function postVerificationResult(
  input: Pick<VerificationHookInput, "engineUrl" | "registrationKey" | "tenantId" | "log">,
  runId: string,
  body: VerificationResultBody,
): Promise<void> {
  try {
    const res = await fetch(`${input.engineUrl}/api/runs/${runId}/verification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-devpilot-runner-key": input.registrationKey,
        "x-devpilot-runner-tenant": input.tenantId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VERIFICATION_POST_TIMEOUT_MS),
    });
    if (!res.ok) {
      input.log.warn(
        `verification POST failed (endpoint may not be merged yet): ${res.status} ${(
          await res.text()
        ).slice(0, 200)}`,
      );
    }
  } catch (err) {
    input.log.warn(
      `verification POST network failure: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Run ENGINEER_QA_COMMAND (+ ENGINEER_BUILD_COMMAND, if configured) in `cwd`
 * and record the outcome against `runId`.
 *
 * L1 / install (ticket-speed audit) — BEFORE either of those, install
 * dependencies when the workspace needs it (`verification-install.ts`): the
 * measured defect was two agents parked asking a human to adjudicate a
 * `pnpm test` failure that was not real — the gate ran the test command
 * against a `node_modules` that was simply never installed. The install
 * command is prepended to the SAME `commands` array `runVerificationCommands`
 * already runs fail-fast, so an install failure is recorded with `command`
 * naming the install command itself (e.g. `pnpm install --frozen-lockfile`),
 * never the qa/build command — that is what keeps an install failure from
 * ever being reported as "tests failed". `resolveInstallCommand` resolves to
 * an empty string (skipped, exactly like a blank `qaCommand`) when there is
 * nothing to install: no `package.json` at all (a non-Node repo), or
 * dependencies are already current.
 *
 * No-op (records nothing) unless ALL of:
 *   - `verifyEnabled` (`ENGINEER_QA_VERIFY_ENABLED`) is on - default off, so
 *     merging this half is inert until an operator opts into shadow mode
 *   - a workspace was prepared (`cwd`) - no checkout means nothing to verify
 *   - `role` is a producer role (`isProducerRole`) - qa/verifier/
 *     release_engineer/pm/triage never hand off to a reviewer
 *   - `qaCommand` resolves to a non-blank command (the no-command escape: an
 *     operator disables verification entirely by setting ENGINEER_QA_COMMAND to
 *     an explicitly blank/whitespace value. *Un*setting it does not disable
 *     anything - env.ts resolves an absent var to the `pnpm test` default, which
 *     both hooks then receive.)
 *   - this run has NOT already been verified at the current HEAD (the per-run
 *     dedup guard) - a run spans ~20 iterations reusing one working tree and
 *     both hooks can fire for the same commit; we verify each HEAD exactly once
 *     per process. See verification-dedup.ts.
 *
 * Never throws. Every failure path (spawn error, git error, network error, a
 * graceful 404 from an unmerged enforce-side endpoint) is caught and logged, so
 * this can never block the caller's own control flow - neither the MCP relay's
 * move-ticket call nor `postStepResult`.
 */
export async function runAndRecordVerification(input: VerificationHookInput): Promise<void> {
  const { runId, role, cwd, log } = input;
  // Recording switch first: off (default) means this whole feature is inert.
  if (!input.verifyEnabled) return;
  if (!cwd) return;
  if (!isProducerRole(role)) return;

  // Trim before the escape check: a blanked platform-secret that round-trips
  // through a text input as " " is "unset", not a command named "".
  const qaCommand = (input.qaCommand ?? "").trim();
  if (!qaCommand) return;
  const buildCommand = (input.buildCommand ?? "").trim();

  // Dedup guard: read HEAD up front (cheap, local git) and skip the whole
  // ~10-minute command run when this run was already verified at this exact
  // commit in this process. A null head (unborn HEAD / git failed) can't be
  // deduped, so we fall through and verify. The commands don't move HEAD, so
  // this same sha is what the record is stamped with below.
  const headSha = await readGitFullHeadSha(cwd);
  if (!shouldVerifyHead(runId, headSha)) {
    log.info(
      `verification run=${runId} head=${(headSha ?? "").slice(0, 12)} unchanged — skipping (already verified this run)`,
    );
    return;
  }

  const commands: VerificationCommand[] = [];
  // Resolved fresh every time (never cached from workspace-prepare time), so
  // a dependency an agent added mid-run is picked up on the very next check.
  const installCommand = await resolveInstallCommand(cwd);
  if (installCommand) {
    commands.push({ label: "install", command: installCommand });
    // Logged unconditionally, regardless of whether install ends up being the
    // LAST (and therefore only logged) outcome below — its absence from the
    // log is exactly what made the original defect invisible: the runner log
    // for both broken runs showed the `qa` step failing with no install ever
    // having run anywhere in its history.
    log.info(`verification run=${runId} installing dependencies: ${installCommand}`);
  }
  commands.push({ label: "qa", command: qaCommand });
  if (buildCommand) commands.push({ label: "build", command: buildCommand });

  try {
    const outcome = await runVerificationCommands(cwd, commands, runCommand);
    // Nothing ran - no record to write. Cannot happen given the guards above,
    // but never invent a passing record if it somehow does.
    if (!outcome) return;

    // Read the branch FRESH (not cached from workspace-prepare time) so a
    // branch switch mid-step is reflected. `pushed` uses the LOCAL (fetch-free)
    // ancestry check: O2 forbids a `git fetch` on this critical path in v1, and
    // the agent's own push already updated the local origin ref. Re-read HEAD
    // only if the up-front read was null.
    const branch = await readGitCurrentBranch(cwd);
    const recordHead = headSha ?? (await readGitFullHeadSha(cwd));
    const pushed = branch ? await isHeadPushedToOriginLocal(cwd, branch) : false;
    // L1 / B2 — "does delivered work exist on this branch at all?". Local and
    // fetch-free; null whenever it can't be answered, which the gate reads as
    // fail-open (see readGitCommitsAhead).
    const commitsAhead = input.baseBranch ? await readGitCommitsAhead(cwd, input.baseBranch) : null;
    log.info(
      `verification run=${runId} step=${outcome.label} command="${outcome.command}" exit=${outcome.exitCode} pushed=${pushed} commitsAhead=${commitsAhead ?? "?"}`,
    );
    await postVerificationResult(input, runId, {
      command: outcome.command,
      exit_code: outcome.exitCode,
      head_sha: recordHead ?? "",
      pushed,
      output_tail: outcome.outputTail,
      ...(input.baseSha ? { base_sha: input.baseSha } : {}),
      ...(commitsAhead !== null ? { commits_ahead: commitsAhead } : {}),
    });
    // Mark AFTER the POST attempt (which never throws) so a crashed verify
    // doesn't suppress a legitimate retry of the same head next iteration.
    markVerifiedHead(runId, recordHead);
  } catch (err) {
    log.warn(
      `verification failed to run for run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
