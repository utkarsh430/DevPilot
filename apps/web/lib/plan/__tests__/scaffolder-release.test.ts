// The hold/release IO seam. What is pinned here is the #79 neighbourhood:
//
//   • RELEASE, NEVER INSERT. `releaseScaffolder` must not be able to create a
//     scaffolder row - a second creator is exactly the duplicate-scaffolder bug
//     PR #79 fixed.
//   • THE CLAIM IS IN THE UPDATE. `status = backlog` must be part of the WHERE,
//     not a read-then-write, or the commit path and the abandonment fallback
//     both "win" the race and two agents enter one workspace.
//   • EXACTLY ONE DISPATCH. A caller that claims no row dispatches nothing.

import { describe, it, expect, beforeEach, vi } from "vitest";

type Filter = { col: string; val: unknown };

const h = vi.hoisted(() => ({
  inngestSend: vi.fn(async (_evt: { name: string; data: unknown }) => {}),
  /** Rows the guarded UPDATE matches. Empty = somebody else already claimed. */
  updateMatches: [{ id: "tk-1" }] as Array<{ id: string }>,
  updateError: null as { message: string } | null,
  /** Recorded per update: the patch and every .eq() filter applied to it. */
  updates: [] as Array<{ table: string; patch: Record<string, unknown>; filters: Filter[] }>,
  /** Any insert at all is a bug - see the module docblock. */
  inserts: [] as Array<{ table: string; row: unknown }>,
  selectRow: { id: "tk-1" } as { id: string } | null,
  selectFilters: [] as Filter[],
}));

vi.mock("@/lib/engine/inngest", () => ({ inngest: { send: h.inngestSend } }));
vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({
    from: (table: string) => ({
      insert: async (row: unknown) => {
        h.inserts.push({ table, row });
        return { error: null };
      },
      update: (patch: Record<string, unknown>) => {
        const filters: Filter[] = [];
        h.updates.push({ table, patch, filters });
        const node: Record<string, unknown> = {
          select: async () => ({
            data: h.updateError ? null : h.updateMatches,
            error: h.updateError,
          }),
        };
        node.eq = (col: string, val: unknown) => {
          filters.push({ col, val });
          return node;
        };
        return node;
      },
      select: () => {
        const node: Record<string, unknown> = {
          order: () => node,
          limit: () => node,
          maybeSingle: async () => ({ data: h.selectRow, error: null }),
        };
        node.eq = (col: string, val: unknown) => {
          h.selectFilters.push({ col, val });
          return node;
        };
        return node;
      },
    }),
  }),
}));

import { findHeldScaffolder, releaseScaffolder } from "@/lib/plan/scaffolder-release.server";

const TENANT = "tenant-1";

beforeEach(() => {
  vi.clearAllMocks();
  h.updateMatches = [{ id: "tk-1" }];
  h.updateError = null;
  h.updates = [];
  h.inserts = [];
  h.selectRow = { id: "tk-1" };
  h.selectFilters = [];
  h.inngestSend.mockImplementation(async () => {});
});

describe("findHeldScaffolder", () => {
  it("looks only for this project's HELD scaffolder, tenant-scoped", async () => {
    const held = await findHeldScaffolder({ tenantId: TENANT, projectId: "proj-1" });
    expect(held).toEqual({ ticketId: "tk-1" });
    const cols = Object.fromEntries(h.selectFilters.map((f) => [f.col, f.val]));
    // Keyed on plan_hold, NOT on status: a released-then-reset scaffolder sits
    // in `backlog` too, and releasing that one would be a re-run nobody asked
    // for.
    expect(cols).toMatchObject({
      tenant_id: TENANT,
      project_id: "proj-1",
      requested_role: "project_scaffolder",
      plan_hold: true,
    });
  });

  it("returns null when the project has no held scaffolder", async () => {
    h.selectRow = null;
    expect(await findHeldScaffolder({ tenantId: TENANT, projectId: "proj-1" })).toBeNull();
  });
});

describe("releaseScaffolder", () => {
  it("flips a held row to ready and dispatches it exactly once", async () => {
    const res = await releaseScaffolder({
      tenantId: TENANT,
      ticketId: "tk-1",
      planSessionId: "sess-1",
      via: "plan-commit",
    });

    expect(res).toEqual({ released: true, ticketId: "tk-1" });
    expect(h.updates).toHaveLength(1);
    // Clearing the hold is part of the release, not bookkeeping: it is what
    // makes the claim one-shot forever.
    expect(h.updates[0]!.patch).toEqual({
      status: "ready",
      plan_hold: false,
      plan_session_id: "sess-1",
    });
    expect(h.inngestSend).toHaveBeenCalledTimes(1);
    expect(h.inngestSend).toHaveBeenCalledWith({
      name: "ticket/dispatch-needed",
      data: { ticketId: "tk-1", tenantId: TENANT },
    });
  });

  it("puts the still-held guard in the UPDATE itself, not in a prior read", async () => {
    await releaseScaffolder({
      tenantId: TENANT,
      ticketId: "tk-1",
      planSessionId: null,
      via: "fallback",
    });
    const cols = Object.fromEntries(h.updates[0]!.filters.map((f) => [f.col, f.val]));
    // Without these in the WHERE, the commit path and the fallback both succeed
    // on the same row and dispatch it twice.
    expect(cols).toMatchObject({
      id: "tk-1",
      tenant_id: TENANT,
      requested_role: "project_scaffolder",
      plan_hold: true,
      status: "backlog",
    });
  });

  it("is a no-op - no dispatch - when the row is no longer held (the lost race)", async () => {
    h.updateMatches = [];
    const res = await releaseScaffolder({
      tenantId: TENANT,
      ticketId: "tk-1",
      planSessionId: "sess-1",
      via: "fallback",
    });
    expect(res).toEqual({ released: false, reason: "not-held" });
    expect(h.inngestSend).not.toHaveBeenCalled();
  });

  it("is idempotent: a second attempt on an already-released row dispatches nothing", async () => {
    const first = await releaseScaffolder({
      tenantId: TENANT,
      ticketId: "tk-1",
      planSessionId: "sess-1",
      via: "plan-commit",
    });
    // The first release consumed the claim; the row is no longer `backlog`.
    h.updateMatches = [];
    const second = await releaseScaffolder({
      tenantId: TENANT,
      ticketId: "tk-1",
      planSessionId: "sess-1",
      via: "plan-commit",
    });

    expect(first.released).toBe(true);
    expect(second.released).toBe(false);
    expect(h.inngestSend).toHaveBeenCalledTimes(1);
  });

  it("carries NO plan link when released with base context (the fallback)", async () => {
    await releaseScaffolder({
      tenantId: TENANT,
      ticketId: "tk-1",
      planSessionId: null,
      via: "fallback",
    });
    // Not `plan_session_id: null` - we don't touch the column at all, so a
    // fallback firing after a commit's release could never blank the link.
    expect(h.updates[0]!.patch).toEqual({ status: "ready", plan_hold: false });
  });

  it("NEVER inserts a ticket row - release-don't-insert is the #79 invariant", async () => {
    await releaseScaffolder({
      tenantId: TENANT,
      ticketId: "tk-1",
      planSessionId: "sess-1",
      via: "plan-commit",
    });
    h.updateMatches = [];
    await releaseScaffolder({
      tenantId: TENANT,
      ticketId: "tk-1",
      planSessionId: null,
      via: "fallback",
    });
    expect(h.inserts).toEqual([]);
  });

  it("reports a failed update instead of dispatching on it", async () => {
    h.updateError = { message: "boom" };
    const res = await releaseScaffolder({
      tenantId: TENANT,
      ticketId: "tk-1",
      planSessionId: null,
      via: "fallback",
    });
    expect(res.released).toBe(false);
    expect(h.inngestSend).not.toHaveBeenCalled();
  });

  it("keeps the claim when the dispatch send fails - the row is already ready", async () => {
    h.inngestSend.mockRejectedValueOnce(new Error("inngest down"));
    const res = await releaseScaffolder({
      tenantId: TENANT,
      ticketId: "tk-1",
      planSessionId: null,
      via: "fallback",
    });
    expect(res).toEqual({ released: true, ticketId: "tk-1" });
  });
});
