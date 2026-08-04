// Soft-navigation fallback for /learnings — mirrors the page's static header
// plus the streamed queue skeleton, so a hard nav and a soft nav look the same.

import { ReviewQueueSkeleton } from "./learnings-skeleton";

export default function LearningsLoading() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold tracking-tight">Lessons to review</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Candidate lessons the system extracted from agent mistakes. Approve the ones worth
          keeping.
        </p>
      </header>
      <ReviewQueueSkeleton />
    </div>
  );
}
