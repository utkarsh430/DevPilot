"use client";

// The guide's left rail. STATEFUL half — it reads `usePathname`, so it cannot
// live in the render-tested presentational set.
//
// ── Why a rail and not the settings tab strip ──────────────────────────────
//
// `app/(app)/settings/tabs.tsx` is right for ten flat peers and wrong here. The
// guide is 14 pages in 4 chapters: as a horizontal strip it wraps to three rows
// (that file already documents wrapping as its fallback), eats vertical space
// above every page, and — the real cost — communicates no hierarchy at all. A
// reading surface has to answer "where am I in the whole thing", which a flat
// strip cannot.
//
// The active-state VOCABULARY is deliberately the tab strip's, rotated 90°:
// `border-l-2` where tabs use `border-b-2`, same `border-primary` +
// `text-foreground font-semibold` active pair, same muted→foreground hover. A
// reader moving between settings and the guide should not have to learn a second
// idiom for "you are here".
//
// ── Chapters are always expanded ───────────────────────────────────────────
//
// There is no Accordion in this repo (`@radix-ui/react-collapsible` is a
// dependency that zero components import) and the established disclosure
// primitive is a native `<details>`. Neither is used: with 14 sections the whole
// tree fits, and collapsing it would hide the structure the rail exists to show
// behind an interaction. Chapter labels are non-interactive headers because
// chapters have no URL — the same reason breadcrumbs render them as plain text.

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { GUIDE, guideSubsections } from "@/lib/guide/manifest";

export function GuideSidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? "";

  return (
    <nav aria-label="Guide sections" className="min-w-0 text-sm">
      <Link
        href="/guide"
        onClick={onNavigate}
        className={cn(
          "mb-3 block border-l-2 py-1 pl-3 transition-colors",
          pathname === "/guide"
            ? "border-primary text-foreground font-semibold"
            : "text-muted-foreground hover:text-foreground border-transparent",
        )}
      >
        Overview
      </Link>

      {GUIDE.map((chapter) => (
        <div key={chapter.label} className="mb-5 min-w-0">
          <p className="text-muted-foreground mb-1.5 pl-3 text-[11px] font-medium uppercase tracking-wider">
            {chapter.label}
          </p>
          <ul className="min-w-0 space-y-0.5">
            {chapter.sections.map((section) => {
              const href = `/guide/${section.slug}`;
              // Exact match, not `startsWith`: slugs are flat siblings, and a
              // prefix test would light up `runs` while the reader is on
              // `runs-and-traces`.
              const active = pathname === href;
              return (
                <li key={section.slug} className="min-w-0">
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block border-l-2 py-1 pl-3 transition-colors",
                      active
                        ? "border-primary text-foreground font-semibold"
                        : "text-muted-foreground hover:text-foreground hover:border-border border-transparent",
                    )}
                  >
                    {section.title}
                  </Link>
                  {/* Sub-nav for the section being read only. Showing every
                      section's headings at once turns a 14-item rail into a
                      60-item wall and buries the chapter structure. Anchors are
                      the ones lowering computed — never re-derived here. */}
                  {active ? <SubNav slug={section.slug} onNavigate={onNavigate} /> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function SubNav({ slug, onNavigate }: { slug: string; onNavigate?: () => void }) {
  const section = React.useMemo(
    () => GUIDE.flatMap((c) => c.sections).find((s) => s.slug === slug),
    [slug],
  );
  if (!section) return null;
  // `guideSubsections` lowers the body, and the manifest memoises lowering per
  // section — so on every render after the first this is a map lookup, not a
  // re-parse. That memo is also why the rail and the article agree on anchors:
  // both read the SAME lowered blocks rather than each deriving their own.
  const subs = guideSubsections(section);
  if (subs.length === 0) return null;
  return (
    <ul className="border-border/60 ml-3 mt-1 min-w-0 space-y-0.5 border-l pl-3">
      {subs.map((sub) => (
        <li key={sub.anchor} className="min-w-0">
          <Link
            href={`/guide/${slug}#${sub.anchor}`}
            onClick={onNavigate}
            className="text-muted-foreground hover:text-foreground block truncate py-0.5 text-xs transition-colors"
          >
            {sub.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}
