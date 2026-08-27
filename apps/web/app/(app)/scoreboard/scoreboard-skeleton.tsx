// Shared skeleton for /scoreboard. The page keeps its real header painting with
// the shell and streams only the board under <Suspense>; `loading.tsx` composes
// this under a header so hard and soft navs look the same.

import { Skeleton } from "@/components/ui/skeleton";

export function ScoreboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-card flex flex-col gap-2 rounded-xl border p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="bg-card rounded-xl border">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <Skeleton className="h-5 w-32 rounded-md" />
            <Skeleton className="h-3 w-40" />
          </div>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-10/12" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading the scoreboard…</span>
    </div>
  );
}
