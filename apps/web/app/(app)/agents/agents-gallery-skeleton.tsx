// Shared agents-gallery skeleton. The page keeps its real header (title +
// description + New-agent menu) painting with the shell and streams only the
// role gallery under a <Suspense> boundary, so this mirrors just the
// handoff-diagram band plus a couple of category sections of role cards. The
// route-level `loading.tsx` (soft-navigation fallback) composes the same
// skeleton under a header skeleton. Tokens only; shimmer honors
// prefers-reduced-motion via <Skeleton>.

import { Skeleton } from "@/components/ui/skeleton";

const SECTIONS = [6, 3] as const;

export function AgentsGallerySkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="mb-8 h-40 w-full rounded-lg" />
      <div className="flex flex-col gap-8">
        {SECTIONS.map((cards, s) => (
          <section key={s}>
            <div className="mb-3 flex items-baseline gap-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-6" />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: cards }).map((_, i) => (
                <Skeleton key={i} className="h-40 w-full rounded-lg" />
              ))}
            </div>
          </section>
        ))}
      </div>
      <span className="sr-only">Loading agents…</span>
    </div>
  );
}
