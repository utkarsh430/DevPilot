// Pins the terminal-column re-sort (Done/Failed by ticket_number DESC) and,
// just as importantly, pins that every ACTIVE column's dependency-aware
// column_position order is untouched by it — that's the regression that
// would matter most here, since column_position drives real DAG ordering
// (see computePlacementAfterBlockers in lib/board/topo.ts) and this PR must
// not widen the new sort onto it.

import { describe, expect, it } from "vitest";
import { compareTicketsForColumn, type SortableTicket } from "@/lib/board/column-sort";

function ticket(overrides: Partial<SortableTicket>): SortableTicket {
  return {
    columnPosition: null,
    ticketNumber: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function sortIn(status: Parameters<typeof compareTicketsForColumn>[0], tickets: SortableTicket[]) {
  return tickets.slice().sort((a, b) => compareTicketsForColumn(status, a, b));
}

describe("compareTicketsForColumn — terminal columns (Done/Failed)", () => {
  it("orders Done by ticket_number DESC, numerically not lexicographically", () => {
    // A string/lexicographic sort would put "DevPilot-2" above "DevPilot-11" —
    // the exact bug this test exists to catch once a board has 10+ tickets.
    const c2 = ticket({ ticketNumber: 2 });
    const c10 = ticket({ ticketNumber: 10 });
    const c11 = ticket({ ticketNumber: 11 });

    const sorted = sortIn("done", [c2, c11, c10]);

    expect(sorted).toEqual([c11, c10, c2]);
  });

  it("orders Failed the same way — ticket_number DESC, numeric", () => {
    const c2 = ticket({ ticketNumber: 2 });
    const c10 = ticket({ ticketNumber: 10 });
    const c11 = ticket({ ticketNumber: 11 });

    const sorted = sortIn("failed", [c2, c10, c11]);

    expect(sorted).toEqual([c11, c10, c2]);
  });

  it("ignores column_position entirely in a terminal column", () => {
    // A ticket with a numerically HIGHER column_position (i.e. it would sort
    // later under the active-column rule) must still win on ticket_number.
    const higherPositionLowerNumber = ticket({ columnPosition: 1, ticketNumber: 2 });
    const lowerPositionHigherNumber = ticket({ columnPosition: 99, ticketNumber: 10 });

    const sorted = sortIn("done", [higherPositionLowerNumber, lowerPositionHigherNumber]);

    expect(sorted).toEqual([lowerPositionHigherNumber, higherPositionLowerNumber]);
  });

  it("sinks a ticket with no ticket_number (project-less) to the bottom", () => {
    const numbered = ticket({ ticketNumber: 1 });
    const unnumbered = ticket({ ticketNumber: null });

    expect(sortIn("done", [unnumbered, numbered])).toEqual([numbered, unnumbered]);
    expect(sortIn("failed", [numbered, unnumbered])).toEqual([numbered, unnumbered]);
  });

  it("breaks a ticket_number tie on updated_at DESC", () => {
    // Only reachable in "All projects" view, where ticket_number is unique
    // per PROJECT rather than globally — two different projects can each
    // have their own DevPilot-1.
    const older = ticket({ ticketNumber: 1, updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = ticket({ ticketNumber: 1, updatedAt: "2026-01-02T00:00:00.000Z" });

    expect(sortIn("done", [older, newer])).toEqual([newer, older]);
  });
});

describe("compareTicketsForColumn — active columns are unaffected", () => {
  const ACTIVE_STATUSES = [
    "backlog",
    "ready",
    "assigned",
    "in_progress",
    "input_required",
    "blocked",
    "paused",
    "in_review",
  ] as const;

  it.each(ACTIVE_STATUSES)("orders %s by column_position ASC, never by ticket_number", (status) => {
    // Deliberately the inverse of ticket_number order: a HIGHER ticket_number
    // gets a LOWER column_position. If the terminal-column sort ever leaked
    // into active columns, this would come out ticket_number-DESC instead.
    const first = ticket({ columnPosition: 1, ticketNumber: 50 });
    const second = ticket({ columnPosition: 2, ticketNumber: 20 });
    const third = ticket({ columnPosition: 3, ticketNumber: 5 });

    const sorted = sortIn(status, [third, first, second]);

    expect(sorted).toEqual([first, second, third]);
  });

  it.each(ACTIVE_STATUSES)(
    "in %s, a legacy row with no column_position sinks below DAG-ordered rows",
    (status) => {
      const positioned = ticket({ columnPosition: 5 });
      const legacy = ticket({ columnPosition: null });

      expect(sortIn(status, [legacy, positioned])).toEqual([positioned, legacy]);
    },
  );

  it.each(ACTIVE_STATUSES)("in %s, a column_position tie breaks on updated_at DESC", (status) => {
    const older = ticket({ columnPosition: 1, updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = ticket({ columnPosition: 1, updatedAt: "2026-01-02T00:00:00.000Z" });

    expect(sortIn(status, [older, newer])).toEqual([newer, older]);
  });
});
