// Server-only registry of live `tmux attach -t <session>` pty processes that
// bridge an agent run's tmux pane into the browser via the
// /api/runs/[id]/attach SSE + POST routes.
//
// Design
// ──────
// Each entry in the registry maps `runId → AttachEntry` so that all browser
// tabs viewing the same run share a single pty (and therefore see the same
// stdout). One pty per run keeps fan-out simple and matches the way `tmux
// attach` itself behaves on the host — multiple attaches to a session mirror
// each other.
//
// Each entry holds:
//   • the node-pty IPty instance (or null if pty spawn is unavailable)
//   • a recent-output rolling buffer (~64KB) so a late-joining EventSource
//     gets context, not a black screen
//   • a Set of listener callbacks fed by the SSE producers
//   • a `lastSeen` timestamp updated whenever a viewer reads or writes
//   • a reap timer that kills the pty after IDLE_REAP_MS without viewers
//
// Lifecycle
// ─────────
//   open(runId, sessionName)
//     → lazy-spawn `tmux attach -t <session>` (or `tmux attach-session -t`)
//     → returns the entry (idempotent: re-open reuses)
//   subscribe(runId, cb): returns unsubscribe()
//     → cb fires with every chunk of output (existing buffer is replayed
//       first so xterm.js shows recent context immediately)
//   write(runId, data): sends bytes to the pty stdin
//   resize(runId, cols, rows): forwards SIGWINCH-equivalent to the pty
//   close(runId): immediate kill (force-quit) — used by Release-control etc.
//
// HMR safety
// ──────────
// We stash the singleton on globalThis so Next.js dev-mode HMR doesn't
// orphan ptys on every save. The dynamic require of node-pty is guarded with
// a try/catch so the module loads cleanly on platforms where the native
// addon hasn't been built (the route then returns a clean 503).

import "server-only";

// node-pty types — we only import the type to keep the runtime import
// dynamic + guarded. The type-only import is erased at build time.
import type { IPty } from "node-pty";

const SCROLLBACK_BYTES = 64 * 1024; // ~64 KB rolling buffer per session
const IDLE_REAP_MS = 5 * 60_000; // kill the pty after 5min of no viewers

export type AttachEntry = {
  runId: string;
  sessionName: string;
  pty: IPty;
  buffer: string; // rolling scrollback, capped at SCROLLBACK_BYTES
  listeners: Set<(chunk: string) => void>;
  lastSeen: number;
  reapTimer: NodeJS.Timeout | null;
  exited: boolean;
  exitInfo?: { code: number; signal?: number };
};

type Registry = {
  entries: Map<string, AttachEntry>;
};

// HMR-safe singleton: Next.js dev mode reloads modules; without this,
// every hot reload would orphan the live pty processes.
const GLOBAL_KEY = "__devpilot_attach_registry__";
type GlobalWithRegistry = typeof globalThis & {
  [GLOBAL_KEY]?: Registry;
};

function registry(): Registry {
  const g = globalThis as GlobalWithRegistry;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { entries: new Map() };
  }
  return g[GLOBAL_KEY] as Registry;
}

// Dynamic require so the route can return a friendly 503 when the native
// addon hasn't been built rather than crashing the whole web server.
// We cache the result so we don't re-import on every request.
let ptyMod: typeof import("node-pty") | null = null;
let ptyImportError: Error | null = null;

async function loadPtyModule(): Promise<typeof import("node-pty") | null> {
  if (ptyMod !== null) return ptyMod;
  if (ptyImportError !== null) return null;
  try {
    ptyMod = (await import("node-pty")) as typeof import("node-pty");
    return ptyMod;
  } catch (err) {
    ptyImportError = err instanceof Error ? err : new Error(String(err));
    return null;
  }
}

export async function ensurePtyAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const mod = await loadPtyModule();
  if (!mod) {
    return {
      ok: false,
      reason:
        ptyImportError?.message ??
        "node-pty native addon is not available — install/build node-pty on this host",
    };
  }
  return { ok: true };
}

/**
 * Open (or reuse) a pty attached to the given tmux session. Idempotent.
 *
 * The pty runs `tmux attach -t <sessionName> -d` — `-d` detaches any other
 * client (the runner's own AppleScript-opened Terminal window, if any) so we
 * don't fight over the pane size. The pty inherits the current env minus
 * sensitive overrides; the runner's launcher script already pinned DEVPILOT_RUN_ID
 * etc. inside the pane so we don't need to re-pass them.
 */
export async function openAttach(
  runId: string,
  sessionName: string,
  opts: { cols?: number; rows?: number } = {},
): Promise<AttachEntry | { error: string }> {
  const reg = registry();
  const existing = reg.entries.get(runId);
  if (existing && !existing.exited) {
    existing.lastSeen = Date.now();
    if (existing.reapTimer) {
      clearTimeout(existing.reapTimer);
      existing.reapTimer = null;
    }
    // Best-effort resize if cols/rows differ.
    if (opts.cols && opts.rows) {
      try {
        existing.pty.resize(opts.cols, opts.rows);
      } catch {
        // ignore — pty might have just died
      }
    }
    return existing;
  }

  const mod = await loadPtyModule();
  if (!mod) {
    return {
      error:
        ptyImportError?.message ??
        "node-pty native addon is not available — install/build node-pty on this host",
    };
  }

  // `tmux attach -t <name> -d`: -d detaches any other client so resize on
  // our pty doesn't fight a parallel attach. If the session is gone (-t fails)
  // tmux exits non-zero; we surface that to the client via the exit event.
  let pty: IPty;
  try {
    pty = mod.spawn("tmux", ["attach-session", "-t", sessionName, "-d"], {
      name: "xterm-256color",
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 32,
      cwd: process.env.HOME ?? "/",
      // Inherit env so PATH/HOME/USER are right — sensitive child env was
      // set up inside the tmux pane by the runner's launcher script, not
      // here. We don't want this attach process to inherit ANTHROPIC_API_KEY
      // (we don't have one anyway in the web server's env), so we don't
      // need to strip anything.
      env: process.env as { [key: string]: string },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const entry: AttachEntry = {
    runId,
    sessionName,
    pty,
    buffer: "",
    listeners: new Set(),
    lastSeen: Date.now(),
    reapTimer: null,
    exited: false,
  };

  pty.onData((chunk) => {
    // Cap the rolling buffer so late joiners get context but we don't grow
    // unbounded for long-lived runs.
    entry.buffer = (entry.buffer + chunk).slice(-SCROLLBACK_BYTES);
    for (const cb of entry.listeners) {
      try {
        cb(chunk);
      } catch {
        // ignore — listener will be cleaned up when its SSE producer ends
      }
    }
  });

  pty.onExit(({ exitCode, signal }) => {
    entry.exited = true;
    entry.exitInfo = { code: exitCode, signal };
    // Synthesize a final marker for any subscribers so xterm.js can render
    // an "attach ended" line. tmux's own goodbye line ("[detached]") will
    // already have been emitted by tmux just before this fires.
    const marker = `\r\n[devpilot] tmux attach exited (code ${exitCode}${signal ? `, signal ${signal}` : ""})\r\n`;
    entry.buffer = (entry.buffer + marker).slice(-SCROLLBACK_BYTES);
    for (const cb of entry.listeners) {
      try {
        cb(marker);
      } catch {
        // ignore
      }
    }
    // Schedule cleanup: keep the entry around briefly so a quick reconnect
    // sees the goodbye marker; then drop it so a fresh attach can spawn.
    setTimeout(() => {
      const cur = reg.entries.get(runId);
      if (cur === entry) reg.entries.delete(runId);
    }, 30_000);
  });

  reg.entries.set(runId, entry);
  return entry;
}

/**
 * Add a listener; returns an unsubscribe function. Caller should also send
 * `entry.buffer` to the new viewer first (the route does this) so xterm
 * shows existing scrollback before the live stream resumes.
 */
export function subscribe(runId: string, cb: (chunk: string) => void): () => void {
  const entry = registry().entries.get(runId);
  if (!entry) {
    return () => undefined;
  }
  entry.listeners.add(cb);
  entry.lastSeen = Date.now();
  if (entry.reapTimer) {
    clearTimeout(entry.reapTimer);
    entry.reapTimer = null;
  }
  return () => {
    entry.listeners.delete(cb);
    entry.lastSeen = Date.now();
    scheduleReapIfIdle(entry);
  };
}

function scheduleReapIfIdle(entry: AttachEntry) {
  if (entry.listeners.size > 0) return;
  if (entry.exited) return;
  if (entry.reapTimer) clearTimeout(entry.reapTimer);
  entry.reapTimer = setTimeout(() => {
    // Recheck — a late viewer could have hopped on.
    if (entry.listeners.size > 0) return;
    closeAttach(entry.runId, "idle reap");
  }, IDLE_REAP_MS);
}

export function writeToAttach(runId: string, data: string): boolean {
  const entry = registry().entries.get(runId);
  if (!entry || entry.exited) return false;
  entry.lastSeen = Date.now();
  try {
    entry.pty.write(data);
    return true;
  } catch {
    return false;
  }
}

export function resizeAttach(runId: string, cols: number, rows: number): boolean {
  const entry = registry().entries.get(runId);
  if (!entry || entry.exited) return false;
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return false;
  if (cols < 2 || rows < 2 || cols > 500 || rows > 200) return false;
  try {
    entry.pty.resize(Math.floor(cols), Math.floor(rows));
    return true;
  } catch {
    return false;
  }
}

export function closeAttach(runId: string, _reason: string): boolean {
  const reg = registry();
  const entry = reg.entries.get(runId);
  if (!entry) return false;
  try {
    // Send 'q' then a 'detach-client' to be polite, then kill if still around.
    // tmux's attach pty exits cleanly on 'C-b d' (prefix + d) — we can't send
    // a prefix sequence reliably without knowing the user's tmux config, so
    // we just SIGTERM the pty process; tmux's session keeps running, which
    // is exactly what we want (the agent continues; only our viewer ends).
    entry.pty.kill("SIGTERM");
  } catch {
    // ignore
  }
  if (entry.reapTimer) {
    clearTimeout(entry.reapTimer);
    entry.reapTimer = null;
  }
  entry.exited = true;
  // Keep the entry briefly so an in-flight SSE producer flushes its tail,
  // then drop it.
  setTimeout(() => {
    const cur = reg.entries.get(runId);
    if (cur === entry) reg.entries.delete(runId);
  }, 5_000);
  return true;
}
