// The abandonment fallback - the third seed path, and the one that keeps
// "an empty repo never stays empty" true when a plan is never committed.
//
// Two properties, both load-bearing:
//   • It releases a still-held scaffolder with BASE context (no plan link).
//     An abandoned plan confirmed nothing, so there is nothing to carry.
//   • It is a NO-OP once the row is released - this is what makes it safe to
//     race `commitPlanAction`.

import { describe, it, expect, beforeEach, vi } from "vitest";

type ReleaseResult = { released: true; ticketId: string } | { released: false; reason: string };

const h = vi.hoisted(() => ({
  releaseScaffolder: vi.fn(
    async (_args: unknown): Promise<ReleaseResult> => ({ released: true, ticketId: "tk-1" }),
  ),
}));

vi.mock("@/lib/plan/scaffolder-release.server", () => ({
  releaseScaffolder: h.releaseScaffolder,
}));
// The module builds an Inngest function at import time.
vi.mock("@/lib/engine/inngest", () => ({
  inngest: { createFunction: () => ({}) },
}));

import { releaseHeldScaffolder } from "@/lib/engine/scaffolder-fallback";

beforeEach(() => {
  vi.clearAllMocks();
  h.releaseScaffolder.mockResolvedValue({ released: true, ticketId: "tk-1" });
});

describe("releaseHeldScaffolder", () => {
  it("releases a still-held scaffolder with BASE context - no plan link", async () => {
    const res = await releaseHeldScaffolder({ ticketId: "tk-1", tenantId: "tn" });
    expect(res).toEqual({ ok: true, released: true, ticketId: "tk-1" });
    expect(h.releaseScaffolder).toHaveBeenCalledWith({
      tenantId: "tn",
      ticketId: "tk-1",
      planSessionId: null,
      via: "fallback",
    });
  });

  it("no-ops when the plan commit already released the row", async () => {
    h.releaseScaffolder.mockResolvedValue({ released: false, reason: "not-held" });
    const res = await releaseHeldScaffolder({ ticketId: "tk-1", tenantId: "tn" });
    expect(res).toEqual({ ok: true, released: false, reason: "not-held" });
  });

  it("reports a throw as a no-op instead of failing the durable run", async () => {
    // An expected non-event must not paint the Inngest dashboard red, and a
    // retry storm on a ticket the operator can see in Backlog helps nobody.
    h.releaseScaffolder.mockRejectedValue(new Error("db down"));
    const res = await releaseHeldScaffolder({ ticketId: "tk-1", tenantId: "tn" });
    expect(res.ok).toBe(true);
    expect(res.released).toBe(false);
  });
});
