// Spawn `claude -p` for one agent step. Uses stream-json so we can pick up
// the final result event with token usage + model id.
//
// Track 2 — every headless agent run is wrapped in a named tmux session
// (`devpilot-run-<runId-16char>`) so operators can `tmux attach -t <name>` from the
// moment a step starts and watch what the agent is doing. The JSON event parse
// loop, stderr buffering, exit handling, and auth-failure detection are all
// preserved exactly: the FIFOs that pipe-through the tmux pane deliver the
// same byte stream the direct child_process spawn used to deliver, so nothing
// downstream observes a difference. When tmux is missing on the host we fall
// back to the direct spawn so we never break Linux/Windows runners.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installSubagentsIntoWorkspace } from "./agents-bundle.js";
import { env } from "./env.js";
import { isModelUnavailableError, modelArgs } from "./model-args.js";
import { sanitizeSubscriptionEnvOverrides } from "./subscription-env.js";
import {
  isTmuxAvailable,
  killHeadlessRunSession,
  startHeadlessRunInTmux,
  TmuxUnavailableError,
  type HeadlessRunHandle,
} from "./tmux-session.js";

// Resolve absolute paths to the tsx binary (workspace-local) and the MCP relay
// source. The static `apps/runner/src/mcp/mcp-config.example.json` is shipped as a
// reference, but its relative `./dist/mcp/server.js` reference can't work in
// a tsx-only workspace (we have no build step). Instead we generate a runtime
// MCP config at module load with absolute paths baked in.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TSX_BIN = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");
// The devpilot-board relay is spawned as `tsx <MCP_SERVER_SOURCE>`, and tsx runs both
// .ts and .js. The file must therefore match whichever mode THIS module runs in:
// in dev (`tsx src/index.ts`) __filename is `src/claude.ts`, and the relay lives
// at `src/mcp/server.ts`; in the compiled prod build (`node dist/index.js`)
// __filename is `dist/claude.js`, and tsc emitted the relay to `dist/mcp/server.js`
// (there is no `dist/mcp/server.ts`). Hardcoding `server.ts` made prod resolve to a
// nonexistent `dist/mcp/server.ts`, so `tsx` failed with ERR_MODULE_NOT_FOUND, the
// devpilot-board server never started, and every `devpilot_*` tool (e.g. devpilot_move_ticket)
// was absent - tickets looped in `in_review`. Derive the extension from this
// module so both modes point at a file that exists; never hardcode src/ or dist/.
const MCP_SERVER_SOURCE = path.resolve(__dirname, "mcp", `server${path.extname(__filename)}`);
const RUNTIME_MCP_CONFIG_PATH = path.join(os.tmpdir(), "devpilot-mcp-config.json");

// DevPilot-owned browser-automation MCP server. We depend on Microsoft's
// @playwright/mcp (pinned in apps/runner/package.json) and resolve its stdio
// binary from the workspace, exactly like TSX_BIN above — so interactive
// browser control ships WITH devpilot and works on any install, rather than
// leaking in the operator's own global Playwright plugin (not portable). The
// server exposes its `browser_*` tools at MCP handshake without launching a
// browser; chromium is only launched at first navigate, so the runner host
// needs `playwright install chromium` as a one-time deploy step (see the PR).
const PLAYWRIGHT_MCP_BIN = path.resolve(__dirname, "..", "node_modules", ".bin", "playwright-mcp");
// @playwright/mcp drops snapshot/screenshot artifacts into a `.playwright-mcp/`
// dir under its cwd by default. An agent's cwd IS its git workspace, so without
// this the artifacts would land inside the engineer's checkout and could be
// swept into a commit/PR. Pin the output outside any workspace.
//
// This is the FALLBACK output dir, used only when a caller runs `claude -p`
// without a (runId, stepIdx) — ad-hoc smoke tests and the interactive takeover
// session. A normal ticket step gets its OWN directory instead (see
// `writeStepMcpConfig`), which is what makes a captured screenshot attributable
// to the step that produced it. Files landing here are still swept at boot but
// are never uploaded: nothing can say which step they belong to.
const PLAYWRIGHT_MCP_OUTPUT_DIR = path.join(os.tmpdir(), "devpilot-playwright-output");

function buildMcpConfig(outputDir: string = PLAYWRIGHT_MCP_OUTPUT_DIR) {
  return {
    mcpServers: {
      "devpilot-board": {
        type: "stdio",
        command: TSX_BIN,
        args: [MCP_SERVER_SOURCE],
        env: {
          LOCAL_CC_ENGINE_URL: process.env.LOCAL_CC_ENGINE_URL ?? "http://localhost:3000",
          DEVPILOT_RUNNER_REGISTRATION_KEY: process.env.DEVPILOT_RUNNER_REGISTRATION_KEY ?? "",
          DEVPILOT_RUNNER_ID: process.env.DEVPILOT_RUNNER_ID ?? "",
        },
      },
      // Namespaced "playwright" → tools are `mcp__playwright__browser_*`
      // (distinct from any operator-global `mcp__plugin_playwright_playwright__*`).
      // --headless: no display on runner hosts. --isolated: an in-memory browser
      // profile per session so concurrent steps (LOCAL_CC_CONCURRENCY>1) don't
      // contend on a shared on-disk profile lock. --output-dir: keep snapshot
      // artifacts out of the agent's git workspace (see note above).
      playwright: {
        type: "stdio",
        command: PLAYWRIGHT_MCP_BIN,
        args: ["--headless", "--isolated", "--output-dir", outputDir],
      },
    },
  };
}

function writeRuntimeMcpConfig(): string {
  fs.writeFileSync(RUNTIME_MCP_CONFIG_PATH, JSON.stringify(buildMcpConfig(), null, 2));
  return RUNTIME_MCP_CONFIG_PATH;
}

/**
 * Write a config for ONE agent step whose @playwright/mcp `--output-dir` is
 * unique to `(runId, stepIdx)`, and return its path.
 *
 * THIS IS THE ATTRIBUTION MECHANISM for browser screenshots, not a tidiness
 * measure. An MCP stdio server is a CHILD of the `claude -p` process that loads
 * it, and the engine records exactly one `run_steps` row (`idx = stepIdx`,
 * kind='think') per such invocation — so a file in this directory can only have
 * been written during that step. That is provable by construction, where a
 * shared directory plus mtime guesswork would not be: under
 * LOCAL_CC_CONCURRENCY > 1 two steps write concurrently and nothing afterwards
 * could tell their captures apart.
 *
 * The config file is written under the OS temp root (never a git workspace) and
 * is the caller's to remove via `removeStepMcpConfig` once the step is done;
 * this function also creates `outputDir`, so there is one owner of that mkdir.
 *
 * Returns null on any write failure — the caller then falls back to the shared
 * config and simply collects no evidence for that step, because a run must never
 * fail over screenshot plumbing.
 */
export function writeStepMcpConfig(args: {
  runId: string;
  stepIdx: number;
  outputDir: string;
}): string | null {
  try {
    const configPath = path.join(
      os.tmpdir(),
      `devpilot-mcp-config-${path.basename(args.runId)}-${args.stepIdx}.json`,
    );
    fs.mkdirSync(args.outputDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(buildMcpConfig(args.outputDir), null, 2));
    return configPath;
  } catch {
    return null;
  }
}

/** Remove a per-step MCP config written by `writeStepMcpConfig`. Best-effort. */
export function removeStepMcpConfig(configPath: string): void {
  try {
    fs.rmSync(configPath, { force: true });
  } catch {
    /* best-effort */
  }
}

// Exported so the interactive "take the wheel" session (tmux-session.ts) can
// expose the same devpilot-board MCP tools (devpilot_move_ticket, devpilot_comment, …) the
// headless path uses — the agent/human moves the ticket to signal "done".
export const MCP_CONFIG_PATH = writeRuntimeMcpConfig();

/**
 * An MCP config declaring NO servers, for the empty-delivery commit nudge.
 *
 * This is the STRUCTURAL half of that turn's bound, and it is why the reduced
 * `COMMIT_NUDGE_TOOLS_CSV` is not the whole story: omitting a tool from
 * `--tools` leaves it deferred but still reachable, whereas a server that is
 * not declared cannot be spawned and its tools do not exist. So the nudge turn
 * provably cannot move the ticket, escalate to a human, or drive a browser
 * — not because it was told not to, but because there is nothing to call.
 *
 * It also skips starting the board relay and a headless Chromium for a turn
 * whose entire job is `git add -A && git commit`.
 *
 * Written once at module load, beside the runtime config, so the nudge path
 * costs no filesystem work per invocation.
 */
export const NO_MCP_CONFIG_PATH = (() => {
  const p = path.join(os.tmpdir(), "devpilot-mcp-config-none.json");
  fs.writeFileSync(p, JSON.stringify({ mcpServers: {} }, null, 2));
  return p;
})();

/**
 * An MCP config declaring the devpilot-board relay and NOTHING ELSE, for the
 * verdictless-review nudge.
 *
 * That turn differs from the commit nudge in one essential way: its whole job IS
 * a board call, so it cannot use `NO_MCP_CONFIG_PATH`. What it does not need is
 * @playwright/mcp — recording a verdict never involves a browser, and every
 * declared server is a real subprocess, here a headless Chromium, started for a
 * turn that will make one tool call.
 *
 * The narrowing that matters for this turn is therefore in the TOOL SET
 * (`VERDICT_NUDGE_TOOLS_CSV`), not in the server list; dropping playwright is
 * the second, cheaper bound on top of it.
 */
export const BOARD_ONLY_MCP_CONFIG_PATH = (() => {
  const p = path.join(os.tmpdir(), "devpilot-mcp-config-board-only.json");
  const full = buildMcpConfig();
  fs.writeFileSync(
    p,
    JSON.stringify(
      { mcpServers: { "devpilot-board": full.mcpServers["devpilot-board"] } },
      null,
      2,
    ),
  );
  return p;
})();

// Base (built-in) agent tools every headless step needs directly loaded.
// `Task` fans out to the bundled read-only subagents (apps/runner/src/agents/*.md)
// for parallel code search/analysis — those subagents declare `tools: Read, Grep,
// Glob`, so intra-step parallelism can't edit, run shell, or call devpilot_* tools and
// therefore can't bypass DevPilot's budget/HITL gates.
const BASE_AGENT_TOOLS = ["Read", "Edit", "Bash", "Grep", "Glob", "Task"] as const;

// Web-research tools. Both are Claude Code BUILT-INS (portable — present on any
// `claude` install, no MCP server), so producer/QA agents can look up library
// APIs, docs, and error messages while they work. Listed in `--tools` so they
// load DIRECT rather than landing deferred alongside the MCP tools on 2.1.207+.
const WEB_TOOLS = ["WebSearch", "WebFetch"] as const;

// Browser-driving tools from the devpilot-owned @playwright/mcp server wired in
// via writeRuntimeMcpConfig above (server name "playwright"). Lets QA agents
// interactively drive a real browser — navigate, click, type, snapshot, assert,
// screenshot — to test web apps, beyond running headless Playwright scripts
// through Bash. This is the EXACT default tool set @playwright/mcp@0.0.78
// exposes at handshake (verified via tools/list); keep it in sync with the
// pinned version — a tool missing here lands DEFERRED on 2.1.207+ and the agent
// cannot call it, and a name here that the server doesn't expose is inert.
const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_click",
  "browser_hover",
  "browser_type",
  "browser_press_key",
  "browser_select_option",
  "browser_fill_form",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_find",
  "browser_wait_for",
  "browser_evaluate",
  "browser_run_code_unsafe",
  "browser_console_messages",
  "browser_network_requests",
  "browser_network_request",
  "browser_handle_dialog",
  "browser_file_upload",
  "browser_drag",
  "browser_drop",
  "browser_resize",
  "browser_tabs",
  "browser_close",
].map((t) => `mcp__playwright__${t}`);

// Every board tool the devpilot-board MCP relay exposes (apps/runner/src/mcp/server.ts
// `TOOLS`). Keep this in sync with that catalog — a tool missing here lands
// DEFERRED on claude 2.1.207+ (see AGENT_TOOLS_CSV below) and the agent cannot
// call it. MCP tools are namespaced `mcp__<server>__<tool>`; our server is
// "devpilot-board".
const DEVPILOT_BOARD_TOOLS = [
  "devpilot_comment",
  "devpilot_handoff",
  "devpilot_move_ticket",
  "devpilot_request_human",
  "devpilot_request_secret",
  "devpilot_query_db",
  "devpilot_query_db_smart",
  "devpilot_log_conflict_event",
  "devpilot_create_ticket",
  "devpilot_spawn_agent",
].map((t) => `mcp__devpilot-board__${t}`);

// The full tool set, passed to BOTH `--tools` (force direct load) and
// `--allowedTools` (auto-approve). See the args block in runClaude for why both.
// Exported so the interactive takeover session (tmux-session.ts) can force the
// same devpilot-board tools to load directly rather than land deferred on 2.1.207+.
export const AGENT_TOOLS_CSV = [
  ...BASE_AGENT_TOOLS,
  ...WEB_TOOLS,
  ...BROWSER_TOOLS,
  ...DEVPILOT_BOARD_TOOLS,
].join(",");

/**
 * The tool set for the empty-delivery commit nudge (`empty-delivery.ts`) — the
 * one extra turn spent asking an agent to commit work it left uncommitted.
 *
 * DELIBERATELY NOT `AGENT_TOOLS_CSV`. That turn is automatic and unbudgeted by
 * the agent's own plan, so its side-effect surface is narrowed to what a git
 * commit actually needs: read the tree, read the diff, run git. It carries NO
 * board tools (it must not move the ticket, file a ticket, comment, or park the
 * ticket in `input_required` via `devpilot_request_human`), no browser, no web,
 * no `Task` fan-out, and NO `Edit` — the work is already written and a
 * hygiene step has no business rewriting it. `.gitignore` maintenance, the one
 * legitimate edit the nudge prompt sanctions, is reachable through `Bash`.
 *
 * The second, independent bound is `NO_MCP_CONFIG_PATH` below: with no MCP
 * server declared the board tools do not merely go unlisted, they do not exist.
 */
export const COMMIT_NUDGE_TOOLS_CSV = ["Read", "Grep", "Glob", "Bash"].join(",");

/**
 * The tool set for the verdictless-review nudge (`verdict-outcome.ts`) — the one
 * extra turn spent asking a reviewer to record the verdict it already reached.
 *
 * THE ABSENCE OF `Bash` IS THE LOAD-BEARING PART, and it is the difference
 * between this turn and a second review. With a shell the agent can re-run the
 * test suite, and a re-review is exactly what AGENTS.md forbids on this path: it
 * is non-deterministic and can flip a genuine "changes requested" into a
 * spurious approve. Without one, an agent that would need to re-test in order to
 * know its verdict cannot, and the prompt's escalation is the only route left —
 * which is the honest answer, because an agent in that position did not reach a
 * verdict. It also bounds the cost: a turn that cannot start a ten-minute
 * command cannot become one. `Edit` is absent for the same reason it is absent
 * from the commit nudge and then some: a bookkeeping step has no business
 * touching the work, and a reviewer must never be able to fix what it is judging.
 *
 * The three board tools are exactly the outcomes the turn is allowed to reach —
 * the verdict itself, its written reason, and the escalation when there is no
 * verdict to record. Deliberately NOT present: `devpilot_create_ticket` and
 * `devpilot_spawn_agent` (an automatic turn does not get to file work or fan
 * out), `devpilot_handoff`, and the `devpilot_query_db` pair (this turn reads its
 * own conclusion, not the board).
 *
 * Read/Grep/Glob are kept so the agent can re-ground itself in a file its own
 * conclusion names before recording — read-only, cheap, and unable to change
 * either the work or the verdict.
 */
export const VERDICT_NUDGE_TOOLS_CSV = [
  "Read",
  "Grep",
  "Glob",
  "mcp__devpilot-board__devpilot_move_ticket",
  "mcp__devpilot-board__devpilot_comment",
  "mcp__devpilot-board__devpilot_request_human",
].join(",");

export type ClaudeRunInput = {
  prompt: string;
  systemPrompt?: string;
  /**
   * Optional working directory for the `claude -p` child process. When set,
   * file/bash/git tools operate inside this directory — used by Phase 1's
   * Engineer git workspace. When undefined, behavior is unchanged from
   * Phase 0 (inherits the runner's cwd).
   */
  cwd?: string;
  /**
   * Phase 1 / M10 — extra env vars propagated to the spawned `claude -p`
   * process AND inherited by its MCP relay child. The MCP `devpilot_query_db`
   * tools read `DEVPILOT_RUN_ID` / `DEVPILOT_TENANT_ID` from here to scope queries to
   * the calling agent. Job-scoped to avoid races under LOCAL_CC_CONCURRENCY>1.
   */
  envOverrides?: Record<string, string>;
  /**
   * Track 2 — when set, the runner wraps this step in a named tmux session
   * (`devpilot-run-<runId>`) instead of a bare child_process spawn so the run is
   * attachable from spawn. The runId is purely cosmetic for the session name;
   * the runner's main loop also stamps it on the runs table via the claim
   * call so the UI can show the attach command.
   *
   * Callers that don't pass a runId (ad-hoc smoke tests) get a synthetic id
   * so the session still has a valid name; callers that pass `null` opt out
   * of the tmux wrapper for that specific call.
   */
  runId?: string | null;
  /**
   * Track 2 — invoked synchronously once the tmux session is created and
   * before `claude -p` starts emitting output. Lets the runner loop stamp the
   * session name onto its in-memory "active session" map so the next outgoing
   * heartbeat carries it. No-op when the tmux fallback is taken.
   */
  onTmuxSession?: (tmuxSession: string) => void;
  /**
   * WI-12 — the model id/alias to pin via `--model`, resolved SERVER-SIDE by the
   * engine from the project's config. Null/undefined (the default, and what every
   * project that hasn't opted in sends) emits NO `--model` flag, so the step runs
   * on the account's own default exactly as it always has.
   *
   * The runner never chooses this value — it only carries it. See model-args.ts
   * for the plan-availability fallback that applies when a pinned model turns out
   * not to be runnable on this subscription.
   */
  model?: string | null;
  /**
   * Browser-evidence plumbing — the MCP config this step should load. A ticket
   * step passes a PER-STEP config (see `writeStepMcpConfig`) whose
   * @playwright/mcp `--output-dir` is unique to `(runId, stepIdx)`, which is
   * what makes a screenshot captured during the step attributable to it.
   *
   * Absent (the default, and what every ad-hoc caller sends) loads the shared
   * config exactly as before — the step still gets the full browser tool set,
   * its captures just land in the shared fallback dir and are never uploaded,
   * because nothing could say which step wrote them.
   */
  mcpConfigPath?: string | null;
  /**
   * Which tool set to force-load and auto-approve. Absent (every existing
   * caller) is `AGENT_TOOLS_CSV` — the full agent surface, byte-for-byte
   * unchanged. The empty-delivery commit nudge passes the narrowed
   * `COMMIT_NUDGE_TOOLS_CSV`; see the note there for why an automatic extra
   * turn does not get the full set.
   */
  toolsCsv?: string | null;
};

export type ClaudeRunOutput = {
  text: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  modelId?: string;
  finishReason?: string;
};

/**
 * Authentication / quota error patterns that `claude -p` returns as the
 * *result text* rather than a non-zero exit. Without this check the runner
 * would happily POST these as successful step results, causing the engine
 * to mark the run `done` with the error text as content — which is exactly
 * what powered the Wave 3 runaway. When we detect one of these patterns we
 * raise a typed error so the runner can short-circuit, POST a failed step
 * result with the real reason, and (via the circuit breaker in index.ts)
 * halt the pull loop after a few consecutive hits.
 */
const AUTH_FAILURE_PATTERNS: ReadonlyArray<RegExp> = [
  /credit balance is too low/i,
  /invalid (?:api )?key/i,
  /authentication (?:failed|error)/i,
  /\bunauthorized\b/i,
  /please (?:upgrade|add credits)/i,
];

export class ClaudeAuthError extends Error {
  constructor(public readonly snippet: string) {
    super(`claude -p auth/quota failure: ${snippet.slice(0, 120)}`);
    this.name = "ClaudeAuthError";
  }
}

function detectAuthFailure(text: string): boolean {
  if (!text || text.length > 2_000) return false; // auth errors are short
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(text));
}

/**
 * The static `claude -p` argv shared by both spawn paths (runClaudeDirect + the
 * tmux launcher, which forwards it verbatim), built from the tool set above.
 * Extracted + exported so the regression test (src/board-tools.test.ts) can
 * assert `mcp__devpilot-board__devpilot_move_ticket` is FORCE-loaded via `--tools`, not
 * merely auto-approved via `--allowedTools` — the exact regression behind three
 * false "fixed" claims.
 *
 * `--tools` vs `--allowedTools` — we pass BOTH, deliberately:
 *   • `--tools` controls which tools are LOADED (directly callable).
 *   • `--allowedTools` controls auto-approval (no permission prompt).
 * claude 2.1.207 (2026-07-10) started DEFERRING MCP tools by default: their
 * schemas aren't loaded up front and require a `ToolSearch` call before they
 * can be called. `--allowedTools` alone only grants PERMISSION — it does NOT
 * force a tool to be loaded, so on 2.1.207 the devpilot-board tools landed DEFERRED,
 * agents' `ToolSearch` attempts didn't surface them, and every producer/QA/
 * verifier run reported "devpilot_* not in this session's tool registry" — unable to
 * `devpilot_move_ticket`, so tickets looped forever in in_review while the reconciler
 * re-dispatched endlessly. `--tools` with the explicit list forces the devpilot-board
 * tools to be DIRECTLY loaded (verified: the same probe reports devpilot_move_ticket
 * as DIRECT with `--tools`, DEFERRED without). We hand the identical set to both
 * flags so every board tool is loaded AND pre-approved.
 */
export function buildClaudeBaseArgs(
  model?: string | null,
  /**
   * Which MCP config to load. Defaults to the shared one written at module load
   * (unchanged behaviour for every existing caller); a ticket step passes a
   * per-step config whose @playwright/mcp `--output-dir` is unique to that step,
   * which is what makes a captured screenshot attributable. See
   * `writeStepMcpConfig`.
   */
  mcpConfigPath: string = MCP_CONFIG_PATH,
  /**
   * Which tool set to force-load and auto-approve. Defaults to the full agent
   * surface, so every existing caller is unchanged; the empty-delivery commit
   * nudge narrows it (see `COMMIT_NUDGE_TOOLS_CSV`).
   */
  toolsCsv: string = AGENT_TOOLS_CSV,
): string[] {
  return [
    "-p",
    "--output-format=stream-json",
    "--verbose",
    "--permission-mode=acceptEdits",
    // Expose DevPilot's board tools (devpilot_comment, devpilot_move_ticket, devpilot_request_human)
    // to the model via the stdio MCP relay at apps/runner/src/mcp/server.ts.
    "--mcp-config",
    mcpConfigPath,
    "--tools",
    toolsCsv,
    "--allowedTools",
    toolsCsv,
    // WI-12 — `--model` ONLY when the engine pinned one. Absent for every project
    // that hasn't opted in, which is what preserves today's account-default
    // behaviour. See model-args.ts.
    ...modelArgs(model),
  ];
}

/**
 * Run `claude -p` and return the structured result. Currently uses
 * --output-format=stream-json --verbose: each line is a JSON event. We collect
 * the `result` event (terminal) which carries the final text + usage.
 *
 * Phase 0 keeps the tool surface small and read-only by default.
 */
export async function runClaude(input: ClaudeRunInput): Promise<ClaudeRunOutput> {
  try {
    return await spawnClaude(input, input.model ?? null);
  } catch (err) {
    // SAFE FALLBACK (WI-12), half 2 of 2. A model the engine recognises can still
    // be unavailable on THIS operator's subscription (Opus on a Pro plan) — only
    // `claude` finds that out, at spawn time. Retry once on the account default
    // rather than failing the ticket over a config choice we can silently survive.
    //
    // Ordering matters: a ClaudeAuthError means the account can't run ANY model,
    // so retrying without `--model` would just buy a second identical failure and
    // rob the circuit breaker of a count. Those rethrow untouched.
    const pinned = (input.model ?? "").trim();
    if (pinned.length === 0) throw err;
    if (err instanceof ClaudeAuthError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (!isModelUnavailableError(message)) throw err;

    console.warn(
      `[devpilot-runner] model "${pinned}" is not available on this subscription ` +
        `(${message.slice(0, 160)}). Retrying on the account default — fix the project's ` +
        `LLM model setting to silence this.`,
    );
    return spawnClaude(input, null);
  }
}

/** One `claude -p` attempt with an explicitly chosen model (or none). Split out of
 *  runClaude so the availability fallback above can re-enter it with `null`. */
async function spawnClaude(input: ClaudeRunInput, model: string | null): Promise<ClaudeRunOutput> {
  const args = buildClaudeBaseArgs(
    model,
    input.mcpConfigPath ?? MCP_CONFIG_PATH,
    input.toolsCsv ?? AGENT_TOOLS_CSV,
  );
  if (input.systemPrompt) {
    args.push("--system-prompt", input.systemPrompt);
  }

  // The Local CC Runner is the SUBSCRIPTION path — by definition. If
  // ANTHROPIC_API_KEY leaks through to `claude -p`, claude-code silently
  // switches to API (pay-per-token) mode and ignores the subscription token,
  // because API key takes precedence over the stored OAuth credentials. We
  // delete it explicitly so this path can never accidentally bill against
  // an API account. (Real incident: Wave 3 M6 acceptance, 2026-06-02.)
  const procEnv: NodeJS.ProcessEnv = { ...process.env };
  delete procEnv.ANTHROPIC_API_KEY;
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    procEnv.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  // Phase 1 / M10 — propagate DEVPILOT_RUN_ID / DEVPILOT_TENANT_ID (and anything else
  // the caller pinned) into the claude child. The MCP relay inherits these
  // and uses them to scope `devpilot_query_db` calls to the current run.
  //
  // WI-12 — SANITIZED FIRST. envOverrides is spread LAST, so it WINS over the
  // strip four lines up: an override named ANTHROPIC_API_KEY would put the key
  // straight back and move the tenant onto per-token billing, and one named
  // ANTHROPIC_BASE_URL would redirect the agent's whole conversation to a host of
  // the writer's choosing. Overrides are DB-sourced (the per-project vault, the
  // engine-fetched tenant config) and therefore untrusted; the host's own env is
  // the operator's and stays untouched. This is the spawn-site half of the filter
  // — index.ts also filters at composition, and BOTH are deliberate: this one is
  // what holds when someone adds a third caller.
  const overrides = sanitizeSubscriptionEnvOverrides(input.envOverrides ?? {});
  for (const [k, v] of Object.entries(overrides)) {
    procEnv[k] = v;
  }

  // Install bundled read-only subagent definitions into the workspace so the
  // parent step can use the Task tool to fan out exploration/research in
  // parallel. Non-fatal if it fails (see agents-bundle.ts). Only when we
  // have a workspace cwd — non-engineer steps that inherit the runner's cwd
  // shouldn't pollute it.
  if (input.cwd) {
    await installSubagentsIntoWorkspace(input.cwd);
  }

  // Track 2 — try the tmux-wrapped path first when the runner is configured
  // for it AND tmux is installed AND we have a real runId to name the session
  // after (a null runId is the caller explicitly opting out — used by smoke
  // tests / future ad-hoc paths). On any opt-out we fall through to the
  // legacy direct-spawn path below; behaviour there is byte-for-byte the
  // pre-Track-2 implementation so nothing downstream regresses.
  const tmuxOptedOut = input.runId === null;
  if (env.HEADLESS_TMUX_ENABLED && !tmuxOptedOut) {
    try {
      if (await isTmuxAvailable()) {
        return await runClaudeInTmux({
          args,
          procEnv,
          prompt: input.prompt,
          cwd: input.cwd,
          runId: input.runId ?? `adhoc-${Date.now().toString(36)}`,
          envOverrides: overrides,
          onTmuxSession: input.onTmuxSession,
        });
      }
    } catch (err) {
      // Only TmuxUnavailableError is recoverable as a fallback — every other
      // failure (FIFO open errors, etc.) is a real runner-host problem and
      // should fail loud rather than silently drop to a non-attachable spawn.
      if (!(err instanceof TmuxUnavailableError)) throw err;
    }
  }

  return runClaudeDirect({
    args,
    procEnv,
    prompt: input.prompt,
    cwd: input.cwd,
    runId: input.runId,
  });
}

// ---------------------------------------------------------------------------
// Cancellation — terminate a wedged `claude -p` step by runId.
//
// The engine gives up on a local-cc step after a timeout: run-agent.ts (ticket
// runs) and the plan-mode runner-bridge both LPUSH `{runId}` onto
// `devpilot:jobs:local-cc:cancel`. The runner's cancel consumer (index.ts →
// cancelLoop) drains that queue and calls cancelClaudeRun so the subprocess
// stops chewing the operator's subscription rate-limit instead of running to
// its own unseen completion. Two spawn paths → two kill mechanisms:
//   • tmux-wrapped (default): the run is tracked in tmux-session.ts by runId;
//     killHeadlessRunSession tears down the whole pane process tree.
//   • direct fallback (no tmux): we track the ChildProcess here and deliver
//     SIGTERM→SIGKILL. Killing `claude` stops the LLM calls; its short-lived
//     helper children (MCP relay, bash tools) exit when their parent/stdin goes.
// ---------------------------------------------------------------------------

/** In-flight DIRECT-spawn `claude` children keyed by runId. Only the no-tmux
 *  fallback needs this — the tmux path is tracked in tmux-session.ts. */
const inFlightDirect = new Map<string, ChildProcess>();

/** Grace between SIGTERM and SIGKILL for a cancelled direct-spawn child.
 *  Mirrors the escalation in tools/run-command.ts. */
const CANCEL_GRACE_MS = 5_000;

function sigtermThenKill(child: ChildProcess): void {
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  try {
    child.kill("SIGTERM");
  } catch {
    // already exited
  }
  const t = setTimeout(() => {
    if (exited) return; // died on SIGTERM — don't risk signalling a reused pid
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, CANCEL_GRACE_MS);
  t.unref?.();
}

/**
 * Terminate the in-flight `claude -p` step for `runId`, across both spawn
 * paths. Returns true when a matching in-flight run was found and signalled;
 * false is the common benign case where the step already finished (or ran on a
 * different runner) between the engine enqueuing the cancel and us draining it.
 */
export async function cancelClaudeRun(runId: string): Promise<boolean> {
  let killed = false;
  // tmux path first (the default) — cleanly tears down the whole pane tree.
  if (await killHeadlessRunSession(runId)) killed = true;
  // direct-spawn fallback.
  const child = inFlightDirect.get(runId);
  if (child) {
    inFlightDirect.delete(runId);
    sigtermThenKill(child);
    killed = true;
  }
  return killed;
}

// ---------------------------------------------------------------------------
// Direct-spawn path — the original (pre-Track-2) implementation, kept verbatim
// as the fallback for hosts without tmux installed. Anything that changes the
// stdout/stderr/exit-code contract here MUST also change runClaudeInTmux below
// or operators on the two paths will see different results for the same run.
// ---------------------------------------------------------------------------

function runClaudeDirect(args: {
  args: string[];
  procEnv: NodeJS.ProcessEnv;
  prompt: string;
  cwd?: string;
  runId?: string | null;
}): Promise<ClaudeRunOutput> {
  return new Promise<ClaudeRunOutput>((resolve, reject) => {
    const child = spawn("claude", args.args, {
      env: args.procEnv,
      stdio: ["pipe", "pipe", "pipe"],
      ...(args.cwd ? { cwd: args.cwd } : {}),
    });

    // Register so the cancel consumer (cancelClaudeRun) can SIGTERM→SIGKILL a
    // wedged step. Deregistered on close/error so the map only holds live
    // children — a cancel after normal completion is then a benign no-op.
    const runId = args.runId ?? null;
    if (runId) inFlightDirect.set(runId, child);
    const deregister = () => {
      if (runId) inFlightDirect.delete(runId);
    };

    const parser = makeStreamParser();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      parser.feedStdoutChunk(chunk);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      parser.feedStderr(chunk);
    });

    child.on("error", (err) => {
      deregister();
      reject(err);
    });
    child.on("close", (code) => {
      deregister();
      const settled = parser.settle(code);
      if (settled.kind === "ok") return resolve(settled.value);
      return reject(settled.error);
    });

    // Feed the user prompt over stdin so we don't run into shell escaping.
    child.stdin.write(args.prompt);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Tmux-wrapped path — Track 2. Same stream-parsing logic as the direct path
// but the bytes arrive via FIFOs piped out of a named tmux pane. The pane is
// kept alive briefly on crash (HEADLESS_TMUX_LINGER_MS) so operators can
// attach for post-mortem; clean exits tear the session down immediately.
// ---------------------------------------------------------------------------

async function runClaudeInTmux(args: {
  args: string[];
  procEnv: NodeJS.ProcessEnv;
  prompt: string;
  cwd?: string;
  runId: string;
  envOverrides?: Record<string, string>;
  onTmuxSession?: (tmuxSession: string) => void;
}): Promise<ClaudeRunOutput> {
  // Snapshot the env we'd hand the direct spawn into a key/value map the
  // launcher script can `export`. We deliberately use the strict envOverrides
  // (caller-controlled) instead of the full procEnv: process.env is already
  // inherited by the launcher's shell, so re-exporting it would only inflate
  // the launcher size + leak unrelated vars into `set` output. Strip the OAuth
  // token from envOverrides too — the launcher already handles it explicitly
  // from env.CLAUDE_CODE_OAUTH_TOKEN to keep a single secrets path.
  //
  // WI-12 — the subscription-only guarantee is now the shared blocklist rather
  // than one hardcoded name, so the two spawn paths can't drift: every credential
  // or endpoint override that must not reach the direct spawn must not reach the
  // tmux pane either. (The caller already sanitized, but this path exports into a
  // shell script — the belt is cheap and the braces are the ones that matter.)
  const launcherEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(sanitizeSubscriptionEnvOverrides(args.envOverrides ?? {}))) {
    if (k === "CLAUDE_CODE_OAUTH_TOKEN") continue; // launcher injects this itself
    launcherEnv[k] = v;
  }

  // The tmux launcher cd's somewhere before exec'ing claude. Direct-spawn
  // path inherits the runner's cwd when args.cwd is unset, so do the same
  // here for parity (process.cwd() at the moment we'd spawn).
  const cwd = args.cwd ?? process.cwd();

  let handle: HeadlessRunHandle;
  try {
    handle = await startHeadlessRunInTmux({
      runId: args.runId,
      prompt: args.prompt,
      claudeArgs: args.args,
      cwd,
      envOverrides: launcherEnv,
    });
  } catch (err) {
    // Let the caller decide whether to fall back (TmuxUnavailableError) or
    // surface (any other failure starting the pane).
    throw err;
  }

  // Surface the session name BEFORE attaching readers so the runner loop's
  // next heartbeat carries it even if claude exits very fast.
  try {
    args.onTmuxSession?.(handle.tmuxSession);
  } catch {
    // never let a notification callback break a run
  }

  const parser = makeStreamParser();
  handle.onStdoutLine((line) => {
    // Re-add the trailing newline the direct-spawn path's feeder relied on
    // (it splits on '\n'). Easier than duplicating the buffer logic.
    parser.feedStdoutChunk(line + "\n");
  });
  handle.onStderrChunk((chunk) => {
    parser.feedStderr(chunk);
  });

  let exitCode: number | null = null;
  try {
    exitCode = await handle.waitForExit();
  } catch (err) {
    // waitForExit() doesn't throw today, but be defensive: kill the pane and
    // re-raise so the caller sees the real reason.
    await handle.killAndCleanup().catch(() => undefined);
    throw err;
  }

  const settled = parser.settle(exitCode ?? null);

  // Linger the tmux session on BOTH clean exit and crash. The original Track 2
  // design only kept crashed panes around — but operators frequently want to
  // peek at a successful panel's scrollback (e.g. "what reasoning did PM use
  // to settle on this stack?") and the current UI's "Open terminal" button
  // dispatches the click async — by the time the panel pane renders and
  // EventSource opens, a fast 30s run could already be reaped if we tore it
  // down at exit. The linger window is small (default 5min) so memory cost is
  // bounded; FIFO file descriptors get released when the launcher's last
  // process exits regardless. Reaping logic is identical to crash path; only
  // the gate changed (now applies to ok too).
  const lingerMs = env.HEADLESS_TMUX_LINGER_MS;
  if (lingerMs > 0) {
    const t = setTimeout(() => {
      handle.killAndCleanup().catch(() => undefined);
    }, lingerMs);
    t.unref?.();
  } else {
    await handle.killAndCleanup().catch(() => undefined);
  }

  if (settled.kind === "ok") return settled.value;
  throw settled.error;
}

// ---------------------------------------------------------------------------
// Shared stream-parser core
// ---------------------------------------------------------------------------
//
// Both the direct-spawn and tmux paths feed the same JSON event stream into
// this helper. It collects the terminal `result` event (text + usage + model),
// accumulates assistant text as a fallback, surfaces Task (subagent)
// invocations to the runner console, buffers stderr, and converts the final
// (text, exit_code) into either a typed ClaudeRunOutput or an error that
// downstream code expects (auth-failure short-circuit, generic non-zero,
// classifier mismatch). Keeping the parser pathway-agnostic guarantees the
// tmux wrapper is byte-for-byte equivalent to the legacy direct spawn — the
// engine and tracing layer can't tell the difference.

type ParserSettlement = { kind: "ok"; value: ClaudeRunOutput } | { kind: "err"; error: Error };

function makeStreamParser(): {
  feedStdoutChunk: (chunk: string) => void;
  feedStderr: (chunk: string) => void;
  settle: (exitCode: number | null) => ParserSettlement;
} {
  let stdoutBuf = "";
  let stderrBuf = "";
  let lastResult: ClaudeRunOutput | null = null;
  let lastAssistantText = "";

  const handleLine = (line: string): void => {
    if (!line) return;
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      // The terminal `result` event has the final answer + usage.
      if (ev.type === "result") {
        const usage = (ev as { usage?: Record<string, number> }).usage;
        const total = (ev as { total_cost_usd?: number }).total_cost_usd;
        lastResult = {
          text: typeof ev.result === "string" ? ev.result : lastAssistantText,
          usage: usage
            ? {
                promptTokens: Number(usage.input_tokens ?? 0),
                completionTokens: Number(usage.output_tokens ?? 0),
                totalTokens: Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0),
              }
            : undefined,
          modelId: typeof ev.model === "string" ? ev.model : undefined,
          finishReason: typeof ev.subtype === "string" ? ev.subtype : undefined,
        };
        // Surface cost in process logs so dev can sanity-check spend.
        if (total != null) console.log(`[devpilot-runner] claude reports usd=${total}`);
      } else if (ev.type === "assistant") {
        // Accumulate assistant text in case `result` doesn't carry it.
        // Also surface Task (subagent) invocations to the process log so
        // operators can see intra-step fan-out — until Langfuse child
        // spans are wired, this is our only visibility.
        const message = (ev as { message?: { content?: unknown[] } }).message;
        const parts = Array.isArray(message?.content) ? message.content : [];
        for (const p of parts) {
          if (
            typeof p === "object" &&
            p &&
            (p as { type?: string }).type === "text" &&
            typeof (p as { text?: unknown }).text === "string"
          ) {
            lastAssistantText += (p as { text: string }).text;
          } else if (
            typeof p === "object" &&
            p &&
            (p as { type?: string }).type === "tool_use" &&
            (p as { name?: string }).name === "Task"
          ) {
            const toolInput = (p as { input?: Record<string, unknown> }).input ?? {};
            const subagent =
              typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : "?";
            const desc = typeof toolInput.description === "string" ? toolInput.description : "";
            console.log(
              `[devpilot-runner] subagent invoke type=${subagent} desc="${desc.slice(0, 80)}"`,
            );
          }
        }
      }
    } catch {
      // Non-JSON lines (warnings, etc) — ignore.
    }
  };

  return {
    feedStdoutChunk(chunk) {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLine(line);
      }
    },
    feedStderr(chunk) {
      stderrBuf += chunk;
    },
    settle(code) {
      // Drain any unterminated trailing line (no \n).
      if (stdoutBuf.length > 0) {
        const tail = stdoutBuf.trim();
        stdoutBuf = "";
        handleLine(tail);
      }
      if (code !== 0 && code !== null && !lastResult) {
        return {
          kind: "err",
          error: new Error(`claude -p exited ${code}: ${stderrBuf.slice(0, 800)}`),
        };
      }
      if (code === null && !lastResult) {
        return {
          kind: "err",
          error: new Error(
            `claude -p tmux pane vanished before emitting a result: ${stderrBuf.slice(0, 800)}`,
          ),
        };
      }
      const finalText = lastResult?.text ?? lastAssistantText;
      // Auth/credit-failure detection — see AUTH_FAILURE_PATTERNS above.
      // `claude -p` returns these as the result body with exit 0, so we have
      // to read the text and convert to a hard failure ourselves.
      if (detectAuthFailure(finalText)) {
        return { kind: "err", error: new ClaudeAuthError(finalText) };
      }
      if (lastResult) return { kind: "ok", value: lastResult };
      return { kind: "ok", value: { text: finalText } };
    },
  };
}
