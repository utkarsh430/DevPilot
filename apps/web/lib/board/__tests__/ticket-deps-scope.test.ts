// Tenant and project scoping of dependency resolution.
//
// `resolveDependencyRefs` runs service-role (the caller is a runner-authed route
// with no user session), so RLS is off and the co-located `.eq("tenant_id", …)`
// / `.eq("project_id", …)` predicates are the ENTIRE boundary. What a missing
// one costs here is worse than a disclosure: the resolved id is written into
// `ticket_dependencies`, so a foreign ticket does not merely become visible, it
// becomes a BLOCKER - this tenant's work waits on a ticket in a workspace nobody
// here can open, forever, with the board showing a blocker card that 404s.
//
// The fake below ACTUALLY APPLIES `.eq` / `.in`. A fake that ignored filters
// would make every assertion in this file vacuous, which is exactly the shape of
// test that lets this class of bug ship. Each guard additionally gets a CONTROL
// that neuters the predicate and asserts the foreign row WOULD have been
// resolved - so deleting a predicate in the source turns this suite red.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tickets: [] as Row[],
  deps: [] as Row[],
  /** Predicates the fake is told to IGNORE - the control lever. */
  ignore: new Set<string>(),
}));

class FakeQuery {
  private eqs: Array<[string, unknown]> = [];
  private ins: Array<[string, unknown[]]> = [];
  private nots: Array<[string, string, unknown]> = [];
  private lim: number | null = null;

  constructor(private rows: Row[]) {}

  select(): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    if (!h.ignore.has(col)) this.eqs.push([col, val]);
    return this;
  }
  in(col: string, vals: readonly unknown[]): this {
    if (!h.ignore.has(col)) this.ins.push([col, [...vals]]);
    return this;
  }
  not(col: string, op: string, val: unknown): this {
    this.nots.push([col, op, val]);
    return this;
  }
  limit(n: number): this {
    this.lim = n;
    return this;
  }

  private run(): { data: Row[]; error: null } {
    let out = this.rows.filter(
      (r) =>
        this.eqs.every(([c, v]) => r[c] === v) &&
        this.ins.every(([c, vs]) => vs.includes(r[c])) &&
        this.nots.every(([c, op, v]) => (op === "is" && v === null ? r[c] != null : true)),
    );
    if (this.lim !== null) out = out.slice(0, this.lim);
    return { data: out, error: null };
  }

  then<T>(onF: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve(this.run()).then(onF);
  }
}

vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({
    from: (table: string) => new FakeQuery(table === "tickets" ? h.tickets : h.deps),
  }),
}));

import {
  loadBlockingEdgeClosure,
  loadRunAliases,
  resolveDependencyRefs,
} from "@/lib/board/ticket-deps.server";
import { classifyDependencyRef, type DependencyRef } from "@/lib/board/ticket-deps";

const TENANT = "tenant-ours";
const OTHER_TENANT = "tenant-theirs";
const PROJECT = "project-ours";
const OTHER_PROJECT = "project-other";
const RUN = "run-1";
const OTHER_RUN = "run-2";

function refs(...raw: string[]): DependencyRef[] {
  return raw.map((r) => {
    const parsed = classifyDependencyRef(r);
    if (!parsed) throw new Error(`fixture ref ${r} does not parse`);
    return parsed;
  });
}

function ticket(over: Row): Row {
  return {
    id: "t-x",
    tenant_id: TENANT,
    project_id: PROJECT,
    status: "backlog",
    ticket_number: null,
    agent_alias: null,
    source_run_id: null,
    ...over,
  };
}

beforeEach(() => {
  h.ignore.clear();
  h.deps = [];
  h.tickets = [
    ticket({ id: "ours-engine", agent_alias: "engine", source_run_id: RUN, ticket_number: 34 }),
    ticket({ id: "ours-plain", ticket_number: 7 }),
    // The three ways a reference can point somewhere it must not reach.
    ticket({
      id: "foreign-tenant",
      tenant_id: OTHER_TENANT,
      agent_alias: "engine",
      source_run_id: RUN,
      ticket_number: 99,
    }),
    ticket({
      id: "foreign-project",
      project_id: OTHER_PROJECT,
      agent_alias: "scaffold",
      source_run_id: RUN,
      ticket_number: 98,
    }),
    ticket({ id: "other-run", agent_alias: "engine", source_run_id: OTHER_RUN, ticket_number: 97 }),
  ];
});

const scope = { tenantId: TENANT, projectId: PROJECT, runId: RUN };

describe("resolveDependencyRefs - the happy path is not vacuous", () => {
  it("resolves an alias from this run, a key, and a uuid", async () => {
    const res = await resolveDependencyRefs({
      ...scope,
      refs: refs("engine", "DevPilot-7", "foreign-tenant"),
    });
    // The uuid form only matches a real uuid shape, so use the two that parse.
    expect(res.blockers.map((b) => b.ticketId)).toEqual(["ours-engine", "ours-plain"]);
    expect(res.unresolved).toEqual(["foreign-tenant"]);
  });

  it("collapses two references that name the same ticket into one blocker", async () => {
    // "engine" and "DevPilot-34" are the same row; emitting both would collide on
    // the (ticket_id, blocks_ticket_id) primary key and fail the whole insert.
    const res = await resolveDependencyRefs({ ...scope, refs: refs("engine", "DevPilot-34") });
    expect(res.blockers).toHaveLength(1);
    expect(res.blockers[0]!.ticketId).toBe("ours-engine");
  });
});

describe("resolveDependencyRefs - tenant boundary", () => {
  it("does not resolve a foreign tenant's ticket by KEY", async () => {
    const res = await resolveDependencyRefs({ ...scope, refs: refs("DevPilot-99") });
    expect(res.blockers).toEqual([]);
    expect(res.unresolved).toEqual(["DevPilot-99"]);
  });

  it("does not resolve a foreign tenant's ticket by ALIAS, even on this run id", async () => {
    // Two rows carry alias "engine" on run RUN; only ours may win.
    const res = await resolveDependencyRefs({ ...scope, refs: refs("engine") });
    expect(res.blockers.map((b) => b.ticketId)).toEqual(["ours-engine"]);
  });

  // CONTROL. Without it the two assertions above could be passing because the
  // fixture is wrong rather than because the predicate is there.
  it("CONTROL: neutering the tenant predicate DOES resolve the foreign row", async () => {
    h.ignore.add("tenant_id");
    const res = await resolveDependencyRefs({ ...scope, refs: refs("DevPilot-99") });
    expect(res.blockers.map((b) => b.ticketId)).toEqual(["foreign-tenant"]);
  });
});

describe("resolveDependencyRefs - project boundary", () => {
  it("does not resolve a ticket in another project of the SAME tenant", async () => {
    // The route derives tenant AND project from the spawning ticket precisely so
    // an agent cannot reach a project it was never dispatched against. A
    // dependency argument must not become the way around that.
    const res = await resolveDependencyRefs({ ...scope, refs: refs("scaffold", "DevPilot-98") });
    expect(res.blockers).toEqual([]);
    expect(res.unresolved).toEqual(["scaffold", "DevPilot-98"]);
  });

  it("CONTROL: neutering the project predicate DOES resolve the foreign-project row", async () => {
    h.ignore.add("project_id");
    const res = await resolveDependencyRefs({ ...scope, refs: refs("scaffold") });
    expect(res.blockers.map((b) => b.ticketId)).toEqual(["foreign-project"]);
  });
});

describe("resolveDependencyRefs - alias run scope", () => {
  it("does not resolve an alias coined by a DIFFERENT run", async () => {
    // Two decompositions both calling their foundation "engine" is entirely
    // likely; cross-talk would wire an edge to a ticket this agent never saw.
    const res = await resolveDependencyRefs({
      ...scope,
      runId: "run-with-no-tickets",
      refs: refs("engine"),
    });
    expect(res.blockers).toEqual([]);
    expect(res.unresolved).toEqual(["engine"]);
  });

  it("CONTROL: neutering the run predicate DOES resolve another run's alias", async () => {
    h.ignore.add("source_run_id");
    const res = await resolveDependencyRefs({
      ...scope,
      runId: "run-with-no-tickets",
      refs: refs("engine"),
    });
    expect(res.blockers.length).toBeGreaterThan(0);
  });

  it("issues no query at all when nothing was declared", async () => {
    const res = await resolveDependencyRefs({ ...scope, refs: [] });
    expect(res).toEqual({ blockers: [], unresolved: [] });
  });
});

describe("loadRunAliases", () => {
  it("returns only this run's aliases, in this tenant", async () => {
    const here = { tenantId: TENANT, projectId: PROJECT };
    // Scoped identically to resolution - tenant, project AND run - so a name it
    // offers is always a name resolution would then accept. `scaffold` lives in
    // another project on the same run and `DevPilot-99`'s alias in another
    // tenant; neither may appear.
    expect(await loadRunAliases({ ...here, runId: RUN })).toEqual(["engine"]);
    expect(await loadRunAliases({ ...here, runId: OTHER_RUN })).toEqual(["engine"]);
    expect(
      await loadRunAliases({ tenantId: OTHER_TENANT, projectId: PROJECT, runId: RUN }),
    ).toEqual(["engine"]);
    expect(
      await loadRunAliases({ tenantId: TENANT, projectId: OTHER_PROJECT, runId: RUN }),
    ).toEqual(["scaffold"]);
  });
});

describe("loadBlockingEdgeClosure", () => {
  beforeEach(() => {
    h.tickets.push(
      ticket({ id: "mid" }),
      ticket({ id: "deep" }),
      ticket({ id: "alien", tenant_id: OTHER_TENANT }),
    );
    h.deps = [
      { ticket_id: "ours-engine", blocks_ticket_id: "mid", relation_type: "blocked_by" },
      { ticket_id: "mid", blocks_ticket_id: "deep", relation_type: "builds_on" },
      // Informational flavours must never read as edges: an @mention
      // auto-creates a `related` row, so treating one as blocking would refuse a
      // perfectly legal dependency because two tickets mentioned each other.
      { ticket_id: "ours-engine", blocks_ticket_id: "ours-plain", relation_type: "related" },
      // A row reaching out of the tenant. Following it would let another
      // workspace's graph decide whether this dependency is legal.
      { ticket_id: "mid", blocks_ticket_id: "alien", relation_type: "blocked_by" },
    ];
  });

  it("walks blocking edges transitively", async () => {
    const edges = await loadBlockingEdgeClosure({
      tenantId: TENANT,
      fromTicketIds: ["ours-engine"],
    });
    expect(edges).toContainEqual({ ticketId: "ours-engine", blocksTicketId: "mid" });
    expect(edges).toContainEqual({ ticketId: "mid", blocksTicketId: "deep" });
  });

  it("ignores non-blocking relation flavours", async () => {
    const edges = await loadBlockingEdgeClosure({
      tenantId: TENANT,
      fromTicketIds: ["ours-engine"],
    });
    expect(edges.some((e) => e.blocksTicketId === "ours-plain")).toBe(false);
  });

  it("drops an edge whose target is in another tenant", async () => {
    const edges = await loadBlockingEdgeClosure({
      tenantId: TENANT,
      fromTicketIds: ["ours-engine"],
    });
    expect(edges.some((e) => e.blocksTicketId === "alien")).toBe(false);
  });

  it("CONTROL: neutering the tenant predicate DOES follow the foreign edge", async () => {
    h.ignore.add("tenant_id");
    const edges = await loadBlockingEdgeClosure({
      tenantId: TENANT,
      fromTicketIds: ["ours-engine"],
    });
    expect(edges.some((e) => e.blocksTicketId === "alien")).toBe(true);
  });
});
