// The project export renders tickets in BUILD ORDER (ticket_number ascending),
// not most-recently-updated first. This is the pure half, so the ordering is a
// test rather than a claim.

import { describe, expect, it } from "vitest";
import { sortByBuildOrder } from "@/lib/export/build-order";

describe("compareByBuildOrder", () => {
  it("orders by ticket_number ascending — first ticket first", () => {
    const ordered = sortByBuildOrder([
      { ticketNumber: 9, createdAt: "2026-07-15T00:00:00.000Z" },
      { ticketNumber: 1, createdAt: "2026-07-01T00:00:00.000Z" },
      { ticketNumber: 5, createdAt: "2026-07-10T00:00:00.000Z" },
    ]);
    expect(ordered.map((t) => t.ticketNumber)).toEqual([1, 5, 9]);
  });

  it("does NOT order by recency — the reported bug was updatedAt DESC", () => {
    // Newest ticket_number is #3 but it was created first; build order is by
    // number, so #3 must still come last, never bubble to the top by any date.
    const ordered = sortByBuildOrder([
      { ticketNumber: 3, createdAt: "2026-07-01T00:00:00.000Z" },
      { ticketNumber: 1, createdAt: "2026-07-20T00:00:00.000Z" },
      { ticketNumber: 2, createdAt: "2026-07-10T00:00:00.000Z" },
    ]);
    expect(ordered.map((t) => t.ticketNumber)).toEqual([1, 2, 3]);
  });

  it("breaks a tie on created_at ascending", () => {
    // Equal numbers should not happen on a real board, but the tiebreak is
    // deterministic: earlier created_at first.
    const ordered = sortByBuildOrder([
      { ticketNumber: 1, createdAt: "2026-07-15T00:00:00.000Z" },
      { ticketNumber: 1, createdAt: "2026-07-01T00:00:00.000Z" },
    ]);
    expect(ordered.map((t) => t.createdAt)).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
    ]);
  });

  it("sorts a null ticket_number after every numbered ticket", () => {
    const ordered = sortByBuildOrder([
      { ticketNumber: null, createdAt: "2026-07-01T00:00:00.000Z" },
      { ticketNumber: 2, createdAt: "2026-07-10T00:00:00.000Z" },
      { ticketNumber: 1, createdAt: "2026-07-05T00:00:00.000Z" },
    ]);
    expect(ordered.map((t) => t.ticketNumber)).toEqual([1, 2, null]);
  });

  it("is a stable no-op when neither side has a usable key", () => {
    // Both null, no dates → comparator returns 0, order preserved.
    const input = [
      { ticketNumber: null, id: "a" },
      { ticketNumber: null, id: "b" },
    ];
    const ordered = sortByBuildOrder(input);
    expect(ordered.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [{ ticketNumber: 2 }, { ticketNumber: 1 }];
    sortByBuildOrder(input);
    expect(input.map((t) => t.ticketNumber)).toEqual([2, 1]);
  });
});
