// Agents index loading state — the route-level fallback shown on soft
// navigation into /agents. Same centered max-w-6xl column + header block as the
// gallery so the resolved page doesn't shift; the gallery band reuses
// <AgentsGallerySkeleton>, shared with the page's inline <Suspense> boundary.
// Tokens only; shimmer honors prefers-reduced-motion.

import { Skeleton } from "@/components/ui/skeleton";
import { AgentsGallerySkeleton } from "./agents-gallery-skeleton";

export default function AgentsLoading() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-8" aria-busy="true">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-32" />
          <Skeleton className="mt-2 h-4 w-full max-w-2xl" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <AgentsGallerySkeleton />
    </div>
  );
}
