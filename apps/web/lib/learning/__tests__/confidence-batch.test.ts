// The DI'd grading pipeline over a fake client + a stubbed model.
//
// Two things this file pins that nothing else can:
//   1. THE FAIL-OPEN CONTRACT — every failure mode (model returns null, model
//      throws, peer load errors, DB update errors) leaves the row UNGRADED and
//      never throws. Grading runs inside extraction, which runs inside the
//      harvest hook on `agent/run.completed`; a grading failure must not
//      propagate up that chain.
//   2. TENANT SCOPE — reads/writes are on the SERVICE client (RLS off), so the
//      `.eq("tenant_id", …)` on each statement is the ENTIRE boundary. The fake
//      client below ACTUALLY applies `.eq`/`.is`/`.limit`; a filter-ignoring fake
//      would make every one of those assertions vacuous.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  backfillTenantConfidence,
  gradeLessonCandidate,
  gradeStoredLesson,
  type ConfidenceDeps,
} from "@/lib/learning/confidence-batch";
import type { ConfidenceInput, LessonForGrading } from "@/lib/learning/confidence";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const L1 = "aaaa1111-1111-4111-8111-111111111111";
const M1 = "cccc3333-3333-4333-8333-333333333333";

type Row = Record<string, unknown>;

/** A fake PostgREST client that ACTUALLY applies `.eq`/`.is`/`.limit` and honours
 *  `.update`. Applying the filters is the point — see the header. */
function fakeClient(store: Record<string, Row[]>, opts: { failOn?: string } = {}): SupabaseClient {
  function builder(table: string) {
    let rows = [...(store[table] ?? [])];
    let filters: Array<(r: Row) => boolean> = [];
    const self: Record<string, unknown> = {};
    const apply = () => rows.filter((r) => filters.every((f) => f(r)));
    self.select = () => self;
    self.eq = (c: string, v: unknown) => {
      filters.push((r) => r[c] === v);
      rows = apply();
      filters = [];
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
    self.maybeSingle = () =>
      Promise.resolve(
        opts.failOn === table
          ? { data: null, error: { message: "boom" } }
          : { data: rows[0] ?? null, error: null },
      );
    self.update = (patch: Row) => {
      const target = rows;
      const upd = {
        eq: (c: string, v: unknown) => {
          const kept = target.filter((r) => r[c] === v);
          kept.forEach((r) => Object.assign(r, patch));
          return upd;
        },
        then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
      };
      return upd;
    };
    self.then = (resolve: (v: { data: Row[]; error: unknown }) => unknown) =>
      resolve(
        opts.failOn === table
          ? { data: null as unknown as Row[], error: { message: "boom" } }
          : { data: rows, error: null },
      );
    return self;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const lesson: LessonForGrading = {
  body: "Run the full test suite before requesting review.",
  scope: "role",
  roleSlug: "engineer",
  category: "testing",
  evidence: { command: "pnpm test", exitCode: 1 },
  mistakeType: "verification_fail",
};

function deps(
  store: Record<string, Row[]>,
  grade: ConfidenceDeps["gradeLesson"],
  opts: { failOn?: string } = {},
): ConfidenceDeps {
  return { db: fakeClient(store, opts), gradeLesson: grade };
}

function seed(): Record<string, Row[]> {
  return {
    agent_learnings: [
      {
        id: L1,
        tenant_id: T,
        body: "Run the full test suite before requesting review.",
        scope: "role",
        role_slug: "engineer",
        category: "testing",
        status: "candidate",
        confidence: null,
        confidence_reason: null,
        source_mistake_id: M1,
      },
    ],
    agent_mistakes: [
      {
        id: M1,
        tenant_id: T,
        type: "verification_fail",
        evidence: { command: "pnpm test", exitCode: 1, outputTail: "2 failing" },
      },
    ],
  };
}

describe("gradeLessonCandidate", () => {
  it("grounds the model's answer", async () => {
    const g = await gradeLessonCandidate(
      deps(seed(), async () => ({ confidence: "high", reason: "backed by a failing test" })),
      { tenantId: T, lesson },
    );
    expect(g).toEqual({ confidence: "high", reason: "backed by a failing test" });
  });

  it("an off-vocabulary answer grades low, not high", async () => {
    const g = await gradeLessonCandidate(
      deps(seed(), async () => ({ confidence: "super-high", reason: "trust me" })),
      { tenantId: T, lesson },
    );
    expect(g?.confidence).toBe("low");
  });

  // Fail-open, mode 1: the model declines / times out.
  it("returns null (leave UNGRADED) when the model returns null", async () => {
    const g = await gradeLessonCandidate(
      deps(seed(), async () => null),
      { tenantId: T, lesson },
    );
    expect(g).toBeNull();
  });

  // Fail-open, mode 2: the model throws.
  it("returns null and does not throw when the model throws", async () => {
    const g = await gradeLessonCandidate(
      deps(seed(), async () => {
        throw new Error("runner down");
      }),
      { tenantId: T, lesson },
    );
    expect(g).toBeNull();
  });

  // Fail-open, mode 3: peers can't be loaded — grade anyway, WITHOUT the conflict
  // signal, rather than skipping the grade entirely.
  it("still grades when the active-peer load errors", async () => {
    const g = await gradeLessonCandidate(
      deps(seed(), async () => ({ confidence: "medium", reason: "ok" }), {
        failOn: "agent_learnings",
      }),
      { tenantId: T, lesson },
    );
    expect(g?.confidence).toBe("medium");
  });

  it("feeds the tenant's ACTIVE lessons to the grader as conflict context", async () => {
    const store = seed();
    store.agent_learnings!.push(
      { id: "x", tenant_id: T, body: "Never run the tests.", status: "active" },
      { id: "y", tenant_id: T, body: "A queued candidate.", status: "candidate" },
    );
    let seen: ConfidenceInput | null = null;
    await gradeLessonCandidate(
      deps(store, async (i) => {
        seen = i;
        return { confidence: "low", reason: "conflicts with active 0" };
      }),
      { tenantId: T, lesson },
    );
    expect(seen!.prompt).toContain("Never run the tests.");
    // Only ACTIVE lessons are peers — a candidate is not yet a commitment.
    expect(seen!.prompt).not.toContain("A queued candidate.");
  });
});

describe("gradeStoredLesson", () => {
  it("writes the grade back to the row", async () => {
    const store = seed();
    const res = await gradeStoredLesson(
      deps(store, async () => ({ confidence: "high", reason: "specific and evidenced" })),
      { tenantId: T, learningId: L1 },
    );
    expect(res).toMatchObject({ ok: true, status: "graded" });
    expect(store.agent_learnings![0]).toMatchObject({
      confidence: "high",
      confidence_reason: "specific and evidenced",
    });
  });

  it("passes the source mistake's evidence to the grader", async () => {
    let seen: ConfidenceInput | null = null;
    await gradeStoredLesson(
      deps(seed(), async (i) => {
        seen = i;
        return { confidence: "high", reason: "ok" };
      }),
      { tenantId: T, learningId: L1 },
    );
    expect(seen!.prompt).toContain("2 failing");
  });

  it("is idempotent — an already-graded row is skipped", async () => {
    const store = seed();
    store.agent_learnings![0]!.confidence = "medium";
    const model = vi.fn(async () => ({ confidence: "high", reason: "x" }));
    const res = await gradeStoredLesson(deps(store, model), { tenantId: T, learningId: L1 });
    expect(res).toMatchObject({ ok: true, status: "skipped", reason: "already-graded" });
    expect(model).not.toHaveBeenCalled();
    expect(store.agent_learnings![0]!.confidence).toBe("medium");
  });

  it("--regrade overwrites an existing grade", async () => {
    const store = seed();
    store.agent_learnings![0]!.confidence = "medium";
    await gradeStoredLesson(
      deps(store, async () => ({ confidence: "low", reason: "too sweeping" })),
      { tenantId: T, learningId: L1, regrade: true },
    );
    expect(store.agent_learnings![0]!.confidence).toBe("low");
  });

  // Fail-open at the write layer: never stamp a placeholder.
  it("leaves the row UNTOUCHED when the model declines", async () => {
    const store = seed();
    const res = await gradeStoredLesson(
      deps(store, async () => null),
      {
        tenantId: T,
        learningId: L1,
      },
    );
    expect(res).toMatchObject({ ok: true, status: "skipped", reason: "not-graded" });
    expect(store.agent_learnings![0]).toMatchObject({
      confidence: null,
      confidence_reason: null,
    });
  });

  it("a dry run grades but writes nothing", async () => {
    const store = seed();
    const res = await gradeStoredLesson(
      deps(store, async () => ({ confidence: "high", reason: "ok" })),
      { tenantId: T, learningId: L1, dryRun: true },
    );
    expect(res).toMatchObject({ ok: true, status: "graded" });
    expect(store.agent_learnings![0]!.confidence).toBeNull();
  });

  it("grades a hand-authored lesson with no source mistake", async () => {
    const store = seed();
    store.agent_learnings![0]!.source_mistake_id = null;
    let seen: ConfidenceInput | null = null;
    const res = await gradeStoredLesson(
      deps(store, async (i) => {
        seen = i;
        return { confidence: "medium", reason: "no evidence" };
      }),
      { tenantId: T, learningId: L1 },
    );
    expect(res).toMatchObject({ ok: true, status: "graded" });
    expect(seen!.prompt).toContain("no recorded evidence");
  });
});

describe("tenant scope (service-role reads — the .eq IS the boundary)", () => {
  it("refuses a lesson belonging to another tenant", async () => {
    const store = seed();
    store.agent_learnings![0]!.tenant_id = FOREIGN;
    const model = vi.fn(async () => ({ confidence: "high", reason: "x" }));
    const res = await gradeStoredLesson(deps(store, model), { tenantId: T, learningId: L1 });
    expect(res).toMatchObject({ ok: false, reason: "lesson-not-found" });
    expect(model).not.toHaveBeenCalled();
    expect(store.agent_learnings![0]!.confidence).toBeNull();
  });

  it("never puts another tenant's active lessons in our grading prompt", async () => {
    const store = seed();
    store.agent_learnings!.push({
      id: "foreign-active",
      tenant_id: FOREIGN,
      body: "FOREIGN TENANT SECRET LESSON.",
      status: "active",
    });
    let seen: ConfidenceInput | null = null;
    await gradeLessonCandidate(
      deps(store, async (i) => {
        seen = i;
        return { confidence: "high", reason: "ok" };
      }),
      { tenantId: T, lesson },
    );
    expect(seen!.prompt).not.toContain("FOREIGN TENANT SECRET LESSON");
  });

  it("never reads another tenant's mistake as our lesson's evidence", async () => {
    const store = seed();
    store.agent_mistakes![0]!.tenant_id = FOREIGN;
    store.agent_mistakes![0]!.evidence = { outputTail: "FOREIGN EVIDENCE" };
    let seen: ConfidenceInput | null = null;
    await gradeStoredLesson(
      deps(store, async (i) => {
        seen = i;
        return { confidence: "high", reason: "ok" };
      }),
      { tenantId: T, learningId: L1 },
    );
    expect(seen!.prompt).not.toContain("FOREIGN EVIDENCE");
    expect(seen!.prompt).toContain("no recorded evidence");
  });

  it("the backfill scan never picks up another tenant's candidates", async () => {
    const store = seed();
    store.agent_learnings!.push({
      id: "foreign-candidate",
      tenant_id: FOREIGN,
      body: "Foreign candidate.",
      scope: "global",
      role_slug: null,
      category: "other",
      status: "candidate",
      confidence: null,
      source_mistake_id: null,
    });
    const res = await backfillTenantConfidence(
      deps(store, async () => ({ confidence: "high", reason: "ok" })),
      { tenantId: T },
    );
    expect(res.scanned).toBe(1);
    expect(res.graded).toBe(1);
    expect(store.agent_learnings!.find((r) => r.id === "foreign-candidate")!.confidence).toBeNull();
  });
});

describe("backfillTenantConfidence", () => {
  it("grades a tenant's ungraded candidates and is idempotent on a second run", async () => {
    const store = seed();
    const first = await backfillTenantConfidence(
      deps(store, async () => ({ confidence: "medium", reason: "narrow" })),
      { tenantId: T },
    );
    expect(first).toMatchObject({ scanned: 1, graded: 1, failures: 0 });

    const model = vi.fn(async () => ({ confidence: "high", reason: "x" }));
    const second = await backfillTenantConfidence(deps(store, model), { tenantId: T });
    expect(second).toMatchObject({ scanned: 0, graded: 0 });
    expect(model).not.toHaveBeenCalled();
    expect(store.agent_learnings![0]!.confidence).toBe("medium");
  });

  it("skips ACTIVE lessons — grading triages the review queue only", async () => {
    const store = seed();
    store.agent_learnings![0]!.status = "active";
    const res = await backfillTenantConfidence(
      deps(store, async () => ({ confidence: "high", reason: "ok" })),
      { tenantId: T },
    );
    expect(res.scanned).toBe(0);
  });

  it("a per-row grading failure does not stop the scan", async () => {
    const store = seed();
    store.agent_learnings!.push({
      id: "second",
      tenant_id: T,
      body: "Second candidate.",
      scope: "global",
      role_slug: null,
      category: "other",
      status: "candidate",
      confidence: null,
      source_mistake_id: null,
    });
    let n = 0;
    const res = await backfillTenantConfidence(
      deps(store, async () => {
        n += 1;
        if (n === 1) throw new Error("runner down");
        return { confidence: "high", reason: "ok" };
      }),
      { tenantId: T },
    );
    expect(res.scanned).toBe(2);
    expect(res.graded).toBe(1);
    expect(res.skipped).toBe(1); // the failed one was left ungraded, not failed-hard
  });
});
