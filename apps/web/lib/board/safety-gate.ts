// Pure policy: may this transition COMPLETE a ticket to `done` right now? (SME
// / human-approval safety gate)
//
// Why this exists
// ───────────────
// Some devpilot tenants build safety-relevant products (e.g. infant-feeding
// guidance — allowed food textures, portion sizes, safe allergens per age
// band). An all-AI flow can otherwise move such a ticket to `done` with no
// qualified human ever reviewing the content. A ticket flagged
// `safety_critical` must therefore never reach `done` on an agent's or the
// engine's say-so — only a real human board approval may complete it.
//
// The rule (one line): a safety-critical ticket may transition to `done` ONLY
// when `actor === "human"`. Any `agent`/`system` `→ done` on a safety-critical
// ticket is BLOCKED; the caller parks it to `blocked` (awaiting human approval)
// instead of completing.
//
// Like `decideQaGate`, this module is deliberately pure — no env, no DB, no
// Next imports — so `__tests__/safety-gate.test.ts` can exercise every branch,
// and so the seam that calls it (`transitionTicket`, keyed on the `actor`
// discriminator) is the single choke point every `→ done` path already flows
// through. Making `actor` mandatory means any FUTURE path that reaches `done`
// is a compile error until it declares its actor, so none can slip past.
//
// NO env flag (contrast with the L1 QA gate's default-off `ENGINEER_QA_GATE_
// ENABLED`). The flag ON THE TICKET is the whole trigger: a safety gate that an
// operator could silently switch off with an env toggle is not a safety gate.
// The gate is active whenever, and only when, a ticket carries the flag.

import type { TicketStatus } from "@/lib/board/state";
import type { TransitionActor } from "@/lib/board/transitions";

export type SafetyGateInput = {
  /** Ticket status the caller is moving to. */
  to: TicketStatus;
  /** Who is driving the move — the same discriminator the L1 gate keys on.
   *  Only `"human"` may complete a safety-critical ticket. */
  actor: TransitionActor;
  /** The `tickets.safety_critical` flag on the ticket being moved. */
  safetyCritical: boolean;
};

export type SafetyGateDecision =
  | { allow: true; skipped: "not-a-completion" | "not-safety-critical" | "human-approval" }
  | { allow: false; code: "safety_approval_required"; reason: string };

/**
 * The park reason surfaced to the human (and, fenced, to the blocking agent).
 * Kept here next to the decision so the wording has one home. Plain text — the
 * caller fences it before it lands in any agent-visible context.
 */
export function safetyApprovalRequiredReason(): string {
  return (
    "safety-critical: requires human approval before Done. This ticket is " +
    "flagged safety-critical, so an agent or the engine cannot complete it — a " +
    "human must review the work and approve it to Done from the board. The " +
    "ticket has been parked to blocked pending that approval; the work itself " +
    "is not rejected."
  );
}

/**
 * Decide whether `to` may proceed for a ticket with this `safetyCritical` flag
 * and `actor`. Pure; safe to call before any write. Only ever BLOCKS the exact
 * intersection — a non-human `→ done` on a safety-critical ticket — and allows
 * everything else unchanged.
 */
export function decideSafetyGate(input: SafetyGateInput): SafetyGateDecision {
  // Only completion is gated. Every other destination is untouched.
  if (input.to !== "done") return { allow: true, skipped: "not-a-completion" };
  // Non-safety-critical tickets are completely unaffected.
  if (!input.safetyCritical) return { allow: true, skipped: "not-safety-critical" };
  // A human board approval is the ONE way a safety-critical ticket completes.
  if (input.actor === "human") return { allow: true, skipped: "human-approval" };

  // Agent or system trying to complete a safety-critical ticket — block.
  return {
    allow: false,
    code: "safety_approval_required",
    reason: safetyApprovalRequiredReason(),
  };
}
