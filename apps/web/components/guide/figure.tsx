// A guide screenshot, framed as a screenshot.
//
// PRESENTATIONAL — no hooks, no Radix, no browser API, no `server-only`. That is
// what lets `lib/guide/__tests__/figure-render.test.ts` render it with
// `renderToStaticMarkup` under the repo's node-environment Vitest (vitest
// collects only `lib/**/__tests__/**/*.test.ts`, so a test living beside this
// file would never run).
//
// ── Why the frame is not decoration ────────────────────────────────────────
//
// Figures are captured in ONE theme (DevPilot Light — see `GUIDE_FIGURE_THEME`),
// and the reader may be in any of six. An unframed light screenshot dropped into
// a dark page does not read as "a picture taken in a different theme", it reads
// as *the app, apparently broken*. A bordered card with a chrome bar naming the
// depicted route reads as a picture OF the app, which is what it is.
//
// The treatment mirrors the PDF's (`lib/export/components/TicketSection.tsx`:
// 1px border, 4px radius, `objectFit: contain`, caption below) so a reader who
// downloads the manual recognises the same object. That is the whole no-drift
// premise applied to the one element that cannot share a renderer.
//
// ── `<img>`, deliberately not `next/image` ─────────────────────────────────
//
// `next/image` does not render under `renderToStaticMarkup` in a node Vitest,
// and this component must be render-testable. `width`/`height` are set from the
// figure's intrinsic size so the browser reserves layout and the page does not
// jump when the PNG arrives.
//
// ── Degrade visibly, never omit ────────────────────────────────────────────
//
// Two independent absences reach here and both draw the same dashed card as
// `components/runs/StepArtifacts.tsx` uses for an unloadable artifact:
//
//   • the id resolves to no registry entry (the capture crew has not filled it
//     yet — normal during Phase B), and
//   • the entry exists but the PNG is missing at runtime (`onError` is a
//     browser concern and cannot be handled in a component this test renders,
//     so the caption carries the file path either way and a broken image sits
//     inside a frame that is visibly a frame).
//
// Silently rendering nothing is the failure this mirrors StepArtifacts to avoid:
// a guide that quietly drops a screenshot looks complete and is not.

import * as React from "react";
import { AlertTriangle, ImageOff } from "lucide-react";
import { cn } from "@/lib/cn";
import type { GuideFigure } from "@/lib/guide/blocks";

export function GuideFigureCard({
  figureId,
  figure,
}: {
  /** The id as written in the markdown — shown in the fallback so it is fixable. */
  figureId: string;
  /** `undefined` when the capture crew has not registered this id yet. */
  figure: GuideFigure | undefined;
}) {
  if (!figure) {
    return (
      <figure className="my-6 min-w-0">
        <FigureFrame route={null}>
          <MissingBody>
            <ImageOff className="h-4 w-4" />
            <span>
              Screenshot not captured yet <code className="font-mono">({figureId})</code>
            </span>
          </MissingBody>
        </FigureFrame>
        <figcaption className="text-muted-foreground mt-2 text-xs">
          This figure is declared by the guide and has no capture behind it yet.
        </figcaption>
      </figure>
    );
  }

  const stale = figure.staleAcknowledged;

  return (
    <figure className="my-6 min-w-0">
      <FigureFrame route={figure.route}>
        {/* eslint-disable-next-line @next/next/no-img-element -- see the header:
            next/image cannot render under renderToStaticMarkup in the node
            Vitest, and this component is render-tested. */}
        <img
          src={`/guide/${figure.file}`}
          alt={figure.alt}
          width={figure.width}
          height={figure.height}
          loading="lazy"
          decoding="async"
          className="bg-background block h-auto w-full"
        />
      </FigureFrame>

      <figcaption className="text-muted-foreground mt-2 min-w-0 space-y-1 text-xs">
        <span className="block">{figure.caption}</span>
        {stale ? (
          <span className="text-warning border-warning/40 bg-warning/10 inline-flex items-start gap-1.5 rounded border px-2 py-1 text-[11px]">
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
            <span className="min-w-0">
              <strong className="font-medium">May be out of date</strong> — {stale.note}{" "}
              <span className="whitespace-nowrap">(acknowledged {stale.since})</span>
            </span>
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/**
 * The screenshot chrome: a thin bar naming the depicted route above the image.
 *
 * The route is the single most useful caption a screenshot can carry — it tells
 * a reader where to go to see the real thing, which is the whole point of a
 * screenshot in a manual. `null` is the not-captured case, which has no route.
 */
function FigureFrame({ route, children }: { route: string | null; children: React.ReactNode }) {
  return (
    <div className="border-border bg-muted/30 min-w-0 overflow-hidden rounded border">
      <div className="border-border/70 text-muted-foreground flex items-center gap-1.5 border-b px-2.5 py-1.5 text-[11px]">
        <span aria-hidden className="flex gap-1">
          <Dot />
          <Dot />
          <Dot />
        </span>
        <span className="min-w-0 truncate font-mono">{route ?? "—"}</span>
      </div>
      {children}
    </div>
  );
}

function Dot() {
  return <span className="bg-border inline-block h-2 w-2 rounded-full" />;
}

function MissingBody({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex h-32 items-center justify-center gap-2",
        "m-2 rounded-md border border-dashed px-3 text-center text-xs",
      )}
    >
      {children}
    </div>
  );
}

/**
 * The guide-level freshness line: `3 of 11 figures may be out of date`.
 *
 * Renders nothing when nothing is acknowledged — a banner that shows while
 * everything is fine is a banner people stop reading. Counts come from the
 * static manifest; nothing is hashed at render time.
 */
export function GuideStaleSummary({ stale, total }: { stale: number; total: number }) {
  if (stale <= 0) return null;
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <AlertTriangle className="text-warning h-3.5 w-3.5 shrink-0" />
      <span>
        {stale} of {total} figures may be out of date.
      </span>
    </p>
  );
}
