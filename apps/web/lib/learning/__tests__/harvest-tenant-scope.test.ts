// Tenant scoping of the harvester.
//
// harvestTicketMistakes reads on the SERVICE client (RLS off), so the ONLY thing
// keeping another tenant's forged rows out of a mistake record is the
// `.eq("tenant_id", tenantId)` written into each query. That is invisible in the
// output — a contaminated harvest looks exactly like a correct one. So this test
// plants foreign-tenant rows attached to our ticket (the write policies pin only
// each row's own tenant, never the FK it points at) and asserts NONE of them is
// harvested or attributed.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { harvestTicketMistakes, type HarvestDeps } from "@/lib/learning/harvest-batch";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TICKET = "aaaa1111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

function fakeClient(store: Record<string, Row[]>): SupabaseClient {
  function builder(table: string) {
    let rows = [...(store[table] ?? [])];
    const self: Record<string, unknown> = {};
    self.select = () => self;
    self.eq = (c: string, v: unknown) => {
      rows = rows.filter((r) => r[c] === v);
      return self;
    };
    self.in = (c: string, vs: readonly unknown[]) => {
      rows = rows.filter((r) => vs.includes(r[c]));
      return self;
    };
    self.order = () => self;
    self.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    self.upsert = (input: Row[]) => {
      (store[table] ??= []).push(...input);
      return Promise.resolve({ error: null });
    };
    self.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null });
    return self;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const deps = (store: Record<string, Row[]>): HarvestDeps => ({
  db: fakeClient(store),
  resolveOnSuccessStatus: (role) =>
    role === "engineer" ? "in_review" : role === "qa" ? "done" : null,
});

describe("harvest tenant scoping", () => {
  it("never harvests or attributes a foreign-tenant row planted on our ticket", async () => {
    const store: Record<string, Row[]> = {
      tickets: [{ id: TICKET, tenant_id: T, retry_count: 0, status: "in_progress" }],
      runs: [
        // Our run.
        {
          id: "ours",
          tenant_id: T,
          ticket_id: TICKET,
          agent_id: "ag-eng",
          fan_out_role: null,
          status: "done",
          created_at: "2026-07-15T08:00:00Z",
          last_event_at: "2026-07-15T08:30:00Z",
        },
        // FORGED: a foreign tenant's FAILED run attached to our ticket. If the
        // runs read is unscoped, this becomes a run_failed mistake on our board.
        {
          id: "forged",
          tenant_id: FOREIGN,
          ticket_id: TICKET,
          agent_id: "ag-x",
          fan_out_role: null,
          status: "failed",
          created_at: "2026-07-15T08:10:00Z",
          last_event_at: "2026-07-15T08:20:00Z",
        },
      ],
      agents: [{ id: "ag-eng", tenant_id: T, role: "engineer", config: {} }],
      run_verifications: [
        // FORGED: a foreign failing verification keyed on our run id.
        {
          run_id: "ours",
          tenant_id: FOREIGN,
          command: "curl evil",
          exit_code: 1,
          output_tail: "x",
          ran_at: "2026-07-15T08:25:00Z",
        },
      ],
      comments: [
        // FORGED: a foreign gate comment on our ticket.
        {
          id: "c-forged",
          tenant_id: FOREIGN,
          ticket_id: TICKET,
          author_type: "system",
          author_id: "devpilot_qa_gate",
          body: "forged",
          created_at: "2026-07-15T08:26:00Z",
        },
      ],
      run_steps: [],
      agent_mistakes: [],
    };

    const res = await harvestTicketMistakes(deps(store), { tenantId: T, ticketId: TICKET });
    expect(res.ok).toBe(true);

    // The forged run_failed, verification_fail and gate_refusal must all be absent.
    const keys = store.agent_mistakes!.map((m) => m.dedupe_key);
    expect(keys).not.toContain("run_failed:forged");
    expect(keys).not.toContain("verification_fail:ours"); // the only verification was foreign
    expect(keys).not.toContain("gate_refusal:c-forged");
    // Nothing at all should be attributed to the foreign tenant.
    expect(store.agent_mistakes!.every((m) => m.tenant_id === T)).toBe(true);
  });

  it("refuses when the ticket belongs to another tenant", async () => {
    const store: Record<string, Row[]> = {
      tickets: [{ id: TICKET, tenant_id: FOREIGN, retry_count: 3, status: "done" }],
      runs: [],
      agents: [],
      run_verifications: [],
      comments: [],
      run_steps: [],
      agent_mistakes: [],
    };
    const res = await harvestTicketMistakes(deps(store), { tenantId: T, ticketId: TICKET });
    expect(res).toMatchObject({ ok: false, reason: "ticket-not-found" });
    expect(store.agent_mistakes!.length).toBe(0);
  });
});
