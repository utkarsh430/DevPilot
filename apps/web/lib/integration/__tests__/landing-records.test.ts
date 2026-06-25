// Tenant scoping for the landing-evidence reads.
//
// The fake below ACTUALLY APPLIES `.eq` / `.in` / `.order`. That is the whole
// point: a fake that ignores filters makes every assertion here vacuous, and
// this is precisely the "service-role read keyed on an attacker-controllable
// pointer" class AGENTS.md documents recurring. Each scoping test is paired with
// a CONTROL that neuters the predicate and asserts the foreign row WOULD be
// picked up — so deleting an `.eq("tenant_id", …)` turns these red rather than
// leaving them silently passing.
//
// Why it matters here specifically: an `integration_queue` row from another
// tenant, keyed on a ticket id we are already rendering, would attach THEIR land
// failure to OUR card. A wrong reason is worse than no reason — it sends the
// operator hunting a failure that never happened on this board.

import { describe, expect, it } from "vitest";
import { loadTicketLandingRecords } from "@/lib/integration/landing-records";

const OURS = "tenant-ours";
const THEIRS = "tenant-theirs";

type Row = Record<string, unknown>;

/** A query builder that really filters. `ignoreTenantFilter` is the control
 *  knob: it makes `.eq("tenant_id", …)` a no-op, simulating a missing predicate. */
function makeDb(tables: Record<string, Row[]>, opts: { ignoreTenantFilter?: boolean } = {}) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          if (col === "tenant_id" && opts.ignoreTenantFilter) return builder;
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          rows = rows.filter((r) => vals.includes(r[col]));
          return builder;
        },
        order(col: string, { ascending }: { ascending: boolean }) {
          rows.sort((a, b) => {
            const av = String(a[col] ?? "");
            const bv = String(b[col] ?? "");
            return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
          return builder;
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          return Promise.resolve(resolve({ data: rows, error: null }));
        },
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const OUR_TICKET = "ticket-1";

function pushRow(over: Partial<Row> = {}): Row {
  return {
    tenant_id: OURS,
    ticket_id: OUR_TICKET,
    branch: "devpilot/ours",
    pushed_at: null,
    conflict_state: "clean",
    unpushed_count: 2,
    updated_at: "2026-07-19T09:00:00Z",
    ...over,
  };
}

function queueRow(over: Partial<Row> = {}): Row {
  return {
    tenant_id: OURS,
    ticket_id: OUR_TICKET,
    status: "pending",
    last_error: null,
    claimed_at: null,
    updated_at: "2026-07-19T09:00:00Z",
    ...over,
  };
}

describe("loadTicketLandingRecords — tenant scoping", () => {
  it("never picks up a foreign tenant's pending_pushes row for our ticket id", async () => {
    const db = makeDb({
      pending_pushes: [
        pushRow({ tenant_id: THEIRS, branch: "devpilot/theirs", conflict_state: "conflict" }),
      ],
      integration_queue: [],
    });
    const out = await loadTicketLandingRecords(db, OURS, [OUR_TICKET]);
    expect(out.get(OUR_TICKET)?.push ?? null).toBeNull();
  });

  it("CONTROL: without the tenant predicate that foreign push row WOULD be used", async () => {
    const db = makeDb(
      {
        pending_pushes: [
          pushRow({ tenant_id: THEIRS, branch: "devpilot/theirs", conflict_state: "conflict" }),
        ],
        integration_queue: [],
      },
      { ignoreTenantFilter: true },
    );
    const out = await loadTicketLandingRecords(db, OURS, [OUR_TICKET]);
    expect(out.get(OUR_TICKET)?.push?.branch).toBe("devpilot/theirs");
  });

  it("never picks up a foreign tenant's integration_queue row for our ticket id", async () => {
    const db = makeDb({
      pending_pushes: [],
      integration_queue: [
        queueRow({ tenant_id: THEIRS, status: "failed", last_error: "their failure" }),
      ],
    });
    const out = await loadTicketLandingRecords(db, OURS, [OUR_TICKET]);
    expect(out.get(OUR_TICKET)?.queue ?? null).toBeNull();
  });

  it("CONTROL: without the tenant predicate that foreign queue row WOULD be used", async () => {
    const db = makeDb(
      {
        pending_pushes: [],
        integration_queue: [
          queueRow({ tenant_id: THEIRS, status: "failed", last_error: "their failure" }),
        ],
      },
      { ignoreTenantFilter: true },
    );
    const out = await loadTicketLandingRecords(db, OURS, [OUR_TICKET]);
    expect(out.get(OUR_TICKET)?.queue?.lastError).toBe("their failure");
  });

  it("keeps our own rows when a foreign row shares the ticket id", async () => {
    const db = makeDb({
      pending_pushes: [
        pushRow({ tenant_id: THEIRS, branch: "devpilot/theirs" }),
        pushRow({ branch: "devpilot/ours" }),
      ],
      integration_queue: [
        queueRow({ tenant_id: THEIRS, status: "failed", last_error: "their failure" }),
        queueRow({ status: "pending" }),
      ],
    });
    const out = await loadTicketLandingRecords(db, OURS, [OUR_TICKET]);
    expect(out.get(OUR_TICKET)?.push?.branch).toBe("devpilot/ours");
    expect(out.get(OUR_TICKET)?.queue?.status).toBe("pending");
  });
});

describe("loadTicketLandingRecords — #137's nothing-to-land notice", () => {
  function noticeRow(over: Partial<Row> = {}): Row {
    return {
      tenant_id: OURS,
      ticket_id: OUR_TICKET,
      author_type: "system",
      author_id: "devpilot_nothing_to_land",
      metadata: {
        kind: "nothing_to_land",
        branch: "devpilot/review",
        base: "dev",
        commits_ahead: 0,
      },
      created_at: "2026-07-19T09:40:00Z",
      ...over,
    };
  }

  it("reads the branch and base off the record", async () => {
    const db = makeDb({
      pending_pushes: [],
      integration_queue: [],
      comments: [noticeRow()],
    });
    const out = await loadTicketLandingRecords(db, OURS, [OUR_TICKET]);
    expect(out.get(OUR_TICKET)?.nothingToLandNotice).toEqual({
      branch: "devpilot/review",
      base: "dev",
    });
  });

  // An AGENT must not be able to declare its own ticket "nothing to land" and
  // silence a stranded-work warning. The agent comment route hardcodes
  // `author_type: "agent"` and writes no metadata, so each clause below is a
  // shape an agent CAN produce and must still be rejected.
  const forged: Array<[string, Row]> = [
    ["author_type is agent, not system", noticeRow({ author_type: "agent" })],
    [
      "metadata kind is wrong",
      noticeRow({ metadata: { kind: "secret_request", branch: "x", base: "dev" } }),
    ],
    ["metadata is absent entirely", noticeRow({ metadata: null })],
    ["metadata is a string, not an object", noticeRow({ metadata: "nothing_to_land" })],
  ];

  for (const [name, row] of forged) {
    it(`rejects a comment where ${name}`, async () => {
      const db = makeDb({ pending_pushes: [], integration_queue: [], comments: [row] });
      const out = await loadTicketLandingRecords(db, OURS, [OUR_TICKET]);
      expect(out.get(OUR_TICKET)?.nothingToLandNotice ?? null).toBeNull();
    });
  }

  it("never picks up a foreign tenant's notice for our ticket id", async () => {
    const db = makeDb({
      pending_pushes: [],
      integration_queue: [],
      comments: [noticeRow({ tenant_id: THEIRS })],
    });
    const out = await loadTicketLandingRecords(db, OURS, [OUR_TICKET]);
    expect(out.get(OUR_TICKET)?.nothingToLandNotice ?? null).toBeNull();
  });

  it("CONTROL: without the tenant predicate that foreign notice WOULD be used", async () => {
    const db = makeDb(
      {
        pending_pushes: [],
        integration_queue: [],
        comments: [noticeRow({ tenant_id: THEIRS })],
      },
      { ignoreTenantFilter: true },
    );
    const out = await loadTicketLandingRecords(db, OURS, [OUR_TICKET]);
    expect(out.get(OUR_TICKET)?.nothingToLandNotice?.branch).toBe("devpilot/review");
  });
});

describe("loadTicketLandingRecords — shape", () => {
  it("returns the NEWEST row per ticket on both sides", async () => {
    const db = makeDb({
      pending_pushes: [
        pushRow({ branch: "devpilot/old", updated_at: "2026-07-19T08:00:00Z" }),
        pushRow({ branch: "devpilot/new", updated_at: "2026-07-19T10:00:00Z" }),
      ],
      integration_queue: [
        queueRow({ status: "failed", updated_at: "2026-07-19T08:00:00Z" }),
        queueRow({ status: "landed", updated_at: "2026-07-19T10:00:00Z" }),
      ],
    });
    const out = await loadTicketLandingRecords(db, OURS, [OUR_TICKET]);
    // A ticket that failed, was fixed and re-enqueued has several rows; only the
    // newest describes where the work stands now.
    expect(out.get(OUR_TICKET)?.push?.branch).toBe("devpilot/new");
    expect(out.get(OUR_TICKET)?.queue?.status).toBe("landed");
  });

  it("does NOT filter pushes on pushed_at — a pushed-but-unlanded branch is the point", async () => {
    const db = makeDb({
      pending_pushes: [pushRow({ pushed_at: "2026-07-19T09:30:00Z" })],
      integration_queue: [],
    });
    const out = await loadTicketLandingRecords(db, OURS, [OUR_TICKET]);
    expect(out.get(OUR_TICKET)?.push?.pushedAt).toBe("2026-07-19T09:30:00Z");
  });

  it("short-circuits on an empty ticket list", async () => {
    const db = makeDb({ pending_pushes: [pushRow()], integration_queue: [queueRow()] });
    expect((await loadTicketLandingRecords(db, OURS, [])).size).toBe(0);
  });

  it("leaves a ticket with no records absent from the map", async () => {
    const db = makeDb({ pending_pushes: [], integration_queue: [] });
    const out = await loadTicketLandingRecords(db, OURS, [OUR_TICKET, "ticket-2"]);
    expect(out.size).toBe(0);
  });
});
