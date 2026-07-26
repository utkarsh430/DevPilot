// Shared skeleton for the lesson review queue. The page keeps its real header
// painting with the shell and streams only the queue under a <Suspense>
// boundary; the route-level `loading.tsx` composes this under a header skeleton.
// Tokens only; shimmer honours prefers-reduced-motion via <Skeleton>.

import { Skeleton } from "@/components/ui/skeleton";

export function ReviewQueueSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <div className="bg-card flex items-center justify-between rounded-xl border px-5 py-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-72" />
        </div>
        <Skeleton className="h-5 w-9 rounded-full" />
      </div>
      <div className="bg-card rounded-xl border">
        <div className="flex flex-col gap-3 border-b px-6 py-5">
          <Skeleton className="h-5 w-24 rounded-md" />
          <Skeleton className="h-6 w-3/4" />
        </div>
        <div className="flex flex-col gap-2 px-6 py-4">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-16 w-full rounded-md" />
        </div>
        <div className="flex gap-2 border-t px-6 py-4">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-20" />
        </div>
      </div>
      <span className="sr-only">Loading lessons…</span>
    </div>
  );
}
