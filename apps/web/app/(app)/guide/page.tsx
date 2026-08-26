// The guide index: a card grid, chapter by chapter, plus the download CTA.
//
// Everything here is STATIC — the manifest is a typed constant and no request
// touches the database — so this is a synchronous RSC with no `<Suspense>` and
// no loading skeleton. The page-streaming convention (`scoreboard/page.tsx`)
// exists to keep a data fetch off the shell's critical path; there is no fetch
// to keep off it.
//
// The order of the grid is the order of `GUIDE`. There is no `order` field to
// disagree with the array — see the manifest header.

import { GUIDE, GUIDE_SECTIONS } from "@/lib/guide/manifest";
import { GUIDE_FIGURES, guideStaleFigureCount } from "@/lib/guide/figures";
import { GuideSectionCard } from "@/components/guide/chrome";
import { GuideStaleSummary } from "@/components/guide/figure";
import { ManualDownload } from "@/components/guide/manual-download";

export default function GuideIndexPage() {
  const counts = guideStaleFigureCount(GUIDE_FIGURES);
  return (
    <div className="min-w-0">
      <header className="mb-8 max-w-2xl">
        <h1 className="font-display text-2xl font-bold tracking-tight">The DevPilot guide</h1>
        <p className="text-muted-foreground mt-1 text-sm leading-6">
          How the board actually works, what has to be true before an agent runs, and what to do
          when something stalls. {GUIDE_SECTIONS.length} sections, in reading order.
        </p>
        <div className="mt-1.5">
          <GuideStaleSummary stale={counts.stale} total={counts.total} />
        </div>
        {/* Also on the index, not only in the rail: below `lg` the rail is
            behind a sheet, so a reader on a phone would never see the control. */}
        <ManualDownload className="mt-4" />
      </header>

      {GUIDE.map((chapter) => (
        <section key={chapter.label} className="mb-8 min-w-0">
          <h2 className="text-muted-foreground mb-3 text-[11px] font-medium uppercase tracking-wider">
            {chapter.label}
          </h2>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            {chapter.sections.map((section) => (
              <GuideSectionCard key={section.slug} section={section} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
