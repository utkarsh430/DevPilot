// Pure, dependency-free translation of the runner's `claude -p
// --output-format=stream-json --verbose` byte stream into a human-readable
// live feed.
//
// The /api/runs/[id]/attach SSE bridge (see RunTerminalPanel) pipes the run's
// tmux pane straight through as raw bytes. Because the pane is running a
// headless `claude -p` that prints one stream-json event per line, those bytes
// are (mostly) newline-delimited JSON - an unreadable wall in xterm. This
// module turns each complete line into a compact FeedItem the panel can render
// as prose + tool activity, while any line that ISN'T valid JSON (plain shell
// output, a prompt, a tmux status redraw) falls through untouched as raw text.
//
// It is intentionally split from the React component so it can be unit-tested
// under Vitest (component .tsx files can't load there - the repo convention).
//
// Event shapes (Claude Agent SDK / `claude -p` stream, mirrored by the runner's
// transcript-tail parser):
//   {"type":"system","subtype":"init", ...}
//   {"type":"assistant","message":{"content":[
//       {"type":"text","text":"..."},
//       {"type":"tool_use","name":"Bash","input":{"command":"..."}}]}}
//   {"type":"user","message":{"content":[
//       {"type":"tool_result","content":"...","is_error":false}]}}
//   {"type":"result","subtype":"success","result":"...","usage":{...}}
// `usage` / cache-token / `request_id` / `diagnostics` fields are noise and are
// never surfaced.

export type FeedItemKind =
  | "assistant" // agent narration, rendered as prose
  | "tool_call" // "→ Bash: pnpm test"
  | "tool_result" // "✓ result" / "✗ error", with an expandable body
  | "system" // subtle status line (session init, run finished, …)
  | "raw"; // a line we could not parse as a known event - shown verbatim

export interface FeedItem {
  /** Stable, monotonic key for React lists. Assigned by the buffer. */
  id: number;
  kind: FeedItemKind;
  /** Primary text: prose (assistant), summary line (tool_call), body (result/raw). */
  text: string;
  /** tool_call: the tool name (e.g. "Bash"). */
  tool?: string;
  /** tool_result: true = error (✗), false = ok (✓). */
  isError?: boolean;
  /** Full, untruncated detail for an expand affordance (long args / output). */
  detail?: string;
  /** True when `text` was truncated and `detail` holds the full content. */
  truncated?: boolean;
}

const SUMMARY_MAX = 200;
const RESULT_TAIL_MAX = 400;

// Matches CSI / single-char ANSI escape sequences. tmux attach redraws the
// pane with cursor-positioning and colour escapes; stripping them is what
// lets a JSON line parse and a raw line read cleanly.
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nqry=><]/g;
// Remaining C0 control chars except tab - leftover bell/backspace noise.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(CONTROL_RE, "");
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + "…", truncated: true };
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Tool results come back as a string or an array of content blocks. */
function resultToText(v: unknown): string {
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
  if (v == null) return "";
  return safeJson(v);
}

/**
 * A concise, human-readable summary of a tool_use - the command for Bash, the
 * path for file tools, the pattern for search, else a compact JSON of the
 * input. First line only; callers truncate for the summary line.
 */
export function summarizeToolUse(name: string, input: unknown): string {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof obj[k] === "string" ? (obj[k] as string) : undefined;
  const firstLine = (s: string): string => s.split("\n")[0] ?? s;

  switch (name) {
    case "Bash":
    case "BashOutput": {
      const cmd = str("command");
      return cmd ? firstLine(cmd) : safeJson(input);
    }
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const p = str("file_path") ?? str("notebook_path") ?? str("path");
      return p ?? safeJson(input);
    }
    case "Glob":
    case "Grep": {
      const pat = str("pattern");
      const path = str("path");
      return pat ? (path ? `${pat}  (in ${path})` : pat) : safeJson(input);
    }
    case "WebFetch":
    case "WebSearch": {
      return str("url") ?? str("query") ?? safeJson(input);
    }
    case "Task": {
      return str("description") ?? str("subagent_type") ?? safeJson(input);
    }
    default: {
      // Board tools (devpilot_move_ticket, devpilot_comment, …) and anything
      // unknown: prefer a telling string field, else compact JSON.
      const telling = str("status") ?? str("body") ?? str("summary") ?? str("title");
      return telling ?? safeJson(input);
    }
  }
}

let itemSeq = 0;

/**
 * Translate ONE already-line-delimited, ANSI-stripped string into zero or more
 * feed items. Pure aside from the shared monotonic id counter - reset it with
 * `resetFeedSeq()` in tests for deterministic ids.
 *
 * A line that isn't a recognised stream-json event (plain shell output, a
 * prompt, a partial redraw) returns a single `raw` item so nothing is ever
 * dropped or allowed to crash the feed.
 */
export function lineToFeedItems(rawLine: string): FeedItem[] {
  const line = stripAnsi(rawLine).trim();
  if (!line) return [];

  // Only attempt JSON when the line actually looks like an object - cheap
  // guard so ordinary shell output doesn't pay the parse cost or risk a
  // surprising coercion.
  if (line[0] !== "{") return [rawItem(line)];

  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [rawItem(line)];
  }
  if (!ev || typeof ev !== "object") return [rawItem(line)];

  const type = ev.type;

  if (type === "assistant" || type === "user") {
    return messageToItems(type, ev);
  }

  if (type === "system") {
    const subtype = typeof ev.subtype === "string" ? ev.subtype : "";
    if (subtype === "init") {
      return [item("system", "Session initialized")];
    }
    // Other system events (diagnostics, tool registry, …) are pure noise.
    return subtype ? [item("system", `System: ${subtype}`)] : [];
  }

  if (type === "result") {
    const subtype = typeof ev.subtype === "string" ? ev.subtype : "";
    const isError = ev.is_error === true || subtype.includes("error");
    const resultText = typeof ev.result === "string" ? ev.result : "";
    const label = isError ? "Run ended with an error" : "Run finished";
    if (resultText.trim()) {
      const { text, truncated } = truncate(resultText.trim(), RESULT_TAIL_MAX);
      return [{ ...item("system", `${label}: ${text}`), truncated, detail: resultText }];
    }
    return [item("system", label)];
  }

  // Unknown but valid JSON (e.g. a bare usage/diagnostics object) - drop as
  // noise rather than surface it.
  return [];
}

function messageToItems(type: "assistant" | "user", ev: Record<string, unknown>): FeedItem[] {
  const message = (ev as { message?: { content?: unknown } }).message;
  const content = message?.content;
  const blocks: unknown[] = Array.isArray(content)
    ? content
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];

  const items: FeedItem[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const bt = (b as { type?: string }).type;

    if (type === "assistant" && bt === "text") {
      const text = (b as { text?: string }).text;
      if (text && text.trim()) items.push(item("assistant", text.trim()));
    } else if (type === "assistant" && bt === "tool_use") {
      const name = (b as { name?: string }).name ?? "tool";
      const full = summarizeToolUse(name, (b as { input?: unknown }).input);
      const { text, truncated } = truncate(full, SUMMARY_MAX);
      items.push({
        ...item("tool_call", text),
        tool: name,
        truncated,
        detail: truncated ? full : undefined,
      });
    } else if (type === "user" && bt === "tool_result") {
      const isError = (b as { is_error?: unknown }).is_error === true;
      const body = resultToText((b as { content?: unknown }).content).trim();
      const { text, truncated } = truncate(body || (isError ? "error" : "ok"), SUMMARY_MAX);
      items.push({
        ...item("tool_result", text),
        isError,
        truncated,
        detail: truncated ? body : undefined,
      });
    } else if (type === "user" && bt === "text") {
      // A human-typed turn during a takeover.
      const text = (b as { text?: string }).text;
      if (text && text.trim()) items.push(item("assistant", text.trim()));
    }
  }
  return items;
}

function item(kind: FeedItemKind, text: string): FeedItem {
  return { id: itemSeq++, kind, text };
}

function rawItem(text: string): FeedItem {
  return { id: itemSeq++, kind: "raw", text };
}

/** Reset the shared id counter - for deterministic ids in unit tests. */
export function resetFeedSeq(): void {
  itemSeq = 0;
}

/**
 * Stateful buffer over the SSE byte chunks. Chunks split lines arbitrarily, so
 * we only translate a line once its terminating newline has arrived; the
 * trailing partial is carried to the next `push`. This is the single seam the
 * component drives.
 */
export interface TerminalFeedBuffer {
  /** Feed a raw SSE chunk; returns any newly-completed feed items. */
  push(chunk: string): FeedItem[];
  /** Force-translate any buffered partial line (e.g. on stream close). */
  flush(): FeedItem[];
}

export function createTerminalFeedBuffer(): TerminalFeedBuffer {
  let pending = "";
  return {
    push(chunk: string): FeedItem[] {
      pending += chunk.replace(/\r/g, "");
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      const out: FeedItem[] = [];
      for (const line of parts) out.push(...lineToFeedItems(line));
      return out;
    },
    flush(): FeedItem[] {
      if (!pending.trim()) {
        pending = "";
        return [];
      }
      const out = lineToFeedItems(pending);
      pending = "";
      return out;
    },
  };
}
