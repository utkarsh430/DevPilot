// A rejected lesson must STAY rejected — without blacklisting its subject.
//
// `rejectLearningAction` has always been documented as feeding dedupe; it did not.
// The extractor's peer query read only `['active','candidate']`, so a lesson the
// operator explicitly declined was invisible to the duplicate check and the next
// mistake that produced it put it straight back in his queue. His judgement was
// discarded.
//
// The fix is asymmetric on purpose, and BOTH halves of that asymmetry are the
// contract under test here:
//
//   • a near-exact RESTATEMENT of a rejected lesson is suppressed — he already
//     decided this exact thing, and re-asking is what made the queue unclearable;
//   • a MATERIALLY DIFFERENT lesson on the same subject still gets through — most
//     rejections are "too vague / badly worded / wrong scope", which are requests
//     for a better formulation, not for the topic to be banned. That loss would be
//     silent and permanent (a suppressed candidate exists in no queue at all),
//     which is why it is guarded explicitly rather than left to the threshold.
//
// Plus: archived is NOT rejected, rejected peers never reach the semantic judge,
// and the (tenant, scope, role) partitioning holds for the rejected set exactly as
// it does for the active one.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractMistakeLesson, type ExtractDeps } from "@/lib/learning/extract-batch";
import {
  bodySimilarity,
  DEDUPE_SIMILARITY_THRESHOLD,
  isRejectedRestatement,
  REJECTED_DEDUPE_SIMILARITY_THRESHOLD,
  type DedupCheckInput,
  type RawLessonCandidate,
} from "@/lib/learning/extract";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISTAKE = "aaaa1111-1111-4111-8111-111111111111";

/** The lesson the operator rejected. */
const REJECTED_BODY = "Run the full test suite before requesting review.";
/** A re-extraction of the same lesson, reworded. Must NOT come back. */
const RESTATEMENT = "Always run the full test suite before requesting a review.";
/**
 * A materially different lesson on the SAME subject: it adds a directive the
 * rejected one never carried (say which commands you ran). Must still get through.
 * Note it scores >= the ACTIVE threshold — so it is only allowed past because
 * rejected peers are matched on a different, stricter basis, not because it is
 * lexically distant. That is precisely the property worth pinning.
 */
const SHARPER = "Run the test suite before requesting review, and state which commands you ran.";

type Row = Record<string, unknown>;

/**
 * Fake client that ACTUALLY applies `.eq` / `.in` / `.is`. A filter-ignoring fake
 * would make every scoping assertion below vacuous.
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

function mistakeRow(tenantId = T): Row {
  return {
    id: MISTAKE,
    tenant_id: tenantId,
    ticket_id: "t",
    role: "engineer",
    type: "verification_fail",
    severity: 2,
    evidence: { command: "pnpm test", exitCode: 1 },
    corrected_by: null,
  };
}

function lessonRow(over: Partial<Row> & { body: string; status: string }): Row {
  return {
    id: `L-${Math.random().toString(36).slice(2)}`,
    tenant_id: T,
    scope: "role",
    role_slug: "engineer",
    category: "testing",
    source_mistake_id: null,
    ...over,
  };
}

/** Run the extractor with a stubbed model returning `body` at role/engineer scope. */
async function extract(
  store: Record<string, Row[]>,
  body: string,
  extra: Partial<ExtractDeps> = {},
) {
  const candidate: RawLessonCandidate = { body, scope: "role", category: "testing" };
  const deps: ExtractDeps = {
    db: fakeClient(store),
    generateCandidate: async () => candidate,
    ...extra,
  };
  return extractMistakeLesson(deps, { tenantId: T, mistakeId: MISTAKE });
}

describe("rejected lessons feed dedupe", () => {
  it("does NOT re-offer a candidate that restates a rejected lesson", async () => {
    const store: Record<string, Row[]> = {
      agent_mistakes: [mistakeRow()],
      agent_learnings: [lessonRow({ body: REJECTED_BODY, status: "rejected" })],
    };
    const res = await extract(store, RESTATEMENT);
    expect(res).toMatchObject({ ok: true, status: "skipped", reason: "rejected-restatement" });
    // The queue is genuinely untouched — nothing new was written.
    expect(store.agent_learnings!.length).toBe(1);
  });

  it("STILL allows a materially different lesson on the same subject", async () => {
    const store: Record<string, Row[]> = {
      agent_mistakes: [mistakeRow()],
      agent_learnings: [lessonRow({ body: REJECTED_BODY, status: "rejected" })],
    };
    const res = await extract(store, SHARPER);
    expect(res).toMatchObject({ ok: true, status: "inserted" });
    expect(store.agent_learnings!.length).toBe(2);
    expect(store.agent_learnings![1]).toMatchObject({ body: SHARPER, status: "candidate" });
  });

  it("the allowed-through lesson is NOT merely lexically distant — it clears the ACTIVE bar", () => {
    // If this ever stops holding, the test above has quietly become trivial: it
    // would be passing because the bodies barely overlap, not because rejected
    // peers are matched on a stricter basis. Pin the discrimination itself.
    const sim = bodySimilarity(SHARPER, REJECTED_BODY);
    expect(sim).toBeGreaterThanOrEqual(DEDUPE_SIMILARITY_THRESHOLD);
    expect(sim).toBeLessThan(REJECTED_DEDUPE_SIMILARITY_THRESHOLD);
  });

  it("an ARCHIVED lesson does not suppress anything (archived is not rejected)", async () => {
    // Archived means a lesson WAS in force and was retired, not that it was
    // wrong. A mistake recurring afterwards is signal it is relevant again.
    const store: Record<string, Row[]> = {
      agent_mistakes: [mistakeRow()],
      agent_learnings: [lessonRow({ body: REJECTED_BODY, status: "archived" })],
    };
    const res = await extract(store, RESTATEMENT);
    expect(res).toMatchObject({ ok: true, status: "inserted" });
  });

  it("an ACTIVE lesson still suppresses broadly, at the looser threshold", async () => {
    // Unchanged behaviour, asserted so the partition can't accidentally route
    // active peers through the strict matcher.
    const store: Record<string, Row[]> = {
      agent_mistakes: [mistakeRow()],
      agent_learnings: [lessonRow({ body: REJECTED_BODY, status: "active" })],
    };
    const res = await extract(store, SHARPER);
    expect(res).toMatchObject({ ok: true, status: "skipped", reason: "duplicate" });
  });

  it("rejected peers are NEVER handed to the semantic judge", async () => {
    // The judge is asked "would an agent following this existing lesson already be
    // doing what the candidate asks" — a premise that is false of a lesson in
    // force nowhere. A rejected-only bucket must not invoke it at all.
    const seen: DedupCheckInput[] = [];
    const store: Record<string, Row[]> = {
      agent_mistakes: [mistakeRow()],
      agent_learnings: [lessonRow({ body: "Some unrelated rejected lesson.", status: "rejected" })],
    };
    const res = await extract(store, SHARPER, {
      checkSemanticDuplicate: async (input) => {
        seen.push(input);
        return { duplicateIndex: 0 };
      },
    });
    expect(seen).toHaveLength(0);
    expect(res).toMatchObject({ ok: true, status: "inserted" });
  });
});

describe("rejected-set scoping", () => {
  it("a FOREIGN tenant's rejected lesson never suppresses our candidate", async () => {
    const store: Record<string, Row[]> = {
      agent_mistakes: [mistakeRow()],
      agent_learnings: [lessonRow({ tenant_id: FOREIGN, body: REJECTED_BODY, status: "rejected" })],
    };
    const res = await extract(store, RESTATEMENT);
    expect(res).toMatchObject({ ok: true, status: "inserted" });
  });

  it("CONTROL: the same row in OUR tenant does suppress it", async () => {
    // Without this the test above passes even if the tenant predicate is deleted
    // and something unrelated is doing the work.
    const store: Record<string, Row[]> = {
      agent_mistakes: [mistakeRow()],
      agent_learnings: [lessonRow({ tenant_id: T, body: REJECTED_BODY, status: "rejected" })],
    };
    const res = await extract(store, RESTATEMENT);
    expect(res).toMatchObject({ ok: true, status: "skipped", reason: "rejected-restatement" });
  });

  it("a rejected GLOBAL lesson never suppresses a role-scoped candidate", async () => {
    const store: Record<string, Row[]> = {
      agent_mistakes: [mistakeRow()],
      agent_learnings: [
        lessonRow({ scope: "global", role_slug: null, body: REJECTED_BODY, status: "rejected" }),
      ],
    };
    const res = await extract(store, RESTATEMENT);
    expect(res).toMatchObject({ ok: true, status: "inserted" });
  });

  it("a rejected lesson for ANOTHER role never suppresses this role's candidate", async () => {
    const store: Record<string, Row[]> = {
      agent_mistakes: [mistakeRow()],
      agent_learnings: [lessonRow({ role_slug: "qa", body: REJECTED_BODY, status: "rejected" })],
    };
    const res = await extract(store, RESTATEMENT);
    expect(res).toMatchObject({ ok: true, status: "inserted" });
  });
});

describe("isRejectedRestatement (pure)", () => {
  it("matches an exact restatement and rejects a reformulation", () => {
    expect(isRejectedRestatement(RESTATEMENT, [REJECTED_BODY])).toBe(true);
    expect(isRejectedRestatement(SHARPER, [REJECTED_BODY])).toBe(false);
  });

  it("is strictly narrower than the active-lesson matcher", () => {
    expect(REJECTED_DEDUPE_SIMILARITY_THRESHOLD).toBeGreaterThan(DEDUPE_SIMILARITY_THRESHOLD);
  });

  it("an empty rejected set never suppresses", () => {
    expect(isRejectedRestatement(RESTATEMENT, [])).toBe(false);
  });
});
