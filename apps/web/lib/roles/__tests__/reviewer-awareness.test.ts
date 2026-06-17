// Pins the reviewer-awareness gate: a role gets the note only when its run is
// ticket-bound AND its completed ticket lands in_review. The in_review half is
// intentionally broad (not just engineering roles); the ticket half keeps the
// note off ticket-less runs (supervisor spawn, replay of a ticket-less run),
// where the QA review it promises can never happen.

import { describe, expect, it } from "vitest";
import { ROLES } from "@/lib/roles/index";
import {
  applyReviewerAwareness,
  renderReviewerAwarenessBlock,
  REVIEWER_AWARENESS_FENCE_FOOTER,
  REVIEWER_AWARENESS_FENCE_HEADER,
  REVIEWER_AWARENESS_NOTE,
} from "@/lib/roles/reviewer-awareness";

describe("applyReviewerAwareness", () => {
  it("appends the note for a producer role (engineer, onSuccessStatus in_review)", () => {
    const role = ROLES.engineer;
    const result = applyReviewerAwareness(role.systemPrompt, role.onSuccessStatus, true);
    expect(result).toContain(REVIEWER_AWARENESS_NOTE);
    expect(result.startsWith(role.systemPrompt)).toBe(true);
  });

  it.each([
    ["product_manager", ROLES.product_manager],
    ["cto", ROLES.cto],
  ])(
    "appends the note for the non-engineering in_review role %s (breadth is intentional)",
    (_slug, role) => {
      expect(role.onSuccessStatus).toBe("in_review");
      const result = applyReviewerAwareness(role.systemPrompt, role.onSuccessStatus, true);
      expect(result).toContain(REVIEWER_AWARENESS_NOTE);
    },
  );

  it("does not append the note for the QA role itself (onSuccessStatus done, self-driven)", () => {
    const role = ROLES.qa;
    const result = applyReviewerAwareness(role.systemPrompt, role.onSuccessStatus, true);
    expect(result).toBe(role.systemPrompt);
    expect(result).not.toContain(REVIEWER_AWARENESS_NOTE);
  });

  it("does not append the note for a role that doesn't land in in_review (pm -> ready)", () => {
    const role = ROLES.pm;
    const result = applyReviewerAwareness(role.systemPrompt, role.onSuccessStatus, false);
    expect(result).not.toContain(REVIEWER_AWARENESS_NOTE);
  });

  it("suppresses the note on a ticket-less run even for an in_review role", () => {
    const role = ROLES.engineer;
    expect(role.onSuccessStatus).toBe("in_review");
    const result = applyReviewerAwareness(role.systemPrompt, role.onSuccessStatus, false);
    expect(result).toBe(role.systemPrompt);
    expect(result).not.toContain(REVIEWER_AWARENESS_NOTE);
  });

  it("requires both gates — neither ticket-less nor non-in_review alone appends", () => {
    expect(applyReviewerAwareness("BASE PROMPT", "done", true)).toBe("BASE PROMPT");
    expect(applyReviewerAwareness("BASE PROMPT", "in_review", false)).toBe("BASE PROMPT");
    expect(applyReviewerAwareness("BASE PROMPT", "done", false)).toBe("BASE PROMPT");
    expect(applyReviewerAwareness("BASE PROMPT", "in_review", true)).toContain(
      REVIEWER_AWARENESS_NOTE,
    );
  });

  it("fences the note so it never reads as trailing content of the preceding section", () => {
    const result = applyReviewerAwareness("BASE PROMPT", "in_review", true);
    expect(result).toBe(`BASE PROMPT\n\n${renderReviewerAwarenessBlock()}`);
    expect(result).toContain(REVIEWER_AWARENESS_FENCE_HEADER);
    expect(result).toContain(REVIEWER_AWARENESS_FENCE_FOOTER);
  });

  it("is idempotent — a second application does not duplicate the note", () => {
    const once = applyReviewerAwareness("BASE PROMPT", "in_review", true);
    const twice = applyReviewerAwareness(once, "in_review", true);
    expect(twice).toBe(once);
    expect(twice.split(REVIEWER_AWARENESS_NOTE)).toHaveLength(2);
    expect(twice.split(REVIEWER_AWARENESS_FENCE_HEADER)).toHaveLength(2);
  });
});
