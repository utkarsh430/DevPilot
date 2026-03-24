// Pins the one composition seam every ticket-bound dispatch path shares: the
// reviewer-awareness note precedes the installed-skill fence, both layers are
// optional, the note is gated on the run actually having a ticket, and
// re-composing an already-composed prompt never duplicates a block.

import { describe, expect, it } from "vitest";
import { composeRoleSystemPrompt } from "@/lib/roles/compose-prompt";
import {
  REVIEWER_AWARENESS_FENCE_HEADER,
  REVIEWER_AWARENESS_NOTE,
} from "@/lib/roles/reviewer-awareness";
import { SKILL_FENCE_HEADER } from "@/lib/skills/merge";
import { OVERLAY_FENCE_HEADER, OVERLAY_PRECEDENCE_NOTE } from "@/lib/roles/overlay";
import type { SelectedSkill } from "@/lib/skills/select";

const SKILLS: SelectedSkill[] = [
  { id: "s1", name: "commit-hygiene", version: "1.0.0", body: "SKILL BODY", score: 1 },
];

describe("composeRoleSystemPrompt", () => {
  it("appends the reviewer-awareness note before the skill fence", () => {
    const result = composeRoleSystemPrompt(
      { systemPrompt: "BASE PROMPT", onSuccessStatus: "in_review" },
      SKILLS,
      true,
      null,
    );
    expect(result.startsWith("BASE PROMPT")).toBe(true);
    expect(result.indexOf(REVIEWER_AWARENESS_FENCE_HEADER)).toBeLessThan(
      result.indexOf(SKILL_FENCE_HEADER),
    );
  });

  it("composes the reviewer note alone when no skills are selected (ticket-bound replay)", () => {
    const result = composeRoleSystemPrompt(
      { systemPrompt: "BASE PROMPT", onSuccessStatus: "in_review" },
      [],
      true,
      null,
    );
    expect(result).toContain(REVIEWER_AWARENESS_NOTE);
    expect(result).not.toContain(SKILL_FENCE_HEADER);
  });

  it("omits the reviewer note on a ticket-less run (supervisor ad-hoc spawn)", () => {
    const result = composeRoleSystemPrompt(
      { systemPrompt: "BASE PROMPT", onSuccessStatus: "in_review" },
      [],
      false,
      null,
    );
    expect(result).toBe("BASE PROMPT");
  });

  it("still merges skills on a ticket-less run — hasTicket gates only the note", () => {
    const result = composeRoleSystemPrompt(
      { systemPrompt: "BASE PROMPT", onSuccessStatus: "in_review" },
      SKILLS,
      false,
      null,
    );
    expect(result).toContain(SKILL_FENCE_HEADER);
    expect(result).not.toContain(REVIEWER_AWARENESS_NOTE);
  });

  it("composes the skill fence alone when the role isn't QA-reviewed", () => {
    const result = composeRoleSystemPrompt(
      { systemPrompt: "BASE PROMPT", onSuccessStatus: "done" },
      SKILLS,
      true,
      null,
    );
    expect(result).toContain(SKILL_FENCE_HEADER);
    expect(result).not.toContain(REVIEWER_AWARENESS_NOTE);
  });

  it("returns the bare prompt when neither layer applies", () => {
    const result = composeRoleSystemPrompt(
      { systemPrompt: "BASE PROMPT", onSuccessStatus: "done" },
      [],
      true,
      null,
    );
    expect(result).toBe("BASE PROMPT");
  });

  it("never doubles the reviewer note when re-composing an already-composed prompt", () => {
    const once = composeRoleSystemPrompt(
      { systemPrompt: "BASE PROMPT", onSuccessStatus: "in_review" },
      [],
      true,
      null,
    );
    const twice = composeRoleSystemPrompt(
      { systemPrompt: once, onSuccessStatus: "in_review" },
      [],
      true,
      null,
    );
    expect(twice).toBe(once);
    expect(twice.split(REVIEWER_AWARENESS_FENCE_HEADER)).toHaveLength(2);
  });
});

// ── Phase 2: the operator overlay ─────────────────────────────────────────
//
// The three properties the whole design rests on:
//   1. the overlay REACHES the composed prompt, in the right position;
//   2. an ABSENT overlay changes nothing — byte-identical to pre-overlay;
//   3. Clear (which makes the overlay absent again) restores exactly that.
describe("composeRoleSystemPrompt — operator overlay", () => {
  const CONFIG = { systemPrompt: "BASE PROMPT", onSuccessStatus: "in_review" } as const;
  const OVERLAY = "Prefer small, reviewable changes.";

  it("places the overlay AFTER the role contract and BEFORE the skill fence", () => {
    const result = composeRoleSystemPrompt(CONFIG, SKILLS, true, OVERLAY);

    // Base first — the shipped prompt is never displaced.
    expect(result.startsWith("BASE PROMPT")).toBe(true);
    // Reviewer awareness belongs to the contract, so it precedes the overlay.
    expect(result.indexOf(REVIEWER_AWARENESS_FENCE_HEADER)).toBeLessThan(
      result.indexOf(OVERLAY_FENCE_HEADER),
    );
    // The operator outranks an installed bundle he did not write.
    expect(result.indexOf(OVERLAY_FENCE_HEADER)).toBeLessThan(result.indexOf(SKILL_FENCE_HEADER));
    expect(result).toContain(OVERLAY);
  });

  it("carries the precedence prose that subordinates it to the contract", () => {
    const result = composeRoleSystemPrompt(CONFIG, [], true, OVERLAY);
    expect(result).toContain(OVERLAY_PRECEDENCE_NOTE);
    // The three things the fence must deny, in the model's own view.
    expect(result).toContain("do NOT change the ticket state machine");
    expect(result).toContain("the contract above wins");
  });

  it("reaches a ticket-less run too — the overlay is a property of the ROLE", () => {
    // A supervisor's ad-hoc child, or a replay of a ticket-less original.
    const result = composeRoleSystemPrompt(CONFIG, [], false, OVERLAY);
    expect(result).toContain(OVERLAY);
    // …while `hasTicket` still correctly gates the reviewer note.
    expect(result).not.toContain(REVIEWER_AWARENESS_NOTE);
  });

  it("an ABSENT overlay is byte-identical to composing without one", () => {
    // The property that makes every pre-overlay dispatch unchanged. Asserted
    // for all three absent spellings, since the DB and the editor can produce
    // each of them.
    for (const absent of [null, undefined, "", "   \n  "]) {
      expect(composeRoleSystemPrompt(CONFIG, SKILLS, true, absent as string | null)).toBe(
        composeRoleSystemPrompt(CONFIG, SKILLS, true, null),
      );
    }
    // …and that baseline contains no overlay trace at all.
    const baseline = composeRoleSystemPrompt(CONFIG, SKILLS, true, null);
    expect(baseline).not.toContain(OVERLAY_FENCE_HEADER);
  });

  // NOTE: the "CLEAR restores exactly the pre-overlay bytes" property is
  // asserted in `overlay-store-tenant-scope.test.ts`, driven through the REAL
  // `clearRoleOverlay` + `loadRoleOverlayBody` against a filter-applying fake.
  // It deliberately does NOT live here: two calls to this pure function with the
  // same `null` argument are equal by definition, so asserting it at this level
  // would be a tautology that passes with the clear path deleted.

  it("never doubles the overlay when re-composing an already-composed prompt", () => {
    const once = composeRoleSystemPrompt(CONFIG, [], true, OVERLAY);
    const twice = composeRoleSystemPrompt(
      { systemPrompt: once, onSuccessStatus: "in_review" },
      [],
      true,
      OVERLAY,
    );
    expect(twice).toBe(once);
    expect(twice.split(OVERLAY_FENCE_HEADER)).toHaveLength(2);
  });
});
