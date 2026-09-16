// The aggregator's invariants: TENANT ISOLATION, the N+1 batch shape, trust
// attribution, and fail-loud.
//
// Two of these are invisible in the output and so can only be defended by tests:
//
//  • Tenant isolation. On the project path `deps.db` is the SERVICE client (no
//    session ⇒ RLS off), so nothing filters by tenant except the aggregator's own
//    explicit predicates. A leak here renders a foreign ticket's title into a
//    downloadable PDF and looks like a perfectly normal export.
//  • The batch shape. A per-ticket loader in a loop reads fine and is a latency
//    bomb that grows with the board; the output is identical either way.
//
// A comment cannot hold either line. Round-trip counts and foreign-row fixtures
// can.

import { describe, expect, it, vi } from "vitest";
import { loadTicketAuditBatch, type AuditDeps } from "@/lib/export/ticket-audit";

/**
 * A fake PostgREST query builder that ACTUALLY APPLIES `.eq()` and `.in()`.
 *
 * The filters are not decoration here — they are the point. An earlier version
 * of this fake returned every row regardless of filters, which would make the
 * cross-tenant tests below pass whether or not the tenant predicate exists in
 * the code. A fake that ignores the thing under test is worse than no test: it
 * reports safety it never checked.
 *
 * `.from()` bumps the counter once per query, which is what the N+1 guard counts.
 */
function fakeClient(tables: Record<string, unknown[]>, counter: { n: number }) {
  const builder = (table: string) => {
    let rows = (tables[table] ?? []) as Array<Record<string, unknown>>;
    const self: Record<string, unknown> = {};
    // Real filters.
    self.eq = (col: string, val: unknown) => {
      rows = rows.filter((r) => r[col] === val);
      return self;
    };
    self.in = (col: string, vals: readonly unknown[]) => {
      rows = rows.filter((r) => vals.includes(r[col]));
      return self;
    };
    // Shape-only — irrelevant to what these tests assert.
    for (const m of ["select", "is", "not", "order", "limit", "neq"]) {
      self[m] = () => self;
    }
    self.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    self.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null });
    return self;
  };
  return {
    from: (table: string) => {
      counter.n += 1;
      return builder(table);
    },
  } as unknown as AuditDeps["db"];
}

/** The tenant every fixture ticket belongs to. */
const TENANT = "33333333-3333-4333-8333-333333333333";
/** Someone else's tenant. Nothing carrying this may ever reach the document. */
const FOREIGN_TENANT = "99999999-9999-4999-8999-999999999999";

const TICKET = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  tenant_id: TENANT,
  project_id: "44444444-4444-4444-8444-444444444444",
  ticket_number: 1,
  title: "A ticket",
  description: null,
  acceptance_criteria: null,
  status: "done",
  priority: 0,
  retry_count: 0,
  safety_critical: false,
  plan_hold: false,
  plan_session_id: null,
  source_run_id: null,
  assignee_agent_id: null,
  requested_role: null,
  git_branch_name: null,
  landed_sha: null,
  integrated_at: null,
  parent_ticket_id: null,
  column_position: 0,
  created_at: "2026-07-15T08:00:00.000Z",
  updated_at: "2026-07-15T10:00:00.000Z",
  ...over,
});

function deps(
  tables: Record<string, unknown[]>,
  counter: { n: number },
  over: Partial<AuditDeps> = {},
): AuditDeps {
  const client = fakeClient(tables, counter);
  return {
    db: client,
    tenantId: TENANT,
    service: fakeClient(tables, counter),
    resolveImages: async () => [],
    langfuse: { baseUrl: "https://lf.example", projectId: "p1" },
    ...over,
  };
}

describe("loadTicketAuditBatch — query count", () => {
  it("issues the SAME number of queries for 1 ticket and for 30", async () => {
    // This is the N+1 guard. If someone reintroduces a per-ticket loop, the
    // 30-ticket count grows and this fails — which is the only way that
    // regression is ever noticed before production, since the output is
    // identical either way.
    const count = async (n: number) => {
      const ids = Array.from({ length: n }, (_, i) => `id-${i}`);
      const counter = { n: 0 };
      await loadTicketAuditBatch(deps({ tickets: ids.map((id) => TICKET(id)) }, counter), ids);
      return counter.n;
    };

    const one = await count(1);
    const thirty = await count(30);
    expect(thirty).toBe(one);
    // And it is a small constant, not "constant at 200".
    expect(one).toBeLessThanOrEqual(12);
  });

  it("issues no queries at all for an empty id list", async () => {
    const counter = { n: 0 };
    await loadTicketAuditBatch(deps({}, counter), []);
    expect(counter.n).toBe(0);
  });

  it("resolves images once per ticket that has them, not once per attachment", async () => {
    const resolveImages = vi.fn(async () => []);
    const counter = { n: 0 };
    const ids = ["a", "b"];
    await loadTicketAuditBatch(
      deps(
        {
          tickets: ids.map((id) => TICKET(id)),
          ticket_attachments: [
            {
              id: "att-1",
              ticket_id: "a",
              tenant_id: TENANT,
              storage_key: "k1",
              mime: "image/png",
              bytes: 10,
            },
            {
              id: "att-2",
              ticket_id: "a",
              tenant_id: TENANT,
              storage_key: "k2",
              mime: "image/png",
              bytes: 10,
            },
          ],
        },
        counter,
        { resolveImages },
      ),
      ids,
    );
    // Both of `a`'s attachments go through in ONE resolve call.
    expect(resolveImages).toHaveBeenCalledTimes(1);
  });
});

describe("tenant isolation (the project job runs with RLS OFF)", () => {
  // These model the exact attack: the write policies do NOT stop a tenant from
  // NAMING a foreign ticket id — `ticket_dependencies_member_write` constrains
  // only `ticket_id`, and `tickets_member_write` constrains a row's own
  // `tenant_id` but not its `parent_ticket_id`/`project_id`. So the aggregator's
  // explicit `.eq("tenant_id", …)` is the only thing standing between an
  // attacker-nominated uuid and someone else's data on a PDF.

  const FOREIGN = (id: string, over: Record<string, unknown> = {}) =>
    TICKET(id, { tenant_id: FOREIGN_TENANT, title: "SECRET foreign title", ...over });

  it("renders NOTHING from a foreign ticket named by a blocked_by edge", async () => {
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(
      deps(
        {
          // Our ticket, plus a tenant-B ticket sitting in the same table.
          tickets: [TICKET("mine"), FOREIGN("victim")],
          // The edge a tenant-A member is allowed to write today.
          ticket_dependencies: [
            { ticket_id: "mine", blocks_ticket_id: "victim", relation_type: "blocked_by" },
          ],
        },
        counter,
      ),
      ["mine"],
    );

    expect(out).toBeDefined();
    // The relation is dropped entirely — a foreign id resolves to no row, so
    // there is nothing to render, exactly as if the ticket were deleted.
    expect(out!.relations.blockedBy).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("SECRET foreign title");
    expect(JSON.stringify(out)).not.toContain(FOREIGN_TENANT);
  });

  it("renders NOTHING from a foreign ticket named by a builds_on edge", async () => {
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(
      deps(
        {
          tickets: [TICKET("mine"), FOREIGN("victim")],
          ticket_dependencies: [
            { ticket_id: "mine", blocks_ticket_id: "victim", relation_type: "builds_on" },
          ],
        },
        counter,
      ),
      ["mine"],
    );
    expect(out!.relations.buildsOn).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("SECRET foreign title");
  });

  it("renders NOTHING from a foreign ticket on the INVERSE edge direction", async () => {
    // The mirror: a foreign ticket claims to be blocked by ours, which would put
    // it in our `blocks` list.
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(
      deps(
        {
          tickets: [TICKET("mine"), FOREIGN("victim")],
          ticket_dependencies: [
            { ticket_id: "victim", blocks_ticket_id: "mine", relation_type: "blocked_by" },
          ],
        },
        counter,
      ),
      ["mine"],
    );
    expect(out!.relations.blocks).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("SECRET foreign title");
  });

  it("renders NOTHING from a foreign ticket parented onto ours (sub-issues)", async () => {
    // `tickets_member_write` gates a row's own tenant, NOT its parent_ticket_id,
    // so a foreign tenant can parent their ticket onto ours and land in this list.
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(
      deps(
        {
          tickets: [TICKET("mine"), FOREIGN("child", { parent_ticket_id: "mine" })],
        },
        counter,
      ),
      ["mine"],
    );
    expect(out!.relations.subIssues).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("SECRET foreign title");
  });

  it("refuses to export a foreign ticket even when its id is requested directly", async () => {
    // Belt and braces on the trust root: `loadFullTicketsByIds` is tenant-scoped,
    // so every downstream id is derived from a row we are entitled to.
    const counter = { n: 0 };
    const out = await loadTicketAuditBatch(
      deps({ tickets: [TICKET("mine"), FOREIGN("victim")] }, counter),
      ["mine", "victim"],
    );
    expect(out.map((t) => t.ticket.id)).toEqual(["mine"]);
  });

  it("still renders a SAME-tenant relation (the filter is not just breaking everything)", async () => {
    // The negative controls above are only meaningful if the positive case works
    // — otherwise `.eq("tenant_id", <nonsense>)` would also pass them all.
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(
      deps(
        {
          tickets: [TICKET("mine"), TICKET("sibling", { title: "A legitimate blocker" })],
          ticket_dependencies: [
            { ticket_id: "mine", blocks_ticket_id: "sibling", relation_type: "blocked_by" },
          ],
        },
        counter,
      ),
      ["mine"],
    );
    expect(out!.relations.blockedBy.map((r) => r.title.value)).toEqual(["A legitimate blocker"]);
  });

  // ── The vector two rounds of fixes walked past ────────────────────────────
  // The tests above all inject a foreign TICKET, which the tenant-scoped ticket
  // read already excludes — so they passed while this hole stood wide open. Here
  // the ticket is OURS and perfectly clean; the CHILD row is foreign. That is a
  // different attack, and "the ids are already scoped, so reads keyed on them are
  // safe" is exactly the reasoning that missed it.
  //
  // It works because a child's tenancy is NOT implied by its parent: `runs`,
  // `comments` and `project_handoffs` each carry their own `tenant_id`, and their
  // write policies constrain only that — never the `ticket_id` they point at. So
  // tenant B can attach a row to tenant A's ticket and the policy passes.

  it("renders NO narration from a foreign RUN attached to our OWN ticket", async () => {
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(
      deps(
        {
          tickets: [TICKET("mine")], // our ticket — nothing wrong with it
          runs: [
            {
              id: "r-theirs",
              ticket_id: "mine", // …but their run points at it
              tenant_id: FOREIGN_TENANT,
              agent_id: null,
              status: "done",
              status_reason: null,
              runner_kind: "local-cc",
              budget_cents: 500,
              spent_cents: 4242,
              created_at: "2026-07-15T09:00:00.000Z",
              last_event_at: "2026-07-15T09:30:00.000Z",
              fan_out_group: null,
              fan_out_role: null,
              replay_of_run_id: null,
            },
          ],
          run_steps: [
            {
              run_id: "r-theirs",
              idx: 0,
              kind: "think",
              payload: { text: "SECRET foreign narration", role: "engineer" },
              created_at: "2026-07-15T09:01:00.000Z",
            },
          ],
        },
        counter,
      ),
      ["mine"],
    );

    expect(out).toBeDefined();
    expect(out!.runs).toEqual([]);
    // The narration text is the confidentiality payload — it must not appear
    // anywhere in the exported bundle.
    expect(JSON.stringify(out)).not.toContain("SECRET foreign narration");
    // Nor may their spend land in our ticket's cost rollup.
    expect(out!.cost.totalCents).toBe(0);
  });

  it("renders NO body from a foreign COMMENT on our OWN ticket", async () => {
    // `comments_member_write` constrains only the comment's own tenant_id.
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(
      deps(
        {
          tickets: [TICKET("mine")],
          comments: [
            {
              id: "c-theirs",
              ticket_id: "mine",
              tenant_id: FOREIGN_TENANT,
              author_type: "agent",
              author_id: "engineer",
              body: "SECRET foreign comment",
              created_at: "2026-07-15T09:00:00.000Z",
            },
          ],
        },
        counter,
      ),
      ["mine"],
    );
    expect(out!.thread).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("SECRET foreign comment");
  });

  it("renders NO foreign HANDOFF on our OWN ticket", async () => {
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(
      deps(
        {
          tickets: [TICKET("mine")],
          project_handoffs: [
            {
              id: "h-theirs",
              ticket_id: "mine",
              tenant_id: FOREIGN_TENANT,
              run_id: null,
              role: "engineer",
              kind: "built",
              body: "SECRET foreign handoff",
              created_at: "2026-07-15T09:00:00.000Z",
            },
          ],
        },
        counter,
      ),
      ["mine"],
    );
    expect(out!.thread).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("SECRET foreign handoff");
  });

  it("renders NO forged EVIDENCE from a foreign run_verifications on our OWN run", async () => {
    // The live hole the fourth review found, and the nastiest of the set: the
    // payload is not merely someone else's data, it is ATTACKER-CHOSEN content
    // in the one place the document makes a claim about correctness. A foreign
    // `run_verifications` row attached to our run supplies `exit_code: 0` and a
    // command of their choosing, so the PDF would assert a check PASSED that
    // never ran — on our ticket, over our name.
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(
      deps(
        {
          tickets: [TICKET("mine")],
          runs: [
            {
              id: "r-mine",
              ticket_id: "mine",
              tenant_id: TENANT, // OUR run…
              agent_id: null,
              status: "done",
              status_reason: null,
              runner_kind: "local-cc",
              budget_cents: 500,
              spent_cents: 10,
              created_at: "2026-07-15T09:00:00.000Z",
              last_event_at: "2026-07-15T09:30:00.000Z",
              fan_out_group: null,
              fan_out_role: null,
              replay_of_run_id: null,
            },
          ],
          run_verifications: [
            {
              run_id: "r-mine", // …their verification row pointed at it
              tenant_id: FOREIGN_TENANT,
              command: "echo FORGED EVIDENCE",
              exit_code: 0,
              head_sha: "deadbeef",
              base_sha: null,
              pushed: true,
              output_tail: "all green, definitely",
            },
          ],
        },
        counter,
      ),
      ["mine"],
    );

    expect(out!.runs).toHaveLength(1);
    // No evidence at all beats forged evidence: the run renders with none.
    expect(out!.runs[0]!.verification).toBeNull();
    expect(JSON.stringify(out)).not.toContain("FORGED EVIDENCE");
    expect(JSON.stringify(out)).not.toContain("all green, definitely");
  });

  it("STILL renders our own run_verifications (positive control)", async () => {
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(
      deps(
        {
          tickets: [TICKET("mine")],
          runs: [
            {
              id: "r-mine",
              ticket_id: "mine",
              tenant_id: TENANT,
              agent_id: null,
              status: "done",
              status_reason: null,
              runner_kind: "local-cc",
              budget_cents: 500,
              spent_cents: 10,
              created_at: "2026-07-15T09:00:00.000Z",
              last_event_at: "2026-07-15T09:30:00.000Z",
              fan_out_group: null,
              fan_out_role: null,
              replay_of_run_id: null,
            },
          ],
          run_verifications: [
            {
              run_id: "r-mine",
              tenant_id: TENANT,
              command: "pnpm test",
              exit_code: 1,
              head_sha: "abc123",
              base_sha: null,
              pushed: false,
              output_tail: "FAIL auth.test.ts",
            },
          ],
        },
        counter,
      ),
      ["mine"],
    );
    expect(out!.runs[0]!.verification?.command.value).toBe("pnpm test");
    expect(out!.runs[0]!.verification?.exitCode).toBe(1);
  });

  it("STILL renders our own run's narration (positive control)", async () => {
    // Without this, a nonsense tenant filter that drops everything would pass
    // every negative test above.
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(
      deps(
        {
          tickets: [TICKET("mine")],
          runs: [
            {
              id: "r-mine",
              ticket_id: "mine",
              tenant_id: TENANT,
              agent_id: null,
              status: "done",
              status_reason: null,
              runner_kind: "local-cc",
              budget_cents: 500,
              spent_cents: 137,
              created_at: "2026-07-15T09:00:00.000Z",
              last_event_at: "2026-07-15T09:30:00.000Z",
              fan_out_group: null,
              fan_out_role: null,
              replay_of_run_id: null,
            },
          ],
          run_steps: [
            {
              run_id: "r-mine",
              idx: 0,
              kind: "think",
              payload: { text: "our own narration", role: "engineer" },
              created_at: "2026-07-15T09:01:00.000Z",
            },
          ],
        },
        counter,
      ),
      ["mine"],
    );
    expect(out!.runs).toHaveLength(1);
    expect(out!.cost.totalCents).toBe(137);
    expect(JSON.stringify(out)).toContain("our own narration");
  });

  it("still renders a SAME-tenant sub-issue", async () => {
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(
      deps(
        {
          tickets: [
            TICKET("mine"),
            TICKET("child", { parent_ticket_id: "mine", title: "A real sub-issue" }),
          ],
        },
        counter,
      ),
      ["mine"],
    );
    expect(out!.relations.subIssues.map((r) => r.title.value)).toEqual(["A real sub-issue"]);
  });
});

describe("loadTicketAuditBatch — content", () => {
  it("omits an id that resolved to no row (RLS filtered it, or it was deleted)", async () => {
    const counter = { n: 0 };
    const out = await loadTicketAuditBatch(deps({ tickets: [TICKET("a")] }, counter), [
      "a",
      "not-mine",
    ]);
    expect(out.map((t) => t.ticket.id)).toEqual(["a"]);
  });

  it("attributes a human-filed ticket's title to a human", async () => {
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(deps({ tickets: [TICKET("a")] }, counter), ["a"]);
    expect(out?.ticket.title.trust).toBe("human");
  });

  it("attributes an AGENT-FILED ticket's own title and description to the agent", async () => {
    // WI-14: `source_run_id` is the discriminator — nothing else about the row
    // distinguishes a ticket an agent filed from one a person typed.
    const counter = { n: 0 };
    const [out] = await loadTicketAuditBatch(
      deps(
        { tickets: [TICKET("a", { source_run_id: "run-1", description: "I found this" })] },
        counter,
      ),
      ["a"],
    );
    expect(out?.ticket.title.trust).toBe("agent");
    expect(out?.ticket.description?.trust).toBe("agent");
  });
});

describe("fail loud", () => {
  /** A client whose `from(table)` errors for one named table. */
  function erroringOn(table: string, tables: Record<string, unknown[]>) {
    return {
      from: (t: string) => {
        const self: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "is", "not", "order", "limit", "neq"]) {
          self[m] = () => self;
        }
        const result =
          t === table
            ? { data: null, error: { message: "boom" } }
            : { data: tables[t] ?? [], error: null };
        self.maybeSingle = () => Promise.resolve(result);
        self.then = (resolve: (v: unknown) => unknown) => resolve(result);
        return self;
      },
    } as unknown as AuditDeps["db"];
  }

  it("THROWS when the integration_queue is unreadable (land state unknown)", async () => {
    // Most loaders in this repo degrade to [] on error, which is right for a UI
    // panel. Here it would print a done-but-unlanded blocker as clean — the
    // exact unsafe state WI-5 exists to prevent — on a document someone signs
    // off against. A failed export is recoverable; a confidently wrong one isn't.
    const tables = {
      // "b" must EXIST and be in our tenant: the land queue is only consulted for
      // refs that actually resolved (an unresolved id is dropped before we get
      // there, so there is nothing to ask about and no read to fail).
      tickets: [TICKET("a"), TICKET("b")],
      ticket_dependencies: [{ ticket_id: "a", blocks_ticket_id: "b", relation_type: "blocked_by" }],
    };
    const counter = { n: 0 };
    const d = deps(tables, counter);
    d.service = erroringOn("integration_queue", tables);
    await expect(loadTicketAuditBatch(d, ["a"])).rejects.toThrow(/integration_queue/);
  });

  it("THROWS when run_verifications is unreadable (QA evidence unknown)", async () => {
    // `loadRunVerification` fails OPEN for the live gate (a DB hiccup must not
    // strand a ticket). In a document that is backwards: "no record" prints as
    // "nothing to see here", laundering a failing QA gate into a clean trail.
    const tables = {
      tickets: [TICKET("a")],
      runs: [
        {
          id: "r1",
          ticket_id: "a",
          agent_id: null,
          status: "done",
          status_reason: null,
          runner_kind: "local-cc",
          budget_cents: 100,
          spent_cents: 10,
          created_at: "2026-07-15T09:00:00.000Z",
          last_event_at: "2026-07-15T09:10:00.000Z",
          fan_out_group: null,
          fan_out_role: null,
          replay_of_run_id: null,
        },
      ],
    };
    const counter = { n: 0 };
    const d = deps(tables, counter);
    d.db = erroringOn("run_verifications", tables);
    await expect(loadTicketAuditBatch(d, ["a"])).rejects.toThrow(/verification/i);
  });

  it("THROWS when the ticket rows themselves are unreadable", async () => {
    const d = deps({}, { n: 0 });
    d.db = erroringOn("tickets", {});
    await expect(loadTicketAuditBatch(d, ["a"])).rejects.toThrow(/ticket load failed/);
  });
});
