"use client";

// Small client-only board preferences: card density and a reduced-motion hook.
// Kept out of BoardClient so Column / TicketCard can import the type and hook
// without a circular dependency, and so the localStorage plumbing lives in one
// place next to the board components it serves.

import * as React from "react";

/** Card rhythm. "comfortable" is today's default spacing; "compact" tightens
 *  padding and gaps so more tickets fit on screen during a triage sweep. */
export type BoardDensity = "comfortable" | "compact";

export const DEFAULT_DENSITY: BoardDensity = "comfortable";

/**
 * Watch the user's `prefers-reduced-motion` setting. Board motion (drag slide,
 * hover lift, status-change color fades) is decorative, so every animated
 * surface reads this and drops the animation when the user has asked the OS to
 * minimize motion. SSR-safe: returns `false` until mounted, then syncs.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    // Safari <14 only supports addListener; guard for both.
    if (mq.addEventListener) {
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);
  return reduced;
}
