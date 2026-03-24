// Shared board skeleton — mirrors the BoardClient chrome (toolbar strip over a
// horizontal row of w-80 lanes) so the resolved board lands on the same
// geometry with zero layout shift. Used both by the route-level `loading.tsx`
// (soft-navigation fallback) and by the page's inline <Suspense> boundary
// (streams while the shell/topbar are already painted). Tokens only; shimmer
// honors prefers-reduced-motion via <Skeleton>.

import { Skeleton } from "@/components/ui/skeleton";

const LANES = [3, 2, 1, 2, 1] as const;

export function BoardSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy="true">
      <header className="bg-background/60 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-6 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-7 w-24" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-7 w-8" />
          <Skeleton className="h-8 w-28" />
        </div>
      </header>
      <div className="flex flex-1 gap-4 overflow-hidden px-6 py-5">
        {LANES.map((cards, i) => (
          <div
            key={i}
            className="bg-muted/30 flex h-full w-80 shrink-0 flex-col gap-2 rounded-xl border p-2"
          >
            <div className="flex items-center gap-2 px-1 py-1.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-6" />
            </div>
            {Array.from({ length: cards }).map((_, j) => (
              <Skeleton key={j} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        ))}
      </div>
      <span className="sr-only">Loading board…</span>
    </div>
  );
}
