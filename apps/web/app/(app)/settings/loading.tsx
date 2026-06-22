// Settings loading state — renders below the (already painted) SettingsTabs
// while a settings page's server payload resolves. Settings pages share a
// centered narrow column (max-w-3xl/4xl) of stacked cards; this fallback uses
// that rhythm. Tokens only; reduced-motion safe.

import { Skeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10" aria-busy="true">
      <div className="mb-8">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-40" />
        </div>
        <Skeleton className="mt-3 h-4 w-96 max-w-full" />
      </div>
      <div className="flex flex-col gap-6">
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
      </div>
      <span className="sr-only">Loading settings…</span>
    </div>
  );
}
