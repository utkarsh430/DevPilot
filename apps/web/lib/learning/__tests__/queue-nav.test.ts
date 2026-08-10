// The review queue's working-set navigation. The load-bearing case is the
// LAST/ONLY-card Skip: removal must empty the set (so the caller renders the
// "all caught up" state), NOT leave the pointer stuck on the final card — the
// dead-no-op bug an index-only `min(i+1, len-1)` clamp caused.

import { describe, expect, it } from "vitest";
import { removeFromQueue } from "@/lib/learning/queue-nav";

const q = (...ids: string[]) => ids.map((id) => ({ id }));

describe("removeFromQueue", () => {
  it("removing the current (non-last) card slides the next one into its slot", () => {
    const items = q("a", "b", "c");
    const res = removeFromQueue(items, 0, "a");
    expect(res.items.map((x) => x.id)).toEqual(["b", "c"]);
    expect(res.index).toBe(0); // "b" now sits at index 0
    expect(res.items[res.index]?.id).toBe("b");
  });

  it("removing a middle card keeps the pointer, showing the following card", () => {
    const res = removeFromQueue(q("a", "b", "c"), 1, "b");
    expect(res.items.map((x) => x.id)).toEqual(["a", "c"]);
    expect(res.index).toBe(1);
    expect(res.items[res.index]?.id).toBe("c");
  });

  it("LAST/ONLY card: Skip empties the set and the current card becomes undefined", () => {
    const res = removeFromQueue(q("only"), 0, "only");
    expect(res.items).toEqual([]);
    expect(res.index).toBe(0);
    // The caller renders `items[index] ?? null` → null → the "all caught up"
    // empty state. This is the fix: Skip on the last card is NOT a no-op.
    expect(res.items[res.index]).toBeUndefined();
  });

  it("removing the last card of a multi-card set clamps the pointer back one", () => {
    const res = removeFromQueue(q("a", "b", "c"), 2, "c");
    expect(res.items.map((x) => x.id)).toEqual(["a", "b"]);
    expect(res.index).toBe(1);
    expect(res.items[res.index]?.id).toBe("b");
  });

  it("walking a whole batch via Skip terminates at the empty state", () => {
    let items = q("a", "b", "c");
    let index = 0;
    // Skip the current card three times.
    for (let n = 0; n < 3; n++) {
      const cur = items[index]!;
      ({ items, index } = removeFromQueue(items, index, cur.id));
    }
    expect(items).toEqual([]);
    expect(items[index]).toBeUndefined();
  });

  it("an id not in the set is a harmless no-op on the contents", () => {
    const res = removeFromQueue(q("a", "b"), 1, "missing");
    expect(res.items.map((x) => x.id)).toEqual(["a", "b"]);
    expect(res.index).toBe(1);
  });
});
