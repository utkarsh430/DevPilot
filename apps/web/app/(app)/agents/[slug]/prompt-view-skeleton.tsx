// Shared by the <Suspense> fallback in page.tsx and the route's loading.tsx, so
// the soft-nav and hard-nav fallbacks cannot diverge (the repo convention for
// every streamed page).

import { Skeleton } from "@/components/ui/skeleton";

export function PromptViewSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-3">
        <Skeleton className="h-10 w-10 rounded-md" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
      </div>
      <Skeleton className="h-36 w-full rounded-lg" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-[32rem] w-full rounded-lg" />
      </div>
    </div>
  );
}
