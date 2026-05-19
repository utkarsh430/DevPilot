// First-run activation - a small set of known-good, repo-generic starter
// tickets. Surfaced two ways: one-click cards on the empty board
// (`FirstRunPanel`) and selectable presets in the New ticket dialog
// (`NewTicketDialog`). Both create the ticket through the same validated
// server-action path a hand-typed ticket uses, so a starter dispatches like
// any other ticket.

export type StarterTicket = {
  /** Stable key for React lists + per-button pending state. */
  id: string;
  /** Ticket title - the short, specific ask. */
  title: string;
  /** One-line pitch shown on the empty-board card. */
  summary: string;
  /** Pre-filled description + acceptance notes dropped into the ticket. */
  description: string;
};

export const STARTER_TICKETS: readonly StarterTicket[] = [
  {
    id: "readme-badge",
    title: "Add a README badge",
    summary: "Surface build or license status at the top of the README.",
    description: [
      "Add a status badge to the top of `README.md`.",
      "",
      "Acceptance:",
      "- A badge (build, license, or version) renders near the top of `README.md`.",
      "- The badge links to its source (CI workflow, license file, or registry page).",
      "- The Markdown renders cleanly with no broken image or link.",
    ].join("\n"),
  },
  {
    id: "fix-lint-warning",
    title: "Fix a lint warning",
    summary: "Clear one existing linter warning without changing behavior.",
    description: [
      "Find and fix a single existing lint warning in the codebase.",
      "",
      "Acceptance:",
      "- The project linter reports one fewer warning than before.",
      "- No runtime behavior changes - the fix is style/quality only.",
      "- Lint, typecheck, and any existing tests still pass.",
    ].join("\n"),
  },
  {
    id: "add-unit-test",
    title: "Add a unit test for an existing function",
    summary: "Cover one already-shipped function with a focused unit test.",
    description: [
      "Pick an existing, under-tested function and add a focused unit test for it.",
      "",
      "Acceptance:",
      "- A new test targets one existing function and asserts its main behavior plus an edge case.",
      "- The test passes against the current implementation (no source changes required).",
      "- The test runs as part of the normal test command.",
    ].join("\n"),
  },
];
