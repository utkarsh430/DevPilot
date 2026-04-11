// Worker env. Loaded via --env-file at dev/start time (see package.json scripts).

import { resolveWorkspaceRoot } from "./workspace-root.js";

/** Parse a boolean env flag. Default OFF: only an explicit truthy value enables
 *  it, so an unset/blank var is inert. Polarity matches the engine's
 *  isEngineerQaGateEnabled — a feature that changes agent-visible behaviour must
 *  never switch itself on during a rollout. */
function isEnvFlagOn(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[devpilot-runner] missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const engineerRepoUrl = process.env.ENGINEER_REPO_URL ?? "";
if (!engineerRepoUrl) {
  // Wave 1: workspace pathway is opt-in; warn rather than crash so existing
  // Phase 0 flows keep running. Wave 2 will hard-require this for engineer roles.
  console.warn(
    "[devpilot-runner] ENGINEER_REPO_URL is unset — git workspace prepareWorkspace() " +
      "calls will fail unless a repoUrl is passed explicitly.",
  );
}

export const env = {
  UPSTASH_REDIS_REST_URL: required("UPSTASH_REDIS_REST_URL"),
  UPSTASH_REDIS_REST_TOKEN: required("UPSTASH_REDIS_REST_TOKEN"),
  REGISTRATION_KEY: required("DEVPILOT_RUNNER_REGISTRATION_KEY"),
  ENGINE_URL: process.env.LOCAL_CC_ENGINE_URL ?? "http://localhost:3000",
  CONCURRENCY: Number(process.env.LOCAL_CC_CONCURRENCY ?? "2"),
  TENANT_ID: required("DEVPILOT_RUNNER_TENANT_ID"),
  NAME: process.env.DEVPILOT_RUNNER_NAME ?? `local-cc-${process.platform}-${process.pid}`,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
  // Phase 1 / M0 — engineer git workspace lifecycle. Wave 1 introduces the
  // primitives; Wave 2 wires them into the job lifecycle.
  ENGINEER_REPO_URL: engineerRepoUrl,
  ENGINEER_QA_COMMAND: process.env.ENGINEER_QA_COMMAND ?? "pnpm test",
  // L1 (ticket-speed audit) — separate build check the runner executes
  // alongside ENGINEER_QA_COMMAND after a producer role's step. Unlike QA_COMMAND
  // this defaults to *unset* (no build check) rather than a guessed command —
  // there's no repo-agnostic convention as safe a default as `pnpm test`, and a
  // wrong guess would fail every producer run. Not yet exposed in the web
  // platform-secrets catalog (apps/web/lib/platform-secrets/catalog.ts only
  // lists ENGINEER_QA_COMMAND) — set it as a plain runner env var for now; it
  // is documented alongside ENGINEER_QA_COMMAND in `.env.example`.
  ENGINEER_BUILD_COMMAND: process.env.ENGINEER_BUILD_COMMAND ?? "",
  // L1 (ticket-speed audit) — runner-side recording switch for the two
  // verification hooks (index.ts hook (ii) + mcp/server.ts hook (i)). Default
  // OFF: an unset var records nothing, so merging this half leaves runner
  // behaviour byte-for-byte unchanged. Flipping it to 1 (shadow mode) makes the
  // runner run ENGINEER_QA_COMMAND(+BUILD) after a producer step and POST the
  // outcome; the engine's own ENGINEER_QA_GATE_ENABLED then decides whether to
  // enforce it. Two independent flags, both default off — see AGENTS.md's L1
  // note. Deliberately decoupled from ENGINEER_QA_COMMAND, which stays load-
  // bearing for the QA role's own `devpilot_run_command` even when recording is off.
  ENGINEER_QA_VERIFY_ENABLED: isEnvFlagOn(process.env.ENGINEER_QA_VERIFY_ENABLED),
  WORKSPACE_ROOT: resolveWorkspaceRoot(process.env.WORKSPACE_ROOT),
  // Phase 2 / M5e — dev-server launcher knobs. PORT_START is the lower
  // bound for the port-probe; the launcher walks upward skipping
  // well-known ports. DEVPILOT_DEV_SERVER_MAX caps the number of concurrent
  // dev servers per runner host so a misbehaving project can't fork-bomb
  // the operator's laptop.
  DEVPILOT_DEV_SERVER_PORT_START: Number(process.env.DEVPILOT_DEV_SERVER_PORT_START ?? "3100"),
  DEVPILOT_DEV_SERVER_MAX: Number(process.env.DEVPILOT_DEV_SERVER_MAX ?? "4"),
  // "Take the wheel" — on-demand interactive Claude takeover (runner-side).
  // When a human grabs a running ticket, the engine LPUSHes an `open` control
  // message and the runner opens an interactive `claude --continue
  // --dangerously-skip-permissions` session in a tmux pane, surfaced via a
  // macOS terminal. Skip-permissions is acceptable here ONLY because a human is
  // attached and watching — their presence is the approval gate (CLAUDE.md §6).
  // Default-on but inert until a human clicks the button; a no-op when tmux is
  // not installed. Never reached on the API/multi-tenant runner path.
  TAKEOVER_ENABLED: (process.env.LOCAL_CC_TAKEOVER_ENABLED ?? "true") !== "false",
  // How long the interactive pane lingers (attachable) after control is
  // released before the runner kills it. "Not immediately" — long enough to
  // read the final state. Failed/stuck sessions are kept open regardless.
  TMUX_CLOSE_DELAY_MS: Number(process.env.LOCAL_CC_TMUX_CLOSE_DELAY_MS ?? "60000"),
  // macOS GUI terminal used to surface the tmux session. "Terminal" (default)
  // or "iTerm". Anything else falls back to leaving the detached tmux session
  // for the operator to `tmux attach` manually.
  TERMINAL_APP: process.env.LOCAL_CC_TERMINAL_APP ?? "Terminal",
  // Track 2 — wrap every headless `claude -p` agent run inside a named tmux
  // session (`devpilot-run-<runId>`) so operators can `tmux attach` mid-run. Default
  // on; opt-out via LOCAL_CC_HEADLESS_TMUX_ENABLED=false (or automatically when
  // tmux isn't installed — see TmuxUnavailableError fallback in claude.ts).
  HEADLESS_TMUX_ENABLED: (process.env.LOCAL_CC_HEADLESS_TMUX_ENABLED ?? "true") !== "false",
  // How long a CRASHED headless tmux session lingers (attachable) after
  // claude exits non-zero, so operators can attach for post-mortem before
  // the runner reaps it. Clean exits are killed immediately. Default 5 min.
  HEADLESS_TMUX_LINGER_MS: Number(process.env.LOCAL_CC_HEADLESS_TMUX_LINGER_MS ?? "300000"),
};
