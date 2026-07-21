// Tenant scoping of the extractor.
//
// extractMistakeLesson reads on the SERVICE client (RLS off), so the ONLY thing
// keeping another tenant's rows out is the `.eq("tenant_id", tenantId)` on every
// query. A contaminated extraction looks exactly like a correct one, so this test
// plants foreign-tenant rows (a mistake attributed to us, and a foreign lesson
// worded like ours) and asserts: a foreign mistake is refused, and a foreign
// lesson never suppresses our candidate via dedupe or short-circuits our
// idempotency check.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractMistakeLesson, type ExtractDeps } from "@/lib/learning/extract-batch";
import type { RawLessonCandidate } from "@/lib/learning/extract";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISTAKE = "aaaa1111-1111-4111-8111-111111111111";

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
    self.is = (c: string, v: unknown) => {
      rows = rows.filter((r) => (r[c] ?? null) === v);
      return self;
    };
    self.limit = (n: number) => {
      rows = rows.slice(0, n);
      return self;
    };
    self.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    self.insert = (input: Row | Row[]) => {
      (store[table] ??= []).push(...(Array.isArray(input) ? input : [input]));
      return Promise.resolve({ error: null });
    };
    self.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null });
    return self;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const candidate: RawLessonCandidate = {
  body: "Run the full test suite before requesting review.",
  scope: "role",
  category: "testing",
};

const deps = (store: Record<string, Row[]>): ExtractDeps => ({
  db: fakeClient(store),
  generateCandidate: async () => candidate,
});

describe("extractor tenant scoping", () => {
  it("refuses a mistake that belongs to another tenant", async () => {
    const store: Record<string, Row[]> = {
      agent_mistakes: [
        {
          id: MISTAKE,
          tenant_id: FOREIGN,
          ticket_id: "t",
          role: "engineer",
          type: "run_failed",
          severity: 3,
          evidence: {},
          corrected_by: null,
        },
      ],
      agent_learnings: [],
    };
    const res = await extractMistakeLesson(deps(store), { tenantId: T, mistakeId: MISTAKE });
    expect(res).toMatchObject({ ok: false, reason: "mistake-not-found" });
    expect(store.agent_learnings!.length).toBe(0);
  });

  it("a FOREIGN lesson worded like ours neither dedupes nor pre-empts our candidate", async () => {
    const store: Record<string, Row[]> = {
      agent_mistakes: [
        {
          id: MISTAKE,
          tenant_id: T,
          ticket_id: "t",
          role: "engineer",
          type: "verification_fail",
          severity: 2,
          evidence: { command: "pnpm test", exitCode: 1 },
          corrected_by: null,
        },
      ],
      agent_learnings: [
        // FORGED: a foreign-tenant lesson pointing at OUR mistake and worded like
        // our candidate. If either query were unscoped, this would (a) trip the
        // already-extracted short-circuit, or (b) trip the body dedupe — both
        // silently suppressing our real candidate.
        {
          id: "L-forged",
          tenant_id: FOREIGN,
          scope: "role",
          role_slug: "engineer",
          category: "testing",
          body: "Run the full test suite before requesting review.",
          status: "active",
          source_mistake_id: MISTAKE,
        },
      ],
    };
    const res = await extractMistakeLesson(deps(store), { tenantId: T, mistakeId: MISTAKE });
    expect(res).toMatchObject({ ok: true, status: "inserted" });
    // Our candidate landed, in OUR tenant, and the foreign row is untouched.
    const ours = store.agent_learnings!.filter((l) => l.tenant_id === T);
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ source_mistake_id: MISTAKE, tenant_id: T });
  });
});
