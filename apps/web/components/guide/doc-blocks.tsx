// The web half of the guide's two dumb renderers: `DocBlock[]` → JSX.
//
// PRESENTATIONAL — no hooks, no browser API, no `server-only`, no Radix
// primitive that needs a provider. `lib/guide/__tests__/doc-blocks-render.test.ts`
// renders this with `renderToStaticMarkup` under the repo's node-environment
// Vitest, which only collects `lib/**/__tests__/**/*.test.ts`; a test beside
// this file would never run, so everything worth asserting has to live on this
// side of the presentational/stateful line.
//
// ══════════════════════════════════════════════════════════════════════════
//  THE `switch` IS EXHAUSTIVE WITH A `never` CHECK, AND THAT IS THE POINT.
// ══════════════════════════════════════════════════════════════════════════
//
// Adding a member to `DocBlock` must be a COMPILE ERROR here rather than a block
// type that renders in the manual and silently vanishes from the web (or the
// reverse). `assertNever` in the default arm is what converts "someone forgot"
// from a runtime absence nobody notices into a red typecheck. The companion
// runtime test walks `DOC_BLOCK_TYPES` and asserts every member produces markup,
// because a `never` check can be defeated by a cast and a list cannot.
//
// ── This does NOT parse markdown ───────────────────────────────────────────
//
// `components/plan/MessageMarkdown.tsx` is the wrong thing to reuse twice over:
// it re-parses markdown (a second parse is exactly the drift `lib/guide/lower.ts`
// exists to remove), and it demotes h1 → h2 at 13px uppercase because it draws
// chat bubbles. Its specific CLASS STRINGS are borrowed on purpose — inline code
// and link colour — so a link in the guide looks like a link everywhere else in
// the app.
//
// ── Overflow contract ──────────────────────────────────────────────────────
//
// (`components/marketplace/skill-preview.tsx` documents the rule.) A guide body
// contains code blocks and tables with arbitrary long lines. Every element on
// the path carries `min-w-0` — without it a flex/grid child refuses to shrink
// below its content and pushes the whole page wide — and code blocks and tables
// are each their own `overflow-x-auto` box, so what cannot wrap scrolls inside
// itself rather than scrolling the document.
//
// ── `scroll-mt-20` on every heading ────────────────────────────────────────
//
// The app shell's top bar is `sticky top-0 h-14`. Without scroll-margin, every
// TOC jump and every shared `#anchor` link lands the target UNDER that bar,
// which reads as the link being broken.

import * as React from "react";
import Link from "next/link";
import { Info, Lightbulb, TriangleAlert, Link2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { CalloutTone, DocBlock, DocInline, GuideFigure } from "@/lib/guide/blocks";
import { GuideFigureCard } from "./figure";

export type DocBlocksProps = {
  blocks: readonly DocBlock[];
  /**
   * Figure resolution is INJECTED rather than imported.
   *
   * It keeps this file free of the registry (so a render test supplies two
   * figures and nothing else), and it is the seam the capture crew fills
   * without touching the renderer.
   */
  figureFor: (id: string) => GuideFigure | undefined;
};

export function DocBlocks({ blocks, figureFor }: DocBlocksProps) {
  return (
    <>
      {blocks.map((block, i) => (
        <DocBlockView key={i} block={block} figureFor={figureFor} />
      ))}
    </>
  );
}

function DocBlockView({
  block,
  figureFor,
}: {
  block: DocBlock;
  figureFor: (id: string) => GuideFigure | undefined;
}) {
  switch (block.type) {
    case "paragraph":
      return (
        <p className="text-foreground/90 my-4 min-w-0 text-[15px] leading-7">
          <Runs runs={block.runs} />
        </p>
      );

    case "heading":
      return <Heading depth={block.depth} anchor={block.anchor} runs={block.runs} />;

    case "list":
      return <ListBlock ordered={block.ordered} items={block.items} />;

    case "code":
      // Its OWN horizontal-scroll box. `whitespace-pre` (not `pre-wrap`) is
      // deliberate: wrapping a shell command mid-flag produces something a
      // reader can copy and cannot run.
      return (
        <pre className="bg-muted border-border my-4 min-w-0 overflow-x-auto rounded-md border p-3">
          <code
            className="text-foreground block whitespace-pre font-mono text-[12px] leading-relaxed"
            data-lang={block.lang ?? undefined}
          >
            {block.value}
          </code>
        </pre>
      );

    case "callout":
      return <Callout tone={block.tone} runs={block.runs} />;

    case "table":
      return <TableBlock header={block.header} rows={block.rows} />;

    case "figure":
      // The measure split, made real. `GuideProse`'s root is `max-w-2xl`
      // (42rem) inside a `max-w-3xl` (48rem) article column, so a figure bleeds
      // the 6rem difference to the right and fills the wider column while the
      // text around it stays at ~70 characters. Only from `lg:` up — below that
      // the article column is narrower than 48rem anyway and the bleed would
      // push the figure off the page.
      return (
        <div className="min-w-0 lg:-mr-24">
          <GuideFigureCard figureId={block.figureId} figure={figureFor(block.figureId)} />
        </div>
      );

    case "rule":
      return <hr className="border-border my-8" />;

    default:
      // Exhaustiveness. If this line stops compiling, a `DocBlock` member was
      // added and this renderer has no arm for it — add one rather than casting.
      return assertNever(block);
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled DocBlock: ${JSON.stringify(x)}`);
}

// ── Inline runs ────────────────────────────────────────────────────────────

/**
 * One inline run's marks, applied innermost-first.
 *
 * `href` exists on `DocInline` only because guide content is first-party and
 * PR-reviewed (see `lower.ts`'s trust-domain table). An EXTERNAL destination
 * still gets `rel="noopener noreferrer"` and `target="_blank"`; an internal one
 * routes through `next/link` so navigation stays client-side and the sidebar
 * active state updates without a full load.
 */
function Runs({ runs }: { runs: readonly DocInline[] }) {
  return (
    <>
      {runs.map((run, i) => (
        <Run key={i} run={run} />
      ))}
    </>
  );
}

const LINK_CLASS = "text-chart-1 hover:text-chart-1/80 underline underline-offset-2";
const INLINE_CODE_CLASS = "bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[12px]";

function Run({ run }: { run: DocInline }) {
  let node: React.ReactNode = run.text;
  if (run.code) node = <code className={INLINE_CODE_CLASS}>{node}</code>;
  if (run.bold) node = <strong className="text-foreground font-semibold">{node}</strong>;
  if (run.italic) node = <em className="italic">{node}</em>;

  if (!run.href) return <>{node}</>;

  if (isInternalHref(run.href)) {
    return (
      <Link href={run.href} className={LINK_CLASS}>
        {node}
      </Link>
    );
  }
  return (
    <a href={run.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
      {node}
    </a>
  );
}

/**
 * Internal means same-origin by construction: a root-relative path or a bare
 * fragment. Anything else — including a protocol-relative `//host` — is treated
 * as external and gets the noopener treatment, which is the safe direction to
 * err when the two differ only by one character.
 */
function isInternalHref(href: string): boolean {
  if (href.startsWith("#")) return true;
  return href.startsWith("/") && !href.startsWith("//");
}

// ── Blocks ────────────────────────────────────────────────────────────────

/**
 * A heading, with the anchor link revealed on hover AND on focus.
 *
 * `group-focus-within:opacity-100` is not belt-and-braces: an opacity-0 control
 * is reachable by keyboard, so without it a keyboard user tabs onto a link they
 * cannot see. The anchor id is the one computed during lowering — never
 * re-derived here, or a TOC entry starts pointing at nothing.
 */
function Heading({
  depth,
  anchor,
  runs,
}: {
  depth: 2 | 3;
  anchor: string;
  runs: readonly DocInline[];
}) {
  const Tag = depth === 2 ? "h2" : "h3";
  return (
    <Tag
      id={anchor}
      className={cn(
        "text-foreground group scroll-mt-20 font-semibold tracking-tight",
        depth === 2 ? "font-display mb-3 mt-10 text-xl" : "mb-2 mt-7 text-base",
      )}
    >
      <Runs runs={runs} />
      <a
        href={`#${anchor}`}
        aria-label="Link to this section"
        className="text-muted-foreground hover:text-foreground ml-2 inline-flex align-middle opacity-0 transition-opacity focus:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <Link2 className="h-3.5 w-3.5" />
      </a>
    </Tag>
  );
}

function ListBlock({
  ordered,
  items,
}: {
  ordered: boolean;
  items: readonly (readonly DocInline[])[];
}) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag
      className={cn(
        "text-foreground/90 my-4 min-w-0 space-y-1.5 pl-5 text-[15px] leading-7",
        ordered ? "list-decimal" : "list-disc",
      )}
    >
      {items.map((runs, i) => (
        <li key={i} className="min-w-0 pl-1">
          <Runs runs={runs} />
        </li>
      ))}
    </Tag>
  );
}

const CALLOUT: Record<
  CalloutTone,
  { label: string; icon: typeof Info; frame: string; accent: string }
> = {
  note: {
    label: "Note",
    icon: Info,
    frame: "border-chart-1/30 bg-chart-1/5",
    accent: "text-chart-1",
  },
  warning: {
    label: "Warning",
    icon: TriangleAlert,
    frame: "border-warning/40 bg-warning/10",
    accent: "text-warning",
  },
  tip: {
    label: "Tip",
    icon: Lightbulb,
    frame: "border-chart-3/30 bg-chart-3/5",
    accent: "text-chart-3",
  },
};

/**
 * A callout. The tone drives colour AND a visible text label.
 *
 * Colour alone is not a signal: three of the six themes are light-leaning and
 * two readers in different themes see different contrast, quite apart from
 * colour vision. The word "Warning" carries the meaning; the tint reinforces it.
 */
function Callout({ tone, runs }: { tone: CalloutTone; runs: readonly DocInline[] }) {
  const style = CALLOUT[tone];
  const Icon = style.icon;
  return (
    <div className={cn("my-5 min-w-0 rounded-md border p-3", style.frame)}>
      <p
        className={cn(
          "mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide",
          style.accent,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        {style.label}
      </p>
      <p className="text-foreground/90 min-w-0 text-sm leading-6">
        <Runs runs={runs} />
      </p>
    </div>
  );
}

function TableBlock({
  header,
  rows,
}: {
  header: readonly (readonly DocInline[])[];
  rows: readonly (readonly (readonly DocInline[])[])[];
}) {
  return (
    // Wide content scrolls inside its own box; the page body never does.
    <div className="border-border my-5 w-full min-w-0 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-sm">
        <thead className="border-border bg-muted/40 border-b text-left">
          <tr>
            {header.map((cell, i) => (
              <th key={i} className="text-foreground px-3 py-2 font-medium">
                <Runs runs={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} className="border-border/60 border-t px-3 py-2 align-top">
                  <Runs runs={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The prose column.
 *
 * `max-w-2xl` on this root while the ARTICLE column is `max-w-3xl`: text sits at
 * roughly 70 characters (the measure this repo already uses for prose) and
 * figures, code and tables fill the wider column. That split is what Stripe and
 * Linear do and it is why a figure is allowed to break the measure.
 */
export function GuideProse({ blocks, figureFor }: DocBlocksProps) {
  return (
    <div className="min-w-0 max-w-2xl">
      <DocBlocks blocks={blocks} figureFor={figureFor} />
    </div>
  );
}
