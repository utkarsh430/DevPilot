// Guide markdown → `DocBlock[]`. PURE: `unified` + `remark-parse` +
// `remark-gfm`, no IO, no `server-only`, loadable by Vitest and by both
// renderers' build.
//
// ══════════════════════════════════════════════════════════════════════════
//  THIS IS A SIBLING OF `lib/export/markdown.ts`, NEVER A REFACTOR OF IT.
// ══════════════════════════════════════════════════════════════════════════
//
// That module lowers markdown to PDF blocks and looks like exactly what this
// needs. Reusing or "unifying" it would be a regression in both directions, and
// the middle row of this table is a SECURITY control, not a formatting choice:
//
//   ┌────────────────┬──────────────────────────┬──────────────────────────────┐
//   │                │ lib/export/markdown.ts   │ lib/guide/lower.ts (here)     │
//   ├────────────────┼──────────────────────────┼──────────────────────────────┤
//   │ Author         │ AGENTS + humans, un-     │ First-party, PR-reviewed      │
//   │                │ trusted (principle 6)    │                               │
//   │ Reader         │ An auditor reading a     │ A user reading a manual       │
//   │                │ compliance record        │                               │
//   │ Links          │ INERT. `MdInline` has no │ Clickable. `DocInline.href`   │
//   │                │ `href` FIELD AT ALL, so  │ exists, because the author    │
//   │                │ a link can never be made │ and the destination are both  │
//   │                │ clickable by a later     │ reviewed before merge         │
//   │                │ edit. A markdown link    │                               │
//   │                │ lets its author pick     │                               │
//   │                │ label and destination    │                               │
//   │                │ independently — that is  │                               │
//   │                │ a phishing affordance in │                               │
//   │                │ a trusted document       │                               │
//   │ Images         │ Dropped to a TEXT        │ The headline requirement.     │
//   │                │ placeholder, never       │ `figure:` references resolve  │
//   │                │ fetched (SSRF / beacon)  │ against a vetted manifest      │
//   │ Unknown nodes  │ `default:` IS the allow- │ Same rule, same reason        │
//   │                │ list — drop, don't       │                               │
//   │                │ blocklist                │                               │
//   │ Headings       │ depth 1–6, clamped       │ depth 2|3, depth 1 is an      │
//   │                │                          │ ERROR (the h1 is the title)   │
//   │ Bounds         │ MD_MAX_BLOCKS / _CODE_   │ None. Agent text is unbounded │
//   │                │ CHARS — a runaway agent  │ by nature; a guide section is │
//   │                │ comment must not become  │ a reviewed diff, and silently │
//   │                │ a 400-page appendix      │ truncating one is drift       │
//   └────────────────┴──────────────────────────┴──────────────────────────────┘
//
// ONE MODULE CANNOT SERVE BOTH TRUST DOMAINS. Widening `markdown.ts` to render
// images and clickable links — the obvious "DRY" move, and the reason this table
// is here rather than in a commit message — would weaken the exact artifact it
// was written to protect. `__tests__/separation.test.ts` is a source scan
// asserting the two modules stay apart and that `MdInline` never gains an
// `href`, because that claim is about every FUTURE path and no runtime test can
// make it.
//
// ── Drop vs. error ──────────────────────────────────────────────────────────
//
// A node type we do not UNDERSTAND is dropped (the allowlist rule, inherited
// wholesale). A construct we understand perfectly well and cannot represent
// FAITHFULLY is an ERROR:
//
//   • a depth-1 heading (would be a second page title),
//   • a depth-4+ heading (the TOC and PDF sub-bookmarks read depth-2 only, so a
//     deeper heading either vanishes from navigation or gets silently promoted),
//   • a nested list (`DocBlock` has no nesting; flattening it is a decision each
//     renderer would make differently, which is the drift this design exists to
//     remove),
//   • an image that is not a `figure:` reference (a raw image bypasses the
//     figure manifest, so it has no alt, no caption, no freshness watch and no
//     provenance — and the PDF renderer has no way to fetch it),
//   • an unrecognised callout marker (`[!CAUTION]`), which would otherwise
//     silently become a plain note.
//
// These throw at MODULE LOAD of the manifest, i.e. in the first test and in the
// build, which is the loudest and cheapest place for a first-party corpus to
// fail. The corresponding failure in `markdown.ts` must stay a silent
// degradation, because there the input is an agent comment and failing the
// export would lose the record.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, PhrasingContent, ListItem, TableRow } from "mdast";
import type { CalloutTone, DocBlock, DocInline } from "./blocks";
import { docRunsToPlainText } from "./blocks";

/** Thrown for a construct we understand and refuse to misrepresent. */
export class GuideLoweringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuideLoweringError";
  }
}

/** Markdown URL prefix that turns an image into a manifest figure reference. */
export const FIGURE_URL_PREFIX = "figure:";

const CALLOUT_MARKER = /^\[!(note|warning|tip|important|caution)\]\s*/i;

const CALLOUT_TONES: Record<string, CalloutTone> = {
  note: "note",
  warning: "warning",
  tip: "tip",
};

/**
 * Turn heading text into a URL fragment.
 *
 * The single derivation, read by five consumers (web `id=`, in-page TOC, sidebar
 * sub-nav, PDF sub-bookmark, PDF TOC row). Deterministic and total: any input
 * yields a non-empty, URL-safe string, because a heading that produced `""`
 * would collapse every such heading onto one anchor.
 *
 * Deliberately conservative — ASCII alphanumerics and dashes only. Transliterating
 * accents or emoji would make the anchor depend on a table that can change under
 * us, and a fragment that changes silently breaks every link anyone has shared.
 */
export function slugifyAnchor(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks so "é" degrades to "e" rather than vanishing.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "section";
}

type Marks = Omit<DocInline, "text" | "href">;

function inlines(nodes: readonly PhrasingContent[], marks: Marks = {}, href?: string): DocInline[] {
  const out: DocInline[] = [];
  const stamp = (run: DocInline): DocInline => (href ? { ...run, href } : run);
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out.push(stamp({ text: node.value, ...marks }));
        break;
      case "inlineCode":
        out.push(stamp({ text: node.value, ...marks, code: true }));
        break;
      case "strong":
        out.push(...inlines(node.children, { ...marks, bold: true }, href));
        break;
      case "emphasis":
        out.push(...inlines(node.children, { ...marks, italic: true }, href));
        break;
      case "delete":
        // No `strike` in this vocabulary — the text survives unmarked rather
        // than being dropped. Guide prose should not need it; if it starts to,
        // add the mark to `DocInline` so BOTH renderers are forced to handle it.
        out.push(...inlines(node.children, marks, href));
        break;
      case "break":
        out.push(stamp({ text: "\n", ...marks }));
        break;
      case "link":
        // Nested links are not expressible in markdown, so the inner `href`
        // always wins harmlessly.
        out.push(...inlines(node.children, marks, node.url));
        break;
      case "linkReference":
        out.push(...inlines(node.children, marks, href));
        break;
      case "image":
      case "imageReference":
        throw new GuideLoweringError(
          "an image must be a standalone figure reference — write " +
            "`![](figure:<id>)` on its own line, so it carries alt text, a " +
            "caption, a freshness watch and provenance from the figure manifest",
        );
      // `html`, footnotes, and anything a future remark plugin adds: dropped.
      default:
        break;
    }
  }
  return out;
}

function cellRuns(row: TableRow): DocInline[][] {
  return row.children.map((cell) => inlines(cell.children));
}

function listItemRuns(item: ListItem): DocInline[] {
  const runs: DocInline[] = [];
  for (const child of item.children) {
    if (child.type === "paragraph") {
      if (runs.length > 0) runs.push({ text: " " });
      runs.push(...inlines(child.children));
    } else if (child.type === "list") {
      throw new GuideLoweringError(
        "nested lists are not representable — `DocBlock` is flat by design, and " +
          "flattening here would be a decision each renderer makes differently. " +
          "Restructure into a paragraph plus a single-level list.",
      );
    } else if (child.type === "code") {
      runs.push({ text: child.value, code: true });
    }
  }
  return runs;
}

/** The lone image in a paragraph, when that paragraph IS a figure reference. */
function figureIdOf(node: RootContent): string | null {
  if (node.type !== "paragraph") return null;
  const meaningful = node.children.filter(
    (c) => !(c.type === "text" && c.value.trim().length === 0),
  );
  const [only] = meaningful;
  if (meaningful.length !== 1 || !only || only.type !== "image") return null;
  if (!only.url.startsWith(FIGURE_URL_PREFIX)) return null;
  const id = only.url.slice(FIGURE_URL_PREFIX.length).trim();
  if (id.length === 0) {
    throw new GuideLoweringError("a `figure:` reference must name a figure id");
  }
  return id;
}

function lowerCallout(node: Extract<RootContent, { type: "blockquote" }>): DocBlock {
  const runs: DocInline[] = [];
  for (const child of node.children) {
    if (child.type !== "paragraph") continue;
    if (runs.length > 0) runs.push({ text: "\n" });
    runs.push(...inlines(child.children));
  }

  let tone: CalloutTone = "note";
  const first = runs[0];
  if (first) {
    const match = CALLOUT_MARKER.exec(first.text);
    if (match) {
      const kind = (match[1] ?? "").toLowerCase();
      const resolved = CALLOUT_TONES[kind];
      if (!resolved) {
        // `[!IMPORTANT]` / `[!CAUTION]` are valid GitHub alerts with no tone in
        // this vocabulary. Falling back to "note" would silently downgrade a
        // warning the author meant to emphasise.
        throw new GuideLoweringError(
          `callout marker [!${kind.toUpperCase()}] has no tone in this vocabulary — ` +
            `use one of ${Object.keys(CALLOUT_TONES).join(", ")}`,
        );
      }
      tone = resolved;
      runs[0] = { ...first, text: first.text.slice(match[0].length) };
      if (runs[0].text.length === 0) runs.shift();
    }
  }

  return { type: "callout", tone, runs };
}

function lowerBlock(node: RootContent, out: DocBlock[], anchors: Set<string>): void {
  const figureId = figureIdOf(node);
  if (figureId !== null) {
    out.push({ type: "figure", figureId });
    return;
  }

  switch (node.type) {
    case "paragraph": {
      const runs = inlines(node.children);
      if (runs.some((r) => r.text.trim().length > 0)) out.push({ type: "paragraph", runs });
      break;
    }
    case "heading": {
      if (node.depth === 1) {
        throw new GuideLoweringError(
          "a body may not contain a depth-1 heading — the page title is the h1 " +
            "and comes from the manifest. Start at `##`.",
        );
      }
      if (node.depth > 3) {
        throw new GuideLoweringError(
          `heading depth ${node.depth} is not representable — navigation (in-page ` +
            "TOC, sidebar sub-nav, PDF sub-bookmarks) reads depth-2 headings, so a " +
            "deeper one would either vanish from navigation or be silently promoted.",
        );
      }
      const runs = inlines(node.children);
      const base = slugifyAnchor(docRunsToPlainText(runs));
      let anchor = base;
      for (let n = 2; anchors.has(anchor); n += 1) anchor = `${base}-${n}`;
      anchors.add(anchor);
      out.push({ type: "heading", depth: node.depth as 2 | 3, anchor, runs });
      break;
    }
    case "list":
      out.push({
        type: "list",
        ordered: node.ordered === true,
        items: node.children.map(listItemRuns),
      });
      break;
    case "code":
      out.push({ type: "code", lang: node.lang ?? null, value: node.value });
      break;
    case "blockquote":
      out.push(lowerCallout(node));
      break;
    case "table": {
      const [head, ...body] = node.children;
      if (!head) break;
      out.push({ type: "table", header: cellRuns(head), rows: body.map(cellRuns) });
      break;
    }
    case "thematicBreak":
      out.push({ type: "rule" });
      break;
    // `html`, `definition`, `footnoteDefinition`, `yaml`, and any unknown type:
    // dropped. This `default:` IS the allowlist — see the module header.
    default:
      break;
  }
}

const processor = unified().use(remarkParse).use(remarkGfm);

/**
 * Lower one guide section body.
 *
 * NOT total, unlike `markdownToBlocks`: a construct this refuses is a first-party
 * authoring mistake and throws, naming the section so the failure points at the
 * file to fix. Anchors are de-duplicated WITHIN a body (`-2`, `-3`, …) because
 * two `### Troubleshooting` headings on one page would otherwise share a
 * fragment and every TOC link to the second would land on the first.
 */
export function lowerGuideMarkdown(source: string, sectionSlug?: string): DocBlock[] {
  const tree = processor.parse(source) as Root;
  const out: DocBlock[] = [];
  const anchors = new Set<string>();
  for (const node of tree.children) {
    try {
      lowerBlock(node, out, anchors);
    } catch (err) {
      if (err instanceof GuideLoweringError && sectionSlug) {
        throw new GuideLoweringError(`guide section "${sectionSlug}": ${err.message}`);
      }
      throw err;
    }
  }
  return out;
}

/** Every figure id referenced by a lowered body, in document order. */
export function figureIdsIn(blocks: readonly DocBlock[]): string[] {
  return blocks.filter((b) => b.type === "figure").map((b) => b.figureId);
}

/** Every depth-2 heading, the source of a section's derived subsections. */
export function headingsIn(
  blocks: readonly DocBlock[],
  depth: 2 | 3 = 2,
): { anchor: string; title: string }[] {
  // Two filters, not one compound predicate: TypeScript infers a type predicate
  // for a simple `b.type === "heading"` callback and does NOT for a compound
  // one, so the narrowed `.anchor` access below depends on the split.
  return blocks
    .filter((b) => b.type === "heading")
    .filter((b) => b.depth === depth)
    .map((b) => ({ anchor: b.anchor, title: docRunsToPlainText(b.runs) }));
}
