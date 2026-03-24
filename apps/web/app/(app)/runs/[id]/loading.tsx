// Run Inspector loading state — the route-level fallback shown on soft
// navigation into /runs/[id]. Shares the exact skeleton geometry the page's
// inline <Suspense> boundary uses (see run-inspector-skeleton.tsx).

import { RunInspectorSkeleton } from "./run-inspector-skeleton";

export default function RunInspectorLoading() {
  return <RunInspectorSkeleton />;
}
