// Shared runs-list skeletons. The page keeps its real header (title +
// description) painting with the shell and streams only the table under a
// <Suspense> boundary, so <RunsTableSkeleton> mirrors just the bordered table
// card. The route-level `loading.tsx` (soft-navigation fallback) composes the
// same table skeleton under a header skeleton. Tokens only; shimmer honors
// prefers-reduced-motion via <Skeleton>.

import { Skeleton } from "@/components/ui/skeleton";

export function RunsTableSkeleton() {
  return (
    <div className="bg-card overflow-hidden rounded-lg border" aria-busy="true">
      <div className="flex items-center gap-6 border-b px-4 py-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-20" />
      </div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-6 border-b px-4 py-3 last:border-b-0">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-32" />
        </div>
      ))}
      <span className="sr-only">Loading runs…</span>
    </div>
  );
}
