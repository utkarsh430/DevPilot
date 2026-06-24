// Caller-side coverage for the RELEASE half: `commitPlanAction`.
//
// Pinned here:
//   • The commit RELEASES the existing held row (with the plan link, so the
//     dispatch prompt carries the plan's context) - it never inserts one.
//   • It roots the committed backlog on the scaffolder with `builds_on`, so
//     feature work branches off the SEEDED repo and the landed-readiness gate
//     holds dependents until the scaffold lands.
//   • Rooting happens BEFORE the claim: a crash between the two leaves a held
//     scaffolder the fallback still releases, which is the safe direction.
//   • A project with no held scaffolder (connect-existing, or a fallback that
//     got there first) commits exactly as it does today.
//   • A release failure never wedges an otherwise-successful commit.
//
// The release seam's own semantics (the atomic claim, idempotence, no double
// dispatch) are proven in scaffolder-release.test.ts; the seam is mocked here.

import { describe, it, expect, beforeEach, vi } from "vitest";

/** The commit input is uuid-validated, so the fixture must be a real one. */
const SESSION = "11111111-1111-4111-8111-111111111111";

type Insert = { table: string; rows: Record<string, unknown>[] };

const h = vi.hoisted(() => ({
  sessionStatus: "planned" as string,
  proposed: [] as Record<string, unknown>[],
  inserts: [] as Insert[],
  /** Ids handed back by the tickets bulk insert, in order. */
  insertedTicketIds: [] as string[],
  findHeld: vi.fn(
    async (_a: unknown) => ({ ticketId: "scaffolder-1" }) as { ticketId: string } | null,
  ),
  findRoot: vi.fn(
    async (_a: unknown) => ({ ticketId: "scaffolder-1" }) as { ticketId: string } | null,
  ),
  release: vi.fn(async (_a: unknown) => ({ released: true as const, ticketId: "scaffolder-1" })),
  /** Call order, so we can prove rooting precedes the claim. */
  trace: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "u1" }),
  requireTenantId: async () => "tn",
}));
vi.mock("@/lib/engine/inngest", () => ({ inngest: { send: async () => {} } }));
vi.mock("@/lib/engine/budget", () => ({ assertCanProceedPlan: async () => {} }));
vi.mock("@/lib/plan/scaffolder-release.server", () => ({
  findHeldScaffolder: h.findHeld,
  findScaffolderToRootOn: h.findRoot,
  releaseScaffolder: async (a: unknown) => {
    h.trace.push("release");
    return h.release(a);
  },
}));
vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({
    from: (table: string) => ({
      insert: (rows: Record<string, unknown>[] | Record<string, unknown>) => {
        const list = Array.isArray(rows) ? rows : [rows];
        h.inserts.push({ table, rows: list });
        h.trace.push(`insert:${table}`);
        const result = {
          data: h.insertedTicketIds.map((id) => ({ id })),
          error: null,
        };
        return Object.assign(Promise.resolve({ error: null }), {
          select: async () => result,
        });
      },
      update: () => {
        const node: Record<string, unknown> = {
          is: () => node,
          select: async () => ({ data: [{ id: "x" }], error: null }),
          then: (res: (v: { error: null }) => void) => res({ error: null }),
        };
        node.eq = () => node;
        return node;
      },
      select: () => {
        const node: Record<string, unknown> = {
          is: () => node,
          order: () => node,
          limit: () => node,
          maybeSingle: async () => ({
            data:
              table === "planning_sessions"
                ? {
                    id: SESSION,
                    tenant_id: "tn",
                    project_id: "proj-1",
                    status: h.sessionStatus,
                    stack_flavor: "mixed",
                    stack_preferences: "",
                    goal_summary: null,
                  }
                : // tickets: max(column_position) probe
                  { column_position: 0 },
            error: null,
          }),
          then: (res: (v: { data: unknown; error: null }) => void) =>
            res({ data: h.proposed, error: null }),
        };
        node.eq = () => node;
        return node;
      },
    }),
  }),
}));

import { commitPlanAction } from "@/app/(app)/plan/actions";

function proposedTicket(ordinal: number, deps: number[] = [], role: string | null = null) {
  return {
    id: `p${ordinal}`,
    ordinal,
    title: `T${ordinal}`,
    description: null,
    acceptance_criteria: null,
    requested_role: role,
    depends_on_ordinals: deps,
    selected: true,
  };
}

function insertsTo(table: string) {
  return h.inserts.filter((i) => i.table === table).flatMap((i) => i.rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sessionStatus = "planned";
  h.inserts = [];
  h.trace = [];
  h.proposed = [proposedTicket(1), proposedTicket(2, [1])];
  h.insertedTicketIds = ["tk-a", "tk-b"];
  h.findHeld.mockResolvedValue({ ticketId: "scaffolder-1" });
  h.findRoot.mockResolvedValue({ ticketId: "scaffolder-1" });
  h.release.mockResolvedValue({ released: true, ticketId: "scaffolder-1" });
});

describe("commitPlanAction - releasing the held scaffolder", () => {
  it("releases the EXISTING held row with the plan link, and inserts no scaffolder", async () => {
    const res = await commitPlanAction({ sessionId: SESSION, mode: "all" });

    expect(res.ok).toBe(true);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith({
      tenantId: "tn",
      ticketId: "scaffolder-1",
      // The enrichment link: this is what makes the dispatch prompt carry the
      // session's confirmed stack + the lead's decisions.
      planSessionId: SESSION,
      via: "plan-commit",
    });
    // Only the plan's own tickets were inserted - no second scaffolder row.
    expect(insertsTo("tickets")).toHaveLength(2);
    expect(insertsTo("tickets").some((r) => r.requested_role === "project_scaffolder")).toBe(false);
  });

  it("roots only the plan's ROOTS on the scaffolder, with builds_on", async () => {
    await commitPlanAction({ sessionId: SESSION, mode: "all" });

    const deps = insertsTo("ticket_dependencies");
    // tk-a is a root → gets the scaffolder edge. tk-b depends on tk-a, so it
    // reaches the scaffolder transitively and gets no direct edge.
    expect(deps).toContainEqual({
      ticket_id: "tk-a",
      blocks_ticket_id: "scaffolder-1",
      relation_type: "builds_on",
    });
    expect(
      deps.filter((d) => d.blocks_ticket_id === "scaffolder-1").map((d) => d.ticket_id),
    ).toEqual(["tk-a"]);
    // The plan's own dependency edge survives untouched.
    expect(deps).toContainEqual({ ticket_id: "tk-b", blocks_ticket_id: "tk-a" });
  });

  it("roots BEFORE it claims, so a crash between them leaves a releasable row", async () => {
    await commitPlanAction({ sessionId: SESSION, mode: "all" });
    const rootIdx = h.trace.lastIndexOf("insert:ticket_dependencies");
    expect(rootIdx).toBeGreaterThan(-1);
    expect(rootIdx).toBeLessThan(h.trace.indexOf("release"));
  });

  it("commits normally for a project with no scaffolder at all", async () => {
    // Connect-existing: there is nothing to root on and nothing to release.
    h.findHeld.mockResolvedValue(null);
    h.findRoot.mockResolvedValue(null);
    const res = await commitPlanAction({ sessionId: SESSION, mode: "all" });

    expect(res.ok).toBe(true);
    expect(h.release).not.toHaveBeenCalled();
    expect(
      insertsTo("ticket_dependencies").filter((d) => d.blocks_ticket_id === "scaffolder-1"),
    ).toEqual([]);
  });

  it("does not wedge a successful commit when the release throws", async () => {
    h.findRoot.mockRejectedValue(new Error("db down"));
    const res = await commitPlanAction({ sessionId: SESSION, mode: "all" });
    // The tickets are already in, and the fallback still releases the
    // scaffolder on its TTL. Failing the commit over an enrichment step would
    // be the worse trade.
    expect(res.ok).toBe(true);
  });

  it("refuses a second commit outright, so nothing can be released twice", async () => {
    h.sessionStatus = "committed";
    const res = await commitPlanAction({ sessionId: SESSION, mode: "all" });
    expect(res).toEqual({
      ok: false,
      error: "session is committed; commit only allowed from 'planned'",
    });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.inserts).toEqual([]);
  });

  it("STILL roots the backlog when the scaffolder is no longer held", async () => {
    // The scaffolder was already released - the TTL fallback beat a long
    // discussion to it, or an operator promoted it. Rooting is a different
    // question from releasing, and tying the two together left every committed
    // ticket branching off an unseeded repo.
    h.findHeld.mockResolvedValue(null);
    h.findRoot.mockResolvedValue({ ticketId: "scaffolder-1" });

    const res = await commitPlanAction({ sessionId: SESSION, mode: "all" });

    expect(res.ok).toBe(true);
    expect(insertsTo("ticket_dependencies")).toContainEqual({
      ticket_id: "tk-a",
      blocks_ticket_id: "scaffolder-1",
      relation_type: "builds_on",
    });
    // Nothing to claim, so nothing is dispatched a second time.
    expect(h.release).not.toHaveBeenCalled();
  });
});

describe("commitPlanAction - the plan may never file a scaffolder", () => {
  it("clamps a planner-proposed project_scaffolder role away at the insert", async () => {
    // `project_scaffolder` is a full catalog slug, so the Thorough tier's
    // planner can propose it and the consolidator keeps it. This insert used to
    // copy requested_role verbatim, which made the plan flow a SECOND creator of
    // scaffolder rows - the exact class of bug #79 fixed.
    h.proposed = [proposedTicket(1, [], "project_scaffolder"), proposedTicket(2, [], "engineer")];
    h.insertedTicketIds = ["tk-a", "tk-b"];

    const res = await commitPlanAction({ sessionId: SESSION, mode: "all" });

    expect(res.ok).toBe(true);
    const tickets = insertsTo("tickets");
    expect(tickets.some((t) => t.requested_role === "project_scaffolder")).toBe(false);
    // Clamped to null (the role classifier picks), not dropped: the work the
    // planner wanted still gets done by whoever the router picks.
    expect(tickets[0]).toMatchObject({ requested_role: null });
    // Every other role is untouched.
    expect(tickets[1]).toMatchObject({ requested_role: "engineer" });
  });
});
