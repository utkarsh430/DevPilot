// "Take the wheel" — interactive Claude takeover session (runner-side).
//
// When a human grabs a running ticket, the engine LPUSHes an `open` control
// message (see takeover-loop.ts) and we open an INTERACTIVE `claude` session
// inside a tmux pane, running in that ticket's git workspace, and surface it
// in a macOS terminal (Terminal.app/iTerm) so the operator can attach and type.
//
// Why tmux: it gives a single, named, reap-able, re-attachable session per run
// that survives the operator closing/reopening the terminal window and lets the
// runner kill it cleanly by name (mirrors the dev-server lifecycle in
// dev-server.ts). Why a launcher script: the OAuth token + DEVPILOT_* env are written
// to a 0700 temp file and exec'd, so secrets never appear in `ps`/tmux's command
// listing — same spirit as the runtime MCP config in claude.ts.
//
// Security: the session runs `--dangerously-skip-permissions`. That is acceptable
// HERE and ONLY here because a human is attached and watching in real time — their
// presence is the approval gate (CLAUDE.md §6). The headless `-p` path keeps its
// `--permission-mode=acceptEdits` posture; this module is never reached on the
// API/multi-tenant runner.

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { env } from "./env.js";
import { openFifoReadStream } from "./fifo-reader.js";
import { AGENT_TOOLS_CSV, MCP_CONFIG_PATH } from "./claude.js";

const execFileP = promisify(execFile);

// Where Claude Code persists per-session transcripts. The project dir is the
// absolute cwd with every non-alphanumeric char replaced by '-'. Verified
// against the installed CLI (v2.1.175) and on-disk layout.
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export function claudeProjectDirFor(workspacePath: string): string {
  const slug = workspacePath.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(CLAUDE_PROJECTS_DIR, slug);
}

/** True when the workspace already has at least one Claude session transcript,
 *  meaning `claude --continue` has a conversation to resume. */
async function hasPriorSession(workspacePath: string): Promise<boolean> {
  try {
    const dir = claudeProjectDirFor(workspacePath);
    const entries = await fs.readdir(dir);
    return entries.some((f) => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

// ---- tmux availability (probed once) -------------------------------------

let tmuxAvailable: boolean | null = null;
export async function isTmuxAvailable(): Promise<boolean> {
  if (tmuxAvailable !== null) return tmuxAvailable;
  try {
    await execFileP("tmux", ["-V"]);
    tmuxAvailable = true;
  } catch {
    tmuxAvailable = false;
  }
  return tmuxAvailable;
}

// ---- session registry -----------------------------------------------------

type TakeoverSession = {
  runId: string;
  ticketId: string | null;
  tmuxSession: string;
  workspacePath: string;
  launcherPath: string;
};

const TRACKED: Map<string, TakeoverSession> = new Map();

export function activeTakeoverRunIds(): string[] {
  return Array.from(TRACKED.keys());
}

// tmux session names cannot contain '.' or ':'. Derive a short, safe, unique
// name from the runId (a uuid). Prefix distinguishes the two parallel session
// flavours so an operator scanning `tmux ls` can tell them apart at a glance:
//   devpilot-tko-<id>   → "Take the wheel" interactive session (skip-permissions)
//   devpilot-run-<id>   → Headless agent run wrapper (acceptEdits)
function tmuxSessionName(runId: string): string {
  return `devpilot-tko-${runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}`;
}

/** Headless-run tmux session name. Track 2 — every `claude -p` agent step
 *  spawns inside a named tmux pane so operators can `tmux attach -t <name>`
 *  mid-run to see what the agent is doing without needing the takeover UI. */
export function headlessRunSessionName(runId: string): string {
  return `devpilot-run-${runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}`;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---- open -----------------------------------------------------------------

export type OpenTakeoverInput = {
  runId: string;
  ticketId?: string | null;
  tenantId: string;
  role?: string | null;
  workspacePath: string;
};

export class TmuxUnavailableError extends Error {
  constructor() {
    super("tmux is not installed — `brew install tmux` to enable take-the-wheel");
    this.name = "TmuxUnavailableError";
  }
}

/**
 * Open (or re-open) the interactive takeover session for a run. Writes a 0700
 * launcher script, starts a detached tmux session running it in the workspace,
 * and surfaces the session in the configured macOS terminal. Idempotent: if a
 * session for this run already exists we just (re)surface it.
 *
 * Returns the tmux session name + the suggested attach command. Throws
 * TmuxUnavailableError when tmux is missing so the caller can post a friendly
 * breadcrumb without crashing the loop.
 */
export async function openTakeoverSession(
  input: OpenTakeoverInput,
): Promise<{ tmuxSession: string; attachCommand: string }> {
  if (!(await isTmuxAvailable())) throw new TmuxUnavailableError();

  const existing = TRACKED.get(input.runId);
  if (existing) {
    // Re-open requested (e.g. the operator closed the window). Re-surface the
    // still-living session. (The control loop owns/cancels any pending
    // auto-close timer.)
    await surfaceInTerminal(existing.tmuxSession);
    return {
      tmuxSession: existing.tmuxSession,
      attachCommand: `tmux attach -t ${existing.tmuxSession}`,
    };
  }

  const sess = tmuxSessionName(input.runId);
  const launcherPath = path.join(os.tmpdir(), `devpilot-takeover-${sess}.sh`);

  // Resolve to an ABSOLUTE path. The control loop derives this from
  // WORKSPACE_ROOT; a relative value (e.g. a misconfigured/empty root) would
  // otherwise be applied twice — once as tmux's `-c` start-dir and again by the
  // launcher's `cd` — descending into <ws>/<ws>, failing, and silently killing
  // the pane. Absolutizing makes both no-ops against the same dir.
  const workspacePath = path.resolve(input.workspacePath);

  const resume = (await hasPriorSession(workspacePath)) ? "--continue " : "";
  // The agent/human signals "done" by moving the ticket via the devpilot-board MCP
  // tools, which --mcp-config wires in. --dangerously-skip-permissions makes
  // every tool (incl. those MCP tools) run without a prompt. `--tools` forces
  // those MCP tools to load DIRECTLY — without it, claude 2.1.207+ defers them
  // and even an attached operator can't call devpilot_move_ticket (see claude.ts).
  const claudeCmd =
    `exec claude ${resume}--dangerously-skip-permissions ` +
    `--mcp-config ${shq(MCP_CONFIG_PATH)} ` +
    `--tools ${shq(AGENT_TOOLS_CSV)}`;

  // Launcher script: strip ANTHROPIC_API_KEY (subscription-mode guarantee —
  // see claude.ts), pin DEVPILOT_* so the MCP relay scopes devpilot_query_db to this run,
  // cd into the workspace, then exec claude. 0700 so the token line is private.
  const lines = [
    "#!/bin/sh",
    "unset ANTHROPIC_API_KEY",
    `export DEVPILOT_RUN_ID=${shq(input.runId)}`,
    `export DEVPILOT_TENANT_ID=${shq(input.tenantId)}`,
  ];
  if (input.role) lines.push(`export DEVPILOT_ROLE=${shq(input.role)}`);
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    lines.push(`export CLAUDE_CODE_OAUTH_TOKEN=${shq(env.CLAUDE_CODE_OAUTH_TOKEN)}`);
  }
  // On a missing workspace, keep the pane up briefly so the operator can SEE
  // the error instead of a window that flashes and vanishes.
  lines.push(
    `cd ${shq(workspacePath)} || { echo "DevPilot takeover: workspace not found at ${workspacePath}"; sleep 10; exit 1; }`,
  );
  lines.push(
    `echo '── DevPilot: you have the wheel · run ${input.runId} · move the ticket (or close this window) when done ──'`,
  );
  lines.push(claudeCmd);
  await fs.writeFile(launcherPath, lines.join("\n") + "\n", { mode: 0o700 });

  // Start the detached session. `-c` sets the pane start dir; the launcher also
  // cd's as a belt-and-suspenders. If a stale session with this name exists
  // (runner restarted), kill it first so we don't error on duplicate.
  await killTmuxSession(sess);
  await execFileP("tmux", ["new-session", "-d", "-s", sess, "-c", workspacePath, launcherPath]);

  TRACKED.set(input.runId, {
    runId: input.runId,
    ticketId: input.ticketId ?? null,
    tmuxSession: sess,
    workspacePath,
    launcherPath,
  });

  await surfaceInTerminal(sess);

  return { tmuxSession: sess, attachCommand: `tmux attach -t ${sess}` };
}

// ---- surface in a GUI terminal -------------------------------------------

async function surfaceInTerminal(sess: string): Promise<void> {
  const attach = `tmux attach -t ${sess}`;
  const app = env.TERMINAL_APP;
  try {
    if (app === "Terminal") {
      await execFileP("osascript", [
        "-e",
        'tell application "Terminal"',
        "-e",
        `  do script "${attach}"`,
        "-e",
        "  activate",
        "-e",
        "end tell",
      ]);
    } else if (app === "iTerm" || app === "iTerm2") {
      await execFileP("osascript", [
        "-e",
        'tell application "iTerm"',
        "-e",
        "  create window with default profile",
        "-e",
        `  tell current session of current window to write text "${attach}"`,
        "-e",
        "  activate",
        "-e",
        "end tell",
      ]);
    } else {
      // Unknown terminal app — leave the detached session for manual attach.
      console.log(`[devpilot-runner] takeover session ready — attach with: ${attach}`);
    }
  } catch (err) {
    // Surfacing is best-effort; the detached session still exists and the
    // operator can attach manually. Never let an AppleScript hiccup fail the
    // takeover.
    console.warn(
      `[devpilot-runner] could not open ${app} for takeover (attach manually: ${attach}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---- close / reap ---------------------------------------------------------

/** Immediately kill the takeover session for one run and clean up its launcher.
 *  The control loop schedules this after the configured close-delay so the pane
 *  stays attachable for a while after control is released ("not immediately"). */
export async function killTakeoverSession(runId: string): Promise<void> {
  const s = TRACKED.get(runId);
  if (!s) return;
  TRACKED.delete(runId);
  await killTmuxSession(s.tmuxSession);
  try {
    await fs.unlink(s.launcherPath);
  } catch {
    // best-effort
  }
}

/** Kill all takeover sessions immediately — called from the SIGTERM/SIGINT
 *  shutdown hook in index.ts, alongside killAllDevServers(). */
export async function killAllTakeoverSessions(): Promise<void> {
  const ids = Array.from(TRACKED.keys());
  await Promise.all(ids.map((id) => killTakeoverSession(id).catch(() => undefined)));
}

async function killTmuxSession(sess: string): Promise<void> {
  try {
    await execFileP("tmux", ["kill-session", "-t", sess]);
  } catch {
    // Session may not exist (already gone / never started) — ignore.
  }
}

// ---- synchronous best-effort reap (for process 'exit') --------------------

/** Best-effort synchronous kill of every tracked tmux session. Node's 'exit'
 *  event can't await async work, so we shell out synchronously. Used as a
 *  last-resort net so we never strand a detached session. */
export function killAllTakeoverSessionsSync(): void {
  for (const s of TRACKED.values()) {
    try {
      fsSync.rmSync(s.launcherPath, { force: true });
    } catch {
      // ignore
    }
    try {
      // spawnSync-free: use a detached spawn that we don't await. Cheap and
      // fire-and-forget; the kernel reaps it.
      spawn("tmux", ["kill-session", "-t", s.tmuxSession], {
        stdio: "ignore",
        detached: true,
      }).unref();
    } catch {
      // ignore
    }
  }
  TRACKED.clear();
  // Also reap headless-run sessions on hard-exit so we don't strand the
  // wrapper panes either (Track 2). Same fire-and-forget pattern.
  for (const s of HEADLESS_TRACKED.values()) {
    try {
      fsSync.rmSync(s.launcherPath, { force: true });
    } catch {
      // ignore
    }
    try {
      fsSync.rmSync(s.promptPath, { force: true });
    } catch {
      // ignore
    }
    try {
      fsSync.rmSync(s.stdoutPath, { force: true });
    } catch {
      // ignore
    }
    try {
      fsSync.rmSync(s.stderrPath, { force: true });
    } catch {
      // ignore
    }
    try {
      fsSync.rmSync(s.exitPath, { force: true });
    } catch {
      // ignore
    }
    try {
      spawn("tmux", ["kill-session", "-t", s.tmuxSession], {
        stdio: "ignore",
        detached: true,
      }).unref();
    } catch {
      // ignore
    }
  }
  HEADLESS_TRACKED.clear();
}

// ===========================================================================
// Track 2 — Headless agent run wrapper
// ===========================================================================
//
// Goal: every `claude -p` agent step runs INSIDE a named, attachable tmux
// session by default so operators can `tmux attach -t devpilot-run-<id>` at any
// moment to watch what the agent is doing — without involving the takeover UI.
//
// The headless path is structurally different from takeover:
//   - The PROMPT is fed via stdin (not interactive typing).
//   - stdout is parsed as JSON line-by-line by the runner.
//   - stderr is buffered for non-zero-exit error messages.
//   - Exit code matters (auth/quota detection, retry decisions).
//
// To preserve all four channels through tmux we use a temp-dir of fifos:
//   <tmpdir>/devpilot-run-<sess>/prompt    → the prompt body (regular file)
//   <tmpdir>/devpilot-run-<sess>/out       → FIFO for claude stdout
//   <tmpdir>/devpilot-run-<sess>/err       → FIFO for claude stderr
//   <tmpdir>/devpilot-run-<sess>/exitcode  → written by the launcher after claude exits
//
// The launcher script (same 0700/exec-secrets trick as openTakeoverSession) cd's
// into the workspace and runs:
//   exec claude -p ... < prompt > out 2> err ; echo $? > exitcode
//
// The runner opens the FIFOs for reading from Node, parses stdout JSON exactly
// as before, polls the exitcode file for completion, and kills the tmux session
// on clean exit (or after a linger window on crash, so operators can attach
// post-mortem).
//
// Naming: devpilot-run-<runId-16char>. The session is registered in HEADLESS_TRACKED
// for shutdown reaping. The takeover and headless registries are disjoint
// (different prefixes, different lifecycles) so a takeover can co-exist with a
// headless wrapper for the same run — even though in practice the engine pauses
// the headless run before opening takeover.

type HeadlessSession = {
  runId: string;
  tmuxSession: string;
  workspacePath: string;
  launcherPath: string;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  exitPath: string;
  baseDir: string;
};

const HEADLESS_TRACKED: Map<string, HeadlessSession> = new Map();

export function activeHeadlessRunIds(): string[] {
  return Array.from(HEADLESS_TRACKED.keys());
}

export function getHeadlessSession(runId: string): { tmuxSession: string } | null {
  const s = HEADLESS_TRACKED.get(runId);
  return s ? { tmuxSession: s.tmuxSession } : null;
}

export type StartHeadlessRunInput = {
  runId: string;
  /** Prompt body fed to claude over stdin (verbatim — written to a temp file
   *  the launcher pipes in). */
  prompt: string;
  /** Argv to pass to `claude` inside the pane. The launcher runs
   *  `exec claude <args> < prompt > out 2> err`, so do NOT include `-p` /
   *  stdin redirection in this list — that's the launcher's job. */
  claudeArgs: string[];
  /** Working directory the pane cd's into before exec'ing claude. */
  cwd: string;
  /** Env vars to export inside the launcher. ANTHROPIC_API_KEY is always
   *  unset (subscription path). CLAUDE_CODE_OAUTH_TOKEN is exported if set
   *  on the runner. DEVPILOT_* etc. should be passed here. */
  envOverrides?: Record<string, string>;
};

export type HeadlessRunHandle = {
  tmuxSession: string;
  /** Resolves with the claude exit code (0+) on clean termination, or null
   *  if the pane was killed externally before the launcher wrote exitcode. */
  waitForExit(): Promise<number | null>;
  /** Subscribe to stdout lines. Each newline-terminated chunk is delivered
   *  as one string (trailing \n stripped). Called once per line. */
  onStdoutLine(handler: (line: string) => void): void;
  /** Subscribe to stderr chunks. Delivered as raw decoded strings (may
   *  contain partial lines — caller buffers if it cares). */
  onStderrChunk(handler: (chunk: string) => void): void;
  /** Immediate kill: tear down the tmux session + remove temp files.
   *  Returns once kill-session has been requested (best-effort). */
  killAndCleanup(): Promise<void>;
  /** Best-effort no-clean-up reap: kill the tmux pane but LEAVE the temp dir
   *  in place. Used when we want to keep the session around for a linger
   *  window without retaining the FIFOs (which are useless once the pane is
   *  dead). Mostly an internal helper exposed for symmetry. */
  killOnly(): Promise<void>;
};

/**
 * Spawn `claude` inside a named tmux session and return a handle that mirrors
 * the four stdio channels of a normal `child_process.spawn` call. The headless
 * caller (claude.ts) uses this in place of the direct spawn so every agent
 * step is attachable from the moment it starts.
 *
 * Throws TmuxUnavailableError when tmux is missing; the caller is expected to
 * fall back to direct spawn in that case so we don't break runners on hosts
 * without tmux installed.
 */
export async function startHeadlessRunInTmux(
  input: StartHeadlessRunInput,
): Promise<HeadlessRunHandle> {
  if (!(await isTmuxAvailable())) throw new TmuxUnavailableError();

  const sess = headlessRunSessionName(input.runId);
  // Each run gets its own temp dir so the four FIFOs/files don't collide with
  // other in-flight runs (LOCAL_CC_CONCURRENCY > 1) and a single rmdir tears
  // the whole thing down. mkdtemp() returns an absolute path on every OS.
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), `devpilot-run-${sess}-`));
  const launcherPath = path.join(baseDir, "launch.sh");
  const promptPath = path.join(baseDir, "prompt");
  const stdoutPath = path.join(baseDir, "out");
  const stderrPath = path.join(baseDir, "err");
  const exitPath = path.join(baseDir, "exitcode");

  // Resolve workspace path to absolute (same reason as openTakeoverSession).
  const workspacePath = path.resolve(input.cwd);

  // 1. Write the prompt body to a temp file. We feed it to claude via stdin
  //    redirection inside the launcher rather than `tmux send-keys` because
  //    keystroke-replay would corrupt non-ASCII / control chars and tmux has
  //    a per-message size cap.
  await fs.writeFile(promptPath, input.prompt, { mode: 0o600 });

  // 2. Create the stdout/stderr FIFOs. Using FIFOs (vs regular files) gives
  //    us back-pressure-aware streaming: the Node-side reader sees lines as
  //    they're written, not after claude flushes. mkfifo isn't in node:fs;
  //    shell out to mkfifo (a POSIX standard tool available wherever tmux is).
  await execFileP("mkfifo", [stdoutPath, stderrPath]);

  // 3. Build the launcher script. Same security posture as the takeover
  //    launcher: 0700 perms, OAuth token + DEVPILOT_* env never appear on `ps`
  //    or tmux's command listing because the script is exec'd and the env
  //    lines are inside the file, not the argv.
  //
  //    Shebang is /bin/bash (not /bin/sh) because we use ${PIPESTATUS[0]} to
  //    recover claude's exit code through the `tee` pipeline below. POSIX sh
  //    has no PIPESTATUS; bash ships on every macOS/Linux that ships tmux.
  const lines: string[] = ["#!/bin/bash", "unset ANTHROPIC_API_KEY"];
  for (const [k, v] of Object.entries(input.envOverrides ?? {})) {
    lines.push(`export ${k}=${shq(v)}`);
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN && !(input.envOverrides ?? {}).CLAUDE_CODE_OAUTH_TOKEN) {
    lines.push(`export CLAUDE_CODE_OAUTH_TOKEN=${shq(env.CLAUDE_CODE_OAUTH_TOKEN)}`);
  }
  lines.push(
    `cd ${shq(workspacePath)} || { echo "DevPilot headless: workspace not found at ${workspacePath}"; echo 127 > ${shq(exitPath)}; exit 127; }`,
  );
  // Operator hint banner — shown to anyone who attaches to the pane mid-run.
  lines.push(
    `echo '── DevPilot: headless agent run · ${input.runId} · this pane is a live mirror of claude stdout · attach with tmux attach -t ${sess} ──'`,
  );
  // The actual claude invocation. Stdin from prompt file; stdout teed so the
  // pane shows it live AND the runner's FIFO reader gets the full stream;
  // stderr also teed for the same reason. ${PIPESTATUS[0]} after the
  // pipeline captures claude's exit code (tee always exits 0, so $? alone
  // would mask claude failures). We deliberately do NOT exec claude — the
  // shell needs to outlive claude to write the exit-code file.
  //
  // Why tee vs the previous straight redirect (`> stdoutPath 2> stderrPath`):
  // the redirect sent claude's output to the FIFO ONLY, leaving the tmux
  // pane empty. An operator attaching mid-run via /api/runs/.../attach saw
  // a blank black screen — the entire point of attaching was lost. tee
  // duplicates the stream so the pane shows the JSON event lines as they
  // arrive while the runner-side parser keeps reading the FIFO unchanged.
  const claudeArgvShq = input.claudeArgs.map(shq).join(" ");
  lines.push(
    `claude ${claudeArgvShq} < ${shq(promptPath)} 2> >(tee ${shq(stderrPath)} >&2) | tee ${shq(stdoutPath)}`,
  );
  lines.push(`echo \${PIPESTATUS[0]} > ${shq(exitPath)}`);
  // Keep the pane alive briefly after claude exits so an operator who only
  // attached at the end has a few seconds to read the buffer. The linger is
  // owned by the headless wrapper (timer in claude.ts) — this sleep is just
  // so the launcher process doesn't race the kill-session call.
  lines.push("sleep 1");

  await fs.writeFile(launcherPath, lines.join("\n") + "\n", { mode: 0o700 });

  // 4. Open the stdout/stderr FIFO readers BEFORE starting the tmux session.
  //    Opening a FIFO for read normally blocks until someone opens it for
  //    write (when the launcher invokes claude with `> out`) — and that block
  //    is served by a libuv THREADPOOL worker, not the event loop. Two FIFOs
  //    per run x LOCAL_CC_CONCURRENCY=2 pinned all four default pool slots and
  //    starved dns.lookup(), which killed every engine call in the runner with
  //    UND_ERR_CONNECT_TIMEOUT against a healthy engine. openFifoReadStream
  //    opens O_RDWR|O_NONBLOCK and watches the fd on the EVENT LOOP instead;
  //    see fifo-reader.ts for the full derivation and why O_RDWR is required.
  //    The stream is a net.Socket, which emits 'data' exactly as the
  //    fs.ReadStream did, so everything below is unchanged.
  const stdoutListeners: Array<(line: string) => void> = [];
  const stderrListeners: Array<(chunk: string) => void> = [];
  let stdoutBuf = "";

  const stdoutStream = openFifoReadStream(stdoutPath);
  stdoutStream.on("data", (chunk) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    stdoutBuf += text;
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      for (const h of stdoutListeners) {
        try {
          h(line);
        } catch {
          // never let a listener crash kill the read
        }
      }
    }
  });
  // Stream errors are non-fatal: the exit-poll below decides actual success.
  stdoutStream.on("error", () => {
    /* ignore — FIFO writer end was closed */
  });

  // If this open throws, the stdout socket is already live and would leak its
  // fd (and its event-loop ref) for the life of the process.
  let stderrStream: net.Socket;
  try {
    stderrStream = openFifoReadStream(stderrPath);
  } catch (err) {
    try {
      stdoutStream.destroy();
    } catch {
      /* ignore */
    }
    throw err;
  }
  stderrStream.on("data", (chunk) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const h of stderrListeners) {
      try {
        h(text);
      } catch {
        // ignore
      }
    }
  });
  stderrStream.on("error", () => {
    /* ignore */
  });

  // 5-6. Kill any stale session with the same name (runner restart on the same
  //      runId) so the new-session call doesn't error on duplicate, then start
  //      the detached tmux session running the launcher. The `-c` start dir
  //      matches the launcher's cd as belt-and-suspenders.
  //
  //      Both readers are already open at this point, so a throw here escapes
  //      before any caller has a handle to close them — leaking two fds and two
  //      event-loop refs for the life of the runner, every time tmux fails to
  //      start a session. Nothing downstream can clean up what it was never
  //      given, so this is the only place that can.
  try {
    await killTmuxSession(sess);
    await execFileP("tmux", ["new-session", "-d", "-s", sess, "-c", workspacePath, launcherPath]);
  } catch (err) {
    for (const s of [stdoutStream, stderrStream]) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    try {
      await fs.rm(baseDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }

  HEADLESS_TRACKED.set(input.runId, {
    runId: input.runId,
    tmuxSession: sess,
    workspacePath,
    launcherPath,
    promptPath,
    stdoutPath,
    stderrPath,
    exitPath,
    baseDir,
  });

  // 7. Exit-code watcher. Poll the exitcode file every 200ms until it
  //    appears (launcher writes it after claude returns) OR the tmux session
  //    is gone (operator killed the pane mid-flight). The Promise is shared
  //    by all waitForExit() callers.
  const exitPromise = (async (): Promise<number | null> => {
    const POLL_MS = 200;
    while (true) {
      try {
        const raw = await fs.readFile(exitPath, "utf8");
        const code = parseInt(raw.trim(), 10);
        if (Number.isFinite(code)) {
          // Give the streams a tick to flush the last reads, then close.
          // destroy() closes the underlying FIFO fd (verified: fstat on it
          // afterwards is EBADF), so this is the whole teardown — do NOT add a
          // closeSync beside it, which would be a double close and, in a
          // long-lived runner, an fd-reuse hazard.
          await new Promise((r) => setTimeout(r, 50));
          try {
            stdoutStream.destroy();
          } catch {
            /* ignore */
          }
          try {
            stderrStream.destroy();
          } catch {
            /* ignore */
          }
          // Flush any trailing partial stdout line (no newline). Synthesize
          // one for consistency with the line-stream contract.
          if (stdoutBuf.length > 0) {
            const tail = stdoutBuf;
            stdoutBuf = "";
            for (const h of stdoutListeners) {
              try {
                h(tail);
              } catch {
                /* ignore */
              }
            }
          }
          return code;
        }
      } catch {
        // file not present yet
      }
      if (!(await sessionExists(sess))) {
        // Pane vanished without writing exitcode (kill -9 / shutdown).
        try {
          stdoutStream.destroy();
        } catch {
          /* ignore */
        }
        try {
          stderrStream.destroy();
        } catch {
          /* ignore */
        }
        return null;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })();

  const cleanupTempDir = async (): Promise<void> => {
    HEADLESS_TRACKED.delete(input.runId);
    try {
      await fs.rm(baseDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };

  return {
    tmuxSession: sess,
    waitForExit: () => exitPromise,
    onStdoutLine: (handler) => {
      stdoutListeners.push(handler);
    },
    onStderrChunk: (handler) => {
      stderrListeners.push(handler);
    },
    killAndCleanup: async () => {
      try {
        stdoutStream.destroy();
      } catch {
        /* ignore */
      }
      try {
        stderrStream.destroy();
      } catch {
        /* ignore */
      }
      await killTmuxSession(sess);
      await cleanupTempDir();
    },
    killOnly: async () => {
      try {
        stdoutStream.destroy();
      } catch {
        /* ignore */
      }
      try {
        stderrStream.destroy();
      } catch {
        /* ignore */
      }
      await killTmuxSession(sess);
    },
  };
}

/** True iff a tmux session with this name currently exists. Used by the
 *  headless wrapper's exit-watcher to detect external kills. */
async function sessionExists(sess: string): Promise<boolean> {
  try {
    await execFileP("tmux", ["has-session", "-t", sess]);
    return true;
  } catch {
    return false;
  }
}

/** Kill ONE headless-run tmux session by runId + remove its temp dir. Returns
 *  true when a matching session was found and killed. Used by the cancel path
 *  (claude.ts → cancelClaudeRun) to terminate a wedged `claude -p` the engine
 *  has given up waiting on so it stops chewing the subscription. Killing the
 *  pane makes the wrapper's waitForExit() see the vanished session and resolve
 *  null, so the run settles as a failed step exactly like any external kill. */
export async function killHeadlessRunSession(runId: string): Promise<boolean> {
  const s = HEADLESS_TRACKED.get(runId);
  if (!s) return false;
  HEADLESS_TRACKED.delete(runId);
  await killTmuxSession(s.tmuxSession);
  try {
    await fs.rm(s.baseDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  return true;
}

/** Reap every tracked headless session immediately + remove its temp dir.
 *  Called from the runner's SIGTERM/SIGINT shutdown hook so we never strand
 *  a detached `devpilot-run-*` session after the runner exits. */
export async function killAllHeadlessRunSessions(): Promise<void> {
  const entries = Array.from(HEADLESS_TRACKED.values());
  await Promise.all(
    entries.map(async (s) => {
      HEADLESS_TRACKED.delete(s.runId);
      await killTmuxSession(s.tmuxSession);
      try {
        await fs.rm(s.baseDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }),
  );
}
