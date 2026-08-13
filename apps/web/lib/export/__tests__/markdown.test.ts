// The markdown allowlist. These are security properties, not formatting checks.

import { describe, expect, it } from "vitest";
import {
  isSafeHref,
  markdownToBlocks,
  runsToPlainText,
  MD_MAX_BLOCKS,
  MD_MAX_CODE_CHARS,
} from "@/lib/export/markdown";

import type { MdBlock } from "@/lib/export/markdown";

const text = (src: string) =>
  markdownToBlocks(src)
    .map((b) =>
      b.type === "code" ? b.value : "runs" in b ? runsToPlainText(b.runs) : JSON.stringify(b),
    )
    .join("\n");

/** First block, asserted present — keeps the tests readable under
 *  `noUncheckedIndexedAccess`. */
function firstBlock(src: string): MdBlock {
  const [block] = markdownToBlocks(src);
  if (!block) throw new Error(`expected at least one block from ${JSON.stringify(src)}`);
  return block;
}

/** The block's inline runs, or [] for a block type that has none. */
function runsOf(block: MdBlock) {
  return "runs" in block ? block.runs : [];
}

describe("isSafeHref", () => {
  it("accepts http and https", () => {
    expect(isSafeHref("https://example.com")).toBe(true);
    expect(isSafeHref("http://example.com/a?b=c#d")).toBe(true);
  });

  it("rejects every scheme that is not http(s)", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox",
      "file:///etc/passwd",
      "about:blank",
    ]) {
      expect(isSafeHref(href), href).toBe(false);
    }
  });

  it("rejects obfuscated javascript: that a regex blocklist would miss", () => {
    // Parsed with `new URL`, never regex-matched — this is why. The browser
    // tolerates embedded control characters in a scheme; a naive
    // /^javascript:/ test does not see them.
    expect(isSafeHref("java\nscript:alert(1)")).toBe(false);
    expect(isSafeHref("java\tscript:alert(1)")).toBe(false);
    expect(isSafeHref(" javascript:alert(1)")).toBe(false);
  });

  it("rejects relative and malformed hrefs", () => {
    // A relative link has no base to resolve against in a downloaded PDF, so a
    // "working" one would be a lie.
    expect(isSafeHref("/docs")).toBe(false);
    expect(isSafeHref("docs.html")).toBe(false);
    expect(isSafeHref("")).toBe(false);
    expect(isSafeHref("//example.com")).toBe(false);
  });
});

describe("markdownToBlocks — the allowlist", () => {
  it("drops raw HTML entirely", () => {
    const blocks = markdownToBlocks("before\n\n<script>alert('xss')</script>\n\nafter");
    const rendered = text("before\n\n<script>alert('xss')</script>\n\nafter");
    expect(rendered).toContain("before");
    expect(rendered).toContain("after");
    // Not escaped-and-shown — GONE. Nothing in the output mentions it at all.
    expect(rendered).not.toContain("script");
    expect(rendered).not.toContain("alert");
    expect(blocks.every((b) => b.type !== "code" || !b.value.includes("script"))).toBe(true);
  });

  it("drops inline raw HTML but keeps the surrounding prose", () => {
    const rendered = text("hello <img src=x onerror=alert(1)> world");
    expect(rendered).toContain("hello");
    expect(rendered).toContain("world");
    expect(rendered).not.toContain("onerror");
  });

  it("keeps a javascript: link's TEXT but never shows it as a destination", () => {
    // Degrading to plain text rather than dropping it: removing content from a
    // record is its own kind of wrong. The URL itself isn't printed — it is not
    // a destination anyone could visit, so it would be noise.
    const block = firstBlock("[click me](javascript:alert(1))");
    expect(block.type).toBe("paragraph");
    expect(runsToPlainText(runsOf(block))).toBe("click me");
  });

  it("renders an https link as INERT text with the URL shown inline", () => {
    // Not clickable — see the module header. Every markdown string in this
    // document is untrusted, and a markdown link lets its author choose the
    // label and the destination independently; a clickable one inside a document
    // an auditor trusts is a phishing affordance. The reader sees both instead.
    const runs = runsOf(firstBlock("[docs](https://example.com/docs)"));
    expect(runsToPlainText(runs)).toBe("docs (https://example.com/docs)");
    expect(runs.some((r) => r.linkUrl === true)).toBe(true);
  });

  it("never emits anything a renderer could turn into a clickable link", () => {
    // The structural guarantee: `MdInline` has no href field at all, so the
    // affordance cannot be reintroduced by a renderer edit alone. This asserts
    // the DATA, which is what the renderer is handed.
    for (const src of [
      "[a](https://example.com)",
      "[b](javascript:alert(1))",
      "[c](http://x.test/p?q=1)",
      "<a href='https://evil.example'>d</a>",
    ]) {
      for (const block of markdownToBlocks(src)) {
        const runs = "runs" in block ? block.runs : [];
        for (const run of runs) {
          expect(Object.hasOwn(run, "href"), `${src} → ${JSON.stringify(run)}`).toBe(false);
        }
      }
    }
  });

  it("shows a deceptive label and its real destination side by side", () => {
    // The phishing shape this exists to defuse: label says one thing, the URL
    // goes somewhere else. Both must be visible.
    const runs = runsOf(firstBlock("[the official QA report](https://evil.example/harvest)"));
    const text = runsToPlainText(runs);
    expect(text).toContain("the official QA report");
    expect(text).toContain("https://evil.example/harvest");
  });

  it("never fetches an image — it becomes a text placeholder", () => {
    // A remote image in agent text would be an SSRF/beacon channel and would
    // break the artifact's self-containment.
    const block = firstBlock("![a screenshot](https://evil.example/track.png)");
    const runs = runsOf(block);
    expect(runsToPlainText(runs)).toBe("[image: a screenshot]");
    expect(JSON.stringify(block)).not.toContain("evil.example");
  });

  it("lowers the node types it does support", () => {
    const blocks = markdownToBlocks(
      ["# Head", "", "para **bold** _em_ `code`", "", "- a", "- b", "", "> quote", "", "---"].join(
        "\n",
      ),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "blockquote",
      "rule",
    ]);
  });

  it("parses GFM tables (the app renders the same dialect)", () => {
    const t = firstBlock("| a | b |\n|---|---|\n| 1 | 2 |");
    if (t.type !== "table") throw new Error("expected a table");
    expect(t.header.map(runsToPlainText)).toEqual(["a", "b"]);
    expect(t.rows[0]?.map(runsToPlainText)).toEqual(["1", "2"]);
  });

  it("parses GFM strikethrough", () => {
    const runs = runsOf(firstBlock("~~gone~~"));
    expect(runs[0]?.strike).toBe(true);
  });

  it("keeps fenced code with its language", () => {
    expect(firstBlock("```ts\nconst x = 1;\n```")).toMatchObject({
      type: "code",
      lang: "ts",
      value: "const x = 1;",
    });
  });

  it("truncates a pathological code block rather than paginating forever", () => {
    const block = firstBlock("```\n" + "x".repeat(MD_MAX_CODE_CHARS * 2) + "\n```");
    if (block.type !== "code") throw new Error("expected code");
    expect(block.value.length).toBeLessThan(MD_MAX_CODE_CHARS + 40);
    expect(block.value).toContain("truncated");
  });

  it("bounds the block count so a runaway comment cannot become an appendix", () => {
    const blocks = markdownToBlocks(
      Array.from({ length: MD_MAX_BLOCKS + 50 }, (_, i) => `para ${i}`).join("\n\n"),
    );
    expect(blocks.length).toBeLessThanOrEqual(MD_MAX_BLOCKS + 1);
    const last = blocks[blocks.length - 1];
    expect(last).toBeDefined();
    expect(runsToPlainText(runsOf(last!))).toContain("truncated");
  });

  it("is total on empty and whitespace input", () => {
    expect(markdownToBlocks("")).toEqual([]);
    expect(markdownToBlocks("   \n  ")).toEqual([]);
  });
});
