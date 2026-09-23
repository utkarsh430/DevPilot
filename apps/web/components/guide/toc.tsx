"use client";

// The sticky in-page table of contents, with scroll-spy.
//
// STATEFUL — `IntersectionObserver` and `useState`, so it lives outside the
// render-tested set. The pure part it depends on (which anchors exist, and what
// they are called) is `guideSubsections`, computed once during lowering.
//
// `hidden xl:block`: below `xl` a third column does not fit beside a 240px rail
// and a 672px measure without squeezing the prose past its measure, which is the
// thing the measure exists to protect. The information is not lost — the sidebar
// renders the same anchors as a sub-nav under the active section.
//
// ══════════════════════════════════════════════════════════════════════════
//  TWO SCROLL-SPY DETAILS THAT ARE EASY TO GET WRONG, AND BOTH SHOW UP LATE.
// ══════════════════════════════════════════════════════════════════════════
//
// 1. PICK THE LAST HEADING ABOVE THE THRESHOLD, NOT THE FIRST INTERSECTING
//    ENTRY. The obvious implementation ("highlight whatever is intersecting")
//    breaks for a section shorter than the viewport: scrolled to the bottom of
//    the page, the final heading may never be the topmost intersecting element,
//    so the last TOC item never activates and reads as dead. Deriving the active
//    anchor from POSITIONS — the last heading whose top is above the activation
//    line — has no such hole, and the observer is used only as a cheap "something
//    moved" trigger.
//
// 2. ACTIVATE ON REACHING THE UPPER THIRD, not on touching the viewport edge.
//    A heading that activates the instant its bottom pixel enters the viewport
//    marks a section the reader has not begun; one that waits until the heading
//    scrolls off the top never marks the section they are actually in. The
//    activation line sits below the sticky top bar (`h-14`) at roughly a third
//    of the viewport, which is where a reader's eye is.

import * as React from "react";
import { cn } from "@/lib/cn";
import type { GuideSubsection } from "@/lib/guide/manifest";

/** Matches the shell's `sticky top-0 h-14` bar plus a little breathing room. */
const TOP_BAR_PX = 56;

export function GuideToc({ subsections }: { subsections: readonly GuideSubsection[] }) {
  const [active, setActive] = React.useState<string | null>(subsections[0]?.anchor ?? null);

  React.useEffect(() => {
    if (subsections.length === 0) return;

    const anchors = subsections.map((s) => s.anchor);

    const recompute = () => {
      // The activation line: below the sticky bar, about a third down.
      const line = TOP_BAR_PX + window.innerHeight / 3;
      let current: string | null = anchors[0] ?? null;
      for (const anchor of anchors) {
        const el = document.getElementById(anchor);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= line) current = anchor;
        else break; // Headings are in document order — past the line, done.
      }
      // At the very bottom of the page the last heading may still sit below the
      // line (a short final section). Without this the last item is unreachable.
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      if (atBottom) current = anchors[anchors.length - 1] ?? current;
      setActive(current);
    };

    recompute();

    // The observer is a cheap change trigger, not the source of truth — see (1).
    const observer = new IntersectionObserver(recompute, {
      rootMargin: `-${TOP_BAR_PX}px 0px -66% 0px`,
      threshold: [0, 1],
    });
    for (const anchor of anchors) {
      const el = document.getElementById(anchor);
      if (el) observer.observe(el);
    }
    window.addEventListener("scroll", recompute, { passive: true });
    window.addEventListener("resize", recompute);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
    };
  }, [subsections]);

  if (subsections.length === 0) return null;

  return (
    <nav
      aria-label="On this page"
      className="sticky top-6 hidden max-h-[calc(100vh-6rem)] min-w-0 overflow-y-auto xl:block"
    >
      <p className="text-muted-foreground mb-2 text-[11px] font-medium uppercase tracking-wider">
        On this page
      </p>
      <ul className="min-w-0 space-y-1">
        {subsections.map((sub) => (
          <li key={sub.anchor} className="min-w-0">
            <a
              href={`#${sub.anchor}`}
              aria-current={active === sub.anchor ? "location" : undefined}
              className={cn(
                "block border-l-2 py-0.5 pl-3 text-xs transition-colors",
                active === sub.anchor
                  ? "border-primary text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:border-border border-transparent",
              )}
            >
              {sub.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
