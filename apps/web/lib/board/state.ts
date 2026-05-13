// Ticket state machine. Pure, side-effect free — callers do the DB write.
// Matches CLAUDE.md exactly. Phase 0 explicitly allows ready→in_progress
// (Dispatcher path) and in_progress→ready (PM hand-off path) so the
// PM→Engineer→QA loop maps cleanly onto the canonical states.

export type TicketStatus =
  | "backlog"
  | "ready"
  | "assigned"
  | "in_progress"
  | "input_required"
  | "blocked"
  | "in_review"
  | "paused"
  | "done"
  | "failed";

// `paused` is operator-initiated (Pause button or runner-watchdog auto-pause
// on runner disconnect). Distinct from `input_required`, which means the
// agent itself asked a human; `paused` is the human pausing the agent.
// Resume reuses the replay primitive — see lib/engine/pause-resume.ts.
export const ALLOWED_TRANSITIONS: Record<TicketStatus, ReadonlyArray<TicketStatus>> = {
  backlog: ["ready", "failed"],
  ready: ["assigned", "in_progress", "backlog", "failed"],
  assigned: ["in_progress", "ready", "paused", "failed"],
  // `in_progress → backlog` / `input_required → backlog` / `blocked → backlog` are
  // the operator "Discard & restart from dev" reset edges: they take a NON-done,
  // partially-completed ticket back to the backlog so it can be re-dispatched
  // fresh off the integration branch after its uncommitted/unpushed work is
  // deliberately discarded. Like `done → backlog`, these edges are HUMAN-ONLY —
  // an agent or engine path must NEVER reset a ticket to backlog (it would abandon
  // in-flight work and, via the discard action's force flag, wipe the workspace).
  // That actor restriction is NOT expressible in this actor-agnostic table, so it
  // is enforced at the `transitionTicket` seam (`decideReopenGate`,
  // lib/board/reopen-policy.ts), which every `→ backlog` path flows through — the
  // same bypass-proof shape as the reopen and safety gates.
  in_progress: [
    "ready",
    "in_review",
    "input_required",
    "blocked",
    "paused",
    "backlog",
    "done",
    "failed",
  ],
  input_required: ["in_progress", "paused", "backlog", "failed"],
  // `blocked → done` exists for the SME safety gate: when an agent/system tries
  // to complete a `safety_critical` ticket, the seam refuses and parks it to
  // `blocked` (see lib/board/safety-gate.ts), and the captain approves it to
  // Done from there. It doubles as a general human override (an operator can
  // close out a blocked ticket). A NON-human `→ done` from any state — blocked
  // included — is still refused by the safety gate for a safety-critical ticket,
  // and no engine path (reconciler/aggregator/scheduler) ever targets `done`,
  // so widening this edge does not open a non-human completion path.
  blocked: ["in_progress", "paused", "backlog", "done", "failed"],
  // `blocked` is reachable from in_review so the engine can park a review that
  // completed WITHOUT a verdict (a reviewer/verdict role that never called
  // devpilot_move_ticket) instead of silently freezing it — see the verdictless-
  // review branch in lib/engine/reconcile-policy.ts. blocked is reversible.
  in_review: ["in_progress", "blocked", "paused", "done", "failed"],
  paused: ["in_progress", "backlog", "failed"],
  // `done → backlog` is the operator "Restart from dev" reopen edge: it takes a
  // finished ticket back to the backlog so it can be re-dispatched against the
  // now-accumulated integration branch. `done` is otherwise terminal, and this
  // edge is HUMAN-ONLY — a re-run of a finished ticket is an operator decision,
  // never an agent/engine one. That actor restriction is NOT expressible in this
  // actor-agnostic table, so it is enforced at the `transitionTicket` seam
  // (`decideReopenGate`, lib/board/reopen-policy.ts), which every `→ backlog`
  // path flows through — the same bypass-proof shape as the safety gate.
  done: ["backlog"],
  failed: [],
};

export const TERMINAL_STATUSES: ReadonlySet<TicketStatus> = new Set(["done", "failed"]);

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TicketStatus, to: TicketStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid ticket transition: ${from} → ${to}`);
  }
}

export function isTerminal(s: TicketStatus): boolean {
  return TERMINAL_STATUSES.has(s);
}
