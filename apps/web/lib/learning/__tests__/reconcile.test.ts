// Reconciling an already-queued backlog against the active lessons.
//
// This proposes REJECTIONS of the operator's own review queue, so the two
// properties that matter most are that a dry run writes NOTHING, and that the
// comparison is scoped exactly as the extractor's is — a foreign tenant's active
// lessons must never justify rejecting this operator's candidates.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bestActiveMatch, reconcileTenantQueue } from "@/lib/learning/reconcile";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const BODY = "Run the full test suite before requesting review.";
const RESTATEMENT = "Always run the full test suite before requesting a review.";
const UNRELATED = "Prefer Vercel over self-hosted CI infrastructure.";

type Row = Record<string, unknown>;

/** Filter-APPLYING fake, with a working `.update().in().eq().select()` chain. */
function fakeClient(store: Record<string, Row[]>): SupabaseClient {
  function builder(table: string) {
    let rows = [...(store[table] ?? [])];
    let patch: Row | null = null;
    const self: Record<string, unknown> = {};
    self.select = () => self;
    self.update = (p: Row) => {
      patch = p;
      return self;
    };
    self.eq = (c: string, v: unknown) => {
      rows = rows.filter((r) => r[c] === v);
      return self;
    };
    self.in = (c: string, vs: readonly unknown[]) => {
      rows = rows.filter((r) => vs.includes(r[c]));
      return self;
    };
    self.then = (resolve: (v: { data: Row[]; error: null }) => unknown) => {
      if (patch) {
        // Apply to the ORIGINALS the filters selected, so the store really changes.
        for (const r of rows) Object.assign(r, patch);
      }
      return resolve({ data: rows, error: null });
    };
    return self;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

function row(over: Partial<Row> & { id: string; body: string; status: string }): Row {
  return { tenant_id: T, scope: "role", role_slug: "engineer", ...over };
}

describe("reconcileTenantQueue", () => {
  it("flags a queued candidate that restates an active lesson, and writes nothing on a dry run", async () => {
    const store: Record<string, Row[]> = {
      agent_learnings: [
        row({ id: "A1", body: BODY, status: "active" }),
        row({ id: "C1", body: RESTATEMENT, status: "candidate" }),
        row({ id: "C2", body: UNRELATED, status: "candidate" }),
      ],
    };
    const res = await reconcileTenantQueue(fakeClient(store), { tenantId: T });
    expect(res.candidatesScanned).toBe(2);
    expect(res.activeCompared).toBe(1);
    expect(res.matches.map((m) => m.candidateId)).toEqual(["C1"]);
    expect(res.rejected).toBe(0);
    // The decisive assertion: nothing in the store moved.
    expect(store.agent_learnings!.map((r) => r.status)).toEqual([
      "active",
      "candidate",
      "candidate",
    ]);
  });

  it("--apply rejects exactly the flagged rows and leaves the rest alone", async () => {
    const store: Record<string, Row[]> = {
      agent_learnings: [
        row({ id: "A1", body: BODY, status: "active" }),
        row({ id: "C1", body: RESTATEMENT, status: "candidate" }),
        row({ id: "C2", body: UNRELATED, status: "candidate" }),
      ],
    };
    const res = await reconcileTenantQueue(fakeClient(store), { tenantId: T, apply: true });
    expect(res.rejected).toBe(1);
    const byId = Object.fromEntries(store.agent_learnings!.map((r) => [r.id, r.status]));
    expect(byId).toEqual({ A1: "active", C1: "rejected", C2: "candidate" });
  });

  it("a FOREIGN tenant's active lesson never flags our candidate", async () => {
    const store: Record<string, Row[]> = {
      agent_learnings: [
        row({ id: "A1", tenant_id: FOREIGN, body: BODY, status: "active" }),
        row({ id: "C1", body: RESTATEMENT, status: "candidate" }),
      ],
    };
    const res = await reconcileTenantQueue(fakeClient(store), { tenantId: T });
    expect(res.activeCompared).toBe(0);
    expect(res.matches).toEqual([]);
  });

  it("CONTROL: the same active lesson in OUR tenant does flag it", async () => {
    const store: Record<string, Row[]> = {
      agent_learnings: [
        row({ id: "A1", tenant_id: T, body: BODY, status: "active" }),
        row({ id: "C1", body: RESTATEMENT, status: "candidate" }),
      ],
    };
    const res = await reconcileTenantQueue(fakeClient(store), { tenantId: T });
    expect(res.matches.map((m) => m.candidateId)).toEqual(["C1"]);
  });

  it("never flags a foreign candidate even when it matches", async () => {
    const store: Record<string, Row[]> = {
      agent_learnings: [
        row({ id: "A1", body: BODY, status: "active" }),
        row({ id: "C1", tenant_id: FOREIGN, body: RESTATEMENT, status: "candidate" }),
      ],
    };
    const res = await reconcileTenantQueue(fakeClient(store), { tenantId: T, apply: true });
    expect(res.candidatesScanned).toBe(0);
    expect(res.rejected).toBe(0);
    expect(store.agent_learnings![1]!.status).toBe("candidate");
  });
});

describe("bestActiveMatch (pure)", () => {
  const cand = { body: RESTATEMENT, scope: "role", roleSlug: "engineer" };

  it("only compares within the same (scope, role) bucket", () => {
    expect(bestActiveMatch(cand, [{ body: BODY, scope: "global", roleSlug: null }])).toBeNull();
    expect(bestActiveMatch(cand, [{ body: BODY, scope: "role", roleSlug: "qa" }])).toBeNull();
    expect(
      bestActiveMatch(cand, [{ body: BODY, scope: "role", roleSlug: "engineer" }]),
    ).not.toBeNull();
  });

  it("returns the CLOSEST match when several clear the threshold", () => {
    const hit = bestActiveMatch(cand, [
      {
        body: "Run the test suite before review, and say which commands you ran.",
        scope: "role",
        roleSlug: "engineer",
      },
      { body: BODY, scope: "role", roleSlug: "engineer" },
    ]);
    expect(hit?.body).toBe(BODY);
  });
});
