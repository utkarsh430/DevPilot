// The race, end to end, against a store that behaves like Postgres.
//
// The review's blocker: an operator drags the held scaffolder Backlog→Ready at
// the same moment the plan commit (or the TTL fallback) releases it. Both paths
// flip the same row to `ready` and both emit `ticket/dispatch-needed` - two
// agents author the first commit of one genuinely-empty repo, which is the #79
// class this feature claims immunity to.
//
// Every other test here mocks one side or the other. This one runs the REAL
// `releaseScaffolder` calls concurrently against a tiny store that enforces the
// one property Postgres actually gives us - an UPDATE ... WHERE only matches
// rows that still satisfy the predicate - and counts dispatches.

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = {
  id: string;
  tenant_id: string;
  status: string;
  plan_hold: boolean;
  requested_role: string;
};

const h = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  dispatches: [] as string[],
}));

vi.mock("@/lib/engine/inngest", () => ({
  inngest: {
    send: async (evt: { name: string; data: { ticketId: string } }) => {
      if (evt.name === "ticket/dispatch-needed") h.dispatches.push(evt.data.ticketId);
    },
  },
}));
// A store with exactly the semantics that matter: the WHERE is evaluated at
// WRITE time, atomically, and a row that no longer matches is not returned.
vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({
    from: (_table: string) => ({
      update: (patch: Record<string, unknown>) => {
        const eqs: Array<[string, unknown]> = [];
        const node: Record<string, unknown> = {
          select: async () => {
            const matched: Array<{ id: string }> = [];
            for (const [id, row] of h.rows) {
              if (!eqs.every(([col, val]) => row[col] === val)) continue;
              Object.assign(row, patch);
              matched.push({ id });
            }
            return { data: matched, error: null };
          },
        };
        node.eq = (col: string, val: unknown) => {
          eqs.push([col, val]);
          return node;
        };
        return node;
      },
    }),
  }),
}));

import { releaseScaffolder } from "@/lib/plan/scaffolder-release.server";

const TICKET = "tk-1";
const TENANT = "tn";

function held(): Row {
  return {
    id: TICKET,
    tenant_id: TENANT,
    status: "backlog",
    plan_hold: true,
    requested_role: "project_scaffolder",
  };
}

beforeEach(() => {
  h.rows = new Map([[TICKET, held() as unknown as Record<string, unknown>]]);
  h.dispatches = [];
});

function release(via: "plan-commit" | "plan-discard" | "fallback", planSessionId: string | null) {
  return releaseScaffolder({ tenantId: TENANT, ticketId: TICKET, planSessionId, via });
}

describe("concurrent releases resolve to exactly one dispatch", () => {
  it("plan commit vs TTL fallback, fired together", async () => {
    const [commit, fallback] = await Promise.all([
      release("plan-commit", "sess-1"),
      release("fallback", null),
    ]);

    expect([commit.released, fallback.released].filter(Boolean)).toHaveLength(1);
    expect(h.dispatches).toEqual([TICKET]);
    expect(h.rows.get(TICKET)).toMatchObject({ status: "ready", plan_hold: false });
  });

  it("plan commit vs plan discard, fired together", async () => {
    const [commit, discard] = await Promise.all([
      release("plan-commit", "sess-1"),
      release("plan-discard", null),
    ]);

    expect([commit.released, discard.released].filter(Boolean)).toHaveLength(1);
    expect(h.dispatches).toEqual([TICKET]);
  });

  it("three paths racing at once still dispatch once", async () => {
    const results = await Promise.all([
      release("plan-commit", "sess-1"),
      release("plan-discard", null),
      release("fallback", null),
    ]);

    expect(results.filter((r) => r.released)).toHaveLength(1);
    expect(h.dispatches).toEqual([TICKET]);
  });

  it("a manual promote that already flipped the row makes the release a no-op", async () => {
    // The `→ ready` gate refuses this promote, but if it ever reached the DB the
    // release must still not stack a second dispatch on top of it.
    h.rows.get(TICKET)!.status = "ready";

    const res = await release("plan-commit", "sess-1");

    expect(res.released).toBe(false);
    expect(h.dispatches).toEqual([]);
  });

  it("a released row that later cycles back to Backlog is never re-released", async () => {
    // "Discard & restart from dev" resets the scaffolder to backlog. The status
    // shape is identical to a held row - only the cleared hold tells them apart,
    // and this is the case a sleeping TTL fallback wakes into.
    const first = await release("plan-commit", "sess-1");
    expect(first.released).toBe(true);
    h.rows.get(TICKET)!.status = "backlog"; // the operator's deliberate reset

    const late = await release("fallback", null);

    expect(late).toEqual({ released: false, reason: "not-held" });
    expect(h.dispatches).toEqual([TICKET]);
    // The operator's reset stands - the fallback didn't drag it back to ready.
    expect(h.rows.get(TICKET)).toMatchObject({ status: "backlog" });
  });
});
