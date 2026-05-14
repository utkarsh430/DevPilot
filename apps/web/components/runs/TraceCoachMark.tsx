"use client";

// A3 — one-time coach mark on the trace view. The trace is the product's
// "aha", so the first time a user lands on a Run Inspector we name what
// they're looking at. Shown exactly once per browser: the localStorage flag
// is written the moment it renders (not on dismiss), so a user who bounces
// mid-read is never re-coached. Purely client-side — no tenant data touched.

import * as React from "react";
import { Sparkles, X } from "lucide-react";
import { getItemWithLegacy } from "@/lib/storage/legacy-key";

const STORAGE_KEY = "devpilot:runs:traceCoachmark";
// Pre-rename key, read-through only — an operator who has already seen the coach
// mark must not be re-coached just because the product was renamed.
const LEGACY_STORAGE_KEY = "ace:runs:traceCoachmark";

export function TraceCoachMark() {
  const [visible, setVisible] = React.useState(false);

  // Decide after mount (localStorage is browser-only); mark seen immediately
  // so it renders once even if the user never explicitly dismisses it.
  React.useEffect(() => {
    try {
      if (getItemWithLegacy(STORAGE_KEY, LEGACY_STORAGE_KEY)) return;
      window.localStorage.setItem(STORAGE_KEY, "1");
      setVisible(true);
    } catch {
      // Storage unavailable (private mode, etc.) — skip rather than nag forever.
    }
  }, []);

  if (!visible) return null;

  return (
    <div
      role="note"
      aria-label="About the live trace"
      className="border-primary/30 bg-primary/10 dp-anim-rise mb-4 flex items-start gap-2.5 rounded-lg border px-4 py-3"
    >
      <Sparkles className="text-primary mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">This is the live trace</p>
        <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
          Every think, tool call, and dollar your agent spends lands here as a step — streamed live,
          and replayable from any point.
        </p>
      </div>
      <button
        type="button"
        onClick={() => setVisible(false)}
        aria-label="Dismiss"
        className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
