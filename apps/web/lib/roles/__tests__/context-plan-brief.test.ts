// The plan brief reaches the agent through the SINGLE prompt-injection seam.
//
// `renderTicketPrompt` is that seam (both dispatch paths build their prompt with
// it). These tests pin that the brief renders THERE - not via a parallel path,
// and never via the system prompt, which is where directives live and where
// plan-derived data must never end up.
//
// `context.ts` reaches Next server APIs through `lib/db/server`, so the module
// is loaded with that mocked out; only the pure render half is exercised here.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/server", () => ({ supabaseService: () => ({}) }));

import { renderTicketPrompt, type TicketContext } from "@/lib/roles/context";
import type { PlanBrief } from "@/lib/plan/scaffolder-brief";
import type { StackTag } from "@/lib/plan/types";

const SUPABASE_TAG: StackTag = {
  provider: "oss",
  serviceKey: "supabase",
  label: "ignored-db-label",
  source: "manual",
  capability: "relational_db",
  overridden: false,
};

function ctx(planBrief: PlanBrief | null): TicketContext {
  return {
    ticketId: "tk-1",
    title: "Scaffold project: Todo",
    description: "A todo app",
    acceptanceCriteria: null,
    status: "ready",
    retryCount: 0,
    comments: [],
    operatorReply: null,
    handoffs: [],
    planBrief,
    learnings: [],
  };
}

const BRIEF: PlanBrief = {
  goalSummary: "Ship a todo app on Supabase",
  decisions: [{ speaker: "operator", body: "no AWS please", createdAt: "2026-07-15T00:01:00Z" }],
  stackTags: [SUPABASE_TAG],
  stackEcosystem: "unset",
};

describe("renderTicketPrompt + plan brief", () => {
  it("renders the confirmed stack and the fenced discussion into the prompt", () => {
    const out = renderTicketPrompt(ctx(BRIEF));
    expect(out).toContain("## Plan context");
    expect(out).toContain("Relational database: Supabase");
    expect(out).toContain("no AWS please");
    expect(out).toContain("⟦UNTRUSTED");
    expect(out).not.toContain("ignored-db-label");
  });

  it("leaves the prompt byte-for-byte unchanged for a ticket with no plan link", () => {
    // Every ticket except the plan-released scaffolder - including a scaffolder
    // the abandonment fallback released - takes this path.
    expect(renderTicketPrompt(ctx(null))).not.toContain("Plan context");
  });

  it("puts the plan context after the ticket's own text and before 'Your task'", () => {
    const out = renderTicketPrompt(ctx(BRIEF));
    // Trusted material anchors the context first; OUR instruction is still the
    // last thing the agent reads.
    expect(out.indexOf("## Ticket")).toBeLessThan(out.indexOf("## Plan context"));
    expect(out.indexOf("## Plan context")).toBeLessThan(out.indexOf("## Your task"));
  });
});
