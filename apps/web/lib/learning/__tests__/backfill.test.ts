// Backfill over a seeded multi-ticket fixture: a ticket QA-rejected-then-fixed, a
// pure verification failure, and a gate park. Asserts the backfill derives EXACTLY
// the expected agent_mistakes rows (correct attribution + counts_against_score),
// and is IDEMPOTENT on a second run (the unique dedupe key drops the re-derived
// rows). Uses a fake in-memory client — never a real Supabase — per the task's
// "do not stand up a local Supabase" constraint.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  backfillTenantMistakes,
  harvestTicketMistakes,
  type HarvestDeps,
} from "@/lib/learning/harvest-batch";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;

/**
 * A fake PostgREST client that ACTUALLY APPLIES `.eq()`/`.in()`/`.order()` and
 * honours `.upsert(..., { onConflict, ignoreDuplicates })`. Applying the filters
 * is the point — a fake that ignored them would make the tenant-scope assertions
 * (in the sibling test) vacuous, and would let the dedupe assertion pass without
 * the unique key doing anything.
 */
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
    self.order = (c: string, opts?: { ascending?: boolean }) => {
      const asc = opts?.ascending !== false;
      rows = [...rows].sort((a, b) =>
        asc
          ? Number(a[c]) - Number(b[c]) || String(a[c]).localeCompare(String(b[c]))
          : Number(b[c]) - Number(a[c]) || String(b[c]).localeCompare(String(a[c])),
      );
      return self;
    };
    self.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    self.upsert = (input: Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
      const dest = (store[table] ??= []);
      const keys = (opts?.onConflict ?? "").split(",").map((k) => k.trim());
      for (const row of input) {
        const dup = dest.some((existing) => keys.every((k) => existing[k] === row[k]));
        if (dup && opts?.ignoreDuplicates) continue;
        if (!dup) dest.push(row);
      }
      return Promise.resolve({ error: null });
    };
    self.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null });
    return self;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const ROLE_ON_SUCCESS: Record<string, string> = {
  engineer: "in_review",
  qa: "done",
  verifier: "done",
};

function deps(store: Record<string, Row[]>): HarvestDeps {
  return {
    db: fakeClient(store),
    resolveOnSuccessStatus: (role) => (role ? (ROLE_ON_SUCCESS[role] ?? null) : null),
  };
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const TICKET_A = "aaaa1111-1111-4111-8111-111111111111"; // rejected then fixed
const TICKET_B = "bbbb2222-2222-4222-8222-222222222222"; // verification failure
const TICKET_C = "cccc3333-3333-4333-8333-333333333333"; // gate park

function seed(): Record<string, Row[]> {
  return {
    tickets: [
      { id: TICKET_A, tenant_id: T, retry_count: 1, status: "done" },
      { id: TICKET_B, tenant_id: T, retry_count: 0, status: "in_progress" },
      { id: TICKET_C, tenant_id: T, retry_count: 0, status: "blocked" },
    ],
    runs: [
      // Ticket A: producer eng1 (rejected), reviewer qa1, producer eng2 (accepted)
      {
        id: "A-eng1",
        tenant_id: T,
        ticket_id: TICKET_A,
        agent_id: "ag-eng",
        fan_out_role: null,
        status: "done",
        created_at: "2026-07-15T08:00:00Z",
        last_event_at: "2026-07-15T08:30:00Z",
      },
      {
        id: "A-qa1",
        tenant_id: T,
        ticket_id: TICKET_A,
        agent_id: "ag-qa",
        fan_out_role: null,
        status: "done",
        created_at: "2026-07-15T08:40:00Z",
        last_event_at: "2026-07-15T08:50:00Z",
      },
      {
        id: "A-eng2",
        tenant_id: T,
        ticket_id: TICKET_A,
        agent_id: "ag-eng",
        fan_out_role: null,
        status: "done",
        created_at: "2026-07-15T09:00:00Z",
        last_event_at: "2026-07-15T09:30:00Z",
      },
      // Ticket B: one producer whose verification failed
      {
        id: "B-eng1",
        tenant_id: T,
        ticket_id: TICKET_B,
        agent_id: "ag-eng",
        fan_out_role: null,
        status: "done",
        created_at: "2026-07-15T10:00:00Z",
        last_event_at: "2026-07-15T10:20:00Z",
      },
      // Ticket C: one producer that got gate-parked
      {
        id: "C-eng1",
        tenant_id: T,
        ticket_id: TICKET_C,
        agent_id: "ag-eng",
        fan_out_role: null,
        status: "done",
        created_at: "2026-07-15T11:00:00Z",
        last_event_at: "2026-07-15T11:20:00Z",
      },
    ],
    agents: [
      { id: "ag-eng", tenant_id: T, role: "engineer", config: {} },
      { id: "ag-qa", tenant_id: T, role: "qa", config: {} },
    ],
    run_verifications: [
      {
        run_id: "A-eng1",
        tenant_id: T,
        command: "pnpm test",
        exit_code: 1,
        output_tail: "2 failing",
        ran_at: "2026-07-15T08:25:00Z",
      },
      {
        run_id: "A-eng2",
        tenant_id: T,
        command: "pnpm test",
        exit_code: 0,
        output_tail: "",
        ran_at: "2026-07-15T09:25:00Z",
      },
      {
        run_id: "B-eng1",
        tenant_id: T,
        command: "pnpm build",
        exit_code: 2,
        output_tail: "type error",
        ran_at: "2026-07-15T10:15:00Z",
      },
    ],
    comments: [
      {
        id: "A-reject",
        tenant_id: T,
        ticket_id: TICKET_A,
        author_type: "system",
        author_id: "devpilot_move_ticket",
        body: "changes requested: handle nulls",
        created_at: "2026-07-15T08:45:00Z",
      },
      {
        id: "C-gate",
        tenant_id: T,
        ticket_id: TICKET_C,
        author_type: "system",
        author_id: "devpilot_qa_gate",
        body: "tests failing, cannot hand off",
        created_at: "2026-07-15T11:10:00Z",
      },
    ],
    run_steps: [],
    agent_mistakes: [],
  };
}

describe("backfillTenantMistakes", () => {
  it("derives exactly the expected mistakes with correct attribution + scoring", async () => {
    const store = seed();
    const res = await backfillTenantMistakes(deps(store), { tenantId: T });

    expect(res.ticketsScanned).toBe(3);
    const mistakes = store.agent_mistakes!;
    const byKey = new Map(mistakes.map((m) => [m.dedupe_key as string, m]));

    // Ticket A: a verification fail on eng1 + a QA reject on eng1 (the rejected
    // producer), both attributed to the engineer, both counting against score.
    expect(byKey.has("verification_fail:A-eng1")).toBe(true);
    expect(byKey.has("qa_reject:A-eng1")).toBe(true);
    expect(byKey.get("verification_fail:A-eng1")).toMatchObject({
      role: "engineer",
      counts_against_score: true,
      run_id: "A-eng1",
    });
    expect(byKey.get("qa_reject:A-eng1")).toMatchObject({
      role: "engineer",
      counts_against_score: true,
    });

    // Ticket B: a verification fail (exit 2) on the producer.
    expect(byKey.get("verification_fail:B-eng1")).toMatchObject({
      role: "engineer",
      counts_against_score: true,
    });

    // Ticket C: a gate refusal attributed to the producer that was parked.
    expect(byKey.get("gate_refusal:C-gate")).toMatchObject({
      type: "gate_refusal",
      role: "engineer",
      counts_against_score: true,
      run_id: "C-eng1",
    });

    // Exactly these four, no phantom rows.
    expect([...byKey.keys()].sort()).toEqual([
      "gate_refusal:C-gate",
      "qa_reject:A-eng1",
      "verification_fail:A-eng1",
      "verification_fail:B-eng1",
    ]);

    // The reviewer (qa) is never the attributed party.
    expect(mistakes.every((m) => m.role !== "qa")).toBe(true);
  });

  it("is idempotent — a second backfill records nothing new", async () => {
    const store = seed();
    await backfillTenantMistakes(deps(store), { tenantId: T });
    const afterFirst = store.agent_mistakes!.length;
    expect(afterFirst).toBe(4);

    // Re-run against the same store (dedupe key + ignoreDuplicates must no-op).
    await backfillTenantMistakes(deps(store), { tenantId: T });
    expect(store.agent_mistakes!.length).toBe(afterFirst);
  });

  it("--dry-run writes nothing but reports what it would record", async () => {
    const store = seed();
    const res = await backfillTenantMistakes(deps(store), { tenantId: T, dryRun: true });
    expect(res.mistakesInserted).toBe(4);
    expect(store.agent_mistakes!.length).toBe(0);
  });

  it("redacts secrets in verification evidence before storing", async () => {
    const store = seed();
    store.run_verifications!.push({
      run_id: "B-eng1",
      tenant_id: T,
      command: "AWS_SECRET_ACCESS_KEY=abcd1234deadbeefcafe pnpm build",
      exit_code: 3,
      output_tail: "failed at /Users/captain/app",
      ran_at: "2026-07-15T10:16:00Z",
    });
    // Replace the earlier B verification (unique per run in reality); keep only the secret one.
    store.run_verifications = store.run_verifications!.filter(
      (v) => !(v.run_id === "B-eng1" && v.exit_code === 2),
    );
    await harvestTicketMistakes(deps(store), { tenantId: T, ticketId: TICKET_B });
    const row = store.agent_mistakes!.find((m) => m.dedupe_key === "verification_fail:B-eng1")!;
    const ev = row.evidence as Record<string, string>;
    expect(ev.command).not.toContain("abcd1234deadbeefcafe");
    expect(ev.outputTail).toBe("failed at /Users/<redacted>/app");
  });
});
