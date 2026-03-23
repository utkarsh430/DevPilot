// Shared Run Inspector skeleton — breadcrumb line, header card, then the step
// tree column, matching the Inspector's max-w-6xl py-6 rhythm so nothing jumps
// when the run resolves. Used by both the route-level `loading.tsx`
// (soft-navigation fallback) and the page's inline <Suspense> boundary (streams
// while the shell/topbar are already painted). Tokens only; reduced-motion safe.

import { Skeleton } from "@/components/ui/skeleton";

export function RunInspectorSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-6" aria-busy="true">
      <div className="mb-4 flex items-center gap-1.5">
        <Skeleton className="h-3.5 w-14" />
        <Skeleton className="h-3.5 w-3.5" />
        <Skeleton className="h-3.5 w-20" />
      </div>
      <Skeleton className="mb-4 h-32 w-full rounded-lg" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
      <span className="sr-only">Loading run…</span>
    </div>
  );
}
