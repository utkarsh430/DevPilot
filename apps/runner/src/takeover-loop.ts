// "Take the wheel" — Redis control loop for interactive takeover sessions.
//
// Runs alongside the local-cc job loop and the dev-server loop (see index.ts).
// Drains `devpilot:jobs:takeover:control` for `{ kind: 'open' | 'close', ... }`
// messages LPUSHed by the engine when an operator clicks "Take the wheel" /
// "Release control" on the run page.
//
//   open  → resolve the ticket's workspace (reuse the agent's on-disk tree so
//           its uncommitted work is preserved — we do NOT re-prepare/reset an
//           existing workspace), open an interactive `claude` tmux session
//           (tmux-session.ts), and start mirroring its transcript into the
//           ticket log (transcript-tail.ts).
//   close → after the configured linger delay, stop the mirror and kill the
//           tmux session. The pane stays attachable during the delay.
//
// Mirrors the structure/precautions of dev-server-loop.ts.

import { Redis } from "@upstash/redis";
import * as fs from "node:fs/promises";
import { env } from "./env.js";
import { getWorkspacePath, prepareWorkspace } from "./workspace.js";
import { postSystemCommentToTicket } from "./engine-client.js";
import {
  killAllTakeoverSessions,
  killTakeoverSession,
  openTakeoverSession,
  TmuxUnavailableError,
} from "./tmux-session.js";
import { startTranscriptTail, type TranscriptTail } from "./transcript-tail.js";
import { nextIdleDelayMs, POLL_BASE_MS, POLL_IDLE_CAP_MS } from "./poll-backoff.js";

export const TAKEOVER_CONTROL_QUEUE = "devpilot:jobs:takeover:control";

type OpenMessage = {
  kind: "open";
  runId: string;
  tenantId: string;
  ticketId?: string | null;
  /** Slice IB-B parity — merger tickets reuse the source ticket's workspace. */
  workspaceTicketId?: string | null;
  role?: string | null;
  // Recovery fields — only used when the workspace dir is missing on disk
  // (GC'd since the agent ran). An existing workspace is reused as-is.
  repoUrl?: string | null;
  ticketSlug?: string | null;
  githubToken?: string | null;
  gitAuthorName?: string | null;
  gitAuthorEmail?: string | null;
  projectSecretsJson?: string | null;
  baseBranch?: string | null;
};

type CloseMessage = { kind: "close"; runId: string };

type ControlMessage = OpenMessage | CloseMessage;

const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
});

// Live transcript mirrors + pending auto-close timers, keyed by runId.
const TAILS: Map<string, TranscriptTail> = new Map();
const CLOSE_TIMERS: Map<string, NodeJS.Timeout> = new Map();

export async function takeoverPullLoop(opts: {
  engineUrl: string;
  registrationKey: string;
  getStopping: () => boolean;
}): Promise<void> {
  // Idle backoff: ramp the empty-poll cadence 1s→5s (takeover events are rare —
  // a human clicking "Take the wheel") so this loop barely touches the Upstash
  // request quota when idle, and snap back to 1s the moment a message lands.
  let idleMs = POLL_BASE_MS;
  while (!opts.getStopping()) {
    let raw: string | null = null;
    try {
      raw = (await redis.rpop(TAKEOVER_CONTROL_QUEUE)) as string | null;
    } catch (err) {
      console.warn(`[devpilot-runner] takeover queue pop failed:`, err);
      idleMs = POLL_IDLE_CAP_MS;
      await sleep(idleMs);
      continue;
    }
    if (!raw) {
      await sleep(idleMs);
      idleMs = nextIdleDelayMs(idleMs);
      continue;
    }
    idleMs = POLL_BASE_MS;
    let msg: ControlMessage;
    try {
      msg = typeof raw === "string" ? (JSON.parse(raw) as ControlMessage) : (raw as ControlMessage);
    } catch (e) {
      console.warn(`[devpilot-runner] takeover bad payload, skipping:`, e);
      continue;
    }
    if (msg.kind === "open") {
      void handleOpen(msg);
    } else if (msg.kind === "close") {
      handleClose(msg);
    } else {
      console.warn(`[devpilot-runner] takeover unknown msg kind:`, (msg as { kind?: string }).kind);
    }
  }
}

async function handleOpen(msg: OpenMessage): Promise<void> {
  if (!env.TAKEOVER_ENABLED) {
    console.log(
      `[devpilot-runner] takeover disabled (LOCAL_CC_TAKEOVER_ENABLED=false) — ignoring open for run=${msg.runId}`,
    );
    return;
  }
  const wsTicket = msg.workspaceTicketId ?? msg.ticketId ?? null;
  if (!wsTicket) {
    console.warn(
      `[devpilot-runner] takeover open for run=${msg.runId} has no ticketId — cannot resolve workspace`,
    );
    return;
  }

  // Re-open (operator closed the window then took the wheel again) cancels any
  // pending auto-close so we don't kill a session we just re-surfaced.
  cancelCloseTimer(msg.runId);

  // Resolve the workspace. Reuse the agent's existing tree as-is so its
  // uncommitted work is intact; only clone-recover when the dir is gone.
  let workspacePath = getWorkspacePath({ ticketId: wsTicket });
  if (!(await dirExists(workspacePath))) {
    const haveRepo = Boolean(msg.repoUrl) || Boolean(env.ENGINEER_REPO_URL);
    if (!haveRepo) {
      console.warn(
        `[devpilot-runner] takeover: workspace missing for ticket=${wsTicket} and no repoUrl to recover from`,
      );
      void breadcrumb(
        msg.ticketId,
        "Take-the-wheel failed: the workspace was cleaned up and there's no repo to recover it from.",
      );
      return;
    }
    try {
      const ws = await prepareWorkspace({
        ticketId: wsTicket,
        runId: msg.runId,
        repoUrl: msg.repoUrl ?? undefined,
        ticketSlug: msg.ticketSlug ?? undefined,
        githubToken: msg.githubToken ?? undefined,
        gitAuthorName: msg.gitAuthorName ?? undefined,
        gitAuthorEmail: msg.gitAuthorEmail ?? undefined,
        projectSecretsJson: msg.projectSecretsJson ?? undefined,
        baseBranch: msg.baseBranch ?? undefined,
      });
      workspacePath = ws.path;
    } catch (err) {
      console.error(
        `[devpilot-runner] takeover workspace recovery failed for run=${msg.runId}:`,
        err,
      );
      void breadcrumb(
        msg.ticketId,
        `Take-the-wheel failed to recover the workspace: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }

  try {
    const { attachCommand } = await openTakeoverSession({
      runId: msg.runId,
      ticketId: msg.ticketId,
      tenantId: msg.tenantId,
      role: msg.role,
      workspacePath,
    });
    // Start mirroring the interactive transcript into the ticket log.
    TAILS.get(msg.runId)?.stop();
    TAILS.set(msg.runId, startTranscriptTail({ runId: msg.runId, workspacePath }));
    console.log(
      `[devpilot-runner] takeover open run=${msg.runId} ticket=${wsTicket} → ${attachCommand}`,
    );
    void breadcrumb(
      msg.ticketId,
      `🕹️ Operator took the wheel — an interactive Claude session is open on the runner. Attach with \`${attachCommand}\`.`,
    );
  } catch (err) {
    if (err instanceof TmuxUnavailableError) {
      console.warn(`[devpilot-runner] takeover: ${err.message}`);
      void breadcrumb(
        msg.ticketId,
        `Take-the-wheel needs tmux on the runner host. Install it with \`brew install tmux\` and try again.`,
      );
    } else {
      console.error(`[devpilot-runner] takeover open failed for run=${msg.runId}:`, err);
      void breadcrumb(
        msg.ticketId,
        `Take-the-wheel failed to open a session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function handleClose(msg: CloseMessage): void {
  cancelCloseTimer(msg.runId);
  const delay = env.TMUX_CLOSE_DELAY_MS;
  console.log(
    `[devpilot-runner] takeover close run=${msg.runId} — closing in ${Math.round(delay / 1000)}s`,
  );
  const t = setTimeout(() => {
    CLOSE_TIMERS.delete(msg.runId);
    TAILS.get(msg.runId)?.stop();
    TAILS.delete(msg.runId);
    void killTakeoverSession(msg.runId);
  }, delay);
  t.unref?.();
  CLOSE_TIMERS.set(msg.runId, t);
}

function cancelCloseTimer(runId: string): void {
  const t = CLOSE_TIMERS.get(runId);
  if (t) {
    clearTimeout(t);
    CLOSE_TIMERS.delete(runId);
  }
}

/** Stop every mirror + kill every takeover session — called from the runner's
 *  SIGTERM/SIGINT shutdown hook, alongside killAllDevServers(). */
export async function shutdownTakeovers(): Promise<void> {
  for (const t of CLOSE_TIMERS.values()) clearTimeout(t);
  CLOSE_TIMERS.clear();
  for (const tail of TAILS.values()) tail.stop();
  TAILS.clear();
  await killAllTakeoverSessions();
}

async function breadcrumb(ticketId: string | null | undefined, body: string): Promise<void> {
  if (!ticketId) return;
  await postSystemCommentToTicket({ ticketId, body }).catch(() => undefined);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
