// The orphaned-push-after-a-merger defect, and its two halves.
//
// PRODUCTION SHAPE, reproduced verbatim in the first test: an `integration_queue`
// row for DevPilot-8, a `pending_pushes` row whose `ticket_id` had been re-parented
// to the merger DevPilot-11 spawned to resolve its conflict, `conflict_state`
// resolved, 15 unpushed commits on `devpilot/set-up-ci-deploy-…`. The land looked
// up DevPilot-8's branch, found no push attached to DevPilot-8, and cancelled:
//   status=cancelled  last_error="ticket has no branch with work to land"
//
// The fake below ACTUALLY APPLIES `.eq` / `.in` against a shared store - a
// filter-ignoring fake would make every tenant assertion vacuous. Each such
// assertion carries a CONTROL that neuters the predicate (i.e. what deleting it
// looks like) and proves the foreign row WOULD be reached, so if a predicate
// ever disappears the corresponding test goes red rather than silently passing.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decidePushOwnership,
  resolveMergerTicketId,
  resolveTicketPush,
} from "@/lib/integration/merger-push";

type Row = Record<string, unknown>;
/** Both tables are always present, so the fixtures can be mutated per-test. */
type Fixture = { pending_pushes: Row[]; tickets: Row[] };

function fakeClient(
  tables: Record<string, Row[]>,
  opts: { honourEq?: boolean; honourIn?: boolean } = {},
) {
  const honourEq = opts.honourEq ?? true;
  const honourIn = opts.honourIn ?? true;

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let order: { column: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    const self: Record<string, unknown> = {};

    self.select = () => self;
    self.eq = (c: string, v: unknown) => {
      if (honourEq) filters.push((r) => r[c] === v);
      return self;
    };
    self.in = (c: string, vs: unknown[]) => {
      if (honourIn) filters.push((r) => vs.includes(r[c]));
      return self;
    };
    self.not = (c: string, _op: string, _v: unknown) => {
      if (honourEq) filters.push((r) => r[c] !== null && r[c] !== undefined);
      return self;
    };
    self.order = (column: string, o?: { ascending?: boolean }) => {
      order = { column, ascending: o?.ascending ?? true };
      return self;
    };
    self.limit = (n: number) => {
      limit = n;
      return self;
    };

    const run = () => {
      let matched = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { column, ascending } = order;
        matched = [...matched].sort((a, b) => {
          const av = String(a[column] ?? "");
          const bv = String(b[column] ?? "");
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limit !== null) matched = matched.slice(0, limit);
      return matched.map((r) => ({ ...r }));
    };

    self.maybeSingle = () => Promise.resolve({ data: run()[0] ?? null, error: null as null });
    self.then = (
      resolve: (v: { data: Row[]; error: null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) =>
      Promise.resolve()
        .then(() => ({ data: run(), error: null as null }))
        .then(resolve, reject);

    return self;
  }

  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

// The operator's live rows.
const DEVPILOT_8 = "33cce803-0000-4000-8000-000000000001"; // source ticket
const DEVPILOT_11 = "830e73cf-0000-4000-8000-000000000002"; // merger spawned for it
const PUSH_8 = "38e49c1f-0000-4000-8000-000000000003";
const BRANCH_8 = "devpilot/set-up-ci-deploy-with-rollback-and-basic-observability";

/** The production shape: push re-parented to the merger, conflict resolved. */
function orphanedFixture(tenantId = T1): Fixture {
  return {
    pending_pushes: [
      {
        id: PUSH_8,
        tenant_id: tenantId,
        project_id: "proj-1",
        ticket_id: DEVPILOT_11, // ← stolen by the merger
        merger_ticket_id: DEVPILOT_11,
        branch: BRANCH_8,
        workspace_path: "/ws/devpilot-8",
        pushed_at: null,
        head_sha: "deadbee",
        conflict_state: "resolved",
        unpushed_count: 15,
        updated_at: "2026-07-19T01:00:00Z",
      },
    ],
    tickets: [{ id: DEVPILOT_11, tenant_id: tenantId, parent_ticket_id: DEVPILOT_8 }],
  };
}

describe("resolveTicketPush - the orphaned push after a merger", () => {
  it("finds the branch for the queued source ticket whose push a merger re-parented", async () => {
    const db = fakeClient(orphanedFixture());

    const push = await resolveTicketPush(db, { ticketId: DEVPILOT_8, tenantId: T1 });

    // This is the assertion the production land could not make: before the fix
    // the direct `ticket_id = DevPilot-8` read returned nothing and the land
    // cancelled with "ticket has no branch with work to land".
    expect(push).not.toBeNull();
    expect(push!.branch).toBe(BRANCH_8);
    expect(push!.id).toBe(PUSH_8);
    expect(push!.workspacePath).toBe("/ws/devpilot-8");
    expect(push!.via).toBe("merger");
    expect(push!.mergerTicketId).toBe(DEVPILOT_11);
  });

  it("prefers the ticket's OWN push over any merger's, and reports it as direct", async () => {
    const tables = orphanedFixture();
    tables.pending_pushes.push({
      id: "own-push",
      tenant_id: T1,
      project_id: "proj-1",
      ticket_id: DEVPILOT_8,
      merger_ticket_id: null,
      branch: "devpilot/own",
      workspace_path: "/ws/own",
      pushed_at: null,
      head_sha: "cafe",
      updated_at: "2026-07-19T00:00:00Z",
    });

    const push = await resolveTicketPush(fakeClient(tables), {
      ticketId: DEVPILOT_8,
      tenantId: T1,
    });

    expect(push!.id).toBe("own-push");
    expect(push!.via).toBe("direct");
  });

  it("returns null for a genuinely branchless ticket, so the cancel still fires", async () => {
    // The ~48 non-code roles, a review-only ticket, a spec ticket: no push, no
    // merger, nothing to land. The land worker's cancel on this is CORRECT and
    // must survive the fix.
    const db = fakeClient({ pending_pushes: [], tickets: [] });

    expect(await resolveTicketPush(db, { ticketId: DEVPILOT_8, tenantId: T1 })).toBeNull();
  });

  it("returns null when the ticket's children are ordinary sub-issues, not mergers", async () => {
    // `tickets.parent_ticket_id` is also plain sub-issue nesting. A child that
    // no push names via `merger_ticket_id` must never contribute a branch - the
    // narrowing comes from the merger_ticket_id side, and this proves it.
    const db = fakeClient({
      pending_pushes: [
        {
          id: "someone-elses",
          tenant_id: T1,
          ticket_id: "unrelated-ticket",
          merger_ticket_id: null,
          branch: "devpilot/unrelated",
          workspace_path: "/ws/unrelated",
          pushed_at: null,
          head_sha: null,
          updated_at: "2026-07-19T02:00:00Z",
        },
      ],
      tickets: [{ id: "sub-issue", tenant_id: T1, parent_ticket_id: DEVPILOT_8 }],
    });

    expect(await resolveTicketPush(db, { ticketId: DEVPILOT_8, tenantId: T1 })).toBeNull();
  });
});

describe("resolveTicketPush - disambiguation with several conflicts in flight", () => {
  // Two tickets in ONE project, each conflicted, each with its own merger which
  // has re-parented its own push. A fix that works with one row and picks
  // arbitrarily with two is not a fix, so both directions are asserted.
  const A = "aaaa0000-0000-4000-8000-00000000000a";
  const B = "bbbb0000-0000-4000-8000-00000000000b";
  const MERGER_A = "aaaa1111-0000-4000-8000-00000000001a";
  const MERGER_B = "bbbb1111-0000-4000-8000-00000000001b";

  function twoInFlight(): Fixture {
    return {
      pending_pushes: [
        {
          id: "push-a",
          tenant_id: T1,
          project_id: "proj-1",
          ticket_id: MERGER_A,
          merger_ticket_id: MERGER_A,
          branch: "devpilot/feature-a",
          workspace_path: "/ws/a",
          pushed_at: null,
          head_sha: "aaa",
          // Deliberately the OLDER row: a fix that leaned on recency alone
          // would return push-b for both tickets and pass a single-row test.
          updated_at: "2026-07-19T01:00:00Z",
        },
        {
          id: "push-b",
          tenant_id: T1,
          project_id: "proj-1",
          ticket_id: MERGER_B,
          merger_ticket_id: MERGER_B,
          branch: "devpilot/feature-b",
          workspace_path: "/ws/b",
          pushed_at: null,
          head_sha: "bbb",
          updated_at: "2026-07-19T09:00:00Z",
        },
      ],
      tickets: [
        { id: MERGER_A, tenant_id: T1, parent_ticket_id: A },
        { id: MERGER_B, tenant_id: T1, parent_ticket_id: B },
      ],
    };
  }

  it("matches ticket A to A's merger's push, not the newer one", async () => {
    const push = await resolveTicketPush(fakeClient(twoInFlight()), {
      ticketId: A,
      tenantId: T1,
    });
    expect(push!.id).toBe("push-a");
    expect(push!.branch).toBe("devpilot/feature-a");
  });

  it("matches ticket B to B's merger's push", async () => {
    const push = await resolveTicketPush(fakeClient(twoInFlight()), {
      ticketId: B,
      tenantId: T1,
    });
    expect(push!.id).toBe("push-b");
    expect(push!.branch).toBe("devpilot/feature-b");
  });

  it("returns the newest when one source spawned mergers over successive conflicts", async () => {
    // A re-conflict after a merger completes spawns a SECOND merger for the same
    // source. Both are children of A; the live branch state is the newest row.
    const tables = twoInFlight();
    tables.tickets.push({ id: "merger-a2", tenant_id: T1, parent_ticket_id: A });
    tables.pending_pushes.push({
      id: "push-a2",
      tenant_id: T1,
      project_id: "proj-1",
      ticket_id: "merger-a2",
      merger_ticket_id: "merger-a2",
      branch: "devpilot/feature-a",
      workspace_path: "/ws/a",
      pushed_at: null,
      head_sha: "aaa2",
      updated_at: "2026-07-19T12:00:00Z",
    });

    const push = await resolveTicketPush(fakeClient(tables), { ticketId: A, tenantId: T1 });
    expect(push!.id).toBe("push-a2");
  });
});

describe("resolveTicketPush - tenant scope", () => {
  // Service-role, RLS off: the co-located `.eq("tenant_id", …)` is the ENTIRE
  // boundary, and what escapes is a BRANCH NAME the land worker then merges into
  // the integration branch.
  it("never returns another tenant's push through the direct path", async () => {
    const db = fakeClient({
      pending_pushes: [
        {
          id: "foreign",
          tenant_id: T2,
          ticket_id: DEVPILOT_8,
          merger_ticket_id: null,
          branch: "evil/branch",
          workspace_path: "/ws/evil",
          pushed_at: null,
          head_sha: null,
          updated_at: "2026-07-19T01:00:00Z",
        },
      ],
      tickets: [],
    });

    expect(await resolveTicketPush(db, { ticketId: DEVPILOT_8, tenantId: T1 })).toBeNull();
  });

  it("CONTROL: with the tenant predicate neutered, the foreign push IS returned", async () => {
    const db = fakeClient(
      {
        pending_pushes: [
          {
            id: "foreign",
            tenant_id: T2,
            ticket_id: DEVPILOT_8,
            merger_ticket_id: null,
            branch: "evil/branch",
            workspace_path: "/ws/evil",
            pushed_at: null,
            head_sha: null,
            updated_at: "2026-07-19T01:00:00Z",
          },
        ],
        tickets: [],
      },
      { honourEq: false },
    );

    const push = await resolveTicketPush(db, { ticketId: DEVPILOT_8, tenantId: T1 });
    expect(push!.branch).toBe("evil/branch");
  });

  it("never returns a foreign push through the merger path", async () => {
    const tables = orphanedFixture();
    tables.pending_pushes[0]!.tenant_id = T2; // push is theirs; merger ticket is ours

    expect(
      await resolveTicketPush(fakeClient(tables), { ticketId: DEVPILOT_8, tenantId: T1 }),
    ).toBeNull();
  });

  it("CONTROL: with the tenant predicate neutered, the foreign merger push IS returned", async () => {
    const tables = orphanedFixture();
    tables.pending_pushes[0]!.tenant_id = T2;

    const push = await resolveTicketPush(fakeClient(tables, { honourEq: false }), {
      ticketId: DEVPILOT_8,
      tenantId: T1,
    });
    expect(push!.id).toBe(PUSH_8);
  });

  it("never walks a foreign tenant's merger ticket to reach a push", async () => {
    const tables = orphanedFixture();
    tables.tickets[0]!.tenant_id = T2; // the merger row is theirs

    expect(
      await resolveTicketPush(fakeClient(tables), { ticketId: DEVPILOT_8, tenantId: T1 }),
    ).toBeNull();
  });
});

describe("decidePushOwnership - the write-side guard", () => {
  it("keeps the source as owner when the incoming run is the row's own merger", async () => {
    const d = decidePushOwnership({
      existingTicketId: DEVPILOT_8,
      existingMergerTicketId: DEVPILOT_11,
      incomingTicketId: DEVPILOT_11,
    });

    expect(d.ticketId).toBe(DEVPILOT_8);
    expect(d.reparented).toBe(false);
    expect(d.reason).toBe("merger_keeps_source");
  });

  it("re-parents normally when the incoming run is an unrelated ticket", async () => {
    // The ordinary path is unchanged: only the one shape that produced the bug
    // behaves differently.
    const d = decidePushOwnership({
      existingTicketId: DEVPILOT_8,
      existingMergerTicketId: DEVPILOT_11,
      incomingTicketId: "some-other-ticket",
    });

    expect(d.ticketId).toBe("some-other-ticket");
    expect(d.reparented).toBe(true);
  });

  it("re-parents when the row has no merger at all", async () => {
    const d = decidePushOwnership({
      existingTicketId: DEVPILOT_8,
      existingMergerTicketId: null,
      incomingTicketId: "some-other-ticket",
    });

    expect(d.ticketId).toBe("some-other-ticket");
    expect(d.reparented).toBe(true);
  });

  it("is idempotent on an already-orphaned row rather than freezing it on the merger", async () => {
    // A row the OLD code already stole: ticket_id == merger_ticket_id. Keeping
    // it would pin the orphan permanently, so this must fall through to the
    // ordinary write and leave the read-side reconciliation to recover it.
    const d = decidePushOwnership({
      existingTicketId: DEVPILOT_11,
      existingMergerTicketId: DEVPILOT_11,
      incomingTicketId: DEVPILOT_11,
    });

    expect(d.ticketId).toBe(DEVPILOT_11);
    expect(d.reparented).toBe(true);
  });

  it("re-parents when the row has no owner yet", async () => {
    const d = decidePushOwnership({
      existingTicketId: null,
      existingMergerTicketId: DEVPILOT_11,
      incomingTicketId: DEVPILOT_11,
    });

    expect(d.ticketId).toBe(DEVPILOT_11);
    expect(d.reparented).toBe(true);
  });
});

describe("resolveMergerTicketId - the reaper's release lookup", () => {
  it("recovers the merger for a parked land whose push was re-parented", async () => {
    // The orphan blinded the RELEASE path too: the old `ticket_id = A` read
    // found nothing, resolved no merger, and `decideReap` never released the
    // parked row.
    const merger = await resolveMergerTicketId(fakeClient(orphanedFixture()), {
      ticketId: DEVPILOT_8,
      tenantId: T1,
    });

    expect(merger).toBe(DEVPILOT_11);
  });

  it("prefers a merger-bearing row over a newer plain one, as the original query did", async () => {
    // The reaper's original read filtered `merger_ticket_id IS NOT NULL`.
    // Routing it through the general resolver would take the ticket's NEWEST
    // push instead and silently stop releasing parked lands.
    const tables: Fixture = {
      pending_pushes: [
        {
          id: "conflicted",
          tenant_id: T1,
          ticket_id: DEVPILOT_8,
          merger_ticket_id: DEVPILOT_11,
          branch: "devpilot/eight",
          workspace_path: "/ws/8",
          pushed_at: null,
          head_sha: null,
          updated_at: "2026-07-19T01:00:00Z",
        },
        {
          id: "newer-plain",
          tenant_id: T1,
          ticket_id: DEVPILOT_8,
          merger_ticket_id: null,
          branch: "devpilot/eight-b",
          workspace_path: "/ws/8b",
          pushed_at: null,
          head_sha: null,
          updated_at: "2026-07-19T09:00:00Z",
        },
      ],
      tickets: [],
    };

    expect(
      await resolveMergerTicketId(fakeClient(tables), { ticketId: DEVPILOT_8, tenantId: T1 }),
    ).toBe(DEVPILOT_11);
  });

  it("returns null when there is no merger at all", async () => {
    const db = fakeClient({ pending_pushes: [], tickets: [] });
    expect(await resolveMergerTicketId(db, { ticketId: DEVPILOT_8, tenantId: T1 })).toBeNull();
  });

  it("never resolves a merger from another tenant's push", async () => {
    const tables = orphanedFixture();
    tables.pending_pushes[0]!.tenant_id = T2;

    expect(
      await resolveMergerTicketId(fakeClient(tables), { ticketId: DEVPILOT_8, tenantId: T1 }),
    ).toBeNull();
  });

  it("CONTROL: with the tenant predicate neutered, the foreign merger IS resolved", async () => {
    const tables = orphanedFixture();
    tables.pending_pushes[0]!.tenant_id = T2;

    expect(
      await resolveMergerTicketId(fakeClient(tables, { honourEq: false }), {
        ticketId: DEVPILOT_8,
        tenantId: T1,
      }),
    ).toBe(DEVPILOT_11);
  });
});

describe("resolveMergerTicketId - tenant scope on the DIRECT read", () => {
  // The suite above exercises the fallback's scoping; a foreign row must also be
  // unreachable through the direct `ticket_id` read itself, which needs a row
  // that read would otherwise match.
  function foreignDirect(): Fixture {
    return {
      pending_pushes: [
        {
          id: "foreign-conflicted",
          tenant_id: T2,
          ticket_id: DEVPILOT_8, // directly matched by the first read
          merger_ticket_id: "their-merger",
          branch: "evil/branch",
          workspace_path: "/ws/evil",
          pushed_at: null,
          head_sha: null,
          updated_at: "2026-07-19T01:00:00Z",
        },
      ],
      tickets: [],
    };
  }

  it("never resolves a foreign merger through the direct read", async () => {
    expect(
      await resolveMergerTicketId(fakeClient(foreignDirect()), {
        ticketId: DEVPILOT_8,
        tenantId: T1,
      }),
    ).toBeNull();
  });

  it("CONTROL: with the tenant predicate neutered, the foreign merger IS resolved", async () => {
    expect(
      await resolveMergerTicketId(fakeClient(foreignDirect(), { honourEq: false }), {
        ticketId: DEVPILOT_8,
        tenantId: T1,
      }),
    ).toBe("their-merger");
  });
});
