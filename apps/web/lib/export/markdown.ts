// Markdown → a small, closed set of layout primitives. PURE.
//
// Ticket descriptions, agent comments and handoff notes are markdown. The app
// renders them with `react-markdown` + `remark-gfm`; this module parses the SAME
// dialect (`unified` + `remark-parse` + `remark-gfm` — literally what
// react-markdown runs internally) and lowers the mdast into `MdBlock`s that
// `components/Markdown.tsx` draws with react-pdf primitives.
//
// ── Why an allowlist and not a sanitizer ────────────────────────────────────
// The rule is AGENTS.md principle 6: agent output is DATA. Rather than parse
// everything and then try to remove the dangerous parts (a blocklist — you are
// one unknown node type away from being wrong), we enumerate the node types we
// know how to draw and DROP everything else. A node type added by a future remark
// plugin, or an `html` node carrying `<script>`, does not need to be recognised
// as dangerous to be excluded — it is excluded because it was never included.
//
// Concretely:
//   • `html` nodes (raw HTML in markdown) are dropped outright. remark does not
//     parse their contents without `rehype-raw`, so they arrive as an opaque
//     string; we never draw it. There is no HTML channel into a PDF anyway —
//     this is belt-and-braces, and it keeps `<script>alert(1)</script>` from
//     being rendered as visible literal text where a reader might act on it.
//   • Links are NEVER clickable, and their text always survives. A markdown link
//     lets its author choose the visible label and the destination
//     INDEPENDENTLY — "[the QA report](https://evil.example/harvest)" — and every
//     markdown string in this document is untrusted (agent comments, handoffs,
//     descriptions, model narration; the only system-generated link, the Langfuse
//     trace, is a direct <Link> built in TicketSection, not markdown). A clickable
//     annotation authored by an agent, inside a document an auditor is inclined
//     to trust, is a phishing/exfil affordance with no upside. So a link renders
//     as inert `label (https://…)` — the reader sees exactly where it would have
//     gone and can decide for themselves.
//     The URL is shown only when `isSafeHref` accepts it (http/https).
//     `javascript:`, `data:`, `vbscript:` and scheme-relative oddities are not
//     destinations a reader could visit anyway; their label still survives.
//   • `image` nodes become a text placeholder, never a fetch. A remote image in
//     agent text would be an SSRF/beacon channel and would break the artifact's
//     self-containment. Ticket attachments are a separate, vetted path
//     (`images.server.ts`).
//
// The output is intentionally shallow — blocks with inline runs, no nesting
// beyond a list's items. That is all react-pdf needs, and a flat shape is what
// makes the allowlist auditable.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, PhrasingContent, ListItem, TableRow } from "mdast";

/** An inline run: text plus the marks that apply to it. */
export type MdInline = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /**
   * True for the ` (https://…)` annotation appended after a link's label. Purely
   * a style hint (muted) — it is INERT TEXT, never a clickable annotation. There
   * is deliberately no `href` on this type: markdown in this document is always
   * untrusted, so there is nothing for the renderer to make clickable and no way
   * for a future edit to reintroduce one by accident.
   */
  linkUrl?: boolean;
};

export type MdBlock =
  | { type: "paragraph"; runs: MdInline[] }
  | { type: "heading"; depth: 1 | 2 | 3 | 4 | 5 | 6; runs: MdInline[] }
  | { type: "list"; ordered: boolean; items: MdInline[][] }
  | { type: "code"; lang: string | null; value: string }
  | { type: "blockquote"; runs: MdInline[] }
  | { type: "table"; header: MdInline[][]; rows: MdInline[][][] }
  | { type: "rule" };

/** Bound on how much markdown we lower. A runaway agent comment must not become
 *  a 400-page appendix. Excess is dropped with a trailing marker block. */
export const MD_MAX_BLOCKS = 400;
/** Bound on a single code block's rendered length. */
export const MD_MAX_CODE_CHARS = 4000;

const SAFE_SCHEMES = ["http:", "https:"] as const;

/**
 * True only for an absolute http(s) URL.
 *
 * Parsed with `new URL`, never regex-matched: a regex over a URL string is how
 * `java\nscript:` and friends slip through. Anything that does not parse, or
 * that parses to a scheme outside the allowlist, is refused. Relative links are
 * refused too — there is no base to resolve them against in a downloaded PDF, so
 * a "working" relative link would be a lie.
 */
export function isSafeHref(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  return (SAFE_SCHEMES as readonly string[]).includes(url.protocol);
}

type Marks = Omit<MdInline, "text">;

/**
 * Flatten phrasing content into inline runs, carrying marks down through nesting.
 * Unknown phrasing node types contribute nothing — the allowlist rule, applied
 * inline as well as at block level.
 */
function inlines(nodes: readonly PhrasingContent[], marks: Marks = {}): MdInline[] {
  const out: MdInline[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out.push({ text: node.value, ...marks });
        break;
      case "inlineCode":
        out.push({ text: node.value, ...marks, code: true });
        break;
      case "strong":
        out.push(...inlines(node.children, { ...marks, bold: true }));
        break;
      case "emphasis":
        out.push(...inlines(node.children, { ...marks, italic: true }));
        break;
      case "delete":
        out.push(...inlines(node.children, { ...marks, strike: true }));
        break;
      case "break":
        out.push({ text: "\n", ...marks });
        break;
      case "link": {
        // The label always survives — dropping it would silently remove content
        // from a record. Nothing here is ever clickable (see the module header):
        // the author of this markdown is untrusted and picks label and
        // destination independently, so we show BOTH and let the reader judge.
        out.push(...inlines(node.children, marks));
        if (isSafeHref(node.url)) {
          out.push({ text: ` (${node.url})`, ...marks, linkUrl: true });
        }
        // A non-http(s) scheme is not a destination anyone could visit; the label
        // above already carries what the author wrote.
        break;
      }
      case "linkReference":
        // No definition resolution — emit the label text only.
        out.push(...inlines(node.children, marks));
        break;
      case "image":
        // Never fetched. See the module header.
        out.push({ text: node.alt ? `[image: ${node.alt}]` : "[image]", ...marks, italic: true });
        break;
      case "imageReference":
        out.push({ text: node.alt ? `[image: ${node.alt}]` : "[image]", ...marks, italic: true });
        break;
      case "footnoteReference":
        out.push({ text: `[^${node.identifier}]`, ...marks });
        break;
      // `html`, and anything a future plugin adds, falls through: dropped.
      default:
        break;
    }
  }
  return out;
}

function cellRuns(row: TableRow): MdInline[][] {
  return row.children.map((cell) => inlines(cell.children));
}

function listItemRuns(item: ListItem): MdInline[] {
  const runs: MdInline[] = [];
  for (const child of item.children) {
    if (child.type === "paragraph") {
      runs.push(...inlines(child.children));
    } else if (child.type === "list") {
      // Nested lists flatten into the parent item, marked with a bullet so the
      // structure is still legible without a recursive layout.
      for (const sub of child.children) {
        runs.push({ text: "\n  • " });
        runs.push(...listItemRuns(sub));
      }
    } else if (child.type === "code") {
      runs.push({ text: child.value, code: true });
    }
  }
  return runs;
}

function lowerBlock(node: RootContent, out: MdBlock[]): void {
  switch (node.type) {
    case "paragraph": {
      const runs = inlines(node.children);
      if (runs.some((r) => r.text.trim().length > 0)) out.push({ type: "paragraph", runs });
      break;
    }
    case "heading":
      out.push({
        type: "heading",
        depth: Math.min(6, Math.max(1, node.depth)) as 1 | 2 | 3 | 4 | 5 | 6,
        runs: inlines(node.children),
      });
      break;
    case "list":
      out.push({
        type: "list",
        ordered: node.ordered === true,
        items: node.children.map(listItemRuns),
      });
      break;
    case "code":
      out.push({
        type: "code",
        lang: node.lang ?? null,
        value:
          node.value.length > MD_MAX_CODE_CHARS
            ? `${node.value.slice(0, MD_MAX_CODE_CHARS)}\n… (truncated)`
            : node.value,
      });
      break;
    case "blockquote": {
      const runs: MdInline[] = [];
      for (const child of node.children) {
        if (child.type === "paragraph") runs.push(...inlines(child.children));
      }
      if (runs.length > 0) out.push({ type: "blockquote", runs });
      break;
    }
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
    // dropped. See the module header — this default IS the allowlist.
    default:
      break;
  }
}

const processor = unified().use(remarkParse).use(remarkGfm);

/**
 * Parse markdown and lower it into drawable blocks.
 *
 * Total: a parse failure yields a single paragraph carrying the raw text, so a
 * pathological input degrades to "shown verbatim" rather than losing the content
 * or failing the export.
 */
export function markdownToBlocks(source: string): MdBlock[] {
  if (!source || source.trim().length === 0) return [];

  let tree: Root;
  try {
    tree = processor.parse(source) as Root;
  } catch {
    return [{ type: "paragraph", runs: [{ text: source }] }];
  }

  const out: MdBlock[] = [];
  for (const node of tree.children) {
    if (out.length >= MD_MAX_BLOCKS) {
      out.push({
        type: "paragraph",
        runs: [{ text: "… (content truncated for export)", italic: true }],
      });
      break;
    }
    lowerBlock(node, out);
  }
  return out;
}

/** Plain-text projection of inline runs — used for summaries and TOC entries. */
export function runsToPlainText(runs: readonly MdInline[]): string {
  return runs.map((r) => r.text).join("");
}
