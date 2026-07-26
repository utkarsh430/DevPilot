// Shared marketplace skeleton. The page keeps its real header (eyebrow, title,
// blurb, security note) painting with the shell and streams only the catalog
// (search + tabs + card grid) under a <Suspense> boundary, so this mirrors just
// that region. The route-level `loading.tsx` (soft-navigation fallback) composes
// the same skeleton under a header skeleton. Tokens only; shimmer honors
// prefers-reduced-motion via <Skeleton>.

import { Skeleton } from "@/components/ui/skeleton";

export function MarketplaceSkeleton() {
  return (
    <div aria-busy="true">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Skeleton className="h-9 w-full max-w-sm" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="mb-6 flex items-center gap-2">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-44 w-full rounded-lg" />
        ))}
      </div>
      <span className="sr-only">Loading marketplace…</span>
    </div>
  );
}
