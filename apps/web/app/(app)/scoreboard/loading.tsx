// Soft-navigation fallback for /scoreboard — mirrors the page's static header
// plus the streamed board skeleton, so a hard nav and a soft nav look the same.

import { ScoreboardSkeleton } from "./scoreboard-skeleton";

export default function ScoreboardLoading() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold tracking-tight">Agent scoreboard</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          How reliably each agent lands its work, ranked within comparable roles.
        </p>
      </header>
      <ScoreboardSkeleton />
    </div>
  );
}
