// Editing a skill you installed.
//
// An installed skill is ALREADY the operator's own copy — `installSkillAction`
// clones the body into a `(tenant_id, name, version)` row and
// `selectSkillsForDispatch` reads only `tenant_id = <caller>`. So the questions
// worth proving are not "can he edit it" but:
//
//   1. does the edit land on HIS copy and leave the public seed untouched;
//   2. can a crafted id reach a row he does not own — another tenant's, or a
//      public one;
//   3. what happens when the public skill ships a NEWER version after his edit;
//   4. is the edited body the text that actually reaches a dispatched run.
//
// The fake below ACTUALLY APPLIES `.eq` / `.is`, because a filter-ignoring fake
// makes every scope assertion here vacuous, and each scope claim carries a
// CONTROL that neuters the predicate and shows the foreign row WOULD have been
// hit without it.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadUpstreamSkill,
  resetOwnedSkillToUpstream,
  updateOwnedSkill,
} from "@/lib/skills/authoring-store";
import {
  classifySkillProvenance,
  readSkillBaseline,
  stampSkillBaseline,
} from "@/lib/marketplace/skill-provenance";
import { renderSkillsBlock } from "@/lib/skills/merge";
import type { SkillDraft } from "@/lib/skills/authoring";
import type { SkillRow } from "@/lib/skills/types";

const OURS = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";

const PUBLIC_SKILL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** Our clone of PUBLIC_SKILL. */
const OUR_CLONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** Their clone of the same public skill. */
const THEIR_CLONE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const CATALOG_V1 = "Run the smoke suite before handing the ticket to QA.";
const CATALOG_V2 = "Run the smoke suite and the contract tests before handing the ticket to QA.";
const MY_VERSION = "Run the smoke suite against staging.example.internal before handing to QA.";

type Row = Record<string, unknown>;

function draft(over: Partial<SkillDraft> = {}): SkillDraft {
  return {
    name: "smoke-before-handoff",
    version: "1.0.0",
    summary: "Smoke checks before QA.",
    body: MY_VERSION,
    targets: ["engineer"],
    triggers: ["smoke"],
    ...over,
  };
}

function seed(over: { catalogBody?: string; catalogVersion?: string } = {}): Row[] {
  return [
    {
      id: PUBLIC_SKILL,
      tenant_id: null,
      name: "smoke-before-handoff",
      version: over.catalogVersion ?? "1.0.0",
      manifest: {
        summary: "Smoke checks before QA.",
        verified: true,
        author: "DevPilot first-party",
      },
      body: over.catalogBody ?? CATALOG_V1,
      targets: ["engineer"],
      triggers: ["smoke"],
      installed_from_skill_id: null,
      created_at: "2026-06-01T00:00:00Z",
    },
    {
      id: OUR_CLONE,
      tenant_id: OURS,
      name: "smoke-before-handoff",
      version: "1.0.0",
      manifest: {
        summary: "Smoke checks before QA.",
        verified: true,
        author: "DevPilot first-party",
      },
      body: CATALOG_V1,
      targets: ["engineer"],
      triggers: ["smoke"],
      installed_from_skill_id: PUBLIC_SKILL,
      created_at: "2026-07-01T00:00:00Z",
    },
    {
      id: THEIR_CLONE,
      tenant_id: THEIRS,
      name: "smoke-before-handoff",
      version: "1.0.0",
      manifest: { summary: "Smoke checks before QA." },
      body: CATALOG_V1,
      targets: ["engineer"],
      triggers: ["smoke"],
      installed_from_skill_id: PUBLIC_SKILL,
      created_at: "2026-07-01T00:00:00Z",
    },
  ];
}

function fakeDb(rows: Row[], opts: { ignoreFilters?: string[] } = {}) {
  const state = { rows: rows.map((r) => ({ ...r })) };
  const ignore = new Set(opts.ignoreFilters ?? []);
  const updated: Row[] = [];
  const inserted: Row[] = [];

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
      select() {
        if (mode === "update") {
          return {
            async maybeSingle() {
              return api.applyUpdate();
            },
          };
        }
        return api;
      },
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

  return { db: db as unknown as SupabaseClient, state, updated, inserted };
}

const row = (state: { rows: Row[] }, id: string) => state.rows.find((r) => r.id === id)!;
const NOW = () => "2026-07-19T12:00:00.000Z";

// ---------------------------------------------------------------------------
// 1. The edit lands on OUR copy, and the public seed is byte-identical after.
// ---------------------------------------------------------------------------

describe("an edit changes this workspace's copy and nothing else", () => {
  it("writes the new body to our clone", async () => {
    const { db, state } = fakeDb(seed());
    const res = await updateOwnedSkill(db, {
      id: OUR_CLONE,
      tenantId: OURS,
      draft: draft(),
      now: NOW,
    });
    expect(res.ok).toBe(true);
    expect(row(state, OUR_CLONE).body).toBe(MY_VERSION);
  });

  it("leaves the PUBLIC row BYTE-IDENTICAL", async () => {
    // The explicit boundary on this feature. Compared field-by-field against a
    // pristine copy of the seed rather than on the body alone: an edit that
    // rewrote the catalogue's manifest or targets while leaving its text alone
    // would still be a write to a row this workspace does not own.
    const before = seed().find((r) => r.id === PUBLIC_SKILL)!;
    const { db, state, updated } = fakeDb(seed());
    await updateOwnedSkill(db, { id: OUR_CLONE, tenantId: OURS, draft: draft(), now: NOW });
    expect(row(state, PUBLIC_SKILL)).toEqual(before);
    expect(updated.map((r) => r.id)).not.toContain(PUBLIC_SKILL);
  });

  it("leaves another tenant's clone of the SAME public skill untouched", async () => {
    // Two workspaces installing one catalogue entry hold two independent rows.
    // Editing ours must not reach theirs, and the name/version they share is
    // exactly the shape a missing tenant predicate would let through.
    const { db, state } = fakeDb(seed());
    await updateOwnedSkill(db, { id: OUR_CLONE, tenantId: OURS, draft: draft(), now: NOW });
    expect(row(state, THEIR_CLONE).body).toBe(CATALOG_V1);
  });

  it("PRESERVES the upstream author instead of claiming the text as ours", async () => {
    // Editing used to flatten `author` to "This workspace", which erased where a
    // first-party skill came from and made a one-sentence tweak look like
    // something written here from scratch.
    const { db, state } = fakeDb(seed());
    await updateOwnedSkill(db, { id: OUR_CLONE, tenantId: OURS, draft: draft(), now: NOW });
    const manifest = row(state, OUR_CLONE).manifest as Record<string, unknown>;
    expect(manifest.author).toBe("DevPilot first-party");
    // But it is no longer the reviewed text, and must not wear a verified badge.
    expect(manifest.verified).toBe(false);
  });

  it("records the divergence point — the catalogue text the edit was made FROM", async () => {
    const { db, state } = fakeDb(seed());
    await updateOwnedSkill(db, { id: OUR_CLONE, tenantId: OURS, draft: draft(), now: NOW });
    const rec = readSkillBaseline(row(state, OUR_CLONE).manifest as never);
    expect(rec).toEqual({
      editedAt: "2026-07-19T12:00:00.000Z",
      upstreamVersion: "1.0.0",
      upstreamBody: CATALOG_V1,
    });
  });

  it("marks the copy SYNCED when an operator hand-reverts to the catalogue text", async () => {
    // A stale "edited here" would leave a permanent flag on a skill nobody has
    // changed — the false signal this feature exists to remove. It is recorded
    // as `editedAt: null` rather than deleted, because "this copy IS the
    // catalogue text" is a fact worth keeping: it is what makes a LATER
    // catalogue change attributable rather than unknown.
    const rows = seed();
    rows[1]!.manifest = stampSkillBaseline(rows[1]!.manifest as never, {
      editedAt: "2026-07-10T00:00:00.000Z",
      upstreamVersion: "1.0.0",
      upstreamBody: CATALOG_V1,
    });
    rows[1]!.body = MY_VERSION;
    const { db, state } = fakeDb(rows);
    await updateOwnedSkill(db, {
      id: OUR_CLONE,
      tenantId: OURS,
      draft: draft({ body: CATALOG_V1 }),
      now: NOW,
    });
    expect(readSkillBaseline(row(state, OUR_CLONE).manifest as never)?.editedAt).toBeNull();
    expect(
      classifySkillProvenance(row(state, OUR_CLONE) as unknown as SkillRow, {
        body: CATALOG_V1,
        version: "1.0.0",
      }).kind,
    ).toBe("pristine");
  });

  it("stamps NO record on an authored skill — there is no upstream to compare to", async () => {
    const rows = seed();
    rows[1]!.installed_from_skill_id = null;
    const { db, state } = fakeDb(rows);
    await updateOwnedSkill(db, { id: OUR_CLONE, tenantId: OURS, draft: draft(), now: NOW });
    expect(readSkillBaseline(row(state, OUR_CLONE).manifest as never)).toBeNull();
    const manifest = row(state, OUR_CLONE).manifest as Record<string, unknown>;
    expect(manifest.author).toBe("This workspace");
  });
});

// ---------------------------------------------------------------------------
// 2. A crafted id cannot reach a row we do not own.
// ---------------------------------------------------------------------------

describe("a crafted id reaches nothing this workspace does not own", () => {
  it("REFUSES an edit aimed at another tenant's clone", async () => {
    const { db, state, updated } = fakeDb(seed());
    const res = await updateOwnedSkill(db, {
      id: THEIR_CLONE,
      tenantId: OURS,
      draft: draft({ body: "injected by another workspace" }),
      now: NOW,
    });
    expect(res.ok).toBe(false);
    expect(updated).toHaveLength(0);
    expect(row(state, THEIR_CLONE).body).toBe(CATALOG_V1);
  });

  it("CONTROL: with the tenant predicate neutered the foreign row WOULD be reachable", async () => {
    // Proves the previous assertion turns on the predicate and not on the row
    // simply being absent from the fixture.
    const { db } = fakeDb(seed(), { ignoreFilters: ["tenant_id"] });
    expect(await loadUpstreamSkill(db, { id: THEIR_CLONE })).not.toBeNull();
  });

  it("REFUSES an edit aimed at the PUBLIC row, and the public body is unchanged", async () => {
    const { db, state, updated } = fakeDb(seed());
    const res = await updateOwnedSkill(db, {
      id: PUBLIC_SKILL,
      tenantId: OURS,
      draft: draft({ body: "rewritten catalogue text" }),
      now: NOW,
    });
    expect(res.ok).toBe(false);
    expect(updated).toHaveLength(0);
    expect(row(state, PUBLIC_SKILL).body).toBe(CATALOG_V1);
  });

  it("SECOND LAYER: the public row is still refused with the tenant predicate neutered", async () => {
    // `assertOwnedRow` refuses a null-tenant row on its own, so the "a member
    // never writes a public row" rule holds even where the scoping predicate
    // does not — which is what makes it a second guard rather than a duplicate.
    const { db, state, updated } = fakeDb(seed(), { ignoreFilters: ["tenant_id"] });
    const res = await updateOwnedSkill(db, {
      id: PUBLIC_SKILL,
      tenantId: OURS,
      draft: draft({ body: "rewritten catalogue text" }),
      now: NOW,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/marketplace/i);
    expect(updated).toHaveLength(0);
    expect(row(state, PUBLIC_SKILL).body).toBe(CATALOG_V1);
  });

  it("RESET refuses a foreign id, and rewrites nothing", async () => {
    // The reset path writes too, so it needs the same proof as the edit path —
    // and it is the more dangerous of the two, because it overwrites a body
    // wholesale rather than with operator-supplied text.
    const { db, state, updated } = fakeDb(seed({ catalogBody: CATALOG_V2 }));
    const res = await resetOwnedSkillToUpstream(db, { id: THEIR_CLONE, tenantId: OURS });
    expect(res.ok).toBe(false);
    expect(updated).toHaveLength(0);
    expect(row(state, THEIR_CLONE).body).toBe(CATALOG_V1);
  });

  it("RESET refuses a public id, and the catalogue row is untouched", async () => {
    const before = seed().find((r) => r.id === PUBLIC_SKILL)!;
    const { db, state } = fakeDb(seed());
    const res = await resetOwnedSkillToUpstream(db, { id: PUBLIC_SKILL, tenantId: OURS });
    expect(res.ok).toBe(false);
    expect(row(state, PUBLIC_SKILL)).toEqual(before);
  });

  it("`loadUpstreamSkill` reads PUBLIC rows only — a tenant id resolves to nothing", async () => {
    // It supplies the text the UI calls "the catalogue version" and the text
    // reset writes into a tenant row. If a private id resolved here, one
    // workspace's guidance could be offered to another as catalogue content.
    const { db } = fakeDb(seed());
    expect(await loadUpstreamSkill(db, { id: PUBLIC_SKILL })).not.toBeNull();
    expect(await loadUpstreamSkill(db, { id: THEIR_CLONE })).toBeNull();
    expect(await loadUpstreamSkill(db, { id: OUR_CLONE })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. A newer public version arriving after an edit.
// ---------------------------------------------------------------------------

describe("the catalogue ships a new version after the operator edited his copy", () => {
  /** Edit at catalogue v1, then the catalogue moves to v2. */
  async function editThenUpstreamMoves() {
    const { db, state, updated } = fakeDb(seed());
    await updateOwnedSkill(db, { id: OUR_CLONE, tenantId: OURS, draft: draft(), now: NOW });
    const before = { ...row(state, OUR_CLONE) };
    // The catalogue ships a new version, in place, as first-party updates do.
    Object.assign(row(state, PUBLIC_SKILL), { body: CATALOG_V2, version: "2.0.0" });
    return { db, state, updated, before };
  }

  it("DOES NOT touch the operator's copy — the update is a notice, never a write", async () => {
    // The headline guarantee. Nothing in DevPilot writes a tenant skill row from
    // upstream: not on a schedule, not on page load, not on install. The only
    // path is `resetOwnedSkillToUpstream`, which runs when the operator asks.
    const { state, updated, before } = await editThenUpstreamMoves();
    expect(row(state, OUR_CLONE)).toEqual(before);
    expect(row(state, OUR_CLONE).body).toBe(MY_VERSION);
    // The only write in the whole sequence was the operator's own edit.
    expect(updated.map((r) => r.id)).toEqual([OUR_CLONE]);
  });

  it("is REPORTED as both facts at once — edited here, and the catalogue moved", async () => {
    const { state } = await editThenUpstreamMoves();
    const p = classifySkillProvenance(
      row(state, OUR_CLONE) as unknown as SkillRow,
      row(state, PUBLIC_SKILL) as unknown as SkillRow,
    );
    expect(p.kind).toBe("edited_upstream_changed");
    expect(p.divergedFromVersion).toBe("1.0.0");
    expect(p.upstreamVersion).toBe("2.0.0");
  });

  it("the operator can then TAKE the new version, explicitly", async () => {
    const { db, state } = await editThenUpstreamMoves();
    const res = await resetOwnedSkillToUpstream(db, { id: OUR_CLONE, tenantId: OURS });
    expect(res.ok).toBe(true);
    const after = row(state, OUR_CLONE);
    expect(after.body).toBe(CATALOG_V2);
    expect(after.version).toBe("2.0.0");
    // Pristine again by definition, and RE-BASELINED against what was copied —
    // a carried-over `editedAt` would describe an edit that no longer exists,
    // while clearing the record outright would forfeit the ability to attribute
    // the NEXT catalogue change.
    expect(readSkillBaseline(after.manifest as never)).toEqual({
      editedAt: null,
      upstreamVersion: "2.0.0",
      upstreamBody: CATALOG_V2,
    });
    expect(
      classifySkillProvenance(after as unknown as SkillRow, {
        body: CATALOG_V2,
        version: "2.0.0",
      }).kind,
    ).toBe("pristine");
  });

  it("after a reset, a LATER catalogue change is attributed to the catalogue", async () => {
    // The payoff of re-baselining rather than clearing: the operator who takes
    // an update and never touches it again still hears about the next one, and
    // is not asked to work out whether he caused the difference.
    const { db, state } = await editThenUpstreamMoves();
    await resetOwnedSkillToUpstream(db, { id: OUR_CLONE, tenantId: OURS });
    Object.assign(row(state, PUBLIC_SKILL), { body: `${CATALOG_V2} Also check the changelog.` });
    const p = classifySkillProvenance(
      row(state, OUR_CLONE) as unknown as SkillRow,
      row(state, PUBLIC_SKILL) as unknown as SkillRow,
    );
    expect(p.kind).toBe("upstream_changed");
    expect(p.editedHere).toBe(false);
  });

  it("taking the new version still leaves the PUBLIC row byte-identical", async () => {
    const { db, state } = await editThenUpstreamMoves();
    const before = { ...row(state, PUBLIC_SKILL) };
    await resetOwnedSkillToUpstream(db, { id: OUR_CLONE, tenantId: OURS });
    expect(row(state, PUBLIC_SKILL)).toEqual(before);
  });

  it("keeps our NAME on a reset — it is this workspace's dedupe key", async () => {
    // Two rows sharing a name are both merged into one prompt, so adopting a
    // renamed catalogue entry could turn a reset into a broken dispatch.
    const { db, state } = await editThenUpstreamMoves();
    Object.assign(row(state, PUBLIC_SKILL), { name: "smoke-checks-renamed" });
    await resetOwnedSkillToUpstream(db, { id: OUR_CLONE, tenantId: OURS });
    expect(row(state, OUR_CLONE).name).toBe("smoke-before-handoff");
  });

  it("a reset with the catalogue entry GONE refuses and leaves the copy working", async () => {
    const { db, state } = fakeDb(seed());
    state.rows = state.rows.filter((r) => r.id !== PUBLIC_SKILL);
    const res = await resetOwnedSkillToUpstream(db, { id: OUR_CLONE, tenantId: OURS });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/no longer listed/i);
    expect(row(state, OUR_CLONE).body).toBe(CATALOG_V1);
  });
});

// ---------------------------------------------------------------------------
// 4. The edited body is what reaches a dispatched run.
// ---------------------------------------------------------------------------

describe("the edited body is what a dispatched run is given", () => {
  /**
   * The query `selectSkillsForDispatch` runs, replayed against the same fake.
   *
   * `lib/skills/select.ts` imports `supabaseService` and the LLM layer, so it
   * cannot load under Vitest — but `loadInstalledSkills` is one statement, and
   * what matters is that it reads the TENANT row and takes `body` straight off
   * it with no upstream fallback. That shape is asserted against the source
   * below so this replay cannot drift from the real thing.
   */
  async function loadAsDispatchWould(db: SupabaseClient, tenantId: string): Promise<SkillRow[]> {
    const { data } = (await db
      .from("skills")
      .select(
        "id, tenant_id, name, version, manifest, body, targets, triggers, installed_from_skill_id, created_at",
      )
      .eq("tenant_id", tenantId)) as unknown as { data: SkillRow[] };
    return data ?? [];
  }

  it("dispatch reads the EDITED body, not the catalogue's", async () => {
    const { db } = fakeDb(seed());
    await updateOwnedSkill(db, { id: OUR_CLONE, tenantId: OURS, draft: draft(), now: NOW });

    const loaded = await loadAsDispatchWould(db, OURS);
    expect(loaded.map((s) => s.id)).toEqual([OUR_CLONE]);
    expect(loaded[0]!.body).toBe(MY_VERSION);
    expect(loaded[0]!.body).not.toBe(CATALOG_V1);
  });

  it("the edited text is what lands in the composed system prompt", async () => {
    // The end of the chain: what the model is actually shown.
    const { db } = fakeDb(seed());
    await updateOwnedSkill(db, { id: OUR_CLONE, tenantId: OURS, draft: draft(), now: NOW });
    const loaded = await loadAsDispatchWould(db, OURS);

    const block = renderSkillsBlock(
      loaded.map((s) => ({ id: s.id, name: s.name, version: s.version, body: s.body, score: 1 })),
    );
    expect(block).toContain(MY_VERSION);
    expect(block).not.toContain(CATALOG_V1);
  });

  it("a NEWER catalogue version does not leak into the prompt over the edit", async () => {
    // The edit survives an upstream change all the way to the model, which is
    // the operator-visible consequence of "nothing overwrites your copy".
    const { db, state } = fakeDb(seed());
    await updateOwnedSkill(db, { id: OUR_CLONE, tenantId: OURS, draft: draft(), now: NOW });
    Object.assign(row(state, PUBLIC_SKILL), { body: CATALOG_V2, version: "2.0.0" });

    const loaded = await loadAsDispatchWould(db, OURS);
    const block = renderSkillsBlock(
      loaded.map((s) => ({ id: s.id, name: s.name, version: s.version, body: s.body, score: 1 })),
    );
    expect(block).toContain(MY_VERSION);
    expect(block).not.toContain(CATALOG_V2);
  });

  it("dispatch never reads a public row, so the catalogue text cannot reach a run", async () => {
    const { db } = fakeDb(seed());
    const loaded = await loadAsDispatchWould(db, OURS);
    expect(loaded.map((s) => s.id)).not.toContain(PUBLIC_SKILL);
    expect(loaded.every((s) => s.tenant_id === OURS)).toBe(true);
  });

  it("STRUCTURAL: the real selector reads the tenant row's own body, with no upstream join", async () => {
    // Pins the shape the replay above stands in for. If `select.ts` ever grew a
    // fallback to `installed_from_skill_id`, an edited body could stop being
    // what a run is given and every runtime test here would still pass.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "select.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).toContain('.eq("tenant_id", tenantId)');
    expect(src).not.toMatch(/\.is\(\s*"tenant_id"\s*,\s*null\s*\)/);
    // The body handed to the merge layer comes straight off the loaded row.
    expect(src).toMatch(/body:\s*s(?:rc)?\.body/);
  });
});
