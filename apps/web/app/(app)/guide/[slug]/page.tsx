// One guide section.
//
// Synchronous RSC with no `<Suspense>`: the manifest is a typed constant and
// lowering is pure and memoised, so there is no request to keep off the shell's
// critical path. `generateStaticParams` enumerates the manifest, which also
// means a slug that is not in it is a real 404 rather than an empty page.
//
// ── Three columns, and why the middle one is capped twice ──────────────────
//
// The article column is `max-w-3xl`; `GuideProse`'s own root is `max-w-2xl`. So
// prose sits at roughly 70 characters while figures, code and tables fill the
// wider column (a figure bleeds the 6rem difference — see `doc-blocks.tsx`).
// The right-hand TOC is `hidden xl:block`: below that, a third column cannot
// coexist with a 240px rail and a readable measure.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  GUIDE_BY_SLUG,
  GUIDE_CHAPTER_BY_SLUG,
  GUIDE_SECTIONS,
  guidePager,
  guideSubsections,
  lowerGuideSection,
} from "@/lib/guide/manifest";
import { figureById } from "@/lib/guide/figures";
import { GuideProse } from "@/components/guide/doc-blocks";
import { GuideBreadcrumbs, GuidePagerNav } from "@/components/guide/chrome";
import { GuideToc } from "@/components/guide/toc";

type Params = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return GUIDE_SECTIONS.map((s) => ({ slug: s.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const section = GUIDE_BY_SLUG.get(slug);
  if (!section) return { title: "Guide" };
  // The summary is already the section's one-sentence description — the same
  // string the index card and the PDF's TOC subtitle use. One sentence, three
  // consumers, no second place to disagree.
  return { title: `${section.title} · Guide`, description: section.summary };
}

export default async function GuideSectionPage({ params }: Params) {
  const { slug } = await params;
  const section = GUIDE_BY_SLUG.get(slug);
  if (!section) notFound();

  const chapter = GUIDE_CHAPTER_BY_SLUG.get(slug);
  const blocks = lowerGuideSection(section);
  const subsections = guideSubsections(section);
  const pager = guidePager(slug);

  return (
    <div className="flex min-w-0 gap-10">
      <article className="min-w-0 max-w-3xl flex-1">
        <GuideBreadcrumbs chapterLabel={chapter?.label ?? "Guide"} sectionTitle={section.title} />

        <header className="mb-6 max-w-2xl">
          {/* The page h1 comes from the manifest, which is why `lower.ts` treats
              a depth-1 heading in a body as an authoring ERROR: a body cannot
              introduce a second page title. */}
          <h1 className="font-display text-2xl font-bold tracking-tight">{section.title}</h1>
          <p className="text-muted-foreground mt-1 text-sm leading-6">{section.summary}</p>
        </header>

        <GuideProse blocks={blocks} figureFor={figureById} />
        <GuidePagerNav pager={pager} />
      </article>

      <div className="hidden w-56 shrink-0 xl:block">
        <GuideToc subsections={subsections} />
      </div>
    </div>
  );
}
