// Behavioural tests for `assertCanProceed` — the actual orchestration of
// `decideBudgetCeiling` + `decideVelocityBreaker` against a run row and the
// tenant's velocity bucket. The pure decisions themselves are covered
// exhaustively in `budget-ceiling-policy.test.ts`; this file proves
// `assertCanProceed` calls them with the right inputs and throws the right
// shape of error, following the mocking pattern established in
// `lib/board/__tests__/board-actions-move-cas.test.ts` (fake `@/lib/db/server`
// so the real module, which reaches `next/headers`, is never loaded).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NonRetriableError } from "inngest";

type RunRow = {
  tenant_id: string | null;
  budget_cents: number;
  spent_cents: number;
  status: string;
};

const h = vi.hoisted(() => ({
  runRow: null as RunRow | null,
  runError: null as { message: string } | null,
  redisBucket: 0 as number | null,
  redisThrows: false,
}));

vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({
    from: (table: string) => {
      if (table !== "runs") throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: h.runRow, error: h.runError }),
          }),
        }),
      };
    },
  }),
}));

vi.mock("@/lib/cache/redis", () => ({
  redis: () => ({
    get: async () => {
      if (h.redisThrows) throw new Error("redis unreachable");
      return h.redisBucket;
    },
    incrby: vi.fn(async () => {}),
    expire: vi.fn(async () => {}),
  }),
}));

import { assertCanProceed } from "@/lib/engine/budget";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  h.runRow = { tenant_id: "tenant-1", budget_cents: 500, spent_cents: 0, status: "running" };
  h.runError = null;
  h.redisBucket = 0;
  h.redisThrows = false;
});

describe("assertCanProceed", () => {
  it("a run comfortably under its cap is never stopped", async () => {
    h.runRow!.spent_cents = 100;
    const result = await assertCanProceed(RUN_ID, "llm");
    expect(result).toEqual({ spentCents: 100, budgetCents: 500, remainingCents: 400 });
  });

  it("a run that has spent its whole budget is refused", async () => {
    h.runRow!.spent_cents = 500;
    await expect(assertCanProceed(RUN_ID, "llm")).rejects.toBeInstanceOf(NonRetriableError);
    await expect(assertCanProceed(RUN_ID, "llm")).rejects.toThrow(/^budget exceeded for llm/);
  });

  it("a run that has already overshot its cap (the measured worst case) is refused", async () => {
    // 996¢ against a 500¢ cap — the worst-case overshoot from the incident
    // this fix closes. The NEXT check must still refuse.
    h.runRow!.spent_cents = 996;
    await expect(assertCanProceed(RUN_ID, "llm")).rejects.toThrow(NonRetriableError);
  });

  it("overrideCap lets an over-cap run continue", async () => {
    h.runRow!.spent_cents = 996;
    const result = await assertCanProceed(RUN_ID, "llm", { overrideCap: true });
    expect(result.remainingCents).toBe(500 - 996);
  });

  it("the same over-cap run stops when overrideCap is off — proves the setting actually gates the behaviour", async () => {
    h.runRow!.spent_cents = 996;
    await expect(assertCanProceed(RUN_ID, "llm", { overrideCap: false })).rejects.toThrow(
      NonRetriableError,
    );
    await expect(assertCanProceed(RUN_ID, "llm", { overrideCap: true })).resolves.toBeDefined();
  });

  it("overrideCap never bypasses the tenant velocity breaker (the backstop)", async () => {
    h.runRow!.spent_cents = 996; // would also be over its own cap
    h.redisBucket = 500; // at the default $5/min tenant limit
    await expect(assertCanProceed(RUN_ID, "llm", { overrideCap: true })).rejects.toThrow(
      /^tenant velocity circuit breaker tripped/,
    );
  });

  it("the velocity breaker refuses even a run that is well under its own cap", async () => {
    h.runRow!.spent_cents = 10;
    h.redisBucket = 500;
    await expect(assertCanProceed(RUN_ID, "llm")).rejects.toThrow(
      /^tenant velocity circuit breaker tripped/,
    );
  });

  it("fails closed when Redis is unreachable for the velocity read", async () => {
    h.runRow!.spent_cents = 10;
    h.redisThrows = true;
    await expect(assertCanProceed(RUN_ID, "llm")).rejects.toThrow(
      /velocity breaker failing closed/,
    );
  });

  it("refuses when the run row cannot be found", async () => {
    h.runRow = null;
    await expect(assertCanProceed(RUN_ID, "llm")).rejects.toThrow(/run .* not found/);
  });

  it("refuses when the run is already terminal", async () => {
    h.runRow!.status = "done";
    await expect(assertCanProceed(RUN_ID, "llm")).rejects.toThrow(/already done/);
  });
});
