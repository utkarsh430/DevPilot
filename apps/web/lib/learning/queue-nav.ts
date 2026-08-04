// Pure navigation logic for the lesson review queue's working set. Extracted
// from the "use client" component so it is unit-testable under the node vitest
// env (the queue itself can't load there — it pulls in React + server actions).
//
// The queue is a stack the operator walks down: Accept / Reject SETTLE a card
// (a DB write), Skip DEFERS one (no write — it stays `candidate` for a later
// pass). Both REMOVE the card from the in-session working set and advance, so
// the batch monotonically shrinks toward the empty "all caught up" state — a
// Skip on the last/only card must NOT be a dead no-op (the bug this fixes: an
// index-only `min(i+1, len-1)` clamp left the last card stuck under itself and
// made the empty state unreachable via Skip).

/** Remove the card `id` from the working `items` and return the next working set
 *  + a clamped index. Removing the current card slides the next one into its
 *  slot; removing the last card empties the set (index clamps to 0), so
 *  `items[index]` becomes `undefined` and the caller renders the done state. */
export function removeFromQueue<T extends { id: string }>(
  items: readonly T[],
  index: number,
  id: string,
): { items: T[]; index: number } {
  const next = items.filter((c) => c.id !== id);
  return { items: next, index: Math.min(index, Math.max(0, next.length - 1)) };
}
