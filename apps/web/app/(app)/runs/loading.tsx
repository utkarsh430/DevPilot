// Runs index loading state — the route-level fallback on soft navigation into
// /runs. Same container + table rhythm as the runs list (max-w-6xl page,
// header block, bordered table card) so the resolved page doesn't shift. The
// table card reuses <RunsTableSkeleton>, shared with the page's inline
// <Suspense> boundary. Tokens only; shimmer honors prefers-reduced-motion.

import { Skeleton } from "@/components/ui/skeleton";
import { RunsTableSkeleton } from "./runs-list-skeleton";

export default function RunsLoading() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-8" aria-busy="true">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-24" />
          <Skeleton className="mt-2 h-4 w-96 max-w-full" />
        </div>
      </div>
      <RunsTableSkeleton />
    </div>
  );
}
