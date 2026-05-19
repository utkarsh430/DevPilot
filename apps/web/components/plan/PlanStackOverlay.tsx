"use client";

// In-sheet Stack advisor overlay (plan-component revamp Phase 2). Summoned from
// the pinned Stack Strip, it drops the full advisor body over the DIMMED
// transcript — a focused sub-task, not a co-habitant of the chat scroll region.
// Rendered as `absolute inset-0` inside the middle (transcript) region, so it
// sits exactly below the strip and above the composer with no magic offsets:
// a light scrim dims the transcript, and the panel carries its OWN
// `max-h-[60svh] overflow-y-auto` so a tall advisor never fights the chat for
// height again. The header and composer stay put.
//
// The Preferences free-text field lives here now (its one home besides the
// empty-state disclosure) — the old duplicated top-strip copy is retired.
//
// Entrance motion uses tailwindcss-animate utilities, which the global
// prefers-reduced-motion block (globals.css) clamps to ~0ms, so reduced-motion
// users get the resolved final frame.

import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StackAdvisorBody } from "@/components/stack/StackAdvisorBody";
import type { StackAdvisor } from "@/components/stack/use-stack-advisor";
import type { TeamTier } from "@/lib/team-tiers/tiers";

export function PlanStackOverlay({
  advisor,
  teamTier,
  prefs,
  onPrefsChange,
  onClose,
}: {
  advisor: StackAdvisor;
  /** Seeds the advisor density dial's default view (Phase 3). */
  teamTier: TeamTier;
  prefs: string;
  onPrefsChange: (s: string) => void;
  onClose: () => void;
}) {
  // Close on Escape — the overlay is a transient focused layer over the chat.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-20 flex flex-col">
      {/* Scrim over the dimmed transcript — click anywhere off the panel to
          close. A button so it's keyboard/AT reachable. */}
      <button
        type="button"
        aria-label="Close stack advisor"
        onClick={onClose}
        className="bg-background/40 animate-in fade-in-0 absolute inset-0 cursor-default duration-200"
      />

      {/* Panel — drops from below the strip; owns its own scroll. */}
      <div className="bg-card animate-in slide-in-from-top-2 fade-in-0 relative z-10 flex max-h-[60svh] flex-col border-b shadow-lg duration-200">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-6 py-3">
          <div className="font-display text-sm font-semibold">Stack advisor</div>
          <Button variant="ghost" size="xs" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
            Done
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <StackAdvisorBody advisor={advisor} teamTier={teamTier} />

          {/* Preferences — free-text steer, moved here from the old top strip. */}
          <div className="flex flex-col gap-1.5 border-t pt-3">
            <label htmlFor="plan-prefs-overlay" className="text-xs font-medium">
              Preferences <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <Textarea
              id="plan-prefs-overlay"
              rows={2}
              placeholder='e.g. "Postgres OK, no AWS, prefer Vercel"'
              value={prefs}
              onChange={(e) => onPrefsChange(e.target.value)}
              className="text-xs"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
