// Phase 1 / M7 — branch-signal parser.
//
// Channel choice (documented for §8b runaway prevention)
// ──────────────────────────────────────────────────────
// A role with a `branches` map signals which branch to take by ending its
// final assistant text with a line of the form:
//
//     next: <branchKey>
//
// where `<branchKey>` matches /^[a-z0-9_-]{1,64}$/. Postprocess runs this
// parser, persists the parsed key onto `runs.branch_key`, and the dispatcher
// reads it back to decide the next role.
//
// Why this channel (vs. a new MCP tool):
//   - Zero new tool routes / engine API surface; the runaway-shape guard
//     (CLAUDE.md §3 / SESSION_HANDOFF.md §8b) stays simple to audit because
//     no new event paths or HTTP endpoints are introduced.
//   - Postprocess already parses role output (PM's description/AC parser),
//     so we extend an existing seam instead of adding a new one.
//   - The signal is durable on `runs.branch_key` (DB), so a dispatcher
//     replay always sees the same value — no Inngest event-payload drift.
//
// Hard constraints:
//   - A missing or unparseable signal → returns `null`. The dispatcher
//     treats `null` as "no decision" and falls back to the state machine.
//   - An invalid character set → `null`. The role's prompt enumerates the
//     allowed keys; anything else is logged as a parse failure and ignored.
//   - The branch key is the FINAL match in the text (so a role can mention
//     the keys earlier without confusing the parser).

const BRANCH_LINE_RE = /(?:^|\n)\s*next\s*:\s*([a-z0-9_-]{1,64})\s*$/i;

/**
 * Parse the branch-signal token from a role's final assistant text.
 * Returns the lowercased branch key if found, null otherwise.
 *
 * Example inputs that match:
 *   "Looks fine.\n\nnext: small_change"
 *   "next: large_change\n"
 *   "Reasoning…\nNEXT: small_change"
 *
 * Example inputs that DO NOT match (return null):
 *   "I'd say next: maybe"             — key has invalid chars
 *   "next: small_change is the call"  — trailing chars on the line
 *   "next:small change"               — spaces in key
 *   ""                                 — empty text
 */
export function parseBranchSignal(finalText: string | null | undefined): string | null {
  if (!finalText || typeof finalText !== "string") return null;
  // Strip a trailing newline so the `\s*$` anchor catches the final line.
  const trimmed = finalText.replace(/\s+$/, "");
  // We want the LAST occurrence — match all then take the final one.
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const m = line.match(/^\s*next\s*:\s*([a-z0-9_-]{1,64})\s*$/i);
    if (m && m[1]) return m[1].toLowerCase();
    // Don't keep scanning past non-empty non-matching trailing lines — the
    // contract is "ends with" not "contains". A non-empty trailing line that
    // isn't a `next:` line means the role didn't follow protocol.
    if (line.trim().length > 0) return null;
  }
  return null;
}

// Re-exported for tests / acceptance scripts. The regex itself is the
// canonical contract — keep it stable across releases.
export const BRANCH_SIGNAL_REGEX = BRANCH_LINE_RE;
