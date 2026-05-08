// Regression coverage for the stuck-in_progress bug (ticket 865345ef):
// a QA run failed (runner disconnect), the ticket was paused + resumed, the
// resume-replay completed 'done' WITHOUT calling devpilot_move_ticket, and nothing
// in the completion path advanced the ticket — it sat in `in_progress`
// forever. `decideTicketReconciliation` is the pure policy that closes that
// gap; these tests reproduce the exact scenario and pin the FSM guarantees.

import { describe, expect, it } from "vitest";
import { canTransition, type TicketStatus } from "@/lib/board/state";
import { decideTicketReconciliation, type ReconcileInput } from "@/lib/engine/reconcile-policy";

function input(overrides: Partial<ReconcileInput>): ReconcileInput {
  return {
    role: "qa",
    onSuccessStatus: "done",
    statusAtRunStart: "in_progress",
    statusNow: "in_progress",
    hasOtherActiveRuns: false,
    postNext: "done",
    moveTicketToolUsed: false,
    ...overrides,
  };
}

describe("decideTicketReconciliation — the captain's stuck ticket", () => {
  it("failed QA run → replayed run completes done without a verdict → ticket parks to blocked", () => {
    // Exact production shape: replay clone of the failed qa run completed
    // 'done', ticket still in_progress, untouched, no sibling runs, no
    // devpilot_move_ticket call ever landed. Remedy CHANGED (2026-07): we no longer
    // re-queue the review (in_progress → in_review) — a fresh review is
    // non-deterministic and can flip a "changes requested" into a spurious
    // approve, unacceptable for a review gate. We park to `blocked` and surface
    // the verdict to a human instead.
    const decision = decideTicketReconciliation(input({}));
    expect(decision).toEqual({
      action: "block",
      reason: expect.stringContaining("verdict"),
    });
  });

  it("replay that lost its role (no seed step) still recovers via dispatch", () => {
    // The replayed run in production carried role=undefined (the failed
    // original persisted no think steps). Even when the role cannot be
    // resolved, the ticket must not stay stuck.
    const decision = decideTicketReconciliation(
      input({ role: null, onSuccessStatus: null, postNext: null }),
    );
    expect(decision.action).toBe("dispatch");
  });
});

describe("decideTicketReconciliation — role-prescribed advancement", () => {
  it("tool-driven engineer-type role (onSuccessStatus=in_review) advances in_progress → in_review", () => {
    const decision = decideTicketReconciliation(
      input({ role: "backend_engineer", onSuccessStatus: "in_review" }),
    );
    expect(decision).toMatchObject({ action: "transition", to: "in_review" });
  });

  it("verdict role stranded at in_review (no verdict recorded) parks to blocked, never force-jumps", () => {
    // The reported bug: a review that concluded but never called devpilot_move_ticket
    // leaves the ticket at its verdict point. We park to blocked (surface the
    // verdict to a human) rather than silently re-dispatching the reviewer.
    const decision = decideTicketReconciliation(
      input({ statusAtRunStart: "in_review", statusNow: "in_review" }),
    );
    expect(decision.action).toBe("block");
  });

  it("never force-approves: a verdict role's onSuccessStatus=done is not applied directly", () => {
    const decision = decideTicketReconciliation(input({}));
    expect(decision).not.toMatchObject({ action: "transition", to: "done" });
  });

  it("role whose onSuccessStatus is illegal from the current state falls back to dispatch", () => {
    // pm has onSuccessStatus=ready; ready is not reachable from in_review.
    const decision = decideTicketReconciliation(
      input({
        role: "pm",
        onSuccessStatus: "ready",
        statusAtRunStart: "in_review",
        statusNow: "in_review",
      }),
    );
    expect(decision.action).toBe("dispatch");
  });
});

describe("decideTicketReconciliation — refusal cases (the run DID advance the ticket, or must not be touched)", () => {
  it("QA approve (ticket now done) → none", () => {
    const decision = decideTicketReconciliation(
      input({ statusAtRunStart: "in_review", statusNow: "done", moveTicketToolUsed: true }),
    );
    expect(decision.action).toBe("none");
  });

  it("QA reject (in_review → in_progress during run) → none", () => {
    const decision = decideTicketReconciliation(
      input({ statusAtRunStart: "in_review", statusNow: "in_progress", moveTicketToolUsed: true }),
    );
    expect(decision.action).toBe("none");
  });

  it("QA no-op reject (same-state move via devpilot_move_ticket) → none; the move route already re-dispatched", () => {
    const decision = decideTicketReconciliation(input({ moveTicketToolUsed: true }));
    expect(decision.action).toBe("none");
  });

  it("another run is still active on the ticket → none", () => {
    const decision = decideTicketReconciliation(input({ hasOtherActiveRuns: true }));
    expect(decision.action).toBe("none");
  });

  it("postprocess already emitted a follow-up dispatch → none", () => {
    const decision = decideTicketReconciliation(input({ postNext: "dispatch" }));
    expect(decision.action).toBe("none");
  });

  it("agent legitimately parked the ticket (input_required / blocked / paused) → none", () => {
    for (const status of ["input_required", "blocked", "paused"] as TicketStatus[]) {
      const decision = decideTicketReconciliation(
        input({ statusAtRunStart: status, statusNow: status }),
      );
      expect(decision.action).toBe("none");
    }
  });

  it("terminal ticket → none", () => {
    for (const status of ["done", "failed"] as TicketStatus[]) {
      const decision = decideTicketReconciliation(
        input({ statusAtRunStart: status, statusNow: status }),
      );
      expect(decision.action).toBe("none");
    }
  });

  it("ticket moved during the run by someone else → none", () => {
    const decision = decideTicketReconciliation(
      input({ statusAtRunStart: "in_progress", statusNow: "in_review" }),
    );
    expect(decision.action).toBe("none");
  });
});

describe("decideTicketReconciliation — FSM legality", () => {
  it("every transition decision is a legal FSM move (no force-jumping)", () => {
    const statuses: TicketStatus[] = [
      "backlog",
      "ready",
      "assigned",
      "in_progress",
      "input_required",
      "blocked",
      "in_review",
      "paused",
      "done",
      "failed",
    ];
    const roles: Array<{ role: string | null; onSuccessStatus: TicketStatus | null }> = [
      { role: "qa", onSuccessStatus: "done" },
      { role: "backend_engineer", onSuccessStatus: "in_review" },
      { role: "pm", onSuccessStatus: "ready" },
      { role: "triage", onSuccessStatus: "in_progress" },
      { role: null, onSuccessStatus: null },
    ];
    for (const status of statuses) {
      for (const r of roles) {
        for (const postNext of ["done", null] as const) {
          const decision = decideTicketReconciliation(
            input({
              ...r,
              statusAtRunStart: status,
              statusNow: status,
              postNext,
            }),
          );
          if (decision.action === "transition") {
            expect(
              canTransition(status, decision.to),
              `illegal ${status} → ${decision.to} for role=${r.role}`,
            ).toBe(true);
          }
          // A `block` decision is applied as a `→ blocked` transition, so it
          // must be an FSM-legal move from the ticket's current status too.
          if (decision.action === "block") {
            expect(
              canTransition(status, "blocked"),
              `illegal ${status} → blocked for role=${r.role}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("sweep mode (no run-start snapshot) still reconciles the captain's ticket shape → blocked", () => {
    const decision = decideTicketReconciliation(input({ statusAtRunStart: null }));
    expect(decision.action).toBe("block");
  });
});

describe("decideTicketReconciliation — sweep-mode false positives (run DID advance the ticket)", () => {
  it("skips a ticket already sitting at the role's onSuccessStatus", () => {
    // Engineer postprocess moved in_progress → in_review; the follow-up QA
    // dispatch was declined (no QA agent / human-review board). The ticket is
    // exactly where the role contract lands it — not stranded.
    const decision = decideTicketReconciliation(
      input({
        role: "backend_engineer",
        onSuccessStatus: "in_review",
        statusAtRunStart: null,
        statusNow: "in_review",
        postNext: null,
      }),
    );
    expect(decision).toMatchObject({
      action: "none",
      reason: expect.stringContaining("success state"),
    });
  });

  it("does NOT skip a verdict role at in_review — a silent review parks to blocked", () => {
    // qa's onSuccessStatus is 'done'; in_review ≠ done, so this is not the
    // "already at success state" false-positive. A silent verdict run at
    // in_review is the reported freeze → park to blocked (was re-dispatch).
    const decision = decideTicketReconciliation(
      input({ statusAtRunStart: null, statusNow: "in_review", postNext: null }),
    );
    expect(decision.action).toBe("block");
  });

  it("event-time path is unaffected: the run-start snapshot remains the evidence", () => {
    // With a snapshot, an unchanged in_review ticket for an engineer role
    // keeps its existing dispatch fallback (the dispatcher decides).
    const decision = decideTicketReconciliation(
      input({
        role: "backend_engineer",
        onSuccessStatus: "in_review",
        statusAtRunStart: "in_review",
        statusNow: "in_review",
        postNext: null,
      }),
    );
    expect(decision.action).toBe("dispatch");
  });
});

describe("decideTicketReconciliation — verdictless review parks to blocked (the reviewer-freeze fix)", () => {
  it("verdict role stranded at in_review with no verdict → block", () => {
    const decision = decideTicketReconciliation(
      input({ role: "qa", statusAtRunStart: "in_review", statusNow: "in_review" }),
    );
    expect(decision).toEqual({ action: "block", reason: expect.stringContaining("verdict") });
  });

  it("verdict role stranded at in_progress with no verdict → block (the live in_progress freeze)", () => {
    // The 86e81e36 repro shape: a reviewer's run left the ticket at in_progress
    // and recorded nothing. From in_progress the dispatcher would send it to the
    // engineer (retry>0) or return role=null (retry=0, hangs) — neither surfaces
    // the missing verdict, so we park to blocked.
    for (const role of ["qa", "verifier", "release_engineer"]) {
      const decision = decideTicketReconciliation(
        input({ role, statusAtRunStart: "in_progress", statusNow: "in_progress" }),
      );
      expect(decision.action, `role=${role}`).toBe("block");
    }
  });

  it("sweep mode (no snapshot) parks a stranded in_progress verdict ticket to blocked", () => {
    const decision = decideTicketReconciliation(
      input({ role: "qa", statusAtRunStart: null, statusNow: "in_progress" }),
    );
    expect(decision.action).toBe("block");
  });

  it("NEVER blocks when the reviewer actually moved the ticket (move tool used) → none", () => {
    // A real reject (in_review → in_progress via devpilot_move_ticket) is a recorded
    // verdict — the run advanced the ticket, so we must not park it.
    const decision = decideTicketReconciliation(
      input({ statusAtRunStart: "in_review", statusNow: "in_progress", moveTicketToolUsed: true }),
    );
    expect(decision.action).toBe("none");
  });

  it("a NON-verdict producer role (onSuccessStatus=in_review) never blocks — it advances", () => {
    // Only verdict roles (onSuccessStatus=done) block; a producer stranded at
    // in_progress advances to its success state (in_review), unchanged.
    const decision = decideTicketReconciliation(
      input({ role: "backend_engineer", onSuccessStatus: "in_review", statusNow: "in_progress" }),
    );
    expect(decision).toMatchObject({ action: "transition", to: "in_review" });
  });

  it("the block decision is a legal FSM move from both in_review and in_progress", () => {
    for (const statusNow of ["in_review", "in_progress"] as TicketStatus[]) {
      const decision = decideTicketReconciliation(
        input({ role: "qa", statusAtRunStart: statusNow, statusNow }),
      );
      expect(decision.action).toBe("block");
      expect(canTransition(statusNow, "blocked"), `${statusNow} → blocked`).toBe(true);
    }
  });
});
