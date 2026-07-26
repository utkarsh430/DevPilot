// "Take the wheel" — mirror an interactive Claude session into the ticket log.
//
// During a takeover we tail Claude Code's per-session transcript JSONL for the
// ticket workspace and forward each new event to the engine as a `run_steps`
// row (via engine-client.postRunStep). The run page's existing Supabase
// Realtime subscription then lights them up live — so the operator sees the
// agent's turns AND their own typed turns reflected in the ticket log, which is
// the whole point of the feature.
//
// We poll (1s) rather than fs.watch: recursive/rename-aware watching is
// unreliable across platforms (the dev-server loop makes the same call for the
// same reason). Transcripts are append-only, so polling file size + reading the
// appended tail is cheap and robust.
//
// We forward only takeover-era content: when the session resumes an existing
// transcript (`claude --continue`), we start reading from that file's size at
// tail-start so the prior headless history isn't replayed; brand-new transcript
// files (no prior session) stream from the beginning.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { postRunStep, type RunStepInput } from "./engine-client.js";
import { claudeProjectDirFor } from "./tmux-session.js";

const POLL_MS = 1_000;
const MAX_FIELD_CHARS = 4_000; // truncate big tool inputs/results in payloads

export type TranscriptTail = { stop: () => void };

/**
 * Start tailing the workspace's Claude transcript and forwarding events as
 * run-steps. Returns a handle whose `stop()` halts the poller. Safe to call
 * even if tmux/claude isn't running yet — it waits for a transcript to appear.
 */
export function startTranscriptTail(input: {
  runId: string;
  workspacePath: string;
}): TranscriptTail {
  const projectDir = claudeProjectDirFor(input.workspacePath);

  // Files that already existed when the takeover began, with their sizes — we
  // resume reading these from end-of-history so we don't replay the headless
  // transcript. New files (created during the takeover) stream from 0.
  let startSizes: Map<string, number> | null = null;
  // Per-file read offset + carried partial (incomplete trailing line).
  const offsets = new Map<string, number>();
  const pending = new Map<string, string>();

  let stopped = false;
  // Serialize POSTs so the engine assigns run-step idx values without colliding
  // on the (run_id, idx) unique constraint.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (step: RunStepInput) => {
    chain = chain.then(() => postRunStep(input.runId, step)).catch(() => undefined);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const files = await listJsonl(projectDir);
      if (startSizes === null) {
        // First successful listing — snapshot pre-existing files' sizes.
        startSizes = new Map();
        for (const f of files) {
          startSizes.set(f, await sizeOf(f));
        }
      }
      const newest = await newestByMtime(files);
      if (newest) await drain(newest);
    } catch {
      // Project dir not created yet, transient read error — try again next tick.
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    }
  };

  const drain = async (file: string) => {
    let from = offsets.get(file);
    if (from === undefined) {
      // First time we read this file. If it pre-existed the takeover, start at
      // its start-of-takeover size (skip history); else from 0.
      from = startSizes?.get(file) ?? 0;
    }
    const size = await sizeOf(file);
    if (size <= from) {
      offsets.set(file, size); // file truncated/rotated or no growth
      return;
    }
    const chunk = await readRange(file, from, size);
    offsets.set(file, size);
    const buf = (pending.get(file) ?? "") + chunk;
    const parts = buf.split("\n");
    pending.set(file, parts.pop() ?? ""); // last is incomplete
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      for (const step of lineToSteps(trimmed)) enqueue(step);
    }
  };

  let timer: NodeJS.Timeout = setTimeout(() => void tick(), POLL_MS);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

// ---- JSONL → run-steps ----------------------------------------------------

function clip(s: string): string {
  return s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) + "…" : s;
}

/** Map one transcript line to zero or more run-steps. Defensive: anything we
 *  don't recognize yields nothing. */
function lineToSteps(line: string): RunStepInput[] {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = ev.type;
  if (type !== "assistant" && type !== "user") return [];

  const message = (ev as { message?: { role?: string; content?: unknown } }).message;
  const content = message?.content;
  const blocks: unknown[] = Array.isArray(content)
    ? content
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];

  const steps: RunStepInput[] = [];
  for (const b of blocks) {
    if (typeof b !== "object" || !b) continue;
    const bt = (b as { type?: string }).type;
    if (type === "assistant" && bt === "text") {
      const text = (b as { text?: string }).text;
      if (text && text.trim()) {
        steps.push({ kind: "think", payload: { text: clip(text), source: "takeover" } });
      }
    } else if (type === "assistant" && bt === "tool_use") {
      const name = (b as { name?: string }).name ?? "tool";
      const inputObj = (b as { input?: unknown }).input;
      steps.push({
        kind: "tool_call",
        payload: {
          tool: name,
          input: clip(safeJson(inputObj)),
          source: "takeover",
        },
      });
    } else if (type === "user" && bt === "tool_result") {
      const result = (b as { content?: unknown }).content;
      steps.push({
        kind: "tool_result",
        payload: { result: clip(toText(result)), source: "takeover" },
      });
    } else if (type === "user" && bt === "text") {
      // A human-typed turn during the takeover.
      const text = (b as { text?: string }).text;
      if (text && text.trim()) {
        steps.push({ kind: "human", payload: { text: clip(text), source: "takeover" } });
      }
    }
  }
  return steps;
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Tool results may be a string or an array of content blocks. */
function toText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((p) =>
        typeof p === "object" && p && typeof (p as { text?: unknown }).text === "string"
          ? (p as { text: string }).text
          : safeJson(p),
      )
      .join("\n");
  }
  return safeJson(v);
}

// ---- fs helpers -----------------------------------------------------------

async function listJsonl(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries.filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
}

async function newestByMtime(files: string[]): Promise<string | null> {
  let best: string | null = null;
  let bestMtime = -1;
  for (const f of files) {
    try {
      const m = (await fs.stat(f)).mtimeMs;
      if (m > bestMtime) {
        bestMtime = m;
        best = f;
      }
    } catch {
      // ignore
    }
  }
  return best;
}

async function readRange(file: string, from: number, to: number): Promise<string> {
  const fh = await fs.open(file, "r");
  try {
    const len = to - from;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, from);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}
