// Reviewer-awareness merge — appends a short note to a reviewed role's
// systemPrompt so the agent knows its work is checked before it's accepted.
//
// Why this file mirrors `lib/skills/merge.ts`: it's merged fresh at dispatch
// time from the stored `RoleConfig`, never baked into `role_config.systemPrompt`
// itself, so editing/duplicating a role in the UI never shows or persists a
// second copy. The note is fenced for the same reason the skill block is —
// so it reads as its own section (role prompts routinely end mid-section) and
// stays grep-able from `run_steps.payload.systemPrompt`.
//
// Gating, both conditions required:
//
//  1. `hasTicket` — the run is bound to a real ticket. The note asserts a
//     ticket/in_review/QA lifecycle, so it would be a lie on a ticket-less run
//     (the supervisor's ad-hoc spawn, a replay of a ticket-less original):
//     there is no ticket to move and no QA hand-off to hold output to.
//  2. `onSuccessStatus === "in_review"` — the existing, accurate signal for
//     "this role's completed ticket is routed to QA" (see `dispatcher.ts`'s
//     in_review → qa routing).
//
// The note therefore fires for EVERY role whose ticket work is actually
// reviewed before Done — built-in or JD-synthesized — and this breadth is
// intentional, not limited to engineering/implementer roles: many
// non-engineering roles (product_manager, cto, vp_engineering,
// marketing_manager, …) land in_review too, so they get the note as well. The
// only roles excluded are those whose `onSuccessStatus` is not "in_review":
// qa/verifier/release_engineer (self-drive to "done"), pm ("ready"), and
// triage ("in_progress").

import type { TicketStatus } from "@/lib/board/state";

export const REVIEWER_AWARENESS_FENCE_HEADER =
  "─── REVIEWER AWARENESS ─────────────────────────────────────";
export const REVIEWER_AWARENESS_FENCE_FOOTER =
  "─── END REVIEWER AWARENESS ─────────────────────────────────";

export const REVIEWER_AWARENESS_NOTE =
  "Your work on this ticket is reviewed before it's accepted: the QA role " +
  "checks it against the ticket's requirements, then approves it to Done or " +
  "rejects it back with the issues to fix. Hold your output to that bar, and " +
  "self-check it against those requirements before you hand off.";

export function renderReviewerAwarenessBlock(): string {
  return [
    REVIEWER_AWARENESS_FENCE_HEADER,
    REVIEWER_AWARENESS_NOTE,
    REVIEWER_AWARENESS_FENCE_FOOTER,
  ].join("\n");
}

export function applyReviewerAwareness(
  systemPrompt: string,
  onSuccessStatus: TicketStatus,
  hasTicket: boolean,
): string {
  if (!hasTicket) return systemPrompt;
  if (onSuccessStatus !== "in_review") return systemPrompt;
  if (systemPrompt.includes(REVIEWER_AWARENESS_FENCE_HEADER)) return systemPrompt;
  return `${systemPrompt}\n\n${renderReviewerAwarenessBlock()}`;
}
