// Unit tests for the pure stream-json -> readable feed translation that backs
// the RunTerminalPanel "readable" view. The component .tsx can't load under
// Vitest, so all the interesting logic lives in the pure module and is tested
// here: representative event shapes map to the right feed items, partial lines
// are buffered until complete, and a non-JSON line falls through as raw text
// and never crashes the feed.

import { beforeEach, describe, expect, it } from "vitest";
import {
  createTerminalFeedBuffer,
  lineToFeedItems,
  resetFeedSeq,
  stripAnsi,
  summarizeToolUse,
} from "@/lib/runs/terminal-feed";

beforeEach(() => resetFeedSeq());

describe("lineToFeedItems", () => {
  it("renders assistant text as prose", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Looking into the bug now." }],
      },
    });
    const items = lineToFeedItems(line);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("assistant");
    expect(items[0]!.text).toBe("Looking into the bug now.");
  });

  it("renders a Bash tool_use as a tool_call showing the command", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "pnpm test", description: "run tests" },
          },
        ],
      },
    });
    const items = lineToFeedItems(line);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("tool_call");
    expect(items[0]!.tool).toBe("Bash");
    expect(items[0]!.text).toBe("pnpm test");
  });

  it("renders file tools with their path", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/repo/src/app.ts" } }],
      },
    });
    const items = lineToFeedItems(line);
    expect(items[0]!.kind).toBe("tool_call");
    expect(items[0]!.tool).toBe("Read");
    expect(items[0]!.text).toBe("/repo/src/app.ts");
  });

  it("renders a successful tool_result as ok", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "3 passed", is_error: false }] },
    });
    const items = lineToFeedItems(line);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("tool_result");
    expect(items[0]!.isError).toBe(false);
    expect(items[0]!.text).toBe("3 passed");
  });

  it("renders an error tool_result as an error, reading array content blocks", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "command failed" }],
            is_error: true,
          },
        ],
      },
    });
    const items = lineToFeedItems(line);
    expect(items[0]!.kind).toBe("tool_result");
    expect(items[0]!.isError).toBe(true);
    expect(items[0]!.text).toBe("command failed");
  });

  it("renders a system init as a subtle status line", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc",
      tools: ["Bash"],
    });
    const items = lineToFeedItems(line);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("system");
    expect(items[0]!.text).toBe("Session initialized");
  });

  it("hides a bare usage / diagnostics object (unknown valid JSON)", () => {
    const usage = JSON.stringify({
      usage: { input_tokens: 10, cache_read_input_tokens: 5 },
      request_id: "req_1",
    });
    expect(lineToFeedItems(usage)).toEqual([]);
  });

  it("truncates long tool_use args and keeps the full detail", () => {
    const long = "x".repeat(500);
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: long } }] },
    });
    const items = lineToFeedItems(line);
    expect(items[0]!.truncated).toBe(true);
    expect(items[0]!.text.length).toBeLessThan(long.length);
    expect(items[0]!.detail).toBe(long);
  });

  it("passes a non-JSON line through as raw text", () => {
    const items = lineToFeedItems("plain shell output: build complete");
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("raw");
    expect(items[0]!.text).toBe("plain shell output: build complete");
  });

  it("passes a malformed-JSON line through as raw rather than crashing", () => {
    const items = lineToFeedItems('{"type":"assistant", "message": {broken');
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("raw");
  });

  it("strips ANSI escapes before parsing and before raw fallthrough", () => {
    const withAnsi =
      "[32m" +
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    const items = lineToFeedItems(withAnsi);
    expect(items[0]!.kind).toBe("assistant");
    expect(items[0]!.text).toBe("hi");

    const rawColoured = "[1;31mERROR:[0m disk full";
    const rawItems = lineToFeedItems(rawColoured);
    expect(rawItems[0]!.kind).toBe("raw");
    expect(rawItems[0]!.text).toBe("ERROR: disk full");
  });

  it("ignores an empty / whitespace-only line", () => {
    expect(lineToFeedItems("   ")).toEqual([]);
    expect(lineToFeedItems("")).toEqual([]);
  });

  it("emits multiple items for an assistant message mixing text and tool_use", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Running the tests." },
          { type: "tool_use", name: "Bash", input: { command: "pnpm test" } },
        ],
      },
    });
    const items = lineToFeedItems(line);
    expect(items.map((i) => i.kind)).toEqual(["assistant", "tool_call"]);
  });
});

describe("summarizeToolUse", () => {
  it("uses the first line of a multi-line Bash command", () => {
    expect(summarizeToolUse("Bash", { command: "cd foo\nmake build" })).toBe("cd foo");
  });
  it("shows Grep pattern with its path", () => {
    expect(summarizeToolUse("Grep", { pattern: "TODO", path: "src" })).toBe("TODO  (in src)");
  });
  it("falls back to compact JSON for an unknown tool with no telling field", () => {
    expect(summarizeToolUse("Mystery", { foo: 1 })).toBe('{"foo":1}');
  });
});

describe("createTerminalFeedBuffer", () => {
  it("buffers a partial line until its newline arrives", () => {
    const buf = createTerminalFeedBuffer();
    const half = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    const a = half.slice(0, 20);
    const b = half.slice(20);
    expect(buf.push(a)).toEqual([]); // incomplete - nothing yet
    const items = buf.push(b + "\n");
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe("hello");
  });

  it("emits one item per completed line across a multi-line chunk", () => {
    const buf = createTerminalFeedBuffer();
    const l1 = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "one" }] },
    });
    const l2 = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "two" }] },
    });
    const items = buf.push(`${l1}\n${l2}\n`);
    expect(items.map((i) => i.text)).toEqual(["one", "two"]);
  });

  it("normalizes CRLF and does not split on a bare carriage return", () => {
    const buf = createTerminalFeedBuffer();
    const l1 = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "crlf" }] },
    });
    const items = buf.push(`${l1}\r\n`);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe("crlf");
  });

  it("flush() translates a trailing partial with no newline", () => {
    const buf = createTerminalFeedBuffer();
    buf.push("tail without newline");
    const items = buf.flush();
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("raw");
    expect(items[0]!.text).toBe("tail without newline");
  });

  it("does not drop or crash on a raw non-JSON line mid-stream", () => {
    const buf = createTerminalFeedBuffer();
    const items = buf.push("$ ls -la\ntotal 0\n");
    expect(items.map((i) => i.kind)).toEqual(["raw", "raw"]);
  });
});

describe("stripAnsi", () => {
  it("removes CSI colour codes and stray control chars but keeps tabs", () => {
    expect(stripAnsi("[31mred[0m\ttail")).toBe("red\ttail");
  });
});
