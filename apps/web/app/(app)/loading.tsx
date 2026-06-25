// Route-group loading state — paints instantly inside the app shell (topbar +
// tabs stay interactive) while a page's server payload resolves. Generic page
// rhythm shared by most (app) surfaces: title block, then content cards. All
// tones come from design tokens via <Skeleton> (bg-muted shimmer,
// reduced-motion safe); sections with their own loading.tsx (board, runs,
// settings) override this with a closer-matching skeleton.

import { Skeleton } from "@/components/ui/skeleton";

export default function AppLoading() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-8" aria-busy="true">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-44" />
          <Skeleton className="mt-2 h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
