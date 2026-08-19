// Tenant scope + public-row protection on operator-authored skills.
//
// These functions run on the SERVICE client (RLS off), so the co-located
// `.eq("tenant_id", …)` on every read and write is the ENTIRE boundary. Two
// consequences, and they fail in different directions:
//
//   • a missing predicate on a WRITE lets a caller edit or delete another
//     workspace's skill — and a skill body is spliced into that workspace's
//     agents' system prompts on their next dispatch, so this is not merely a
//     data-integrity bug, it is a way to put words in someone else's agent's
//     mouth, durably and silently;
//   • a missing predicate on a READ discloses one workspace's private
//     operating guidance to another.
//
// A third rule is independent of the tenant id and is what keeps the public
// marketplace out of reach: NO path here may create or modify a row whose
// `tenant_id` is NULL.
//
// So the fake below ACTUALLY APPLIES `.eq` / `.is` — a filter-ignoring fake
// makes every assertion in this file vacuous — and every scope assertion has a
// CONTROL that neuters the predicate and proves the foreign row WOULD have been
// hit without it. Deleting a `.eq("tenant_id", …)` from the source turns this
// suite red.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createOwnedSkill,
  deleteOwnedSkill,
  findPublicNameClash,
  listOwnedSkills,
  loadOwnedSkill,
  updateOwnedSkill,
} from "@/lib/skills/authoring-store";
import type { SkillDraft } from "@/lib/skills/authoring";

const OURS = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";

const OUR_SKILL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THEIR_SKILL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PUBLIC_SKILL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Row = Record<string, unknown>;

const DRAFT: SkillDraft = {
  name: "billing-rounding",
  version: "1.0.0",
  summary: "Re-read the pricing table.",
  body: "Re-read the pricing table before touching billing code.",
  targets: ["engineer"],
  triggers: ["billing"],
};

function seed(): Row[] {
  return [
    {
      id: OUR_SKILL,
      tenant_id: OURS,
      name: "ours",
      version: "1.0.0",
      manifest: { summary: "ours" },
      body: "our guidance",
      targets: [],
      triggers: [],
      installed_from_skill_id: null,
      created_at: "2026-07-01T00:00:00Z",
    },
    {
      id: THEIR_SKILL,
      tenant_id: THEIRS,
      name: "theirs",
      version: "1.0.0",
      manifest: { summary: "theirs" },
      body: "their guidance",
      targets: [],
      triggers: [],
      installed_from_skill_id: null,
      created_at: "2026-07-02T00:00:00Z",
    },
    {
      id: PUBLIC_SKILL,
      tenant_id: null,
      name: "first-party-review",
      version: "2.0.0",
      manifest: { summary: "public", verified: true },
      body: "public guidance",
      targets: [],
      triggers: [],
      installed_from_skill_id: null,
      created_at: "2026-06-01T00:00:00Z",
    },
  ];
}

type FakeOpts = {
  /** CONTROL: drop the named filter columns, simulating a missing predicate. */
  ignoreFilters?: string[];
};

/**
 * Minimal Supabase double that HONOURS `.eq` / `.is`. `ignoreFilters` is the
 * control lever: naming a column makes the fake behave as if the source had
 * omitted that predicate.
 */
function fakeDb(rows: Row[], opts: FakeOpts = {}) {
  // Copy each ROW, not just the array: the update path mutates in place, and a
  // shared fixture object would leak one test into the next.
  const state = { rows: rows.map((r) => ({ ...r })) };
  const ignore = new Set(opts.ignoreFilters ?? []);
  const inserted: Row[] = [];
  const updated: Row[] = [];
  const deleted: Row[] = [];

  function builder(mode: "select" | "insert" | "update" | "delete", patch?: Row) {
    const filters: Array<(r: Row) => boolean> = [];
    const api = {
      eq(col: string, val: unknown) {
        if (!ignore.has(col)) filters.push((r) => r[col] === val);
        return api;
      },
      is(col: string, val: unknown) {
        if (!ignore.has(col)) filters.push((r) => (r[col] ?? null) === val);
        return api;
      },
      order() {
        return api;
      },
      match(r: Row) {
        return filters.every((f) => f(r));
      },
      async maybeSingle() {
        if (mode === "update") return api.applyUpdate();
        return { data: state.rows.filter(api.match)[0] ?? null, error: null };
      },
      async single() {
        if (mode === "insert") {
          const row = { id: `new-${inserted.length}`, ...(patch ?? {}) };
          inserted.push(row);
          state.rows.push(row);
          return { data: { id: row.id }, error: null };
        }
        return { data: state.rows.filter(api.match)[0] ?? null, error: null };
      },
      applyUpdate() {
        const hit = state.rows.filter(api.match);
        for (const r of hit) Object.assign(r, patch);
        updated.push(...hit);
        return { data: hit[0] ? { id: hit[0].id } : null, error: null };
      },
      /** Terminal on the update / delete chains. */
      select() {
        if (mode === "update") {
          return {
            async maybeSingle() {
              return api.applyUpdate();
            },
          };
        }
        if (mode === "delete") {
          const going = state.rows.filter(api.match);
          deleted.push(...going);
          state.rows = state.rows.filter((r) => !api.match(r));
          return Promise.resolve({ data: going.map((r) => ({ id: r.id })), error: null });
        }
        return api;
      },
      // A bare `await` on a filtered select resolves here (the nameTaken path).
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        resolve({ data: state.rows.filter(api.match), error: null });
      },
    };
    return api;
  }

  const db = {
    from() {
      return {
        select() {
          return builder("select");
        },
        insert(patch: Row) {
          return builder("insert", patch);
        },
        update(patch: Row) {
          return builder("update", patch);
        },
        delete() {
          return builder("delete");
        },
      };
    },
  };

  return { db: db as unknown as SupabaseClient, state, inserted, updated, deleted };
}

describe("read scope", () => {
  it("loads our own skill", async () => {
    const { db } = fakeDb(seed());
    const row = await loadOwnedSkill(db, { id: OUR_SKILL, tenantId: OURS });
    expect(row?.id).toBe(OUR_SKILL);
  });

  it("REFUSES to load another tenant's skill", async () => {
    const { db } = fakeDb(seed());
    expect(await loadOwnedSkill(db, { id: THEIR_SKILL, tenantId: OURS })).toBeNull();
  });

  it("CONTROL: without the tenant predicate the foreign skill WOULD be returned", async () => {
    const { db } = fakeDb(seed(), { ignoreFilters: ["tenant_id"] });
    const row = await loadOwnedSkill(db, { id: THEIR_SKILL, tenantId: OURS });
    expect(row?.id).toBe(THEIR_SKILL);
  });

  it("REFUSES to load a PUBLIC marketplace skill for editing", async () => {
    // Its `tenant_id` is null, which is in no tenant — so the same predicate
    // that keeps tenants apart also keeps the catalogue read-only here, with
    // no separate check to forget.
    const { db } = fakeDb(seed());
    expect(await loadOwnedSkill(db, { id: PUBLIC_SKILL, tenantId: OURS })).toBeNull();
  });

  it("lists only our own skills — never a foreign or a public row", async () => {
    const { db } = fakeDb(seed());
    const rows = await listOwnedSkills(db, { tenantId: OURS });
    expect(rows.map((r) => r.id)).toEqual([OUR_SKILL]);
  });

  it("CONTROL: without the predicate the list WOULD include foreign and public rows", async () => {
    const { db } = fakeDb(seed(), { ignoreFilters: ["tenant_id"] });
    const rows = await listOwnedSkills(db, { tenantId: OURS });
    expect(rows.map((r) => r.id)).toContain(THEIR_SKILL);
    expect(rows.map((r) => r.id)).toContain(PUBLIC_SKILL);
  });
});

describe("create", () => {
  it("stamps the CALLER's tenant, never null", async () => {
    const { db, inserted } = fakeDb(seed());
    const res = await createOwnedSkill(db, { tenantId: OURS, draft: DRAFT });
    expect(res.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.tenant_id).toBe(OURS);
  });

  it("marks an operator's own skill unverified and NOT first-party", async () => {
    // A catalogue reading `manifest.verified` must never render an operator's
    // own skill as vetted by omission.
    const { db, inserted } = fakeDb(seed());
    await createOwnedSkill(db, { tenantId: OURS, draft: DRAFT });
    const manifest = inserted[0]!.manifest as Record<string, unknown>;
    expect(manifest.verified).toBe(false);
    expect(manifest.author).not.toContain("first-party");
  });

  it("has NO input that could ask for a public (tenant_id null) row", async () => {
    // The tenant id is a required argument the action derives from the session;
    // the draft type carries no tenant field at all. This asserts the shape:
    // every insert this module can perform names a non-null tenant.
    const { db, inserted } = fakeDb(seed());
    await createOwnedSkill(db, { tenantId: OURS, draft: DRAFT });
    await createOwnedSkill(db, { tenantId: THEIRS, draft: { ...DRAFT, name: "other" } });
    expect(inserted.every((r) => r.tenant_id != null)).toBe(true);
  });

  it("refuses a name this tenant already uses — at NAME level, not (name, version)", async () => {
    // Two same-named rows would BOTH be selected for one dispatch and merged
    // into one prompt. The DB's unique (tenant_id, name, version) only catches
    // the exact-version case, which is the less likely one.
    const { db } = fakeDb(seed());
    const res = await createOwnedSkill(db, {
      tenantId: OURS,
      draft: { ...DRAFT, name: "ours", version: "9.9.9" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflict).toBe("name_taken");
  });

  it("does NOT refuse a name another tenant uses", async () => {
    const { db } = fakeDb(seed());
    const res = await createOwnedSkill(db, {
      tenantId: OURS,
      draft: { ...DRAFT, name: "theirs" },
    });
    expect(res.ok).toBe(true);
  });

  it("does NOT refuse a name the PUBLIC catalogue uses", async () => {
    // A public skill has no runtime effect until it is installed, so reserving
    // its name inside a workspace that has never browsed the catalogue would be
    // a refusal with nothing behind it. The clash is surfaced as a warning.
    const { db } = fakeDb(seed());
    const res = await createOwnedSkill(db, {
      tenantId: OURS,
      draft: { ...DRAFT, name: "first-party-review" },
    });
    expect(res.ok).toBe(true);
  });
});

describe("edit — in place, and scoped", () => {
  it("updates our own skill IN PLACE, keeping the same id and creating no second row", async () => {
    // The versioning decision: an edit mutates the row. A version bump that
    // inserted a second row would leave two same-named skills BOTH eligible for
    // one dispatch, because `selectSkillsForDispatch` has no notion of "latest".
    const { db, state, inserted } = fakeDb(seed());
    const res = await updateOwnedSkill(db, {
      id: OUR_SKILL,
      tenantId: OURS,
      draft: { ...DRAFT, name: "ours", version: "2.0.0", body: "revised guidance" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.id).toBe(OUR_SKILL);
    expect(inserted).toHaveLength(0);
    expect(state.rows.filter((r) => r.name === "ours")).toHaveLength(1);
    const row = state.rows.find((r) => r.id === OUR_SKILL)!;
    expect(row.version).toBe("2.0.0");
    expect(row.body).toBe("revised guidance");
  });

  it("REFUSES to edit another tenant's skill, and touches nothing", async () => {
    const { db, updated, state } = fakeDb(seed());
    const res = await updateOwnedSkill(db, { id: THEIR_SKILL, tenantId: OURS, draft: DRAFT });
    expect(res.ok).toBe(false);
    expect(updated).toHaveLength(0);
    expect(state.rows.find((r) => r.id === THEIR_SKILL)!.body).toBe("their guidance");
  });

  it("SECOND LAYER: with the tenant predicate neutered, `assertOwnedRow` still refuses the foreign edit", async () => {
    // The update path carries THREE independent guards, and this is what makes
    // the middle one non-decorative. With `.eq("tenant_id", …)` neutered the
    // load DOES hand back the foreign row (proven by the read-scope CONTROL
    // above) — and the write is still refused, because `assertOwnedRow`
    // compares the loaded row's own `tenant_id` before anything is written.
    //
    // The third guard is the `.eq("tenant_id", …)` on the UPDATE statement
    // itself, which is the one that holds if the row changed hands between the
    // load and the write. No single-neuter control can isolate it while the
    // other two stand; it is asserted structurally by the source-scan test in
    // `authoring-write-scope.test.ts`.
    const { db, updated, state } = fakeDb(seed(), { ignoreFilters: ["tenant_id"] });
    const res = await updateOwnedSkill(db, {
      id: THEIR_SKILL,
      tenantId: OURS,
      draft: { ...DRAFT, body: "injected by another tenant" },
    });
    expect(res.ok).toBe(false);
    expect(updated).toHaveLength(0);
    expect(state.rows.find((r) => r.id === THEIR_SKILL)!.body).toBe("their guidance");
  });

  it("REFUSES to edit a PUBLIC marketplace skill, and touches nothing", async () => {
    const { db, updated, state } = fakeDb(seed());
    const res = await updateOwnedSkill(db, { id: PUBLIC_SKILL, tenantId: OURS, draft: DRAFT });
    expect(res.ok).toBe(false);
    expect(updated).toHaveLength(0);
    expect(state.rows.find((r) => r.id === PUBLIC_SKILL)!.body).toBe("public guidance");
  });

  it("SECOND LAYER: the null-tenant refusal fires even with the tenant predicate neutered", async () => {
    // This is the non-redundant half of "a member never writes a public row".
    // With `tenant_id` filtering off, `loadOwnedSkill` returns the public row —
    // and `assertOwnedRow` refuses it specifically for being public, with a
    // message that says so rather than a generic not-found. That message is
    // only reachable on this path, which is exactly why the check is not dead
    // code: it is what protects a future caller that loads a row some other
    // way.
    const { db, updated } = fakeDb(seed(), { ignoreFilters: ["tenant_id"] });
    const res = await updateOwnedSkill(db, { id: PUBLIC_SKILL, tenantId: OURS, draft: DRAFT });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/marketplace/i);
    expect(updated).toHaveLength(0);
  });

  it("refuses a rename onto another of OUR OWN skills' names", async () => {
    const rows = seed();
    rows.push({ ...rows[0], id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "second" });
    const { db } = fakeDb(rows);
    const res = await updateOwnedSkill(db, {
      id: OUR_SKILL,
      tenantId: OURS,
      draft: { ...DRAFT, name: "second" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflict).toBe("name_taken");
  });

  it("allows saving a skill under its OWN existing name", async () => {
    // The collision check excludes the row being edited; otherwise every save
    // that did not rename would be refused.
    const { db } = fakeDb(seed());
    const res = await updateOwnedSkill(db, {
      id: OUR_SKILL,
      tenantId: OURS,
      draft: { ...DRAFT, name: "ours" },
    });
    expect(res.ok).toBe(true);
  });
});

describe("delete", () => {
  it("deletes our own skill", async () => {
    const { db, state } = fakeDb(seed());
    const res = await deleteOwnedSkill(db, { id: OUR_SKILL, tenantId: OURS });
    expect(res.ok).toBe(true);
    expect(state.rows.find((r) => r.id === OUR_SKILL)).toBeUndefined();
  });

  it("REFUSES to delete another tenant's skill, and removes nothing", async () => {
    const { db, state, deleted } = fakeDb(seed());
    const res = await deleteOwnedSkill(db, { id: THEIR_SKILL, tenantId: OURS });
    expect(res.ok).toBe(false);
    expect(deleted).toHaveLength(0);
    expect(state.rows.find((r) => r.id === THEIR_SKILL)).toBeDefined();
  });

  it("CONTROL: without the tenant predicate the foreign skill WOULD be deleted", async () => {
    const { db, state } = fakeDb(seed(), { ignoreFilters: ["tenant_id"] });
    const res = await deleteOwnedSkill(db, { id: THEIR_SKILL, tenantId: OURS });
    expect(res.ok).toBe(true);
    expect(state.rows.find((r) => r.id === THEIR_SKILL)).toBeUndefined();
  });

  it("REFUSES to delete a PUBLIC marketplace skill", async () => {
    const { db, state } = fakeDb(seed());
    const res = await deleteOwnedSkill(db, { id: PUBLIC_SKILL, tenantId: OURS });
    expect(res.ok).toBe(false);
    expect(state.rows.find((r) => r.id === PUBLIC_SKILL)).toBeDefined();
  });
});

describe("public name clash — warned, not refused", () => {
  it("finds a public skill sharing the name", async () => {
    const { db } = fakeDb(seed());
    const clash = await findPublicNameClash(db, { name: "first-party-review" });
    expect(clash?.version).toBe("2.0.0");
  });

  it("does not report a TENANT-owned skill as a public clash", async () => {
    // Scoped on `tenant_id IS NULL`; another tenant's same-named skill is
    // invisible to us and must not surface as a catalogue warning.
    const { db } = fakeDb(seed());
    expect(await findPublicNameClash(db, { name: "theirs" })).toBeNull();
  });

  it("CONTROL: without the null-tenant predicate a foreign skill WOULD be reported", async () => {
    const { db } = fakeDb(seed(), { ignoreFilters: ["tenant_id"] });
    expect(await findPublicNameClash(db, { name: "theirs" })).not.toBeNull();
  });
});
