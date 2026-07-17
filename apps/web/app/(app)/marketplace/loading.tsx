// Marketplace loading state — the route-level fallback shown on soft navigation
// into /marketplace. Same centered max-w-6xl column + header block as the page
// so the resolved surface doesn't shift; the catalog band reuses
// <MarketplaceSkeleton>, shared with the page's inline <Suspense> boundary.
// Tokens only; shimmer honors prefers-reduced-motion.

import { Skeleton } from "@/components/ui/skeleton";
import { MarketplaceSkeleton } from "./marketplace-skeleton";

export default function MarketplaceLoading() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10" aria-busy="true">
      <div className="mb-8">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="mt-2 h-9 w-72 max-w-full" />
        <Skeleton className="mt-3 h-4 w-full max-w-2xl" />
        <Skeleton className="mt-5 h-16 w-full rounded-lg" />
      </div>
      <MarketplaceSkeleton />
    </div>
  );
}
