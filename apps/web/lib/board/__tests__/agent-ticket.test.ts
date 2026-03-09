// WI-14 - the pure half of the agent-ticket guardrails. These are the decisions
// the `devpilot_create_ticket` route delegates to, so a regression here is a hole in
// the security envelope, not a cosmetic bug.

import { describe, it, expect } from "vitest";
import {
  AGENT_DESCRIPTION_MAX_CHARS,
  AGENT_TICKET_CAP_LABEL,
  AGENT_TICKET_ENABLE_LABEL,
  AGENT_TITLE_MAX_CHARS,
  DEFAULT_MAX_TICKETS_PER_RUN,
  describeNotEnabledRefusal,
  describeTicketCapRefusal,
  findDuplicateTicket,
  normalizeTicketCeiling,
  normalizeTicketTitle,
  resolveMaxTicketsPerRun,
  validateAgentTicketInput,
} from "@/lib/board/agent-ticket";

describe("normalizeTicketTitle", () => {
  it("collapses case, punctuation and whitespace", () => {
    expect(normalizeTicketTitle("Fix the retry loop!")).toBe("fix the retry loop");
    expect(normalizeTicketTitle("  fix   THE  retry-loop  ")).toBe("fix the retry loop");
    expect(normalizeTicketTitle("Fix the retry_loop.")).toBe("fix the retry loop");
  });

  it("keeps a genuinely different word set distinct", () => {
    expect(normalizeTicketTitle("Fix the retry loop")).not.toBe(
      normalizeTicketTitle("Fix retry loop"),
    );
  });

  it("survives a title made entirely of punctuation", () => {
    expect(normalizeTicketTitle("!!! ???")).toBe("");
  });
});

describe("findDuplicateTicket", () => {
  const open = [
    { id: "t1", title: "Add retry/backoff to the Stripe webhook client" },
    { id: "t2", title: "Write tests for the dispatcher" },
  ];

  it("matches an existing open ticket across punctuation + case drift", () => {
    const hit = findDuplicateTicket("add retry backoff to the STRIPE webhook client!", open);
    expect(hit?.id).toBe("t1");
  });

  it("returns null for genuinely new work", () => {
    expect(findDuplicateTicket("Add a rate limiter to the webhook client", open)).toBeNull();
  });

  it("never matches on an all-punctuation title (which normalizes to empty)", () => {
    // Guards the degenerate case: an empty normalized title must not collide
    // with an existing ticket whose title also normalizes to empty.
    expect(findDuplicateTicket("...", [{ id: "t9", title: "???" }])).toBeNull();
  });
});

describe("resolveMaxTicketsPerRun - project » env » default", () => {
  // The whole point of the project rung: one instance-wide number cannot serve
  // both an engineer noticing stray work (~3) and a decomposition ticket that
  // is supposed to fan out to five or more.
  it("prefers the project rung over the env rung", () => {
    expect(resolveMaxTicketsPerRun({ project: 8, env: "5" })).toEqual({
      max: 8,
      source: "project",
    });
  });

  it("falls through to env when the project has no override", () => {
    // NULL on the column means INHERIT, not "no cap" - if this ever resolved to
    // the project rung, every project would silently pin itself at NULL.
    expect(resolveMaxTicketsPerRun({ project: null, env: "5" })).toEqual({
      max: 5,
      source: "env",
    });
    expect(resolveMaxTicketsPerRun({ project: undefined, env: "5" })).toEqual({
      max: 5,
      source: "env",
    });
  });

  it("falls through to the built-in default when neither rung is set", () => {
    expect(resolveMaxTicketsPerRun({ project: null, env: undefined })).toEqual({
      max: DEFAULT_MAX_TICKETS_PER_RUN,
      source: "default",
    });
  });

  // ── THE SAFETY PROPERTY ───────────────────────────────────────────────────
  // This is the test that must fail if someone "simplifies" the resolver. A
  // ceiling that a typo can switch off is not a ceiling, and the failure is
  // silent: nothing errors, an agent simply files without bound.
  it("never lets a bad value at ANY rung disable the cap", () => {
    const BAD = [undefined, null, "", "abc", "0", "-1", 0, -1, NaN, Infinity, "3.9.1"] as const;

    for (const bad of BAD) {
      // A bad PROJECT value falls THROUGH to the next rung - it does not
      // disable the cap, and it does not short-circuit to the default either
      // (that would silently ignore a perfectly good env setting).
      expect(resolveMaxTicketsPerRun({ project: bad, env: "5" })).toEqual({
        max: 5,
        source: "env",
      });

      // A bad ENV value with no project override lands on the built-in default.
      expect(resolveMaxTicketsPerRun({ project: null, env: bad as string | undefined })).toEqual({
        max: DEFAULT_MAX_TICKETS_PER_RUN,
        source: "default",
      });

      // Both rungs bad: still capped, never unbounded.
      expect(resolveMaxTicketsPerRun({ project: bad, env: bad as string | undefined }).max).toBe(
        DEFAULT_MAX_TICKETS_PER_RUN,
      );
    }
  });

  it("accepts the project rung as a number OR a string, and floors it", () => {
    // The column is an int, but this mapper's value also arrives via the
    // `shell_bootstrap` RPC's jsonb, where it is untyped.
    expect(resolveMaxTicketsPerRun({ project: "8", env: undefined }).max).toBe(8);
    expect(resolveMaxTicketsPerRun({ project: 8.9, env: undefined }).max).toBe(8);
    // Floored, never rounded up: 1.9 is one slot, not two.
    expect(resolveMaxTicketsPerRun({ project: 1.9, env: undefined }).max).toBe(1);
  });
});

describe("normalizeTicketCeiling - the shared predicate", () => {
  it("returns null for every value that must not become a ceiling", () => {
    for (const bad of [undefined, null, "", "abc", "0", "-1", 0, -1, NaN, Infinity]) {
      expect(normalizeTicketCeiling(bad as number | string | null | undefined)).toBeNull();
    }
  });

  it("returns a floored positive integer otherwise", () => {
    expect(normalizeTicketCeiling(1)).toBe(1);
    expect(normalizeTicketCeiling("12")).toBe(12);
    expect(normalizeTicketCeiling(12.7)).toBe(12);
  });
});

// ── THE REFUSAL COPY IS THE FIX ─────────────────────────────────────────────
// A refusal is the ONLY text an operator ever sees of this route: the agent
// quotes it into an escalation and stops. So these assert the operator-visible
// CONTENT, not the structured code - a test that only checked
// `code: "not-enabled"` passes against the copy that caused the incident.
describe("describeNotEnabledRefusal", () => {
  const r = describeNotEnabledRefusal("proj-123");

  it("keeps the structured code the agent's prompt routes on", () => {
    expect(r.code).toBe("not-enabled");
  });

  it("names the exact control AND the page it lives on", () => {
    expect(r.reason).toContain(AGENT_TICKET_ENABLE_LABEL);
    expect(r.reason).toContain("/projects/proj-123");
  });

  it("tells the agent to record what it could not file, and to name the tool", () => {
    // The old copy said only "report the out-of-scope work in a comment", which
    // left the operator with no way to know WHICH setting stopped their agent.
    expect(r.reason).toMatch(/comment/i);
    expect(r.reason).toContain("devpilot_create_ticket");
  });

  it("forbids reporting the unfiled work as done", () => {
    expect(r.reason).toMatch(/do not report/i);
  });
});

describe("describeTicketCapRefusal", () => {
  it("keeps the structured code and states the number", () => {
    const r = describeTicketCapRefusal({ max: 3, source: "default", projectId: "p1" });
    expect(r.code).toBe("ticket-cap");
    expect(r.reason).toContain("3");
  });

  // The partial-decomposition property. An agent that files 3 of 5 and reads
  // the refusal as "fine, that's the limit" leaves a half-decomposition on the
  // board in which the missing children are indistinguishable from children
  // that were never planned.
  it("makes the truncation unmistakable and forbids reporting success", () => {
    const r = describeTicketCapRefusal({ max: 3, source: "project", projectId: "p1" });
    expect(r.reason).toMatch(/THIS TICKET WAS NOT CREATED/);
    expect(r.reason).toMatch(/INCOMPLETE/);
    expect(r.reason).toMatch(/do not report/i);
    // …and says what to do instead, with a count, or the remainder is lost.
    expect(r.reason).toMatch(/comment/i);
    expect(r.reason).toMatch(/how many/i);
  });

  it("names the per-project control on every rung, so 'raise it' is actionable", () => {
    for (const source of ["project", "env", "default"] as const) {
      const r = describeTicketCapRefusal({ max: 4, source, projectId: "p1" });
      expect(r.reason).toContain(AGENT_TICKET_CAP_LABEL);
      expect(r.reason).toContain("/projects/p1");
    }
  });

  it("names the env var only when the env var is what set the number", () => {
    // Telling an operator to edit DEVPILOT_MAX_TICKETS_PER_RUN when their
    // PROJECT is what set the ceiling sends them to a file that will not change
    // anything.
    const fromProject = describeTicketCapRefusal({ max: 9, source: "project", projectId: "p1" });
    expect(fromProject.reason).not.toContain("DEVPILOT_MAX_TICKETS_PER_RUN");
    expect(fromProject.reason).toMatch(/this project's limit is 9/i);

    const fromEnv = describeTicketCapRefusal({ max: 5, source: "env", projectId: "p1" });
    expect(fromEnv.reason).toContain("DEVPILOT_MAX_TICKETS_PER_RUN");
    expect(fromEnv.reason).toMatch(/instance-wide/i);

    const fromDefault = describeTicketCapRefusal({ max: 3, source: "default", projectId: "p1" });
    expect(fromDefault.reason).toMatch(/default/i);
  });
});

describe("validateAgentTicketInput - UNTRUSTED agent text is bounded", () => {
  it("accepts and trims a well-formed pair", () => {
    const res = validateAgentTicketInput({ title: "  Fix the thing  ", description: "  why  " });
    expect(res).toEqual({ ok: true, title: "Fix the thing", description: "why" });
  });

  it("defaults a missing description to empty", () => {
    const res = validateAgentTicketInput({ title: "Fix the thing", description: undefined });
    expect(res.ok && res.description).toBe("");
  });

  it("refuses an over-long title rather than truncating it", () => {
    // Truncation would silently file a DIFFERENT ticket than the agent meant.
    const res = validateAgentTicketInput({
      title: "x".repeat(AGENT_TITLE_MAX_CHARS + 1),
      description: "",
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.refusal.code).toBe("invalid-input");
  });

  it("refuses an over-long description", () => {
    const res = validateAgentTicketInput({
      title: "Fix the thing",
      description: "x".repeat(AGENT_DESCRIPTION_MAX_CHARS + 1),
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.refusal.code).toBe("invalid-input");
  });

  it("refuses a too-short or non-string title", () => {
    expect(validateAgentTicketInput({ title: "ab", description: "" }).ok).toBe(false);
    expect(validateAgentTicketInput({ title: 42, description: "" }).ok).toBe(false);
    expect(validateAgentTicketInput({ title: null, description: "" }).ok).toBe(false);
  });

  it("refuses a non-string description", () => {
    expect(validateAgentTicketInput({ title: "Fix the thing", description: { a: 1 } }).ok).toBe(
      false,
    );
  });
});
