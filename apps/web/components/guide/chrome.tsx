// Guide page chrome: breadcrumbs, the prev/next pager, and the index card grid.
//
// PRESENTATIONAL — no hooks, no browser API, no `server-only`. Everything here
// derives from props the RSC already has, which is what keeps it inside the
// half `lib/guide/__tests__/chrome-render.test.ts` can render. The one stateful
// concern on these pages (which sidebar item is active, which heading the
// reader is on) lives in separate `"use client"` files.

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { GuidePager, GuideSection } from "@/lib/guide/manifest";

/**
 * Breadcrumbs: Guide › Chapter › Section.
 *
 * THE CHAPTER IS PLAIN TEXT, NOT A LINK. Chapters have no URL of their own —
 * `GuideChapter` carries a label and a section list and nothing addressable —
 * so linking it would 404. A crumb that looks clickable and is not is worse
 * than one that plainly is not, so it is rendered as a `<span>`.
 */
export function GuideBreadcrumbs({
  chapterLabel,
  sectionTitle,
}: {
  chapterLabel: string;
  sectionTitle: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className="text-muted-foreground mb-4 min-w-0 text-xs">
      <ol className="flex min-w-0 flex-wrap items-center gap-1">
        <li>
          <Link href="/guide" className="hover:text-foreground transition-colors">
            Guide
          </Link>
        </li>
        <Sep />
        <li>
          <span>{chapterLabel}</span>
        </li>
        <Sep />
        <li className="text-foreground min-w-0 truncate font-medium" aria-current="page">
          {sectionTitle}
        </li>
      </ol>
    </nav>
  );
}

function Sep() {
  return (
    <li aria-hidden className="flex items-center">
      <ChevronRight className="h-3 w-3" />
    </li>
  );
}

/**
 * Prev / next across the WHOLE guide, not within a chapter.
 *
 * `guidePager` already spans chapters for the reason recorded there: a reader
 * who reaches the last section of a chapter and finds no forward control reads
 * it as the guide ending. Each end renders an empty cell rather than collapsing,
 * so "next" stays in the same place on every page.
 */
export function GuidePagerNav({ pager }: { pager: GuidePager }) {
  const { prev, next } = pager;
  if (!prev && !next) return null;
  return (
    <nav
      aria-label="Guide sections"
      className="border-border mt-12 grid grid-cols-1 gap-3 border-t pt-6 sm:grid-cols-2"
    >
      {prev ? <PagerLink section={prev} dir="prev" /> : <span aria-hidden />}
      {next ? <PagerLink section={next} dir="next" /> : <span aria-hidden />}
    </nav>
  );
}

function PagerLink({ section, dir }: { section: GuideSection; dir: "prev" | "next" }) {
  const isNext = dir === "next";
  return (
    <Link
      href={`/guide/${section.slug}`}
      className={cn(
        "border-border hover:border-primary/60 hover:bg-muted/40 group min-w-0 rounded-lg border p-3 transition-colors",
        isNext && "sm:text-right",
      )}
    >
      <span
        className={cn(
          "text-muted-foreground flex items-center gap-1 text-[11px] uppercase tracking-wide",
          isNext && "sm:justify-end",
        )}
      >
        {!isNext && <ArrowLeft className="h-3 w-3" />}
        {isNext ? "Next" : "Previous"}
        {isNext && <ArrowRight className="h-3 w-3" />}
      </span>
      <span className="text-foreground group-hover:text-primary mt-0.5 block truncate text-sm font-medium transition-colors">
        {section.title}
      </span>
    </Link>
  );
}

/** One card on the index grid. The summary is the section's own one-liner. */
export function GuideSectionCard({ section }: { section: GuideSection }) {
  const Icon = section.icon ?? BookOpen;
  return (
    <Link
      href={`/guide/${section.slug}`}
      className="border-border hover:border-primary/60 hover:bg-muted/30 group flex min-w-0 flex-col rounded-lg border p-4 transition-colors"
    >
      <span className="text-primary mb-2 inline-flex">
        <Icon className="h-4 w-4" />
      </span>
      <span className="text-foreground group-hover:text-primary text-sm font-semibold transition-colors">
        {section.title}
      </span>
      <span className="text-muted-foreground mt-1 min-w-0 text-xs leading-5">
        {section.summary}
      </span>
    </Link>
  );
}

/**
 * The download control's PRESENTATIONAL half.
 *
 * It owns no fetch and no state. The manual route and its download hook belong
 * to the manual crew (`app/api/guide/manual/`, `use-guide-manual.ts`); this
 * component takes the three things any implementation of that hook can supply,
 * so wiring it is a prop change rather than a rewrite — and so the busy and
 * error states are render-testable without a browser.
 */
export function DownloadManualButton({
  onDownload,
  busy = false,
  error = null,
  className,
}: {
  onDownload?: () => void;
  busy?: boolean;
  error?: string | null;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <button
        type="button"
        onClick={onDownload}
        disabled={busy || !onDownload}
        className="border-border hover:bg-muted/50 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Building the manual…" : "Download the manual (PDF)"}
      </button>
      {error ? <p className="text-warning mt-1.5 text-xs">{error}</p> : null}
    </div>
  );
}
