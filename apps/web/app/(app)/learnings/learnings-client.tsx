"use client";

// The `(app)/learnings` shell: owns the view mode (cards ⇄ table) and the table
// query, and syncs both to the URL.
//
// BOTH views stay live and switchable — the card stack is still the right tool
// for working through a handful of candidates one at a time, and the table is
// the right tool for scanning dozens and sweeping the safe ones. Neither
// replaces the other, so the toggle is the only thing that chooses.
//
// URL sync: `router.replace(..., { scroll: false })` on every query change, so a
// filtered view is shareable/bookmarkable and survives a refresh, without
// stacking a history entry per keystroke. The query is READ from the URL on
// mount (via `useSearchParams`) so a pasted link lands on exactly the same view.

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LayoutGrid, Rows3 } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  type LessonQuery,
  type LessonTableRow,
  parseLessonQuery,
  serializeLessonQuery,
} from "@/lib/learning/table-view";
import { ReviewQueue } from "./queue-client";
import { LessonsTable } from "./table-client";

type ViewMode = "cards" | "table";

export function LearningsClient({
  rows,
  autoApprove,
}: {
  rows: LessonTableRow[];
  autoApprove: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Seed from the URL once; from then on this component owns the state and
  // pushes it back out. (Re-deriving on every `searchParams` change would fight
  // the user's typing, since we write the URL on each keystroke.)
  const [view, setView] = React.useState<ViewMode>(() =>
    searchParams.get("view") === "table" ? "table" : "cards",
  );
  const [query, setQuery] = React.useState<LessonQuery>(() => parseLessonQuery(searchParams));

  const syncUrl = React.useCallback(
    (nextQuery: LessonQuery, nextView: ViewMode) => {
      const qs = serializeLessonQuery(nextQuery, nextView);
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const onQueryChange = React.useCallback(
    (next: LessonQuery) => {
      setQuery(next);
      syncUrl(next, view);
    },
    [syncUrl, view],
  );

  const onViewChange = React.useCallback(
    (next: ViewMode) => {
      setView(next);
      syncUrl(query, next);
    },
    [query, syncUrl],
  );

  // The card stack reviews candidates; that is its whole contract, so it always
  // gets the candidate set regardless of the table's filter.
  const candidates = React.useMemo(() => rows.filter((r) => r.status === "candidate"), [rows]);
  const pendingCount = candidates.length;

  return (
    // The card stack reads best in a narrow, CENTERED measure; the table needs
    // the full page. Constraining the WHOLE column (toggle included) rather than
    // just the cards keeps the "N waiting" bar + view toggle aligned with the
    // cards below them. Centering (not just capping) matters on a wide viewport
    // — a capped-but-left-flush column leaves the right half of the page empty.
    // The page header (page.tsx) centers alongside this in cards view for the
    // same reason: a left-flush heading over a centered column disagrees with
    // itself. Table view is untouched — no cap, no center, full width.
    <div className={cn("flex flex-col gap-4", view === "cards" && "mx-auto max-w-3xl")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-muted-foreground text-sm">
          {pendingCount === 0
            ? "No lessons waiting for review."
            : `${pendingCount} ${pendingCount === 1 ? "lesson is" : "lessons are"} waiting for review.`}
        </span>
        <ViewToggle view={view} onChange={onViewChange} />
      </div>

      {view === "table" ? (
        <LessonsTable
          rows={rows}
          query={query}
          onQueryChange={onQueryChange}
          onMutated={() => router.refresh()}
        />
      ) : (
        <ReviewQueue candidates={candidates} autoApprove={autoApprove} />
      )}
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (next: ViewMode) => void }) {
  const options: Array<{ value: ViewMode; label: string; Icon: typeof Rows3 }> = [
    { value: "cards", label: "Review cards", Icon: LayoutGrid },
    { value: "table", label: "Table", Icon: Rows3 },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Lesson view"
      className="bg-muted/60 inline-flex items-center gap-0.5 rounded-lg border p-0.5"
    >
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={view === value}
          onClick={() => onChange(value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            view === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
