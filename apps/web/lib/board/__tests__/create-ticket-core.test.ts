// WI-14 - `createTicketCore` is the ONE insert path now shared by the human
// board form and the agent's `devpilot_create_ticket` tool. Two things are pinned
// here:
//
//   • The UI path's behaviour is UNCHANGED by the extraction: the WI-8
//     1024-spaced placement still lands on the row, the auto-enrich event still
//     fires, the builds_on link is still written, and the insert still goes
//     through the caller's own (RLS-bound) client.
//   • The Haiku dep-suggestion rerank NO LONGER runs inline on the request path
//     (it hung the "Creating…" button on a slow model call). createTicketCore
//     now emits `ticket/suggest-deps.requested` for a background function to
//     run the rerank and park the result — so these tests pin that the create
//     resolves WITHOUT calling `suggestDependencies` inline and DOES emit that
//     event.
//   • The agent path files into `backlog` with `requested_role = null` and
//     stamps `source_run_id`. Those two forced values are the reason the tool
//     cannot reach a run start (nothing dispatches from backlog) and the reason
//     the UI-only Runners gate stays inert on it.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  inserted: [] as Record<string, unknown>[],
  depRows: [] as Record<string, unknown>[],
  attachmentRows: [] as Record<string, unknown>[],
  attachmentInsertError: null as { message: string } | null,
  inngestSend: vi.fn(async (_evt: { name: string }) => {}),
  placement: 3072,
  computePlacement: vi.fn(),
  suggestDependencies: vi.fn(async () => ({ ok: true, suggestions: [{ id: "s1" }] })),
  /** tenant_id the service client reports for the builds_on parent lookup. */
  parentTenant: "tn" as string | null,
}));

vi.mock("@/lib/engine/inngest", () => ({ inngest: { send: h.inngestSend } }));
vi.mock("@/lib/engine/dep-suggest", () => ({ suggestDependencies: h.suggestDependencies }));
vi.mock("@/lib/board/topo", () => ({ computePlacementAfterBlockers: h.computePlacement }));
vi.mock("@/lib/db/server", () => ({
  // The SERVICE client - used only for the builds_on parent lookup/link and the
  // dep-suggest candidate read. NOT for the ticket insert (that uses the
  // caller-supplied client, which is the whole point).
  supabaseService: () => ({
    from: (table: string) => ({
      // Both service reads start `.select(...).eq(...)`: the builds_on parent
      // lookup ends in `.maybeSingle()`, the dep-suggest candidate read chains
      // on through `.eq().in().neq().order().limit()`.
      select: () => {
        const eqNode: Record<string, unknown> = {
          maybeSingle: async () => ({
            data: h.parentTenant ? { tenant_id: h.parentTenant } : null,
          }),
          in: () => ({
            neq: () => ({
              order: () => ({
                limit: async () => ({
                  data: [{ id: "c1", title: "c", status: "backlog", updated_at: "now" }],
                  error: null,
                }),
              }),
            }),
          }),
        };
        eqNode.eq = () => eqNode;
        return eqNode;
      },
      insert: async (row: Record<string, unknown> | Record<string, unknown>[]) => {
        if (table === "ticket_dependencies") h.depRows.push(row as Record<string, unknown>);
        if (table === "ticket_attachments") {
          for (const r of Array.isArray(row) ? row : [row]) h.attachmentRows.push(r);
          return { error: h.attachmentInsertError };
        }
        return { error: null };
      },
    }),
  }),
}));

import { createTicketCore } from "@/lib/board/create-ticket";

/** Stand-in for whichever client the caller hands in. Records the insert so we
 *  can assert the row shape AND that this client (not the service one) wrote it. */
function fakeClient() {
  return {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        h.inserted.push(row);
        return {
          select: () => ({ single: async () => ({ data: { id: "new-ticket" }, error: null }) }),
        };
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const PARENT = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  h.inserted = [];
  h.depRows = [];
  h.attachmentRows = [];
  h.attachmentInsertError = null;
  h.parentTenant = "tn";
  h.computePlacement.mockResolvedValue(h.placement);
  h.suggestDependencies.mockResolvedValue({ ok: true, suggestions: [{ id: "s1" }] });
  // clearAllMocks resets call history but NOT implementations, so restore the
  // default no-op send each test (one test overrides it to reject).
  h.inngestSend.mockImplementation(async (_evt: { name: string }) => {});
});

describe("createTicketCore - the UI path is byte-identical after the extraction", () => {
  it("inserts through the CALLER's client with the WI-8 placement and the picked role", async () => {
    const res = await createTicketCore({
      tenantId: "tn",
      projectId: "pj",
      title: "Do the thing",
      description: "because",
      supabase: fakeClient(),
      requestedRole: "engineer",
    });

    expect(res.ok).toBe(true);
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      tenant_id: "tn",
      project_id: "pj",
      title: "Do the thing",
      description: "because",
      status: "backlog",
      requested_role: "engineer",
      column_position: h.placement,
    });
    // No source_run_id key at all on a human-created ticket - the column stays
    // NULL rather than being written with a falsy value.
    expect(h.inserted[0]).not.toHaveProperty("source_run_id");
  });

  it("fires auto-enrich AND emits the background suggest-deps event, without an inline rerank", async () => {
    const res = await createTicketCore({
      tenantId: "tn",
      projectId: "pj",
      title: "Do the thing",
      description: "because",
      supabase: fakeClient(),
    });

    expect(h.inngestSend).toHaveBeenCalledWith({
      name: "ticket/auto-enrich.requested",
      data: { ticketId: "new-ticket", tenantId: "tn" },
    });
    // The dep-suggestion is now a BACKGROUND job: the create path emits the
    // event carrying everything the job needs, and must NOT run the Haiku
    // rerank inline (the whole point — an inline await hung "Creating…").
    expect(h.inngestSend).toHaveBeenCalledWith({
      name: "ticket/suggest-deps.requested",
      data: {
        ticketId: "new-ticket",
        tenantId: "tn",
        projectId: "pj",
        title: "Do the thing",
        description: "because",
      },
    });
    expect(h.suggestDependencies).not.toHaveBeenCalled();
    // The result no longer carries suggestions — they arrive async on the row.
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty("suggestions");
  });

  it("does not fail the create when the suggest-deps emit throws", async () => {
    // Only the suggest-deps send rejects; auto-enrich still succeeds. A flaky
    // background emit must never fail the create — the ticket already inserted.
    h.inngestSend.mockImplementation(async (evt: { name: string }) => {
      if (evt.name === "ticket/suggest-deps.requested") throw new Error("inngest down");
    });
    const res = await createTicketCore({
      tenantId: "tn",
      projectId: "pj",
      title: "Do the thing",
      description: "",
      supabase: fakeClient(),
    });
    expect(res.ok).toBe(true);
  });

  it("passes the builds_on parent to the placement helper and writes the relation", async () => {
    await createTicketCore({
      tenantId: "tn",
      projectId: "pj",
      title: "Stacked work",
      description: "",
      supabase: fakeClient(),
      buildsOnTicketId: PARENT,
    });

    expect(h.computePlacement).toHaveBeenCalledWith({
      projectId: "pj",
      tenantId: "tn",
      blockerIds: [PARENT],
    });
    expect(h.depRows).toEqual([
      { ticket_id: "new-ticket", blocks_ticket_id: PARENT, relation_type: "builds_on" },
    ]);
  });

  it("skips a cross-tenant builds_on parent instead of linking it", async () => {
    h.parentTenant = "other-tenant";
    const res = await createTicketCore({
      tenantId: "tn",
      projectId: "pj",
      title: "Stacked work",
      description: "",
      supabase: fakeClient(),
      buildsOnTicketId: PARENT,
    });
    expect(res.ok).toBe(true);
    expect(h.depRows).toEqual([]);
  });

  it("does not fail the create when the auto-enrich emit throws", async () => {
    h.inngestSend.mockImplementation(async (evt: { name: string }) => {
      if (evt.name === "ticket/auto-enrich.requested") throw new Error("inngest down");
    });
    const res = await createTicketCore({
      tenantId: "tn",
      projectId: "pj",
      title: "Do the thing",
      description: "",
      supabase: fakeClient(),
    });
    expect(res.ok).toBe(true);
  });
});

describe("createTicketCore - image attachments (best-effort, tenant-scoped)", () => {
  // Real uuids so `isKeyUnderTenant` (the boundary re-check) accepts the paths.
  const TENANT = "11111111-1111-1111-1111-111111111111";
  const OTHER = "22222222-2222-2222-2222-222222222222";
  const DRAFT = "33333333-3333-3333-3333-333333333333";
  const key = (t: string, f: string) => `${t}/${DRAFT}/${f}.png`;

  it("writes one ticket_attachments row per valid, tenant-scoped attachment", async () => {
    const res = await createTicketCore({
      tenantId: TENANT,
      projectId: "pj",
      title: "With a screenshot",
      description: "",
      supabase: fakeClient(),
      attachments: [
        {
          storageKey: key(TENANT, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
          mime: "image/png",
          bytes: 2048,
        },
        {
          storageKey: key(TENANT, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
          mime: "image/webp",
          bytes: 4096,
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(h.attachmentRows).toHaveLength(2);
    expect(h.attachmentRows[0]).toMatchObject({
      ticket_id: "new-ticket",
      tenant_id: TENANT,
      storage_key: key(TENANT, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
      mime: "image/png",
      bytes: 2048,
    });
  });

  it("drops a cross-tenant key and never writes a row for it", async () => {
    const res = await createTicketCore({
      tenantId: TENANT,
      projectId: "pj",
      title: "Tampered",
      description: "",
      supabase: fakeClient(),
      attachments: [
        {
          storageKey: key(OTHER, "cccccccc-cccc-cccc-cccc-cccccccccccc"),
          mime: "image/png",
          bytes: 2048,
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(h.attachmentRows).toHaveLength(0);
  });

  it("does not fail the create when the attachment insert errors", async () => {
    h.attachmentInsertError = { message: "storage table down" };
    const res = await createTicketCore({
      tenantId: TENANT,
      projectId: "pj",
      title: "With a screenshot",
      description: "",
      supabase: fakeClient(),
      attachments: [
        {
          storageKey: key(TENANT, "dddddddd-dddd-dddd-dddd-dddddddddddd"),
          mime: "image/png",
          bytes: 2048,
        },
      ],
    });
    // The row insert failed, but the ticket was already saved — create must stay ok.
    expect(res.ok).toBe(true);
  });

  it("writes no rows when there are no attachments (the common path)", async () => {
    await createTicketCore({
      tenantId: TENANT,
      projectId: "pj",
      title: "Plain ticket",
      description: "",
      supabase: fakeClient(),
    });
    expect(h.attachmentRows).toHaveLength(0);
  });
});

describe("createTicketCore - the agent path", () => {
  it("files into backlog with NO role and stamps the source run", async () => {
    const res = await createTicketCore({
      tenantId: "tn",
      projectId: "pj",
      title: "Out-of-scope thing",
      description: "found while doing X",
      supabase: fakeClient(),
      status: "backlog",
      requestedRole: null,
      sourceRunId: "run-1",
    });

    expect(res.ok).toBe(true);
    expect(h.inserted[0]).toMatchObject({
      status: "backlog",
      requested_role: null,
      source_run_id: "run-1",
    });
    // No builds_on parent → placement is "end of the project backlog".
    expect(h.computePlacement).toHaveBeenCalledWith({
      projectId: "pj",
      tenantId: "tn",
      blockerIds: [],
    });
  });
});
