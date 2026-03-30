// Board loading state — the route-level fallback shown on soft navigation into
// /board. Shares the exact skeleton geometry the page's inline <Suspense>
// boundary uses (see board-skeleton.tsx) so the two never disagree.

import { BoardSkeleton } from "./board-skeleton";

export default function BoardLoading() {
  return <BoardSkeleton />;
}
