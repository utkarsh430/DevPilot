// Local Claude Code Runner — worker process.
//
// Boots → registers with the engine → heartbeats every 15s → pulls jobs from
// Upstash Redis (LOCAL_CC_QUEUE) → spawns `claude -p` → POSTs the result back
// to the engine, which resumes the durable run via Inngest event.
//
// Concurrency capped by LOCAL_CC_CONCURRENCY to stay inside subscription
// rate limits (typical Pro/Max ~1–3 steady concurrent agents).

// FIRST import, for side effects: mirrors any legacy `ACE_*` env onto
// `DEVPILOT_*`. Must precede `./env.js`, whose module body calls
// `required("DEVPILOT_RUNNER_REGISTRATION_KEY")` and exits the process on a miss.
import "./legacy-alias.js";

import { Redis } from "@upstash/redis";
import { env } from "./env.js";
import {
  claimRun,
  fetchRunAttachments,
  heartbeat,
  postRunArtifact,
  postStepResult,
  registerRunner,
} from "./engine-client.js";
import {
  browserArtifactDirForStep,
  cleanupStepArtifacts,
  sweepStaleBrowserArtifacts,
  uploadStepArtifacts,
} from "./browser-artifacts.js";
import {
  cleanupRunAttachments,
  downloadRunAttachments,
  renderAttachmentPromptSection,
  sweepStaleAttachments,
} from "./attachments.js";
import { retryOnTransientConnect } from "./connect-retry.js";
import { fetchRunnerConfig } from "./config-client.js";
import {
  runClaude,
  ClaudeAuthError,
  cancelClaudeRun,
  removeStepMcpConfig,
  writeStepMcpConfig,
  COMMIT_NUDGE_TOOLS_CSV,
  NO_MCP_CONFIG_PATH,
  VERDICT_NUDGE_TOOLS_CSV,
  BOARD_ONLY_MCP_CONFIG_PATH,
} from "./claude.js";
import { prepareWorkspace, cleanupWorkspace } from "./workspace.js";
import { devServerPullLoop, killAllDevServers, startHeartbeatTicker } from "./dev-server-loop.js";
import { takeoverPullLoop, shutdownTakeovers } from "./takeover-loop.js";
import { killAllHeadlessRunSessions, killAllTakeoverSessionsSync } from "./tmux-session.js";
import { killAllSpawnedTrees } from "./process-tree.js";
import {
  decideShutdownRequeue,
  REQUEUE_PUSH_SIDE,
  requeuePayload,
  type JobPhase,
} from "./shutdown-requeue.js";
import { nextIdleDelayMs, POLL_BASE_MS, POLL_IDLE_CAP_MS } from "./poll-backoff.js";
import { buildSubscriptionEnvOverrides } from "./subscription-env.js";
import { runAndRecordVerification } from "./verification-hook.js";
import { readGitFullHeadSha, readGitCommitsAhead, readGitWorkingTreeStatus } from "./git-utils.js";
import {
  COMMIT_NUDGE_SYSTEM_PROMPT,
  decideCommitNudge,
  renderCommitNudgePrompt,
} from "./empty-delivery.js";
import {
  VERDICT_NUDGE_SYSTEM_PROMPT,
  decideVerdictNudge,
  renderVerdictNudgePrompt,
} from "./verdict-outcome.js";
import {
  outcomeMarkerPathFor,
  readRecordedOutcomes,
  removeOutcomeMarker,
  sweepStaleOutcomeMarkers,
} from "./outcome-marker.js";
import { decideJobWorkspaceRefusal, decideWorkspacePrepAttempt } from "./workspace-precondition.js";
import { supervisorLoop } from "./supervisor-loop.js";

const LOCAL_CC_QUEUE = "devpilot:jobs:local-cc:ready";
const WORKSPACE_CLEANUP_QUEUE = "devpilot:jobs:workspace-cleanup";
// Runner-side kill channel. The engine LPUSHes `{ runId, reason }` here when it
// gives up waiting on a local-cc step (run-agent / plan-mode timeout) so we can
// terminate the wedged `claude -p` before it burns more subscription quota.
const LOCAL_CC_CANCEL_QUEUE = "devpilot:jobs:local-cc:cancel";
const HEARTBEAT_MS = 15_000;
// Cleanup loop polls less aggressively — reaper events arrive at most nightly.
const CLEANUP_POLL_MS = 30_000;
// Circuit breaker: after N consecutive ClaudeAuthError job failures, stop
// pulling jobs. Prevents the Wave-3-style runaway where every job 200-OK's
// with "Credit balance is too low" — pulling more would just drain the queue
// into NULL results and confuse the engine's retry loop.
const AUTH_FAILURE_CIRCUIT_LIMIT = 3;
let consecutiveAuthFailures = 0;

type Job = {
  jobId: string;
  runId: string;
  tenantId: string;
  iterationIdx: number;
  prompt: string;
  systemPrompt?: string;
  engineUrl: string;
  /** Phase 1 / M0 — optional; if present (and ENGINEER_REPO_URL is set OR
   *  repoUrl is provided) we prepare a git workspace and pass it as cwd to
   *  `claude -p`. */
  ticketId?: string;
  /** Engine-stamped workspace precondition: true when this job cannot possibly
   *  succeed without a git checkout (a ticket-bound dispatch of a
   *  code-producing role). The runner REFUSES such a job before invoking the
   *  model when no workspace was prepared - see workspace-precondition.ts.
   *
   *  Absent on every legitimately ticket-less invocation on this queue
   *  (one-shot classifiers/rankers, plan-mode calls, supervisor children, the
   *  headless /v1 + widget surfaces) and on jobs from a pre-guard engine, all
   *  of which keep today's permissive behaviour. */
  requiresWorkspace?: boolean;
  /** Engine-stamped: is this job even ELIGIBLE for workspace prep, independent
   *  of `ticketId`/`repoUrl`? Distinct from `requiresWorkspace` on purpose — a
   *  reviewer (qa/verifier) does not REQUIRE a checkout but very much WANTS one
   *  when a repo is resolvable, so eligibility can't be inferred from role
   *  either.
   *
   *  Absent/true (the default) preserves today's behaviour: attempt prep
   *  whenever `ticketId && haveRepoUrl`. Explicit `false` is stamped ONLY by
   *  one-shot bridges (dispatch classifiers, ticket enrichment, …) that tag a
   *  job with a real ticketId for AUDIT/attribution purposes but never resolve
   *  a project repo of their own — they must never attempt prep even when
   *  `ENGINEER_REPO_URL` happens to be configured as a legacy global fallback,
   *  because that would race a concurrent producer's live workspace for the
   *  SAME ticket (prepareWorkspace re-entry does a hard reset + clean). See
   *  `apps/web/lib/runners/local-cc-oneshot.server.ts`. */
  workspacePrepEligible?: boolean;
  /** Phase 2 / M5a — per-project plumbing.
   *
   *  `repoUrl` overrides the runner's ENGINEER_REPO_URL fallback. The engine
   *  resolves it from the ticket's project (tickets.project_id → projects.repo_url).
   *
   *  `githubToken` is the project owner's OAuth access token. workspace.ts
   *  injects it into the origin URL via the `x-access-token` username so the
   *  runner can `git push` private repos. NEVER log this value — workspace.ts
   *  treats the URL as a secret after injection. */
  repoUrl?: string | null;
  githubToken?: string | null;
  gitAuthorName?: string | null;
  gitAuthorEmail?: string | null;
  /** C4 — human-readable branch slug. Engine-resolved from tickets.title and
   *  cached on tickets.git_branch_name. When null/undefined the runner falls
   *  back to slugify(ticketId) — its pre-C4 behaviour. */
  ticketSlug?: string | null;
  /** Slice IB — base branch the workspace clones from. Engine-resolved to
   *  `project.integration_branch ?? project.default_branch ?? "main"`. The
   *  ticket's `devpilot/<slug>` branch is cut from this. Null falls through to
   *  the repo's default branch (legacy behavior for pre-IB jobs). */
  baseBranch?: string | null;
  /** WI-5.2 — the exact commit on `baseBranch` to cut `devpilot/<slug>` from. Set by
   *  the engine only for a `builds_on` child whose parent has LANDED, so the
   *  child roots at the parent's `landed_sha` instead of at the integration tip.
   *  Null/undefined = branch from the tip (every other job). */
  baseSha?: string | null;
  /** Slice IB-B — when the dispatched role is `release_engineer` and the
   *  merger ticket has a parent_ticket_id, the engine sets this to the
   *  parent's id so the runner re-enters the source ticket's workspace
   *  (where the conflict markers live) instead of cloning into a fresh
   *  merger-specific directory. Null/undefined falls through to `ticketId`
   *  (the normal path). */
  workspaceTicketId?: string | null;
  /** Post-F5 — role slug for this run (engineer, qa, verifier, designer, …).
   *  Propagated into the claude child as `DEVPILOT_ROLE`; the MCP relay reads it
   *  and stamps `author_id` on comment/move-ticket/request-human calls so the
   *  dispatcher's state-machine fallback can recognise actual role identity
   *  (it has been silently broken since wave 2 hardcoded "claude"). Null for
   *  ad-hoc smoke tests; relay falls back to "claude" then. */
  role?: string | null;
  /** Slice A — per-project encrypted env values as a serialised JSON object
   *  ({"DATABASE_URL":"…", "STRIPE_API_KEY":"…"}) or null when the project
   *  has no secrets configured.
   *
   *  The runner does two things with this payload:
   *    1. Writes a `<workspace>/.env.local` file (0o600, single-quoted values)
   *       so `pnpm dev` / `pnpm build` style commands can read them natively.
   *    2. Merges each key/value into the `envOverrides` passed to claude -p
   *       so tools that read `process.env` (rather than `.env.local`) see
   *       them too.
   *
   *  NEVER log this value — it carries credentials in cleartext at the
   *  runner-job boundary. workspace.ts treats the file write as a secret
   *  operation.
   *
   *  WI-12 — vault secrets on the BLOCKLIST (ANTHROPIC_API_KEY,
   *  ANTHROPIC_BASE_URL, provider creds — see subscription-env.ts) never reach
   *  the `claude -p` env, however this payload names them. They still reach the
   *  workspace `.env.local`, which is a different consumer with a different trust
   *  story (the project's own app, not our agent process). */
  projectSecretsJson?: string | null;
  /** WI-12 — model id/alias for `claude -p --model`, resolved SERVER-SIDE by the
   *  engine from the project's LLM config. NULL for every project that hasn't
   *  opted in (the default), and the runner then emits no `--model` at all.
   *
   *  This is the ONLY LLM-config field the runner is ever told. It is deliberately
   *  not a base URL and not a credential: the subscription path authenticates with
   *  the operator's own OAuth token and must not be re-pointable from a job
   *  payload. An OpenAI-compatible project never reaches this queue — the engine
   *  routes it to the API runner instead. */
  model?: string | null;
  /** Phase 3 (ticket screenshots) — how many image attachments this run's ticket
   *  has for the agent to Read. A HINT set by the engine on the first iteration
   *  only; > 0 means "call GET /api/runs/[id]/attachments for fresh signed URLs
   *  and deliver them as files". Absent/0 (the common case) means skip the
   *  endpoint entirely. The endpoint is authoritative on WHICH images and
   *  re-derives the ticket/tenant from the run row. */
  attachmentCount?: number | null;
  /** L1 / B2 — the verification RECORDING switch, resolved by the ENGINE.
   *
   *  Previously the runner answered this from its own host env
   *  (`env.ENGINEER_QA_VERIFY_ENABLED`, read once at module load). The engine
   *  and the runner are separate processes, usually on separate hosts with
   *  separate environments, so "gate enforcing in the engine, runner recording
   *  nothing" was a silently valid configuration — and it is the one prod was
   *  in. `decideQaGate` fails OPEN on an absent record, so the gate allowed
   *  every failing-build hand-off it was supposed to stop.
   *
   *  Absent/undefined (an older engine talking to a newer runner) falls back to
   *  the host env, so the two can be deployed in either order. */
  qaVerifyEnabled?: boolean | null;
  /** L1 / B2 — the integration/base branch the workspace was cut from, so the
   *  hook can count commits on the ticket branch that are NOT on it
   *  (`commits_ahead`). That answers "does delivered work exist at all",
   *  which `base_sha === head_sha` cannot: on a QA-reject retry the run-start
   *  base already contains the previous run's commits. Null/absent leaves the
   *  field unrecorded and the gate on its pre-B2 behaviour. */
  qaBaseBranch?: string | null;
  /** Empty-delivery nudge — engine-stamped `isCodeProducingRole(role)`, i.e.
   *  "is this role's deliverable committed source?".
   *
   *  Absent/non-`true` means NO nudge, which is both the ticket-less default and
   *  what a pre-nudge engine sends, so an older engine talking to a newer runner
   *  behaves exactly as today. See `empty-delivery.ts` for why this is stamped
   *  rather than re-derived here. */
  codeProducing?: boolean | null;
  /** Verdictless-review nudge — engine-stamped `isVerdictRoleConfig(roleConfig)`,
   *  i.e. "does this role's contract make its success state the VERDICT?"
   *  (`onSuccessStatus === 'done'`: qa / verifier / release_engineer, plus any
   *  custom reviewer role, which only the engine can resolve).
   *
   *  Absent/non-`true` means NO nudge — the ticket-less default, every producer
   *  role, and what a pre-nudge engine sends. See `verdict-outcome.ts` for why
   *  an over-broad set here is the dangerous direction. */
  verdictRole?: boolean | null;
  /** Verdictless-review nudge — is this the LAST turn of the run? A reviewer
   *  nudged mid-review would be pushed to decide before it has finished looking.
   *  Only an explicit `false` suppresses; absent reads as final, which keeps the
   *  field purely additive (a pre-nudge engine sends no `verdictRole` either). */
  finalIteration?: boolean | null;
};

const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
});

// Phase 5 — per-tenant config fetched from the engine (GET /api/runners/config).
//
// This is an OVERLAY on top of `env`, never a replacement: the runner's own
// env stays the floor. `fetchedConfig` holds the most recent successful pull
// (or stays empty if the engine is unreachable / the feature is off). The
// `runnerCfg()` getter resolves `fetched ?? env-floor` for the runner-relevant
// keys, so a cold/failed fetch behaves byte-for-byte like reading env today.
//
// We refresh on the heartbeat cadence (every HEARTBEAT_MS) so a rotation in the
// UI propagates within roughly the engine's secret TTL. The fetch is fire-and-
// forget — boot and the pull loop must NOT block on it.
let fetchedConfig: Record<string, string> = {};

async function refreshRunnerConfig(): Promise<void> {
  const cfg = await fetchRunnerConfig();
  // Only replace the overlay on a successful pull. A transient failure (null)
  // keeps the last-known-good values rather than dropping back to env mid-run.
  if (cfg) fetchedConfig = cfg.secrets;
}

/** Resolve a runner-relevant config key: engine-fetched override » env floor.
 *  Returns undefined when neither side has a non-empty value, so callers can
 *  decide whether to inject it at all. */
function runnerCfg(
  key:
    | "ANTHROPIC_API_KEY"
    | "CLAUDE_CODE_OAUTH_TOKEN"
    | "ENGINEER_REPO_URL"
    | "ENGINEER_QA_COMMAND"
    | "ENGINEER_BUILD_COMMAND",
): string | undefined {
  const fetched = fetchedConfig[key];
  if (fetched && fetched.length > 0) return fetched;
  // Env floor. CLAUDE_CODE_OAUTH_TOKEN / ENGINEER_REPO_URL / ENGINEER_QA_COMMAND /
  // ENGINEER_BUILD_COMMAND live on `env`; ANTHROPIC_API_KEY is never on `env`
  // (subscription path strips it) so its floor is process.env, which yields
  // undefined when unset. ENGINEER_BUILD_COMMAND has no engine-fetched override
  // today (not yet in the platform-secrets catalog — see env.ts) so `fetched`
  // is always empty for it; this still returns the env floor correctly.
  const floor =
    key === "ANTHROPIC_API_KEY"
      ? process.env.ANTHROPIC_API_KEY
      : key === "CLAUDE_CODE_OAUTH_TOKEN"
        ? env.CLAUDE_CODE_OAUTH_TOKEN
        : key === "ENGINEER_REPO_URL"
          ? env.ENGINEER_REPO_URL
          : key === "ENGINEER_QA_COMMAND"
            ? env.ENGINEER_QA_COMMAND
            : env.ENGINEER_BUILD_COMMAND;
  return floor && floor.length > 0 ? floor : undefined;
}

/** Runner-relevant config to merge into the `claude -p` spawn env. Deliberately
 *  EXCLUDES ANTHROPIC_API_KEY: claude.ts strips it before spawning the
 *  subscription `claude -p`, and re-injecting it here would defeat that strip
 *  (envOverrides is spread last in claude.ts and would win). CLAUDE_CODE_OAUTH_-
 *  TOKEN is safe to inject — claude.ts intends it set, and a fetched rotation
 *  should win over the boot-time env value. */
function runnerConfigEnvOverrides(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ENGINEER_REPO_URL",
    "ENGINEER_QA_COMMAND",
    // L1 (ticket-speed audit) — the MCP relay (mcp/server.ts) reads this
    // directly off its own process.env to run the build check when it
    // intercepts a producer's devpilot_move_ticket(in_review) call. See that
    // file for why it can't import runnerCfg/env.ts itself.
    "ENGINEER_BUILD_COMMAND",
  ] as const) {
    const v = runnerCfg(key);
    if (v) out[key] = v;
  }
  return out;
}

let runnerId: string | null = null;
let activeJobs = 0;
let stopping = false;

// Track 2 — active headless tmux sessions keyed by runId. Populated when
// claude.ts calls back with its session name; cleared when the job's
// handleJob() returns. Read by the heartbeat loop so each ping carries the
// most recently spawned session name (the engine stamps it onto runs so the
// UI can render `tmux attach -t <name>`). One entry per concurrent slot —
// `Map<runId, sessionName>` instead of a single string so concurrency>1 hosts
// don't trample each other's session names.
const activeTmuxSessions: Map<string, string> = new Map();

// L1 (ticket-speed audit, §#5) — runIds for which a cancel landed while the job
// was in flight. The failure/catch branch of handleJob reads this to SKIP the
// verification hook on a cancelled run: a cancel kills `claude -p` (surfacing as
// a throw), and starting a ~10-minute verification against a workspace nobody is
// waiting on is exactly the never-terminating bug this feature must not add.
// Populated by handleCancelJob, cleared in handleJob's finally.
const cancelledRuns: Set<string> = new Set();

// The runs this process is ACTUALLY executing right now - added at the top of
// handleJob and removed on every exit path, so membership means "a `claude -p`
// for this run is in flight ON THIS HOST".
//
// This is the one fact the runner has that the database does not, and it is why
// the project supervisor lives here rather than being a second cron. On this
// board `runs` rows lied in BOTH directions: rows marked `failed` whose agent
// processes were still working 56 minutes later, and rows marked `running` that
// were never claimed at all. The supervision tick reports this set to the
// engine, which admits it as a VETO ONLY - it can stop the supervisor touching a
// ticket, never cause it to act (see `isVetoedByLiveRunner`). Absence proves
// nothing, because the runner pool is multi-host.
//
// Distinct from `activeTmuxSessions`, which is populated only when the host has
// tmux AND the step was wrapped in it - a direct-spawn fallback is missing from
// that map and would look, wrongly, like a dead run.
const inFlightRuns: Set<string> = new Set();

// Shutdown requeue (shutdown-requeue.ts): the job each in-flight run was
// popped as, plus how far handleJob has got with it. A run in `requeuedRuns`
// has been put BACK on the queue by `shutdown()`; whatever its killed
// `claude -p` still produces must not be posted, and a job that had not yet
// started its model turn must not start it now.
const inFlightJobs: Map<string, { job: Job; phase: JobPhase }> = new Map();
const requeuedRuns: Set<string> = new Set();

/** Snapshot the most recently activated tmux session, or null when no run is
 *  currently wrapped in tmux. The heartbeat payload carries this so the
 *  engine can stamp it on the latest active run. */
function currentTmuxSession(): string | null {
  if (activeTmuxSessions.size === 0) return null;
  // Map iteration order is insertion order; take the last-inserted entry
  // (most recently started run). For concurrency=1 this is unambiguous; for
  // concurrency>2 the per-run claim() call already stamps each session
  // individually, so this fallback is purely best-effort recovery.
  let last: string | null = null;
  for (const v of activeTmuxSessions.values()) last = v;
  return last;
}

/**
 * L1 (ticket-speed audit, §L1 / §#1) — hook (ii) of the two-hook contract.
 * Called BEFORE every `postStepResult` (both the success and failure
 * branch) because `applyRolePostProcess`/the reconciler fire engine-side the
 * moment step-result lands, and the built-in `engineer` role — the primary
 * target — never calls `devpilot_move_ticket` itself, so only this hook covers
 * it. Hook (i) (the MCP relay's `devpilot_move_ticket` interceptor, in
 * `mcp/server.ts`) covers roles that DO call the tool mid-step; the two are
 * safe together because the ingest route upserts on `run_id` — whichever
 * POST lands second simply overwrites the first with the run's final head.
 *
 * Both hooks share one implementation (`verification-hook.ts`); this wrapper
 * only supplies the runner-side config sources (fetched tenant config » env
 * floor) that the env-free shared module can't reach. It never throws.
 */
async function recordStepVerification(
  job: Job,
  workspacePath: string | null,
  baseSha: string | null,
): Promise<void> {
  await runAndRecordVerification({
    runId: job.runId,
    // L1 recording switch. The ENGINE decides (see Job.qaVerifyEnabled): it is
    // the process that also decides whether to ENFORCE, and splitting the two
    // across hosts is what let the gate run on evidence nobody was collecting.
    // The host env is only the fallback for a job from an older engine, so the
    // two apps can be deployed in either order.
    verifyEnabled: job.qaVerifyEnabled ?? env.ENGINEER_QA_VERIFY_ENABLED,
    role: job.role,
    cwd: workspacePath,
    baseSha,
    baseBranch: job.qaBaseBranch ?? job.baseBranch ?? null,
    qaCommand: runnerCfg("ENGINEER_QA_COMMAND"),
    buildCommand: runnerCfg("ENGINEER_BUILD_COMMAND"),
    engineUrl: env.ENGINE_URL,
    registrationKey: env.REGISTRATION_KEY,
    tenantId: env.TENANT_ID,
    log: {
      info: (message) => console.log(`[devpilot-runner] ${message}`),
      warn: (message) => console.warn(`[devpilot-runner] ${message}`),
    },
  });
}

/**
 * The empty-delivery seam — spend ONE extra `claude -p` turn asking an agent to
 * commit work it left uncommitted, WHILE the workspace still exists and a turn
 * is still possible.
 *
 * See `empty-delivery.ts` for the measured defect and why no other seam in the
 * system can deliver this signal. Three properties of the CALL SITE, which the
 * pure decision cannot enforce for itself:
 *
 *  (1) IT RUNS BEFORE `recordStepVerification`, so the verification record — and
 *      therefore `decideQaGate` — sees the POST-nudge truth. A nudge that
 *      succeeds means the gate never meets an empty delivery at all, rather than
 *      meeting one and being talked out of it. The gate itself is untouched.
 *
 *  (2) IT NEVER THROWS AND NEVER FAILS THE RUN. Every failure path — a git read
 *      that will not answer, a `claude -p` that crashes, an auth error on the
 *      extra turn — is caught here and degrades to "no nudge", leaving the step
 *      to be reported exactly as it would have been. This is a recovery
 *      attempt; it must not become a new way for a finished run to die.
 *
 *  (3) THE LOOP BOUND IS STRUCTURAL. It is called from ONE place, without a
 *      loop, and passes `alreadyNudged: false` because a single call cannot
 *      have nudged before. There is no retry: if the agent still commits
 *      nothing, control falls through to today's behaviour — the gate refuses
 *      `empty_delivery` and the ticket parks `blocked` for a human. That is the
 *      terminal state, reached in one pass, whether the nudge fired or not.
 *
 * Returns the number of commits on the branch after the attempt, purely so the
 * caller can log the before/after; nothing branches on it.
 */
async function nudgeUncommittedWork(job: Job, workspacePath: string | null): Promise<void> {
  const baseBranch = job.qaBaseBranch ?? job.baseBranch ?? null;
  try {
    // Both reads are local, fetch-free git and answer in milliseconds; both
    // return null rather than a guess when they cannot answer, and the decision
    // fails open on either.
    const commitsAhead =
      workspacePath && baseBranch ? await readGitCommitsAhead(workspacePath, baseBranch) : null;
    const statusEntries = workspacePath ? await readGitWorkingTreeStatus(workspacePath) : null;

    const decision = decideCommitNudge({
      codeProducing: job.codeProducing,
      workspacePath,
      commitsAhead,
      statusEntries,
      alreadyNudged: false,
    });
    if (!decision.nudge) {
      // Logged at info only for the code-producing roles this could ever apply
      // to, so a board full of PM/designer runs does not narrate a skip on every
      // step. `delivery-indeterminate` and `worktree-indeterminate` are the two
      // worth seeing: they are coverage gaps, not healthy outcomes.
      if (job.codeProducing === true) {
        console.log(
          `[devpilot-runner] commit-nudge run=${job.runId} skipped (${decision.skipped}) ` +
            `commitsAhead=${commitsAhead ?? "?"} dirty=${statusEntries?.length ?? "?"}`,
        );
      }
      return;
    }

    console.warn(
      `[devpilot-runner] commit-nudge run=${job.runId} FIRING — role=${job.role ?? "-"} ` +
        `ticket=${job.ticketId ?? "-"} commitsAhead=0 uncommittedEntries=${decision.statusEntries.length}`,
    );

    await runClaude({
      prompt: renderCommitNudgePrompt(decision.statusEntries),
      systemPrompt: COMMIT_NUDGE_SYSTEM_PROMPT,
      cwd: workspacePath!,
      // Narrowed tool set + a config declaring no MCP servers. Together these
      // mean the turn cannot move the ticket, file one, comment, park the ticket
      // in `input_required`, or drive a browser — not by instruction but because
      // no such tool exists in it. See `COMMIT_NUDGE_TOOLS_CSV`.
      toolsCsv: COMMIT_NUDGE_TOOLS_CSV,
      mcpConfigPath: NO_MCP_CONFIG_PATH,
      // Not wrapped in tmux: the run's session belongs to the step that just
      // finished, and a second session under the same run id would make the
      // engine's "attach here" pointer ambiguous.
      runId: null,
      model: job.model ?? null,
      // The SAME composed+blocklist-filtered env the step itself ran with, so
      // git author identity, credentials and project config are identical —
      // minus nothing, because subscription-env.ts is the one place that
      // decides what a `claude -p` child may see.
      envOverrides: buildSubscriptionEnvOverrides({
        runId: job.runId,
        tenantId: job.tenantId,
        ticketId: job.ticketId,
        role: job.role,
        workspacePath,
        baseSha: null,
        qaVerifyEnabled: Boolean(job.qaVerifyEnabled ?? env.ENGINEER_QA_VERIFY_ENABLED),
        baseBranch,
        runnerConfig: runnerConfigEnvOverrides(),
        projectSecretsJson: job.projectSecretsJson,
      }),
    });

    const after =
      workspacePath && baseBranch ? await readGitCommitsAhead(workspacePath, baseBranch) : null;
    if (after !== null && after > 0) {
      console.log(
        `[devpilot-runner] commit-nudge run=${job.runId} RECOVERED — branch now ${after} commit(s) ahead of ${baseBranch}`,
      );
    } else {
      // Not an error. The agent may have looked and correctly concluded there
      // was nothing to commit — the prompt sanctions exactly that. Either way we
      // stop here: the gate is the backstop and the ticket parks for a human.
      console.warn(
        `[devpilot-runner] commit-nudge run=${job.runId} did not produce a commit ` +
          `(commitsAhead=${after ?? "?"}) — leaving the QA gate to refuse and park the ticket`,
      );
    }
  } catch (err) {
    // Never fail a finished run over a recovery attempt.
    console.warn(
      `[devpilot-runner] commit-nudge run=${job.runId} errored (ignored): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The verdictless-review seam — spend ONE extra `claude -p` turn asking a
 * reviewer to record the verdict it already reached, WHILE a turn is still
 * possible.
 *
 * See `verdict-outcome.ts` for the measured defect (12 parks / 7 tickets on
 * `scoursh`) and why no other seam in the system can deliver this signal. Five
 * properties of the CALL SITE, which the pure decision cannot enforce for
 * itself:
 *
 *  (1) IT RUNS BEFORE `postStepResult`. The engine acts on the step result the
 *      instant it lands — `role-post`, then `reconcile-ticket` — so a nudge
 *      afterwards would be racing the very park it exists to pre-empt. A verdict
 *      recorded here is a verdict the reconciler simply never has to reason
 *      about, because `moveTicketToolUsed` is true by the time it looks.
 *
 *  (2) THE RECONCILER IS UNTOUCHED AND REMAINS THE BACKSTOP. Nothing here
 *      evaluates, imports or short-circuits its policy; the runner holds no
 *      reconcile logic. If the nudge fires and the agent still records nothing,
 *      control falls through to today's behaviour exactly: the ticket parks
 *      `blocked` for a human, including the run-scoped idempotency marker that
 *      keeps that park from re-firing.
 *
 *  (3) IT NEVER THROWS AND NEVER FAILS THE RUN. Every failure path — an
 *      unreadable marker, a `claude -p` that crashes, an auth error on the extra
 *      turn — is caught here and degrades to "no nudge", leaving the step to be
 *      reported exactly as it would have been. This is a recovery attempt; it
 *      must not become a new way for a finished run to die.
 *
 *  (4) THE LOOP BOUND IS STRUCTURAL. Called from ONE place, without a loop,
 *      passing `alreadyNudged: false` because a single call cannot have nudged
 *      before. There is no retry and no second evaluation.
 *
 *  (5) IT CHOOSES NO VERDICT. The runner reads the marker, not the review; it
 *      passes the agent's own final text back and never a status. There is no
 *      expression anywhere on this path that evaluates to `"done"` or
 *      `"in_progress"` — the agent makes the call, through the same MCP tool it
 *      would have used unprompted.
 */
async function nudgeMissingVerdict(
  job: Job,
  workspacePath: string | null,
  markerPath: string,
  reviewText: string,
): Promise<void> {
  try {
    const recordedOutcomes = readRecordedOutcomes(markerPath);
    const decision = decideVerdictNudge({
      verdictRole: job.verdictRole,
      ticketId: job.ticketId ?? null,
      finalIteration: job.finalIteration,
      recordedOutcomes,
      alreadyNudged: false,
    });
    if (!decision.nudge) {
      // Logged at info only for the verdict roles this could ever apply to, so a
      // board of engineer runs does not narrate a skip on every step.
      // `outcome-indeterminate` is the one worth seeing: it is a coverage gap,
      // not a healthy outcome.
      if (job.verdictRole === true) {
        console.log(
          `[devpilot-runner] verdict-nudge run=${job.runId} skipped (${decision.skipped}) ` +
            `outcomes=${recordedOutcomes ? recordedOutcomes.join("|") || "none" : "?"}`,
        );
      }
      return;
    }

    console.warn(
      `[devpilot-runner] verdict-nudge run=${job.runId} FIRING — role=${job.role ?? "-"} ` +
        `ticket=${job.ticketId ?? "-"} recorded no verdict`,
    );

    await runClaude({
      prompt: renderVerdictNudgePrompt({
        // Non-null by the decision above; the pure rule refuses a ticket-less run.
        ticketId: job.ticketId!,
        role: job.role ?? null,
        // UNTRUSTED, and fenced inside the renderer. A review quotes repository
        // content and command output back at itself, so this text can carry an
        // injected directive into a turn that holds `devpilot_move_ticket`.
        reviewSummary: reviewText,
      }),
      systemPrompt: VERDICT_NUDGE_SYSTEM_PROMPT,
      // The reviewer's checkout when it has one. A verdict role does not REQUIRE
      // a workspace (`runRequiresWorkspace` gates on code-producing roles), and a
      // reviewer on a repo-less project still owes a verdict — so unlike the
      // commit nudge this turn runs with or without a cwd.
      ...(workspacePath ? { cwd: workspacePath } : {}),
      // Read-only tools plus the three board calls the turn is allowed to reach.
      // NO `Bash` — a shell would let it re-run the suite, i.e. perform the
      // non-deterministic re-review AGENTS.md forbids here. See
      // `VERDICT_NUDGE_TOOLS_CSV`.
      toolsCsv: VERDICT_NUDGE_TOOLS_CSV,
      // The board relay, without @playwright/mcp: a verdict never involves a
      // browser, and every declared server is a real subprocess.
      mcpConfigPath: BOARD_ONLY_MCP_CONFIG_PATH,
      // Not wrapped in tmux: the run's session belongs to the step that just
      // finished, and a second session under the same run id would make the
      // engine's "attach here" pointer ambiguous.
      runId: null,
      model: job.model ?? null,
      // The SAME composed+blocklist-filtered env the step itself ran with, so the
      // relay reaches the same engine with the same run/ticket/role scoping —
      // including the marker path, so a verdict recorded HERE is recorded like
      // any other and a future reader cannot tell (or need to tell) the two apart.
      envOverrides: buildSubscriptionEnvOverrides({
        runId: job.runId,
        tenantId: job.tenantId,
        ticketId: job.ticketId,
        role: job.role,
        workspacePath,
        baseSha: null,
        qaVerifyEnabled: Boolean(job.qaVerifyEnabled ?? env.ENGINEER_QA_VERIFY_ENABLED),
        baseBranch: job.qaBaseBranch ?? job.baseBranch ?? null,
        outcomeMarkerPath: markerPath,
        runnerConfig: runnerConfigEnvOverrides(),
        projectSecretsJson: job.projectSecretsJson,
      }),
    });

    const after = readRecordedOutcomes(markerPath);
    if (after !== null && after.length > 0) {
      console.log(
        `[devpilot-runner] verdict-nudge run=${job.runId} RECOVERED — recorded ${after.join("|")}`,
      );
    } else {
      // Not an error, and deliberately not retried. The agent may have looked at
      // its own conclusion, found no verdict in it, and correctly declined to
      // invent one — the prompt sanctions exactly that. Either way we stop here
      // and the reconciler parks the ticket for a human, as it does today.
      console.warn(
        `[devpilot-runner] verdict-nudge run=${job.runId} did not produce a verdict ` +
          `— leaving the reconciler to park the ticket`,
      );
    }
  } catch (err) {
    // Never fail a finished run over a recovery attempt.
    console.warn(
      `[devpilot-runner] verdict-nudge run=${job.runId} errored (ignored): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleJob(job: Job): Promise<void> {
  activeJobs++;
  // Registered BEFORE any await: the supervision tick runs on its own loop slot
  // and could otherwise observe a claimed-but-unregistered run and read it as
  // dead. Removed on every exit path below, including both early returns.
  inFlightRuns.add(job.runId);
  inFlightJobs.set(job.runId, { job, phase: "prep" });
  await heartbeat(runnerId!, "busy", currentTmuxSession());
  console.log(
    `[devpilot-runner] picked job ${job.jobId} (run=${job.runId} idx=${job.iterationIdx})`,
  );

  // Phase 1 / M0 (Wave 2) — prepare an isolated git workspace for the run
  // before invoking `claude -p`. The workspace persists across iterations of
  // the same run; cleanup happens out-of-band when the ticket reaches a
  // terminal state.
  // TODO(wave-3): a reaper service is responsible for invoking
  // `cleanupWorkspace({ ticketId })` once the owning ticket settles into
  // Done/Failed. Do NOT clean up here — subsequent iterations of the same
  // run need the same working tree.
  let workspacePath: string | null = null;
  // L1 (ticket-speed audit) — contract addendum: the workspace's HEAD sha at
  // run start, before the agent does any work this run. Captured immediately
  // after prepareWorkspace() (which has already reset to the branch's
  // committed state) so it reflects exactly what the sibling's enforce seam
  // needs: base_sha vs the post-run head_sha answers "did THIS run produce a
  // new commit", not "does this differ from the default branch". Null when
  // no workspace was prepared, or on an unborn HEAD (brand-new empty repo).
  let baseSha: string | null = null;
  // Phase 2 / M5a — accept the repo URL from either source: the per-job
  // override (engine-resolved from the ticket's project) OR the legacy
  // ENGINEER_REPO_URL env. Prep is skipped when either is missing, OR when the
  // job explicitly opts out via `workspacePrepEligible: false` (one-shot
  // bridges audit-tagged to a real ticket that must never race a live
  // producer's workspace) — see `decideWorkspacePrepAttempt`.
  const repoFromJob = job.repoUrl ?? null;
  const haveRepoUrl = Boolean(repoFromJob) || Boolean(env.ENGINEER_REPO_URL);
  const prepEligible = job.workspacePrepEligible !== false;
  // `job.ticketId &&` is redundant with decideWorkspacePrepAttempt's own check
  // (kept here only so TypeScript narrows `job.ticketId` to `string` for the
  // prepareWorkspace() call below — a function call can't narrow a property
  // read on its argument).
  if (job.ticketId && decideWorkspacePrepAttempt(job, env.ENGINEER_REPO_URL)) {
    try {
      const ws = await prepareWorkspace({
        // Slice IB-B — merger tickets inherit the source ticket's workspace
        // so the conflict markers in the source's checkout are still
        // available. Falls back to job.ticketId when no override is set.
        ticketId: job.workspaceTicketId ?? job.ticketId,
        runId: job.runId,
        repoUrl: repoFromJob ?? undefined,
        // C4 — human-readable branch slug resolved by the engine from
        // tickets.title (cached on tickets.git_branch_name). Falls back to
        // slugify(ticketId) inside prepareWorkspace when this is absent —
        // the pre-C4 behaviour for jobs that pre-date the field.
        ticketSlug: job.ticketSlug ?? undefined,
        githubToken: job.githubToken ?? undefined,
        gitAuthorName: job.gitAuthorName ?? undefined,
        gitAuthorEmail: job.gitAuthorEmail ?? undefined,
        // Slice A — write per-project secrets to workspace/.env.local AND
        // ensure .env.local is in .git/info/exclude so the agent can never
        // accidentally commit it. Null safely skips both.
        projectSecretsJson: job.projectSecretsJson ?? undefined,
        // Slice IB — clone --branch <baseBranch> so the ticket branch is
        // cut from the integration tip (e.g. dev). Null falls through to
        // the repo's default branch (legacy).
        baseBranch: job.baseBranch ?? undefined,
        // WI-5.2 — cut `devpilot/<slug>` from this exact commit on baseBranch (a
        // landed builds_on parent's sha). Undefined = branch from the tip.
        baseSha: job.baseSha ?? undefined,
      });
      workspacePath = ws.path;
      baseSha = await readGitFullHeadSha(workspacePath);
      console.log(
        `[devpilot-runner] workspace ready for ticket=${job.ticketId} run=${job.runId} → ${ws.path} (branch=${ws.branch})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[devpilot-runner] workspace prep failed for job ${job.jobId}:`, err);
      // Don't crash the worker — surface the failure as a failed step result
      // so the engine can mark the run failed and the operator can see why.
      await postStepResult(job.runId, {
        jobId: job.jobId,
        ok: false,
        error: `workspace prep failed: ${msg}`,
        workspacePath: null,
      }).catch((postErr) =>
        console.error(`[devpilot-runner] failed to post workspace-prep failure:`, postErr),
      );
      inFlightRuns.delete(job.runId);
      inFlightJobs.delete(job.runId);
      activeJobs--;
      if (activeJobs === 0) await heartbeat(runnerId!, "idle").catch(() => undefined);
      return;
    }
  } else {
    // NB: never log job.githubToken; only its presence as a boolean.
    console.log(
      `[devpilot-runner] skipping workspace prep (ticketId=${job.ticketId ?? "<none>"}, repoUrl=${repoFromJob ? "job" : env.ENGINEER_REPO_URL ? "env" : "unset"}, token=${job.githubToken ? "present" : "absent"}, prepEligible=${prepEligible})`,
    );
  }

  // Workspace precondition - REFUSE BEFORE SPENDING.
  //
  // Placed here deliberately: after prep (so `workspacePath` reflects what
  // actually exists) and before attachment delivery and `runClaude` (so a
  // refused job costs zero subscription spend and zero signed-URL traffic). A
  // guard that ran after the model call would save nothing - the failure this
  // fixes is measured in a real dollar already spent.
  //
  // Reported through the SAME channel as a workspace-prep failure above:
  // `postStepResult({ok:false, error})`, which run-agent's `lc-await-<i>` turns
  // into a NonRetriableError, so the run ends `failed` with the reason on its
  // audit step rather than `done`.
  const wsRefusal = decideJobWorkspaceRefusal(job, workspacePath);
  if (wsRefusal.refuse) {
    console.error(
      `[devpilot-runner] refusing job ${job.jobId} (run=${job.runId}): ${wsRefusal.error}`,
    );
    await postStepResult(job.runId, {
      jobId: job.jobId,
      ok: false,
      error: wsRefusal.error,
      workspacePath: null,
    }).catch((postErr) =>
      console.error(`[devpilot-runner] failed to post workspace-precondition refusal:`, postErr),
    );
    inFlightRuns.delete(job.runId);
    inFlightJobs.delete(job.runId);
    activeJobs--;
    if (activeJobs === 0) await heartbeat(runnerId!, "idle").catch(() => undefined);
    return;
  }

  // Phase 3 (ticket screenshots) — if the engine flagged image attachments,
  // fetch fresh signed URLs (run-scoped endpoint), download them into a per-run
  // temp dir OUTSIDE the workspace, and append a fenced "Read these" section so
  // the agent's Read tool can view them. Fully best-effort: any failure leaves
  // `prompt` untouched and the agent runs on the ticket text alone. The dir is
  // removed in the finally block; a runner crash is swept at next boot.
  let prompt = job.prompt;
  let attachmentsDownloaded = false;
  if ((job.attachmentCount ?? 0) > 0) {
    try {
      const descriptors = await fetchRunAttachments(job.runId);
      if (descriptors.length > 0) {
        const dl = await downloadRunAttachments({
          runId: job.runId,
          attachments: descriptors,
          log: {
            info: (m) => console.log(`[devpilot-runner] ${m}`),
            warn: (m) => console.warn(`[devpilot-runner] ${m}`),
          },
        });
        if (dl.paths.length > 0) {
          attachmentsDownloaded = true;
          prompt = job.prompt + renderAttachmentPromptSection(dl.paths);
          console.log(
            `[devpilot-runner] delivered ${dl.paths.length} image attachment(s) for run=${job.runId}`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[devpilot-runner] attachment delivery failed for run=${job.runId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Verdictless-review seam — the run-scoped file the MCP relay appends to when
  // it successfully relays an outcome-recording tool. Derived here (the runner
  // owns the location) and injected into the spawn env below, so the relay is
  // told where to write rather than deriving it. Per RUN, not per step: a verdict
  // recorded on an earlier turn is still recorded on this one.
  const outcomeMarkerPath = outcomeMarkerPathFor(job.runId);

  // Browser evidence (outbound) — give THIS step its own @playwright/mcp
  // `--output-dir` so any screenshot the agent captures is attributable to it.
  //
  // The dir is keyed on (runId, iterationIdx), and the engine records exactly
  // one `run_steps` row per such invocation (idx = iterationIdx, kind='think'),
  // so a file here can only have been written during this step — attribution by
  // construction rather than by mtime guesswork, which is what lets the inspector
  // file the image under a step honestly. Best-effort: if the config can't be
  // written we fall through to the shared config, and the step runs with the
  // same browser tools it always had, just without collectable evidence.
  const artifactDir = browserArtifactDirForStep(job.runId, job.iterationIdx);
  const stepMcpConfigPath = writeStepMcpConfig({
    runId: job.runId,
    stepIdx: job.iterationIdx,
    outputDir: artifactDir,
  });
  if (!stepMcpConfigPath) {
    console.warn(
      `[devpilot-runner] could not write a per-step MCP config for run=${job.runId} step=${job.iterationIdx} — browser screenshots from this step will not be collected`,
    );
  }

  // Shutdown requeue: a job put back on the queue while it was still preparing
  // must not start a model turn now - the next runner start owns it.
  if (requeuedRuns.has(job.runId)) {
    console.log(
      `[devpilot-runner] run=${job.runId} was requeued during shutdown before its model turn — not starting it`,
    );
    inFlightRuns.delete(job.runId);
    inFlightJobs.delete(job.runId);
    activeJobs--;
    return;
  }
  inFlightJobs.set(job.runId, { job, phase: "model" });

  try {
    const result = await runClaude({
      prompt,
      systemPrompt: job.systemPrompt,
      // Null falls back to the shared config inside runClaude.
      mcpConfigPath: stepMcpConfigPath,
      ...(workspacePath ? { cwd: workspacePath } : {}),
      // Track 2 — let claude.ts wrap this step in a named tmux session
      // (`devpilot-run-<runId>`). When tmux is unavailable on the host, claude.ts
      // silently falls back to direct child_process spawn (no behavior change
      // vs Phase 0); the callback below is never invoked in that case.
      runId: job.runId,
      onTmuxSession: (sess) => {
        activeTmuxSessions.set(job.runId, sess);
        // Best-effort: also stamp the session name onto the runs row right
        // away via the claim path so the UI can render `tmux attach -t <sess>`
        // without waiting for the next heartbeat tick (15s worst case). The
        // claim endpoint is idempotent on tmuxSession — see route comments.
        if (runnerId) {
          void claimRun(job.runId, runnerId, sess);
        }
      },
      // WI-12 — model id/alias pinned by the engine, or null (the default) for
      // no `--model` at all. The runner carries this value; it never picks one.
      model: job.model ?? null,
      // The spawn env for `claude -p`. Composed + BLOCKLIST-FILTERED in one place
      // (subscription-env.ts) so the credential-isolation rule is a property of
      // the composition rather than a convention each call site has to remember:
      //
      //   • DEVPILOT_RUN_ID / DEVPILOT_TENANT_ID / DEVPILOT_ROLE — the MCP relay reads these to
      //     scope `devpilot_query_db` and stamp comment authorship on the real role.
      //   • DEVPILOT_WORKSPACE_PATH / DEVPILOT_BASE_SHA / ENGINEER_QA_VERIFY_ENABLED — L1's
      //     verification hooks (see verification-hook.ts).
      //   • the engine-fetched tenant config, then the per-project secrets, so a
      //     project's explicit value wins over the tenant default.
      //
      // What CANNOT be in there, no matter which layer names it: ANTHROPIC_API_KEY
      // (re-injecting it silently flips this subscription spawn onto per-token
      // billing), ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN (they re-point or
      // re-authenticate the agent's whole conversation), and any provider
      // credential. See subscription-env.ts for the full argument.
      envOverrides: buildSubscriptionEnvOverrides({
        runId: job.runId,
        tenantId: job.tenantId,
        // WI-14 — the MCP relay's `devpilot_create_ticket` derives the new ticket's
        // tenant AND project from THIS id server-side, so the model never names
        // either. Absent on a ticket-less run, where the relay refuses the tool.
        ticketId: job.ticketId,
        role: job.role,
        workspacePath,
        baseSha,
        // Same engine-authoritative switch hook (ii) uses, so the mid-step MCP
        // relay and the end-of-step hook can never disagree about whether this
        // run records.
        qaVerifyEnabled: Boolean(job.qaVerifyEnabled ?? env.ENGINEER_QA_VERIFY_ENABLED),
        baseBranch: job.qaBaseBranch ?? job.baseBranch ?? null,
        // Verdictless-review seam — where the relay writes down that this run
        // reached an actionable outcome for its ticket. See outcome-marker.ts.
        outcomeMarkerPath,
        runnerConfig: runnerConfigEnvOverrides(),
        projectSecretsJson: job.projectSecretsJson,
      }),
    });
    // Shutdown requeue: the turn was killed mid-flight and the job is already
    // back on the queue - whatever the parser salvaged is NOT the step's result.
    if (requeuedRuns.has(job.runId)) {
      console.log(
        `[devpilot-runner] run=${job.runId} was requeued during shutdown — discarding its interrupted turn`,
      );
      return;
    }
    inFlightJobs.set(job.runId, { job, phase: "post" });
    console.log(
      `[devpilot-runner] claude finished — text ${result.text.length} chars, model=${result.modelId ?? "?"}`,
    );
    consecutiveAuthFailures = 0; // reset on any clean success
    // Empty-delivery seam — the step reported SUCCESS, which is exactly the
    // shape the defect wears: run `384996f1` finished `done` having committed
    // nothing. This is the last instant at which a turn against this workspace
    // is still possible, so if the branch is empty and the tree is not, spend
    // one telling the agent so. Ordered BEFORE the verification record on
    // purpose, so the gate sees the post-nudge truth. Never throws.
    await nudgeUncommittedWork(job, workspacePath);
    // Verdictless-review seam — the reviewer-side twin of the nudge above, and
    // the same shape of defect: run `0222c4c9` (qa, ticket #90) finished `done`
    // having recorded no verdict, and two more runs on that ticket did the same.
    // This is the last instant at which a turn is still possible, so if the run
    // recorded no outcome at all, spend one handing the reviewer back its own
    // conclusion and asking it to record the verdict that conclusion reached.
    //
    // BEFORE `postStepResult`, which is the ordering that matters: the engine
    // runs `role-post` and then `reconcile-ticket` the moment the result lands,
    // so a nudge afterwards would be racing the park it exists to pre-empt. The
    // reconciler is untouched and stays the backstop. Never throws.
    await nudgeMissingVerdict(job, workspacePath, outcomeMarkerPath, result.text);
    // L1 (ticket-speed audit) — hook (ii): verify + record BEFORE reporting
    // step-result, since applyRolePostProcess/the reconciler act the moment
    // step-result lands and the engineer role never calls devpilot_move_ticket
    // itself (see recordStepVerification's doc comment).
    await recordStepVerification(job, workspacePath, baseSha);
    await postStepResult(job.runId, {
      jobId: job.jobId,
      ok: true,
      result: {
        text: result.text,
        usage: result.usage,
        finishReason: result.finishReason,
        modelId: result.modelId,
      },
      workspacePath,
    });
  } catch (err) {
    // Shutdown requeue: this is the kill from `shutdown()`, not a failure. The
    // job is back on the queue; reporting it failed here would end the run the
    // next runner start is about to continue.
    if (requeuedRuns.has(job.runId)) {
      console.log(
        `[devpilot-runner] run=${job.runId} was requeued during shutdown — its interrupted turn is not reported`,
      );
      return;
    }
    const isAuthErr = err instanceof ClaudeAuthError;
    if (isAuthErr) {
      consecutiveAuthFailures++;
      console.error(
        `[devpilot-runner] job ${job.jobId} hit auth/quota failure (${consecutiveAuthFailures}/${AUTH_FAILURE_CIRCUIT_LIMIT}): ${err.message}`,
      );
      if (consecutiveAuthFailures >= AUTH_FAILURE_CIRCUIT_LIMIT) {
        console.error(
          `[devpilot-runner] CIRCUIT BREAKER TRIPPED — ${AUTH_FAILURE_CIRCUIT_LIMIT} consecutive auth/quota failures. ` +
            `Halting pull loop. Fix auth (check CLAUDE_CODE_OAUTH_TOKEN and remove ANTHROPIC_API_KEY from env), then restart the runner.`,
        );
        stopping = true;
      }
    } else {
      console.error(`[devpilot-runner] job ${job.jobId} failed:`, err);
    }
    // L1 (ticket-speed audit) — hook (ii) on the failure path, BUT skip it when
    // the step was cancelled or hit an auth/quota failure. A cancelled run's
    // workspace is being torn down (or nobody is waiting on it), and an auth
    // failure means the agent never ran — verifying either would only start a
    // ~10-minute command against a dead run (the never-terminating bug). A
    // genuine mid-step crash still records, so a hand-off it managed to make
    // before dying is still gated. The dedup guard makes a redundant record a
    // fast no-op regardless.
    //
    // NO commit nudge on this branch, deliberately. The measured defect is a
    // step that SUCCEEDED with nothing committed (run `384996f1` finished
    // `done`), and only that path reaches `applyEngineerPost` → the QA gate. A
    // step that crashed does not hand its ticket to QA at all, so there is no
    // refusal to pre-empt — and spending an extra `claude -p` on a run that just
    // died, possibly on auth or mid-cancellation, is the never-terminating shape
    // the skip below already exists to avoid.
    //
    // NO verdict nudge on this branch either, for the same reason and one more.
    // The measured defect is a run that SUCCEEDED with no verdict recorded (all
    // three of ticket #90's qa runs finished `done`), and a step that crashed
    // does not reach `reconcile-ticket`'s success path at all — a
    // NonRetriableError routes to `runAgentFailed`, so there is no verdictless
    // park to pre-empt. Beyond that, a reviewer whose turn died mid-review has
    // by definition not reached a verdict, and asking a fresh session to record
    // one anyway is the closest this design could come to inventing it.
    const skipVerify = isAuthErr || cancelledRuns.has(job.runId);
    if (!skipVerify) {
      await recordStepVerification(job, workspacePath, baseSha);
    }
    await postStepResult(job.runId, {
      jobId: job.jobId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      workspacePath,
    });
  } finally {
    inFlightRuns.delete(job.runId);
    inFlightJobs.delete(job.runId);
    activeJobs--;
    // Browser evidence (outbound) — ship whatever the agent screenshotted during
    // this step, then remove the local copy.
    //
    // Placed in `finally`, AFTER `postStepResult` on both the success and the
    // failure path, and that placement is the guarantee: evidence handling
    // cannot delay, block or fail a run even in principle, because the run's
    // outcome has already been reported by the time this line is reached. A
    // failed upload is a degraded run — fewer images — never a failed one. It
    // also means a CRASHED step still ships what it captured before dying,
    // which is exactly when a screenshot is worth the most.
    if (stepMcpConfigPath) {
      await uploadStepArtifacts({
        runId: job.runId,
        stepIdx: job.iterationIdx,
        dir: artifactDir,
        upload: postRunArtifact,
        log: {
          info: (m) => console.log(`[devpilot-runner] ${m}`),
          warn: (m) => console.warn(`[devpilot-runner] ${m}`),
        },
      });
      removeStepMcpConfig(stepMcpConfigPath);
    }
    // The stored copy is the record now; leaving the local one is what made the
    // old fixed output dir grow without bound. A crash before this line is swept
    // at the next boot.
    await cleanupStepArtifacts(artifactDir);
    // Phase 3 — remove this run's downloaded screenshot temp dir now that the
    // agent step is done reading them. The dir lives under the OS temp root
    // (never in the workspace), and a runner crash before this line is caught
    // by the boot-time sweep. Best-effort; never throws.
    if (attachmentsDownloaded) {
      await cleanupRunAttachments(job.runId).catch((err) =>
        console.warn(
          `[devpilot-runner] attachment cleanup failed for run=${job.runId}:`,
          err instanceof Error ? err.message : err,
        ),
      );
    }
    // Verdictless-review seam — drop this run's outcome marker, but ONLY once
    // the run has no further turns.
    //
    // The marker is scoped to the RUN and this function handles one STEP, so an
    // unconditional delete here would erase a verdict recorded on turn 1 of a
    // 3-turn run and then nudge that reviewer, at turn 3, to record the verdict
    // it had already recorded — the seam firing against a healthy review, which
    // is the one outcome it must not produce. `finalIteration === false` is the
    // engine saying "more turns follow"; anything else (absent, or an explicit
    // true) is the last one. Best-effort either way: an abandoned marker is
    // swept at the next runner boot, and a lost marker can only cost a needless
    // nudge, never a skipped verdict.
    if (job.finalIteration !== false) {
      removeOutcomeMarker(outcomeMarkerPath);
    }
    // Track 2 — release the tmux-session-name slot so the next heartbeat
    // doesn't keep stamping a dead session onto runs. The actual tmux pane is
    // owned by claude.ts (immediate kill on clean exit, linger-then-kill on
    // crash); we only forget the name on the runner side.
    activeTmuxSessions.delete(job.runId);
    // L1 — forget any cancel mark for this run so the set can't grow unbounded.
    cancelledRuns.delete(job.runId);
    if (activeJobs === 0) {
      await heartbeat(runnerId!, "idle", null).catch(() => undefined);
    } else {
      // Other jobs still in flight — refresh heartbeat with whichever session
      // is still active so the engine doesn't see a stale name.
      await heartbeat(runnerId!, "busy", currentTmuxSession()).catch(() => undefined);
    }
  }
}

async function pullLoop(): Promise<void> {
  // Idle backoff: ramp the empty-poll cadence 1s→5s so an idle runner stops
  // burning Upstash request quota, and reset to 1s the moment a job arrives.
  let idleMs = POLL_BASE_MS;
  while (!stopping) {
    if (activeJobs >= env.CONCURRENCY) {
      // At capacity — this branch doesn't hit Redis, so keep it fast so we
      // resume pulling promptly once a slot frees.
      await new Promise((r) => setTimeout(r, POLL_BASE_MS));
      continue;
    }
    let raw: string | null = null;
    try {
      // Upstash REST doesn't support BRPOP; poll with RPOP.
      raw = (await redis.rpop(LOCAL_CC_QUEUE)) as string | null;
    } catch (err) {
      // Throttle to the cap on a pop error so an over-quota / down Redis isn't
      // hammered (the failure mode that killed the dev-server hand-off).
      console.warn(`[devpilot-runner] redis pop failed:`, err);
      idleMs = POLL_IDLE_CAP_MS;
      await new Promise((r) => setTimeout(r, idleMs));
      continue;
    }
    if (!raw) {
      await new Promise((r) => setTimeout(r, idleMs));
      idleMs = nextIdleDelayMs(idleMs);
      continue;
    }
    idleMs = POLL_BASE_MS;
    let job: Job;
    try {
      job = typeof raw === "string" ? JSON.parse(raw) : (raw as Job);
    } catch (e) {
      console.warn(`[devpilot-runner] bad job payload, skipping:`, raw, e);
      continue;
    }
    // Stamp runs.runner_id before handleJob so the engine's runner-watchdog
    // can attribute in-flight runs to this runner. Best-effort: a failed
    // claim only loses fast watchdog recovery; the 15-min stale-run reaper
    // still catches the run as a fallback. Awaited so the claim lands
    // before the agent's first `claude -p` returns and stamps results.
    if (runnerId) {
      await claimRun(job.runId, runnerId);
    }
    // Fire-and-forget; pullLoop keeps going so we can saturate concurrency.
    //
    // The `.catch` is load-bearing, not defensive tidying. `handleJob` ends BOTH
    // its success and its failure branch with `postStepResult`, which throws on
    // any non-2xx - so an engine 5xx escapes an unawaited promise, and with no
    // `unhandledRejection` handler installed that terminates the whole runner
    // process, taking every OTHER in-flight job on this host with it. The job
    // itself is lost either way (it was already rpop'd from Redis), so logging
    // is strictly better than dying; the engine's stale-run reaper is what
    // recovers the run. Reached more often now that the engine bounds its
    // `inngest.send` - a wedged event endpoint used to leave that POST pending
    // forever, which silently leaked this job's concurrency slot instead
    // (`handleJob`'s `finally`, and its `activeJobs--`, never ran).
    void handleJob(job).catch((err) => {
      console.error(
        `[devpilot-runner] job ${job.jobId} (run=${job.runId}) failed to report its result:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
}

// Phase 1 / M0 Wave 3 — workspace cleanup consumer.
//
// The engine's `workspaceReaper` cron emits `workspace/cleanup-requested`;
// the engine-side `workspaceCleanupEnqueuer` translates each event into one
// or more JSON jobs on `WORKSPACE_CLEANUP_QUEUE`. This loop drains the
// queue and removes the workspaces. It deliberately runs in parallel with
// the main pull loop on its own slow cadence — cleanups are low-priority
// and shouldn't compete with `claude -p` slots.
type CleanupJob = {
  tenantId: string;
  ticketId: string;
  path: string;
  reason?: string;
  /**
   * DELIBERATE-DISCARD override. Set ONLY by the operator "Discard & restart from
   * dev" action; makes `cleanupWorkspace` skip its reap guard and wipe the
   * workspace even with unpushed commits. Absent for reaper / safe-restart jobs,
   * which keep the refuse-on-unpushed guard fully intact.
   */
  force?: boolean;
  enqueuedAt?: string;
};

async function handleCleanupJob(job: CleanupJob): Promise<void> {
  // The reaper sends absolute paths gathered from `run_steps.payload`. We
  // only act on paths under our local WORKSPACE_ROOT — a path outside that
  // root probably came from a different host's runner and we should not
  // touch it (cross-host safety; see workspace-reaper.ts header).
  if (!job.path.startsWith(env.WORKSPACE_ROOT)) {
    console.warn(`[devpilot-runner] cleanup skipped (path not under WORKSPACE_ROOT): ${job.path}`);
    return;
  }
  try {
    // `cleanupWorkspace` refuses to delete a workspace that still holds commits
    // on no remote (see workspace-reap-guard.ts). A refusal is a normal,
    // expected outcome - the engine's reaper makes the same call against
    // `pending_pushes` and usually never enqueues the job at all - so log it as
    // a hold, not a failure. The operator releases it by pushing or discarding
    // the change on /changes; the next reaper pass then sweeps it.
    //
    // `job.force` (operator "Discard & restart from dev" only) overrides the
    // guard: the operator has explicitly confirmed the discard, so the unpushed
    // work is being thrown away on purpose. No other producer sets it.
    const result = await cleanupWorkspace({ ticketId: job.ticketId, force: job.force === true });
    if (!result.removed) {
      console.warn(
        `[devpilot-runner] cleanup HELD ticket=${job.ticketId} path=${job.path}: ${result.reason ?? "unsafe to delete"}`,
      );
      return;
    }
    console.log(
      `[devpilot-runner] cleaned workspace ticket=${job.ticketId} path=${job.path} reason=${job.reason ?? "n/a"}${job.force ? " (forced discard)" : ""}`,
    );
  } catch (err) {
    console.warn(`[devpilot-runner] cleanup failed for ${job.path}:`, err);
  }
}

async function cleanupLoop(): Promise<void> {
  while (!stopping) {
    let raw: string | null = null;
    try {
      raw = (await redis.rpop(WORKSPACE_CLEANUP_QUEUE)) as string | null;
    } catch (err) {
      console.warn(`[devpilot-runner] cleanup queue pop failed:`, err);
      await new Promise((r) => setTimeout(r, CLEANUP_POLL_MS));
      continue;
    }
    if (!raw) {
      await new Promise((r) => setTimeout(r, CLEANUP_POLL_MS));
      continue;
    }
    let job: CleanupJob;
    try {
      job = typeof raw === "string" ? JSON.parse(raw) : (raw as CleanupJob);
    } catch (e) {
      console.warn(`[devpilot-runner] bad cleanup payload, skipping:`, raw, e);
      continue;
    }
    void handleCleanupJob(job);
  }
}

// Cancel consumer — drains LOCAL_CC_CANCEL_QUEUE and kills the matching
// in-flight `claude -p`. Runs on its own slot in the Promise.race so a kill
// request is serviced within ~1s even while the pull loop is saturated. The
// producers are the engine's timeout paths (run-agent.ts + plan runner-bridge).
type CancelJob = {
  runId: string;
  reason?: string;
  stage?: string;
  timeoutHint?: string;
};

async function handleCancelJob(job: CancelJob): Promise<void> {
  if (!job.runId) {
    console.warn(`[devpilot-runner] cancel job missing runId, skipping`);
    return;
  }
  // L1 — mark the run cancelled so handleJob's catch branch skips verification.
  // Set unconditionally (even if nothing is in-flight here): the mark is cheap,
  // harmless if the job already finished, and cleared in handleJob's finally.
  cancelledRuns.add(job.runId);
  try {
    const killed = await cancelClaudeRun(job.runId);
    if (killed) {
      console.log(
        `[devpilot-runner] cancelled in-flight claude run=${job.runId} (reason=${job.reason ?? "n/a"})`,
      );
    } else {
      // Benign: the step already finished (or ran on another runner) between
      // the engine enqueuing the cancel and this loop draining it.
      console.log(
        `[devpilot-runner] cancel for run=${job.runId} — nothing in-flight here (already done or another runner)`,
      );
    }
  } catch (err) {
    console.warn(`[devpilot-runner] cancel failed for run=${job.runId}:`, err);
  }
}

async function cancelLoop(): Promise<void> {
  // Idle backoff: cancels are rare (engine timeout paths), so this loop can
  // ramp its empty-poll cadence 1s→5s and stay nearly free on the Upstash
  // request quota, snapping back to 1s only when a cancel actually lands.
  let idleMs = POLL_BASE_MS;
  while (!stopping) {
    let raw: string | null = null;
    try {
      raw = (await redis.rpop(LOCAL_CC_CANCEL_QUEUE)) as string | null;
    } catch (err) {
      console.warn(`[devpilot-runner] cancel queue pop failed:`, err);
      idleMs = POLL_IDLE_CAP_MS;
      await new Promise((r) => setTimeout(r, idleMs));
      continue;
    }
    if (!raw) {
      await new Promise((r) => setTimeout(r, idleMs));
      idleMs = nextIdleDelayMs(idleMs);
      continue;
    }
    idleMs = POLL_BASE_MS;
    let job: CancelJob;
    try {
      job = typeof raw === "string" ? JSON.parse(raw) : (raw as CancelJob);
    } catch (e) {
      console.warn(`[devpilot-runner] bad cancel payload, skipping:`, raw, e);
      continue;
    }
    void handleCancelJob(job);
  }
}

function heartbeatLoop(): NodeJS.Timeout {
  return setInterval(() => {
    if (!runnerId || stopping) return;
    heartbeat(
      runnerId,
      activeJobs > 0 ? "busy" : "idle",
      activeJobs > 0 ? currentTmuxSession() : null,
    ).catch((err) => console.warn(`[devpilot-runner] heartbeat error:`, err));
  }, HEARTBEAT_MS);
}

async function main(): Promise<void> {
  console.log(`[devpilot-runner] booting (name=${env.NAME}, concurrency=${env.CONCURRENCY})`);

  // Phase 3 — no run is in flight at boot, so any leftover per-run screenshot
  // temp dir is a straggler from a runner that died mid-job. Wipe the root so a
  // crash can never leak downloaded images into a later run. Best-effort.
  await sweepStaleAttachments().catch((err) =>
    console.warn(
      `[devpilot-runner] stale-attachment sweep failed:`,
      err instanceof Error ? err.message : err,
    ),
  );

  // Same reasoning for the OUTBOUND direction: no step is in flight at boot, so
  // any leftover per-step browser-artifact dir belongs to a runner that died
  // mid-job. Its images can no longer be attributed to a live step, so wipe the
  // root rather than leave a directory nothing will ever collect. Best-effort.
  await sweepStaleBrowserArtifacts().catch((err) =>
    console.warn(
      `[devpilot-runner] stale browser-artifact sweep failed:`,
      err instanceof Error ? err.message : err,
    ),
  );

  // Verdictless-review seam — same reasoning again. An outcome marker is only
  // meaningful for a run THIS process is executing; anything present at boot
  // belongs to a dead one and could only mislead a later run that happens to
  // reuse the id. Wiping is safe in the only direction that matters: the worst
  // case is a nudge that fires when it need not have, never a verdict skipped.
  sweepStaleOutcomeMarkers();

  // Loud auth sanity check. The Local CC Runner exists specifically to use
  // the Claude Code subscription — never the API. If ANTHROPIC_API_KEY is
  // present in the environment, claude.ts will strip it before spawning
  // `claude -p` so it can't accidentally bill against the API account. We
  // still warn here so the operator notices the misconfiguration. If neither
  // CLAUDE_CODE_OAUTH_TOKEN nor the stored ~/.claude OAuth credentials are
  // available, `claude -p` will fail to authenticate — surface that early.
  if (process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "[devpilot-runner] WARNING: ANTHROPIC_API_KEY is set in the runner env. " +
        "It WILL be stripped before invoking `claude -p` (subscription mode only). " +
        "Remove it from .env.local to silence this warning.",
    );
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.warn(
      "[devpilot-runner] CLAUDE_CODE_OAUTH_TOKEN is unset; `claude -p` will fall back " +
        "to its stored config (~/.claude). Run `claude setup-token` on this host " +
        "if subscription auth fails.",
    );
  }

  // Boot-race resilience: on a cold `pnpm dev`, turbo starts this runner and
  // the Next.js engine together, and the runner routinely wins — issuing this
  // registration call before the engine has bound :3000. That surfaces as
  // `TypeError: fetch failed` (ECONNREFUSED), which is transient, not fatal, so
  // retry with bounded backoff until the engine is listening. A real HTTP
  // response (e.g. a 401/403 or malformed body) is NOT retried — it rethrows
  // immediately so genuine misconfiguration still fails loudly.
  const { runnerId: id } = await retryOnTransientConnect(registerRunner, {
    onWait: ({ attempt, delayMs, elapsedMs }) =>
      console.warn(
        `[devpilot-runner] engine not reachable yet at ${env.ENGINE_URL} ` +
          `(attempt ${attempt}, waited ${Math.round(elapsedMs / 1000)}s) — retrying in ${delayMs}ms. ` +
          "Normal on a cold `pnpm dev` while Next.js binds :3000; not yet registered.",
      ),
  });
  runnerId = id;
  console.log(`[devpilot-runner] registered: ${id}`);

  // Phase 5 — pull this runner's per-tenant config once at boot, then refresh
  // on the heartbeat cadence. Best-effort: a failure leaves `fetchedConfig`
  // empty and every getter falls back to the env floor, so boot and the pull
  // loop proceed exactly as before. Awaited (not blocking on success) only so a
  // fast initial pull lands before the first job, but its result is optional.
  await refreshRunnerConfig().catch(() => undefined);
  const cfgRefresh = setInterval(() => {
    if (stopping) return;
    void refreshRunnerConfig().catch((err) =>
      console.warn(`[devpilot-runner] config refresh error:`, err),
    );
  }, HEARTBEAT_MS);

  const hb = heartbeatLoop();
  // Phase 2 / M5e — dev-server heartbeat ticker. Posts per-session status
  // + log tail every 3s while the runner is up. Cleared in shutdown().
  const devHb = startHeartbeatTicker({
    engineUrl: env.ENGINE_URL,
    registrationKey: env.REGISTRATION_KEY,
    runnerId: runnerId!,
    getStopping: () => stopping,
  });

  // Re-entrancy guard: under `tsx watch` a Ctrl-C reaches this process TWICE
  // (the terminal's process-group SIGINT, and tsx relaying its own), and two
  // concurrent shutdowns pushed every interrupted job onto the queue twice -
  // measured: `LLEN` 2 after one requeue. The first signal owns the shutdown;
  // later ones are ignored.
  let shutdownStarted = false;
  const shutdown = async (sig: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(`[devpilot-runner] ${sig} — shutting down`);
    stopping = true;
    clearInterval(hb);
    clearInterval(devHb);
    clearInterval(cfgRefresh);
    // Interrupted jobs go BACK on the queue BEFORE anything is killed, so the
    // next runner start re-runs the step and the engine's `lc-await` - still
    // waiting, and persisted across restarts by the Inngest dev server - picks
    // the result up as if nothing happened. A job past its model turn is left
    // alone: its result is about to be posted (the wait below covers it).
    // Rules in shutdown-requeue.ts.
    for (const [runId, entry] of inFlightJobs) {
      if (decideShutdownRequeue(entry.phase) !== "requeue") continue;
      if (requeuedRuns.has(runId)) continue; // belt and braces beside the guard above
      try {
        await redis[REQUEUE_PUSH_SIDE](LOCAL_CC_QUEUE, requeuePayload(entry.job));
        requeuedRuns.add(runId);
        console.log(
          `[devpilot-runner] requeued job ${entry.job.jobId} (run=${runId}, phase=${entry.phase}) — it runs again on the next start`,
        );
        // Re-read the phase: it may have reached `model` while the push was
        // in flight, and a model turn that has started must be stopped now
        // rather than when the straggler sweep gets to it.
        if (inFlightJobs.get(runId)?.phase === "model") {
          await cancelClaudeRun(runId).catch(() => undefined);
        }
      } catch (err) {
        console.error(
          `[devpilot-runner] could not requeue job ${entry.job.jobId} (run=${runId}) — it will be reported as failed instead:`,
          err,
        );
      }
    }
    // Phase 2 / M5e — graceful TERM→KILL on all tracked dev-server
    // children before we exit. The children are also attached to the
    // runner's process group, but giving them a 5s window first lets
    // pnpm/vite/etc. clean up their own subprocesses (esbuild workers,
    // etc.) and free their ports cleanly.
    await killAllDevServers({ graceMs: 5_000 }).catch((err) =>
      console.warn(`[devpilot-runner] killAllDevServers during shutdown failed:`, err),
    );
    // "Take the wheel" — stop transcript mirrors + kill interactive tmux
    // sessions so we never strand a detached session after the runner exits.
    await shutdownTakeovers().catch((err) =>
      console.warn(`[devpilot-runner] shutdownTakeovers during shutdown failed:`, err),
    );
    // Track 2 — reap any headless-run tmux sessions wrapping in-flight agent
    // steps. claude.ts normally tears them down on its own (clean exit) or
    // after a 5-min linger (crash), but on shutdown we want them gone now so
    // we don't strand panes operators would attach to and find empty.
    await killAllHeadlessRunSessions().catch((err) =>
      console.warn(`[devpilot-runner] killAllHeadlessRunSessions during shutdown failed:`, err),
    );
    // Best-effort: wait briefly for in-flight jobs to finish.
    const waitStart = Date.now();
    while (activeJobs > 0 && Date.now() - waitStart < 30_000) {
      await new Promise((r) => setTimeout(r, 500));
    }
    // Verification commands and workspace git are spawned detached (so a
    // timeout can reap their whole tree), which also means they no longer die
    // with our process group. Anything still alive after the in-flight wait is
    // a straggler that would otherwise keep chewing a workspace the next runner
    // reuses — SIGTERM it here, give it the same short window we give dev
    // servers, and let the exit hook SIGKILL whatever ignored us.
    if (killAllSpawnedTrees("SIGTERM") > 0) {
      await new Promise((r) => setTimeout(r, 5_000));
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // Last-resort synchronous net: if the process exits without the async
  // shutdown completing (e.g. an uncaught fatal), still kill tmux sessions so
  // we don't leave a detached interactive claude running, and force-reap any
  // surviving detached command/git trees.
  process.on("exit", () => {
    killAllTakeoverSessionsSync();
    killAllSpawnedTrees("SIGKILL");
  });

  // Run all loops in parallel. Cleanup and dev-server control run on their
  // own slots so neither blocks the main local-cc pull. Promise.race exits
  // the moment any loop returns — but each loop only returns when
  // `stopping` is true, so a return from one means shutdown is in flight.
  await Promise.race([
    pullLoop(),
    cleanupLoop(),
    cancelLoop(),
    devServerPullLoop({
      runnerId: runnerId!,
      engineUrl: env.ENGINE_URL,
      registrationKey: env.REGISTRATION_KEY,
      getStopping: () => stopping,
    }),
    takeoverPullLoop({
      engineUrl: env.ENGINE_URL,
      registrationKey: env.REGISTRATION_KEY,
      getStopping: () => stopping,
    }),
    // The project supervisor's clock. A sibling of the loops above, and it has
    // to be one: every recovery mechanism in the engine is an Inngest cron, so
    // when that scheduler wedges they all stop at once and nothing is left to
    // notice (2026-08-03 - seven hours, found by a human). The runner is the
    // only resident process in the system, so this is the one loop that
    // survives it.
    //
    // Stateless between iterations by contract: the engine re-derives every
    // decision from the database each pass. See supervisor-loop.ts for why that
    // does not violate the TDD's long-lived-loop rule, which is about AGENT
    // state.
    supervisorLoop({
      engineUrl: env.ENGINE_URL,
      registrationKey: env.REGISTRATION_KEY,
      tenantId: env.TENANT_ID,
      runnerId: () => runnerId,
      activeRunIds: () => [...inFlightRuns],
      getStopping: () => stopping,
    }),
  ]);
}

void main().catch((err) => {
  console.error("[devpilot-runner] fatal:", err);
  process.exit(1);
});
