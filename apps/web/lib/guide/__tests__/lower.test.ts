import { describe, expect, it } from "vitest";
import {
  FIGURE_URL_PREFIX,
  GuideLoweringError,
  figureIdsIn,
  headingsIn,
  lowerGuideMarkdown,
  slugifyAnchor,
} from "@/lib/guide/lower";
import { DOC_BLOCK_TYPES, docRunsToPlainText, type DocBlock } from "@/lib/guide/blocks";

function typesOf(blocks: readonly DocBlock[]): string[] {
  return blocks.map((b) => b.type);
}

describe("slugifyAnchor", () => {
  it("is deterministic", () => {
    expect(slugifyAnchor("Connect a runner")).toBe(slugifyAnchor("Connect a runner"));
  });

  it("lowercases, collapses punctuation and trims dashes", () => {
    expect(slugifyAnchor("  Done is NOT landed! ")).toBe("done-is-not-landed");
    expect(slugifyAnchor("blocked_by vs builds_on")).toBe("blocked-by-vs-builds-on");
    expect(slugifyAnchor("What's a runner?")).toBe("what-s-a-runner");
  });

  it("degrades accents rather than dropping the character", () => {
    expect(slugifyAnchor("Café mode")).toBe("cafe-mode");
  });

  it("is total — a heading of pure punctuation still yields a usable anchor", () => {
    // An empty anchor would collapse every such heading onto one fragment.
    expect(slugifyAnchor("— ✳︎ —")).toBe("section");
    expect(slugifyAnchor("")).toBe("section");
  });

  it("produces URL-safe output for adversarial headings", () => {
    for (const input of ["A/B testing", "50% done", "a#b?c=d", "<script>", "tabs\tand\nnewlines"]) {
      expect(slugifyAnchor(input)).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe("anchors within a body", () => {
  it("are unique, with a numeric suffix on collision", () => {
    const blocks = lowerGuideMarkdown(
      ["## Troubleshooting", "a", "## Troubleshooting", "b", "## Troubleshooting", "c"].join(
        "\n\n",
      ),
    );
    expect(headingsIn(blocks).map((h) => h.anchor)).toEqual([
      "troubleshooting",
      "troubleshooting-2",
      "troubleshooting-3",
    ]);
  });

  it("de-duplicates across depths too — the fragment namespace is one space", () => {
    const blocks = lowerGuideMarkdown("## Signals\n\ntext\n\n### Signals\n\ntext");
    const anchors = blocks.filter((b) => b.type === "heading").map((b) => b.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("ignores inline marks when deriving the anchor", () => {
    const blocks = lowerGuideMarkdown("## The **runner** must be `alive`");
    expect(headingsIn(blocks)[0]?.anchor).toBe("the-runner-must-be-alive");
  });
});

describe("heading depth is a contract, not a suggestion", () => {
  it("rejects a depth-1 heading — the page title is the h1 and comes from the manifest", () => {
    expect(() => lowerGuideMarkdown("# A second page title")).toThrow(GuideLoweringError);
  });

  it("names the section in the message so the failure points at a file", () => {
    expect(() => lowerGuideMarkdown("# nope", "connect-a-runner")).toThrow(/connect-a-runner/);
  });

  it("rejects depth 4+ rather than silently promoting it into navigation", () => {
    expect(() => lowerGuideMarkdown("#### Too deep")).toThrow(GuideLoweringError);
  });

  it("accepts 2 and 3", () => {
    const blocks = lowerGuideMarkdown("## Two\n\n### Three");
    expect(blocks.filter((b) => b.type === "heading").map((b) => b.depth)).toEqual([2, 3]);
  });
});

describe("every block type round-trips through the lowering", () => {
  const SOURCE = [
    "A paragraph with **bold**, *italic*, `code` and a [link](https://example.com/x).",
    "## A heading",
    "### A sub-heading",
    "- one",
    "- two",
    "1. first",
    "2. second",
    "```bash\npnpm dev\n```",
    "> [!NOTE]\n> A note.",
    "> [!WARNING]\n> A warning.",
    "> [!TIP]\n> A tip.",
    "| A | B |\n|---|---|\n| 1 | 2 |",
    `![](${FIGURE_URL_PREFIX}board-orchestration)`,
    "---",
  ].join("\n\n");

  const blocks = lowerGuideMarkdown(SOURCE);

  it("emits every member of DOC_BLOCK_TYPES", () => {
    // If a block type is added, this fixture must grow to exercise it — which is
    // the point: the vocabulary and its coverage move together.
    expect(new Set(typesOf(blocks))).toEqual(new Set(DOC_BLOCK_TYPES));
  });

  it("carries inline marks and a clickable href", () => {
    const para = blocks.find((b) => b.type === "paragraph");
    expect(para?.runs.some((r) => r.bold)).toBe(true);
    expect(para?.runs.some((r) => r.italic)).toBe(true);
    expect(para?.runs.some((r) => r.code)).toBe(true);
    expect(para?.runs.find((r) => r.href)?.href).toBe("https://example.com/x");
  });

  it("distinguishes ordered from unordered lists", () => {
    const lists = blocks.filter((b) => b.type === "list");
    expect(lists.map((l) => l.ordered)).toEqual([false, true]);
    expect(lists[0]?.items.map((i) => docRunsToPlainText(i))).toEqual(["one", "two"]);
  });

  it("keeps the code fence language and body verbatim", () => {
    const code = blocks.find((b) => b.type === "code");
    expect(code).toEqual({ type: "code", lang: "bash", value: "pnpm dev" });
  });

  it("reads the callout tone from the marker and strips it from the text", () => {
    const callouts = blocks.filter((b) => b.type === "callout");
    expect(callouts.map((c) => c.tone)).toEqual(["note", "warning", "tip"]);
    expect(docRunsToPlainText(callouts[0]?.runs ?? [])).toBe("A note.");
  });

  it("splits a table into header and rows", () => {
    const table = blocks.find((b) => b.type === "table");
    expect(table?.header.map(docRunsToPlainText)).toEqual(["A", "B"]);
    expect(table?.rows.map((r) => r.map(docRunsToPlainText))).toEqual([["1", "2"]]);
  });

  it("resolves a figure reference to its id", () => {
    expect(figureIdsIn(blocks)).toEqual(["board-orchestration"]);
  });
});

describe("callouts", () => {
  it("default to `note` when a blockquote carries no marker", () => {
    const [block] = lowerGuideMarkdown("> Just a quote.");
    expect(block).toMatchObject({ type: "callout", tone: "note" });
  });

  it("refuse a marker with no tone rather than silently downgrading it", () => {
    // `[!CAUTION]` is a valid GitHub alert. Rendering it as a plain note would
    // quietly drop the emphasis the author chose.
    expect(() => lowerGuideMarkdown("> [!CAUTION]\n> Careful.")).toThrow(/CAUTION/);
  });
});

describe("figures", () => {
  it("refuse a raw image — it would bypass alt, caption, watch and provenance", () => {
    expect(() => lowerGuideMarkdown("![a board](/guide/board.png)")).toThrow(GuideLoweringError);
  });

  it("refuse an inline image even when the URL is a figure reference", () => {
    // A figure is a block. Inline, it has nowhere to put a caption and the PDF
    // renderer has no inline image primitive.
    expect(() => lowerGuideMarkdown(`text ![](${FIGURE_URL_PREFIX}x) more`)).toThrow(
      GuideLoweringError,
    );
  });

  it("refuse an empty figure id", () => {
    expect(() => lowerGuideMarkdown(`![](${FIGURE_URL_PREFIX})`)).toThrow(GuideLoweringError);
  });
});

describe("the allowlist", () => {
  it("drops an unknown / unrepresentable node instead of guessing", () => {
    // Raw HTML arrives as an opaque `html` node. It is dropped — never drawn,
    // never rendered as visible literal text a reader might act on.
    const blocks = lowerGuideMarkdown('<div onclick="alert(1)">hi</div>\n\nAfter.');
    expect(typesOf(blocks)).toEqual(["paragraph"]);
    expect(docRunsToPlainText(blocks[0]?.type === "paragraph" ? blocks[0].runs : [])).toBe(
      "After.",
    );
  });

  it("drops a whitespace-only paragraph", () => {
    expect(lowerGuideMarkdown("   \n\n")).toEqual([]);
  });

  it("refuses a nested list rather than flattening it differently per renderer", () => {
    expect(() => lowerGuideMarkdown("- a\n  - b")).toThrow(GuideLoweringError);
  });
});
