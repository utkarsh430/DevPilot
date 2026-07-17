// The DI'd extraction pipeline over a fake client + a stubbed model: inserts a
// grounded candidate, is idempotent per source mistake, skips a body-near-dup,
// and skips when the model declines. Uses a fake in-memory client — never a real
// Supabase — per the task's "do not stand up a local Supabase" constraint.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  backfillTenantLessons,
  extractMistakeLesson,
  type ExtractDeps,
} from "@/lib/learning/extract-batch";
import type {
  DedupCheckInput,
  ExtractionInput,
  RawDedupVerdict,
  RawLessonCandidate,
} from "@/lib/learning/extract";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;

/** A fake PostgREST client that ACTUALLY applies `.eq`/`.in`/`.is`/`.limit` and
 *  honours `.insert`. Applying the filters is the point: a fake that ignored them
 *  would make the tenant-scope + dedupe assertions vacuous. */
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

function deps(
  store: Record<string, Row[]>,
  model: (input: ExtractionInput) => Promise<RawLessonCandidate | null>,
  extra: Partial<
    Pick<ExtractDeps, "checkSemanticDuplicate" | "resolveAutoApprove" | "gradeCandidate">
  > = {},
): ExtractDeps {
  return { db: fakeClient(store), generateCandidate: model, ...extra };
}

const MISTAKE_A = "aaaa1111-1111-4111-8111-111111111111";

function seed(): Record<string, Row[]> {
  return {
    agent_mistakes: [
      {
        id: MISTAKE_A,
        tenant_id: T,
        ticket_id: "t-A",
        role: "engineer",
        type: "verification_fail",
        severity: 2,
        evidence: { command: "pnpm test", exitCode: 1, outputTail: "2 failing" },
        corrected_by: { nextRunId: "r2", reVerificationClean: true },
      },
    ],
    agent_learnings: [],
  };
}

const engineerLesson: RawLessonCandidate = {
  body: "Run the full test suite locally before requesting review.",
  scope: "role",
  category: "testing",
};

describe("extractMistakeLesson", () => {
  it("inserts a grounded candidate lesson with the mistake as its source", async () => {
    const store = seed();
    const res = await extractMistakeLesson(
      deps(store, async () => engineerLesson),
      {
        tenantId: T,
        mistakeId: MISTAKE_A,
      },
    );
    expect(res).toMatchObject({ ok: true, status: "inserted" });
    expect(store.agent_learnings).toHaveLength(1);
    expect(store.agent_learnings![0]).toMatchObject({
      tenant_id: T,
      scope: "role",
      role_slug: "engineer",
      category: "testing",
      status: "candidate",
      source_mistake_id: MISTAKE_A,
      created_by: "lesson_extractor",
    });
  });

  it("is idempotent — a second extraction for the same mistake inserts nothing", async () => {
    const store = seed();
    await extractMistakeLesson(
      deps(store, async () => engineerLesson),
      {
        tenantId: T,
        mistakeId: MISTAKE_A,
      },
    );
    expect(store.agent_learnings).toHaveLength(1);
    // Re-run: the source-mistake check must short-circuit BEFORE the model call.
    let modelCalled = false;
    const res = await extractMistakeLesson(
      deps(store, async () => {
        modelCalled = true;
        return engineerLesson;
      }),
      { tenantId: T, mistakeId: MISTAKE_A },
    );
    expect(res).toMatchObject({ ok: true, status: "skipped", reason: "already-extracted" });
    expect(modelCalled).toBe(false);
    expect(store.agent_learnings).toHaveLength(1);
  });

  it("skips a body-near-duplicate of an existing lesson in the same scope+role", async () => {
    const store = seed();
    // An existing ACTIVE lesson for engineers that says the same thing.
    store.agent_learnings!.push({
      id: "L-existing",
      tenant_id: T,
      scope: "role",
      role_slug: "engineer",
      category: "testing",
      body: "Always run the full test suite before requesting review.",
      status: "active",
      source_mistake_id: null,
    });
    const near: RawLessonCandidate = {
      body: "Run the test suite before you request review.",
      scope: "role",
      category: "testing",
    };
    const res = await extractMistakeLesson(
      deps(store, async () => near),
      {
        tenantId: T,
        mistakeId: MISTAKE_A,
      },
    );
    expect(res).toMatchObject({ ok: true, status: "skipped", reason: "duplicate" });
    expect(store.agent_learnings).toHaveLength(1); // only the pre-existing one
  });

  it("does NOT treat a same-worded lesson in a DIFFERENT scope as a duplicate", async () => {
    const store = seed();
    // A GLOBAL lesson with the IDENTICAL body — different scope, so NOT a dup
    // (the dedupe query filters to the candidate's own scope+role).
    store.agent_learnings!.push({
      id: "L-global",
      tenant_id: T,
      scope: "global",
      role_slug: null,
      category: "testing",
      body: engineerLesson.body,
      status: "active",
      source_mistake_id: null,
    });
    const res = await extractMistakeLesson(
      deps(store, async () => engineerLesson),
      {
        tenantId: T,
        mistakeId: MISTAKE_A,
      },
    );
    expect(res).toMatchObject({ ok: true, status: "inserted" });
    expect(store.agent_learnings).toHaveLength(2);
  });

  it("skips when the model declines (null) without inserting", async () => {
    const store = seed();
    const res = await extractMistakeLesson(
      deps(store, async () => null),
      {
        tenantId: T,
        mistakeId: MISTAKE_A,
      },
    );
    expect(res).toMatchObject({ ok: true, status: "skipped", reason: "no-candidate" });
    expect(store.agent_learnings).toHaveLength(0);
  });

  it("--dry-run drafts + dedupes but writes nothing", async () => {
    const store = seed();
    const res = await extractMistakeLesson(
      deps(store, async () => engineerLesson),
      {
        tenantId: T,
        mistakeId: MISTAKE_A,
        dryRun: true,
      },
    );
    expect(res).toMatchObject({ ok: true, status: "inserted" });
    expect(store.agent_learnings).toHaveLength(0);
  });
});

describe("semantic dedup (stage 2)", () => {
  const judgeDup = (): Promise<RawDedupVerdict> => Promise.resolve({ duplicateIndex: 0 });

  it("does NOT call the judge when stage-1 Jaccard already flags a dup", async () => {
    const store = seed();
    store.agent_learnings!.push({
      id: "L-lexical",
      tenant_id: T,
      scope: "role",
      role_slug: "engineer",
      category: "testing",
      body: "Always run the full test suite before requesting review.",
      status: "active",
      source_mistake_id: null,
    });
    const judge = vi.fn((_i: DedupCheckInput) => judgeDup());
    const near: RawLessonCandidate = {
      body: "Run the test suite before you request review.",
      scope: "role",
      category: "testing",
    };
    const res = await extractMistakeLesson(
      deps(store, async () => near, { checkSemanticDuplicate: judge }),
      { tenantId: T, mistakeId: MISTAKE_A },
    );
    expect(res).toMatchObject({ ok: true, status: "skipped", reason: "duplicate" });
    expect(judge).not.toHaveBeenCalled();
  });

  it("does NOT call the judge when there are no peers", async () => {
    const store = seed(); // no existing lessons
    const judge = vi.fn((_i: DedupCheckInput) => judgeDup());
    const res = await extractMistakeLesson(
      deps(store, async () => engineerLesson, { checkSemanticDuplicate: judge }),
      { tenantId: T, mistakeId: MISTAKE_A },
    );
    expect(res).toMatchObject({ ok: true, status: "inserted" });
    expect(judge).not.toHaveBeenCalled();
    expect(store.agent_learnings).toHaveLength(1);
  });

  it("skips a candidate the judge flags even when stage-1 passed", async () => {
    const store = seed();
    // A peer that is semantically the same but LEXICALLY distinct (low Jaccard),
    // so only the judge can catch it.
    store.agent_learnings!.push({
      id: "L-semantic",
      tenant_id: T,
      scope: "role",
      role_slug: "engineer",
      category: "testing",
      body: "Verify your change works locally before handing it off.",
      status: "active",
      source_mistake_id: null,
    });
    const judge = vi.fn((_i: DedupCheckInput) => judgeDup());
    const res = await extractMistakeLesson(
      deps(store, async () => engineerLesson, { checkSemanticDuplicate: judge }),
      { tenantId: T, mistakeId: MISTAKE_A },
    );
    expect(res).toMatchObject({ ok: true, status: "skipped", reason: "duplicate" });
    expect(judge).toHaveBeenCalledOnce();
    expect(store.agent_learnings).toHaveLength(1); // nothing new inserted
  });

  it("fail-open: a null judge verdict inserts (dedup degrades to Jaccard-only)", async () => {
    const store = seed();
    store.agent_learnings!.push({
      id: "L-semantic",
      tenant_id: T,
      scope: "role",
      role_slug: "engineer",
      category: "testing",
      body: "Verify your change works locally before handing it off.",
      status: "active",
      source_mistake_id: null,
    });
    const res = await extractMistakeLesson(
      deps(store, async () => engineerLesson, {
        checkSemanticDuplicate: async () => null, // downed runner / timeout
      }),
      { tenantId: T, mistakeId: MISTAKE_A },
    );
    expect(res).toMatchObject({ ok: true, status: "inserted" });
    expect(store.agent_learnings).toHaveLength(2);
  });

  it("an out-of-range judge index is treated as not-a-duplicate (inserts)", async () => {
    const store = seed();
    store.agent_learnings!.push({
      id: "L-semantic",
      tenant_id: T,
      scope: "role",
      role_slug: "engineer",
      category: "testing",
      body: "Verify your change works locally before handing it off.",
      status: "active",
      source_mistake_id: null,
    });
    const res = await extractMistakeLesson(
      deps(store, async () => engineerLesson, {
        checkSemanticDuplicate: async () => ({ duplicateIndex: 99 }),
      }),
      { tenantId: T, mistakeId: MISTAKE_A },
    );
    expect(res).toMatchObject({ ok: true, status: "inserted" });
    expect(store.agent_learnings).toHaveLength(2);
  });
});

describe("auto-approve (confidence-gated)", () => {
  const graded = (c: "high" | "medium" | "low") => async () => ({
    confidence: c,
    reason: `graded ${c}`,
  });

  it("off (default) inserts a candidate with no approver, even for a high grade", async () => {
    const store = seed();
    await extractMistakeLesson(
      deps(store, async () => engineerLesson, {
        resolveAutoApprove: async () => "off" as const,
        gradeCandidate: graded("high"),
      }),
      { tenantId: T, mistakeId: MISTAKE_A },
    );
    expect(store.agent_learnings![0]).toMatchObject({
      status: "candidate",
      approved_by: null,
      confidence: "high",
    });
  });

  it("high_only activates a high grade, stamped with the auto_approve approver", async () => {
    const store = seed();
    await extractMistakeLesson(
      deps(store, async () => engineerLesson, {
        resolveAutoApprove: async () => "high_only" as const,
        gradeCandidate: graded("high"),
      }),
      { tenantId: T, mistakeId: MISTAKE_A },
    );
    expect(store.agent_learnings![0]).toMatchObject({
      status: "active",
      approved_by: "auto_approve",
      created_by: "lesson_extractor",
      confidence: "high",
      confidence_reason: "graded high",
    });
  });

  it("high_only does NOT activate a medium grade", async () => {
    const store = seed();
    await extractMistakeLesson(
      deps(store, async () => engineerLesson, {
        resolveAutoApprove: async () => "high_only" as const,
        gradeCandidate: graded("medium"),
      }),
      { tenantId: T, mistakeId: MISTAKE_A },
    );
    expect(store.agent_learnings![0]).toMatchObject({
      status: "candidate",
      approved_by: null,
      confidence: "medium",
    });
  });

  it("high_and_medium activates a medium grade but never a low one", async () => {
    for (const [grade, status] of [
      ["medium", "active"],
      ["low", "candidate"],
    ] as const) {
      const store = seed();
      await extractMistakeLesson(
        deps(store, async () => engineerLesson, {
          resolveAutoApprove: async () => "high_and_medium" as const,
          gradeCandidate: graded(grade),
        }),
        { tenantId: T, mistakeId: MISTAKE_A },
      );
      expect(store.agent_learnings![0]).toMatchObject({ status, confidence: grade });
    }
  });

  // The load-bearing one: grading is fail-open, so a downed grader leaves the row
  // ungraded — and an ungraded row must NEVER be auto-approved by any threshold,
  // or the fail-open grader would become a fail-OPEN safety gate.
  it("an UNGRADED candidate never auto-approves, at any threshold", async () => {
    for (const threshold of ["high_only", "high_and_medium"] as const) {
      const store = seed();
      const res = await extractMistakeLesson(
        deps(store, async () => engineerLesson, {
          resolveAutoApprove: async () => threshold,
          gradeCandidate: async () => null, // grader down / timed out
        }),
        { tenantId: T, mistakeId: MISTAKE_A },
      );
      // Extraction still SUCCEEDS — a grading failure never fails extraction.
      expect(res).toMatchObject({ ok: true, status: "inserted", grade: null });
      expect(store.agent_learnings![0]).toMatchObject({
        status: "candidate",
        approved_by: null,
        confidence: null,
        confidence_reason: null,
      });
    }
  });

  it("an unwired grader leaves the row ungraded and queued", async () => {
    const store = seed();
    await extractMistakeLesson(
      deps(store, async () => engineerLesson, {
        resolveAutoApprove: async () => "high_and_medium" as const,
      }),
      { tenantId: T, mistakeId: MISTAKE_A },
    );
    expect(store.agent_learnings![0]).toMatchObject({ status: "candidate", confidence: null });
  });

  // A THROWING grader must not cost us the lesson: extraction still records the
  // candidate, just ungraded (and therefore queued for a human).
  it("a grader that THROWS still inserts the lesson, ungraded", async () => {
    const store = seed();
    const res = await extractMistakeLesson(
      deps(store, async () => engineerLesson, {
        resolveAutoApprove: async () => "high_only" as const,
        gradeCandidate: async () => {
          throw new Error("model exploded");
        },
      }),
      { tenantId: T, mistakeId: MISTAKE_A },
    );
    expect(res).toMatchObject({ ok: true, status: "inserted", grade: null });
    expect(store.agent_learnings![0]).toMatchObject({
      status: "candidate",
      confidence: null,
      approved_by: null,
    });
  });

  it("resolver is not consulted on a dry run (writes nothing)", async () => {
    const store = seed();
    const resolver = vi.fn(async () => "high_only" as const);
    const res = await extractMistakeLesson(
      deps(store, async () => engineerLesson, { resolveAutoApprove: resolver }),
      { tenantId: T, mistakeId: MISTAKE_A, dryRun: true },
    );
    expect(res).toMatchObject({ ok: true, status: "inserted" });
    expect(resolver).not.toHaveBeenCalled();
    expect(store.agent_learnings).toHaveLength(0);
  });
});

describe("backfillTenantLessons", () => {
  it("extracts across a tenant's mistakes and is idempotent on a second run", async () => {
    const store = seed();
    store.agent_mistakes!.push({
      id: "bbbb2222-2222-4222-8222-222222222222",
      tenant_id: T,
      ticket_id: "t-B",
      role: "qa",
      type: "human_correction",
      severity: 1,
      evidence: { comment: "please prefer Vercel for deploys" },
      corrected_by: { nextRunId: "r9" },
    });
    let n = 0;
    const model = async (): Promise<RawLessonCandidate> => {
      n += 1;
      return n === 1
        ? engineerLesson
        : {
            body: "Deploy to Vercel by default for new services.",
            scope: "user",
            category: "preference",
          };
    };
    const r1 = await backfillTenantLessons(deps(store, model), { tenantId: T });
    expect(r1.mistakesScanned).toBe(2);
    expect(r1.lessonsInserted).toBe(2);
    expect(store.agent_learnings).toHaveLength(2);

    const r2 = await backfillTenantLessons(deps(store, model), { tenantId: T });
    expect(r2.lessonsInserted).toBe(0);
    expect(r2.skipped).toBe(2);
    expect(store.agent_learnings).toHaveLength(2);
  });
});
