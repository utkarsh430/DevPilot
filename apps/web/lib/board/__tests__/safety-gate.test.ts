// Unit coverage for the pure SME safety-gate policy (`lib/board/safety-gate.ts`).
// The exhaustive branch matrix lives here; `transitions-gate.test.ts` proves the
// same policy fires from the REAL `transitionTicket` seam.

import { describe, it, expect } from "vitest";
import { decideSafetyGate, safetyApprovalRequiredReason } from "@/lib/board/safety-gate";
import type { TransitionActor } from "@/lib/board/transitions";
import type { TicketStatus } from "@/lib/board/state";

const ACTORS: TransitionActor[] = ["human", "agent", "system"];

describe("decideSafetyGate — the one blocked intersection", () => {
  it("BLOCKS an agent → done on a safety-critical ticket", () => {
    const d = decideSafetyGate({ to: "done", actor: "agent", safetyCritical: true });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.code).toBe("safety_approval_required");
      expect(d.reason).toBe(safetyApprovalRequiredReason());
    }
  });

  it("BLOCKS a system → done on a safety-critical ticket", () => {
    const d = decideSafetyGate({ to: "done", actor: "system", safetyCritical: true });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("safety_approval_required");
  });
});

describe("decideSafetyGate — allow paths", () => {
  it("ALLOWS a human → done on a safety-critical ticket (the approval)", () => {
    const d = decideSafetyGate({ to: "done", actor: "human", safetyCritical: true });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.skipped).toBe("human-approval");
  });

  it("ALLOWS any actor → done on a NON-safety-critical ticket", () => {
    for (const actor of ACTORS) {
      const d = decideSafetyGate({ to: "done", actor, safetyCritical: false });
      expect(d.allow).toBe(true);
      if (d.allow) expect(d.skipped).toBe("not-safety-critical");
    }
  });

  it("ALLOWS every non-done destination even for a safety-critical ticket, any actor", () => {
    const nonDone: TicketStatus[] = [
      "backlog",
      "ready",
      "assigned",
      "in_progress",
      "input_required",
      "blocked",
      "in_review",
      "paused",
      "failed",
    ];
    for (const to of nonDone) {
      for (const actor of ACTORS) {
        const d = decideSafetyGate({ to, actor, safetyCritical: true });
        expect(d.allow, `${actor} → ${to} must be allowed`).toBe(true);
        if (d.allow) expect(d.skipped).toBe("not-a-completion");
      }
    }
  });
});

describe("decideSafetyGate — full matrix is exhaustive", () => {
  it("blocks ONLY {agent,system} × done × safetyCritical, nothing else", () => {
    for (const safetyCritical of [true, false]) {
      for (const actor of ACTORS) {
        const d = decideSafetyGate({ to: "done", actor, safetyCritical });
        const shouldBlock = safetyCritical && actor !== "human";
        expect(d.allow, `${actor} done sc=${safetyCritical}`).toBe(!shouldBlock);
      }
    }
  });
});
