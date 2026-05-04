// Tenant scope on `agent_prompt_overlays`.
//
// The table denies every JWT write, so reads and writes run on the SERVICE
// client with RLS OFF and the co-located `.eq("tenant_id", …)` is the ENTIRE
// boundary.
//
// The severity here is unusually high and worth stating: a missing predicate on
// the READ does not merely disclose another workspace's overlay — it splices
// that workspace's standing instructions into this tenant's agents' system
// prompts on the very next dispatch, silently, forever. On the WRITE it lets a
// caller overwrite or delete a foreign tenant's overlay.
//
// So the fake below ACTUALLY APPLIES `.eq` / `.is` (a filter-ignoring fake makes
// every assertion in this file vacuous), and every assertion has a CONTROL that
// neuters the predicate and proves the foreign row would win without it —
// i.e. deleting a `.eq("tenant_id", …)` from the source turns this suite red.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  clearRoleOverlay,
  loadRoleOverlay,
  loadRoleOverlayBody,
  upsertRoleOverlay,
} from "@/lib/roles/overlay-store";
import { composeRoleSystemPrompt } from "@/lib/roles/compose-prompt";

const OURS = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;

type FakeOpts = {
  /** CONTROL: drop the named filter columns, simulating a missing predicate. */
  ignoreFilters?: string[];
  /** Make the UPDATE fail, to prove a failed write destroys nothing. */
  failUpdate?: string;
};

/**
 * Minimal Supabase double that HONOURS `.eq` / `.is`. `ignoreFilters` is the
 * control lever: naming a column makes the fake behave as if the source had
 * omitted that predicate.
 */
function fakeDb(rows: Row[], opts: FakeOpts = {}) {
  // Copy each ROW, not just the array: the update path mutates rows in place,
  // and sharing a fixture object between tests would leak one test into the next.
  const state = { rows: rows.map((r) => ({ ...r })) };
  const ignore = new Set(opts.ignoreFilters ?? []);
  const inserted: Row[] = [];
  const deleted: Row[] = [];
  const updated: Row[] = [];

  function builder(mode: "select" | "delete" | "update", patch?: Row) {
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
      match(r: Row) {
        return filters.every((f) => f(r));
      },
      async maybeSingle() {
        const hit = state.rows.filter(api.match);
        return { data: hit[0] ?? null, error: null };
      },
      /** Terminal on the UPDATE chain — returns the rows it actually touched. */
      async select() {
        if (mode === "update") {
          if (opts.failUpdate) return { data: null, error: { message: opts.failUpdate } };
          const hit = state.rows.filter(api.match);
          for (const r of hit) Object.assign(r, patch);
          updated.push(...hit);
          return { data: hit.map((r) => ({ id: r.id })), error: null };
        }
        return { data: state.rows.filter(api.match), error: null };
      },
      // A bare `await` on a delete chain resolves here.
      then(resolve: (v: { error: null }) => void) {
        if (mode === "delete") {
          const going = state.rows.filter(api.match);
          deleted.push(...going);
          state.rows = state.rows.filter((r) => !api.match(r));
        }
        resolve({ error: null });
      },
    };
    return api;
  }

  const db = {
    from() {
      return {
        select: () => builder("select"),
        delete: () => builder("delete"),
        update: (patch: Row) => builder("update", patch),
        async insert(row: Row) {
          inserted.push(row);
          state.rows.push(row);
          return { error: null };
        },
      };
    },
  };

  return { db: db as unknown as SupabaseClient, state, inserted, deleted, updated };
}

const OUR_ROW = {
  id: "our-overlay",
  tenant_id: OURS,
  project_id: null,
  role_slug: "engineer",
  body: "OUR HOUSE RULES",
  updated_at: "2026-07-01T00:00:00Z",
};
const THEIR_ROW = {
  id: "their-overlay",
  tenant_id: THEIRS,
  project_id: null,
  role_slug: "engineer",
  body: "THEIR HOUSE RULES",
  updated_at: "2026-07-02T00:00:00Z",
};

describe("loadRoleOverlay — tenant scope on the READ", () => {
  it("returns only our tenant's overlay", async () => {
    const { db } = fakeDb([THEIR_ROW, OUR_ROW]);
    const row = await loadRoleOverlay(db, OURS, "engineer");
    expect(row?.body).toBe("OUR HOUSE RULES");
  });

  it("returns null when only a FOREIGN tenant has an overlay for this role", async () => {
    const { db } = fakeDb([THEIR_ROW]);
    expect(await loadRoleOverlay(db, OURS, "engineer")).toBeNull();
  });

  it("CONTROL: without the tenant predicate the foreign overlay would be returned", async () => {
    // Non-vacuity. This is what deleting `.eq("tenant_id", …)` from the source
    // would do — and the returned body goes straight into a system prompt.
    const { db } = fakeDb([THEIR_ROW], { ignoreFilters: ["tenant_id"] });
    const row = await loadRoleOverlay(db, OURS, "engineer");
    expect(row?.body).toBe("THEIR HOUSE RULES");
  });

  it("scopes on the role slug too", async () => {
    const { db } = fakeDb([{ ...OUR_ROW, role_slug: "qa", body: "QA RULES" }]);
    expect(await loadRoleOverlay(db, OURS, "engineer")).toBeNull();
  });

  it("scopes to the tenant-wide rung — a project-scoped row is not the global one", async () => {
    // Phase 4 will write project rows; without `.is("project_id", null)` the
    // effective overlay would become whichever row the planner returned.
    const { db } = fakeDb([{ ...OUR_ROW, project_id: "some-project" }]);
    expect(await loadRoleOverlay(db, OURS, "engineer")).toBeNull();
  });

  it("CONTROL: without the project predicate a project-scoped row would leak in", async () => {
    const { db } = fakeDb([{ ...OUR_ROW, project_id: "some-project" }], {
      ignoreFilters: ["project_id"],
    });
    expect((await loadRoleOverlay(db, OURS, "engineer"))?.body).toBe("OUR HOUSE RULES");
  });
});

describe("loadRoleOverlayBody — the dispatch read", () => {
  it("returns the body for our tenant", async () => {
    const { db } = fakeDb([OUR_ROW, THEIR_ROW]);
    expect(await loadRoleOverlayBody(db, OURS, "engineer")).toBe("OUR HOUSE RULES");
  });

  it("treats a whitespace-only stored body as absent", async () => {
    const { db } = fakeDb([{ ...OUR_ROW, body: "   " }]);
    expect(await loadRoleOverlayBody(db, OURS, "engineer")).toBeNull();
  });

  it("degrades to null rather than throwing — an overlay must never fail a dispatch", async () => {
    const exploding = {
      from() {
        throw new Error("connection reset");
      },
    } as unknown as SupabaseClient;
    expect(await loadRoleOverlayBody(exploding, OURS, "engineer")).toBeNull();
  });
});

describe("upsertRoleOverlay — tenant scope on the WRITE", () => {
  it("replaces only our row and leaves a foreign tenant's untouched", async () => {
    const { db, state } = fakeDb([OUR_ROW, THEIR_ROW]);
    const res = await upsertRoleOverlay(db, {
      tenantId: OURS,
      roleSlug: "engineer",
      body: "NEW RULES",
      updatedBy: "user-1",
    });
    expect(res.ok).toBe(true);
    expect(state.rows.find((r) => r.id === "their-overlay")?.body).toBe("THEIR HOUSE RULES");
    expect(state.rows.filter((r) => r.tenant_id === OURS)).toHaveLength(1);
  });

  it("CONTROL: without the tenant predicate the foreign row WOULD be clobbered", async () => {
    // Non-vacuity for the write. Under UPDATE-first a missing predicate
    // OVERWRITES the foreign tenant's overlay in place (rather than deleting it,
    // as the old delete-then-insert would have) — the breach is the same, so the
    // assertion tracks the mechanism rather than the symptom.
    const { db, state } = fakeDb([OUR_ROW, THEIR_ROW], { ignoreFilters: ["tenant_id"] });
    await upsertRoleOverlay(db, {
      tenantId: OURS,
      roleSlug: "engineer",
      body: "NEW RULES",
      updatedBy: "user-1",
    });
    expect(state.rows.find((r) => r.id === "their-overlay")?.body).toBe("NEW RULES");
  });

  it("stamps the tenant, a NULL project, and the author on the inserted row", async () => {
    const { db, inserted } = fakeDb([]);
    await upsertRoleOverlay(db, {
      tenantId: OURS,
      roleSlug: "engineer",
      body: "NEW RULES",
      updatedBy: "user-1",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      tenant_id: OURS,
      project_id: null,
      role_slug: "engineer",
      body: "NEW RULES",
      updated_by: "user-1",
    });
  });

  it("writes an EXACT column set — no copy of the shipped prompt can ride along", async () => {
    // The migration liability the design explicitly rejects (§3.8 of the plan):
    // the moment a copy of a shipped prompt exists in the DB, so does the v1→v2
    // drift problem, whether or not anything reads it.
    //
    // Asserted as an EXACT key set rather than the absence of three invented
    // names — "not base_prompt / system_prompt / base_hash" passes for every
    // plausible implementation including one that stored the base under some
    // fourth name, so it proved nothing. This fails if ANY column is added.
    const { db, inserted } = fakeDb([]);
    await upsertRoleOverlay(db, {
      tenantId: OURS,
      roleSlug: "engineer",
      body: "NEW RULES",
      updatedBy: null,
    });
    expect(Object.keys(inserted[0] ?? {}).sort()).toEqual([
      "body",
      "project_id",
      "role_slug",
      "tenant_id",
      "updated_at",
      "updated_by",
    ]);
  });
});

describe("clearRoleOverlay — THE RESET", () => {
  it("deletes only our row", async () => {
    const { db, state } = fakeDb([OUR_ROW, THEIR_ROW]);
    const res = await clearRoleOverlay(db, OURS, "engineer");
    expect(res.ok).toBe(true);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.id).toBe("their-overlay");
  });

  it("CONTROL: without the tenant predicate a foreign overlay WOULD be deleted", async () => {
    const { db, state } = fakeDb([OUR_ROW, THEIR_ROW], { ignoreFilters: ["tenant_id"] });
    await clearRoleOverlay(db, OURS, "engineer");
    expect(state.rows).toHaveLength(0);
  });

  it("clearing nothing is success — a double click is not an error", async () => {
    const { db } = fakeDb([]);
    expect((await clearRoleOverlay(db, OURS, "engineer")).ok).toBe(true);
  });

  it("after clearing, the dispatch read returns null — back to the shipped prompt", async () => {
    const { db } = fakeDb([OUR_ROW]);
    await clearRoleOverlay(db, OURS, "engineer");
    expect(await loadRoleOverlayBody(db, OURS, "engineer")).toBeNull();
  });

  it("CLEAR restores exactly the pre-overlay composed bytes (end to end)", async () => {
    // The reset property, driven through the REAL store rather than asserted on
    // the pure composer — two calls to that with the same `null` would be equal
    // by definition and would pass with the clear path deleted entirely.
    const config = { systemPrompt: "SHIPPED PROMPT", onSuccessStatus: "in_review" } as const;
    const { db } = fakeDb([]);

    // 1. No overlay: the baseline every pre-Phase-2 dispatch produced.
    const baseline = composeRoleSystemPrompt(
      config,
      [],
      true,
      await loadRoleOverlayBody(db, OURS, "engineer"),
    );

    // 2. Save one: the composed prompt genuinely changes.
    await upsertRoleOverlay(db, {
      tenantId: OURS,
      roleSlug: "engineer",
      body: "HOUSE RULES",
      updatedBy: null,
    });
    const withOverlay = composeRoleSystemPrompt(
      config,
      [],
      true,
      await loadRoleOverlayBody(db, OURS, "engineer"),
    );
    expect(withOverlay).not.toBe(baseline);
    expect(withOverlay).toContain("HOUSE RULES");

    // 3. Clear it: byte-identical to the baseline. Nothing was reconstructed —
    //    the shipped prompt was never copied anywhere to begin with.
    await clearRoleOverlay(db, OURS, "engineer");
    const afterClear = composeRoleSystemPrompt(
      config,
      [],
      true,
      await loadRoleOverlayBody(db, OURS, "engineer"),
    );
    expect(afterClear).toBe(baseline);
  });
});

describe("upsertRoleOverlay — never destroys the previous overlay", () => {
  it("UPDATES in place when a row exists, rather than deleting and re-inserting", async () => {
    const { db, state, inserted } = fakeDb([OUR_ROW]);
    await upsertRoleOverlay(db, {
      tenantId: OURS,
      roleSlug: "engineer",
      body: "REVISED RULES",
      updatedBy: "user-1",
    });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.body).toBe("REVISED RULES");
    // The load-bearing half: no INSERT ran, so there was no window in which the
    // row did not exist. A delete-then-insert that failed at the insert would
    // have destroyed the operator's only copy while returning an error the UI
    // reads as "nothing happened".
    expect(inserted).toHaveLength(0);
  });

  it("a failing write leaves the previous overlay intact", async () => {
    // The whole reason this is UPDATE-first. Under delete-then-insert a failure
    // here would have left NO row at all, while the editor kept showing the old
    // text and the next dispatch composed without it.
    const { db, state } = fakeDb([OUR_ROW], { failUpdate: "statement timeout" });

    const res = await upsertRoleOverlay(db, {
      tenantId: OURS,
      roleSlug: "engineer",
      body: "REVISED",
      updatedBy: null,
    });
    expect(res).toEqual({ ok: false, error: "statement timeout" });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.body).toBe("OUR HOUSE RULES");
  });
});
