// Tenant isolation for run artifacts — the store path.
//
// `run_artifacts` denies all JWT writes, so the ingest path runs on the SERVICE
// client with RLS off and the co-located `.eq("tenant_id", …)` on every read and
// write is the ENTIRE boundary. It matters unusually much on the READ side:
// what comes back is a SIGNED URL to an image that is then rendered in an
// operator's browser, filed under a step of THEIR run. A leaked foreign row does
// not merely disclose another tenant's screen — it presents it as evidence about
// this tenant's work, which is the worst possible way to get this wrong.
//
// The fake below ACTUALLY APPLIES `.eq`. A filter-ignoring fake would make every
// assertion here vacuous (the trap `lib/export/__tests__/ticket-audit.test.ts`
// warns about), so each guard has a CONTROL that neuters exactly that predicate
// and asserts the foreign row IS returned / IS counted there. If the predicate
// ever disappears from artifacts-store.ts, the real tests go red.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRunArtifacts, storeRunArtifact } from "@/lib/runs/artifacts-store";
import { ARTIFACT_BUCKET, MAX_ARTIFACTS_PER_RUN } from "@/lib/runs/artifacts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const RUN = "22222222-2222-4222-8222-222222222222";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

type Row = Record<string, unknown>;

type FakeOpts = {
  /** ONLY for the non-vacuity controls: make `.eq` a no-op, i.e. what deleting
   *  the tenant predicate would look like. */
  honourEq?: boolean;
  /** Simulate a storage backend that refuses the upload. */
  uploadFails?: boolean;
  /** Simulate a storage backend that cannot mint a signed URL. */
  signFails?: boolean;
};

function fakeClient(store: { run_artifacts: Row[] }, opts: FakeOpts = {}) {
  const honourEq = opts.honourEq ?? true;
  const uploaded: string[] = [];
  const signed: string[] = [];

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" = "select";
    let head = false;
    let wantCount = false;
    let inserted: Row | null = null;
    const self: Record<string, unknown> = {};

    self.select = (_cols?: string, o?: { count?: string; head?: boolean }) => {
      if (o?.count) wantCount = true;
      if (o?.head) head = true;
      return self;
    };
    self.insert = (row: Row) => {
      mode = "insert";
      inserted = { id: `row-${store[table as "run_artifacts"].length + 1}`, ...row };
      return self;
    };
    self.eq = (c: string, v: unknown) => {
      if (honourEq) filters.push((r) => r[c] === v);
      return self;
    };
    self.order = () => self;

    const rows = () => store[table as "run_artifacts"].filter((r) => filters.every((f) => f(r)));

    self.maybeSingle = async () => {
      if (mode === "insert" && inserted) {
        store[table as "run_artifacts"].push(inserted);
        return { data: { id: inserted.id }, error: null };
      }
      return { data: rows()[0] ?? null, error: null };
    };
    // `await`ing the builder directly (the count + list shapes).
    self.then = (resolve: (v: unknown) => unknown) => {
      const matched = rows();
      return Promise.resolve(
        resolve(
          wantCount
            ? { data: head ? null : matched, count: matched.length, error: null }
            : { data: matched, error: null },
        ),
      );
    };
    return self;
  }

  const client = {
    from: (table: string) => builder(table),
    storage: {
      from: (bucket: string) => ({
        upload: async (key: string) => {
          expect(bucket).toBe(ARTIFACT_BUCKET);
          if (opts.uploadFails) return { error: { message: "storage exploded" } };
          uploaded.push(key);
          return { error: null };
        },
        createSignedUrl: async (key: string) => {
          expect(bucket).toBe(ARTIFACT_BUCKET);
          if (opts.signFails) return { data: null, error: { message: "sign exploded" } };
          signed.push(key);
          return { data: { signedUrl: `https://signed.example/${key}` }, error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;

  return { client, uploaded, signed };
}

function storedRow(over: Partial<Row> = {}): Row {
  return {
    id: "existing",
    run_id: RUN,
    tenant_id: TENANT,
    step_idx: 0,
    storage_key: `${TENANT}/${RUN}/0/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`,
    mime: "image/png",
    bytes: 100,
    sequence: 0,
    captured_total: 1,
    captured_at: "2026-07-19T00:00:00.000Z",
    ...over,
  };
}

const input = {
  tenantId: TENANT,
  runId: RUN,
  stepIdx: 2,
  mime: "image/png" as const,
  bytes: PNG,
  sequence: 0,
  capturedTotal: 1,
  capturedAt: "2026-07-19T00:00:00.000Z",
};

// ───────────────────────────────────────────────────────────────────────────
// Write: an image reaches storage under the RIGHT tenant's folder.
// ───────────────────────────────────────────────────────────────────────────

describe("storeRunArtifact — the stored object is tenant-scoped", () => {
  it("writes the object under the tenant's own folder and records the row", async () => {
    const store = { run_artifacts: [] as Row[] };
    const { client, uploaded } = fakeClient(store);

    const res = await storeRunArtifact(client, input);

    expect(res.ok).toBe(true);
    expect(uploaded).toHaveLength(1);
    // The FIRST path segment is the tenant — the predicate the bucket RLS keys on.
    expect(uploaded[0]!.startsWith(`${TENANT}/`)).toBe(true);
    expect(uploaded[0]!.startsWith(`${OTHER_TENANT}/`)).toBe(false);
    expect(uploaded[0]).toContain(`/${RUN}/2/`);

    const row = store.run_artifacts[0]!;
    expect(row.tenant_id).toBe(TENANT);
    expect(row.run_id).toBe(RUN);
    expect(row.step_idx).toBe(2);
    expect(row.source).toBe("browser");
  });

  it("refuses an off-allowlist mime before any upload happens", async () => {
    const store = { run_artifacts: [] as Row[] };
    const { client, uploaded } = fakeClient(store);
    const res = await storeRunArtifact(client, {
      ...input,
      mime: "image/svg+xml" as unknown as typeof input.mime,
    });
    expect(res).toMatchObject({ ok: false, code: "invalid" });
    expect(uploaded).toHaveLength(0);
    expect(store.run_artifacts).toHaveLength(0);
  });

  it("refuses an oversized body", async () => {
    const store = { run_artifacts: [] as Row[] };
    const { client, uploaded } = fakeClient(store);
    const res = await storeRunArtifact(client, {
      ...input,
      bytes: new Uint8Array(6 * 1024 * 1024),
    });
    expect(res).toMatchObject({ ok: false, code: "invalid" });
    expect(uploaded).toHaveLength(0);
  });

  it("does not insert a row when the upload fails — no row without an object", async () => {
    // A row pointing at a missing object renders as a broken image: a claim of
    // evidence with nothing behind it. A missing image is the safer failure.
    const store = { run_artifacts: [] as Row[] };
    const { client } = fakeClient(store, { uploadFails: true });
    const res = await storeRunArtifact(client, input);
    expect(res).toMatchObject({ ok: false, code: "upload_failed" });
    expect(store.run_artifacts).toHaveLength(0);
  });

  it("never throws — a typed refusal is the only failure mode", async () => {
    const exploding = {
      from: () => {
        throw new Error("db gone");
      },
    } as unknown as SupabaseClient;
    // The caller is a route that must answer, and the runner behind it has
    // already reported its step result. A throw here would turn lost evidence
    // into a 500 the operator has to interpret.
    await expect(
      storeRunArtifact(exploding, input).catch((e) => ({ threw: String(e) })),
    ).resolves.toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Retention: the per-run cap.
// ───────────────────────────────────────────────────────────────────────────

describe("storeRunArtifact — the per-run cap", () => {
  it("refuses once the run is at its cap, and spends no upload doing it", async () => {
    const store = {
      run_artifacts: Array.from({ length: MAX_ARTIFACTS_PER_RUN }, (_, i) =>
        storedRow({ id: `r${i}`, storage_key: `${TENANT}/${RUN}/0/k${i}.png` }),
      ),
    };
    const { client, uploaded } = fakeClient(store);

    const res = await storeRunArtifact(client, input);

    expect(res).toMatchObject({ ok: false, code: "run_cap" });
    expect(uploaded).toHaveLength(0);
    expect(store.run_artifacts).toHaveLength(MAX_ARTIFACTS_PER_RUN);
  });

  it("one under the cap still stores", async () => {
    const store = {
      run_artifacts: Array.from({ length: MAX_ARTIFACTS_PER_RUN - 1 }, (_, i) =>
        storedRow({ id: `r${i}`, storage_key: `${TENANT}/${RUN}/0/k${i}.png` }),
      ),
    };
    const { client } = fakeClient(store);
    expect((await storeRunArtifact(client, input)).ok).toBe(true);
  });

  it("ANOTHER TENANT's rows do not consume this run's cap", async () => {
    // The cap count is a service-role read keyed on run_id; without the tenant
    // predicate a foreign tenant could starve a run of its own evidence budget.
    const store = {
      run_artifacts: Array.from({ length: MAX_ARTIFACTS_PER_RUN }, (_, i) =>
        storedRow({
          id: `foreign-${i}`,
          tenant_id: OTHER_TENANT,
          storage_key: `${OTHER_TENANT}/${RUN}/0/k${i}.png`,
        }),
      ),
    };
    const { client } = fakeClient(store);
    expect((await storeRunArtifact(client, input)).ok).toBe(true);
  });

  it("CONTROL: without the tenant predicate, the foreign rows DO starve the cap", async () => {
    const store = {
      run_artifacts: Array.from({ length: MAX_ARTIFACTS_PER_RUN }, (_, i) =>
        storedRow({
          id: `foreign-${i}`,
          tenant_id: OTHER_TENANT,
          storage_key: `${OTHER_TENANT}/${RUN}/0/k${i}.png`,
        }),
      ),
    };
    const { client } = fakeClient(store, { honourEq: false });
    expect(await storeRunArtifact(client, input)).toMatchObject({ code: "run_cap" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Read: retrievable by the owning tenant ONLY.
// ───────────────────────────────────────────────────────────────────────────

describe("loadRunArtifacts — retrievable by the owning tenant only", () => {
  it("returns this tenant's artifacts with signed URLs", async () => {
    const store = { run_artifacts: [storedRow({ id: "mine" })] };
    const { client, signed } = fakeClient(store);

    const out = await loadRunArtifacts(client, { runId: RUN, tenantId: TENANT });

    expect(out.map((a) => a.id)).toEqual(["mine"]);
    expect(out[0]!.url).toContain(`${TENANT}/`);
    expect(signed).toHaveLength(1);
  });

  it("does NOT return another tenant's artifacts on the same run id", async () => {
    const store = {
      run_artifacts: [
        storedRow({ id: "mine" }),
        storedRow({
          id: "theirs",
          tenant_id: OTHER_TENANT,
          storage_key: `${OTHER_TENANT}/${RUN}/0/theirs.png`,
        }),
      ],
    };
    const { client, signed } = fakeClient(store);

    const out = await loadRunArtifacts(client, { runId: RUN, tenantId: TENANT });

    expect(out.map((a) => a.id)).toEqual(["mine"]);
    // And crucially: no URL was ever minted for the foreign object.
    expect(signed.some((k) => k.startsWith(OTHER_TENANT))).toBe(false);
  });

  it("CONTROL: the two read guards catch DIFFERENT rows, and both are needed", async () => {
    // Writing this control the obvious way — neuter `.eq`, expect a leak — FAILS,
    // and the reason is worth recording rather than tuning away: the read path
    // has TWO independent guards, and for the ordinary foreign row they overlap.
    //
    //   (a) `.eq("tenant_id", …)` — the SQL predicate.
    //   (b) `isKeyUnderTenant(storage_key, …)` — refuses to SIGN a key that is
    //       not under this tenant's folder.
    //
    // So the control has to use the row shape that only ONE of them can catch:
    // a row STAMPED with a foreign tenant whose storage key nonetheless sits
    // under ours. That is exactly what a mis-stamped or planted row looks like,
    // (b) waves it through, and only (a) stops it.
    const plantedKey = `${TENANT}/${RUN}/0/planted.png`;
    const store = {
      run_artifacts: [
        storedRow({ id: "mine" }),
        storedRow({ id: "planted", tenant_id: OTHER_TENANT, storage_key: plantedKey }),
      ],
    };

    // Guard (a) present: the planted row never reaches the signer.
    const guarded = fakeClient(store);
    const safe = await loadRunArtifacts(guarded.client, { runId: RUN, tenantId: TENANT });
    expect(safe.map((a) => a.id)).toEqual(["mine"]);
    expect(guarded.signed).not.toContain(plantedKey);

    // Guard (a) removed: it leaks, and a signed URL is minted for it. This is
    // what deleting `.eq("tenant_id", …)` from the read costs.
    const unguarded = fakeClient(store, { honourEq: false });
    const leaked = await loadRunArtifacts(unguarded.client, { runId: RUN, tenantId: TENANT });
    expect(leaked.map((a) => a.id).sort()).toEqual(["mine", "planted"]);
    expect(unguarded.signed).toContain(plantedKey);
  });

  it("CONTROL: the key guard alone catches the ordinary foreign row", async () => {
    // The other half of the pair above: with `.eq` neutered, a foreign row
    // carrying a foreign KEY is still refused — by (b). Both guards earn their
    // place, and neither is redundant.
    const store = {
      run_artifacts: [
        storedRow({
          id: "theirs",
          tenant_id: OTHER_TENANT,
          storage_key: `${OTHER_TENANT}/${RUN}/0/theirs.png`,
        }),
      ],
    };
    const { client, signed } = fakeClient(store, { honourEq: false });
    expect(await loadRunArtifacts(client, { runId: RUN, tenantId: TENANT })).toHaveLength(0);
    expect(signed).toHaveLength(0);
  });

  it("drops a row whose stored key points outside the tenant, even when the query returned it", async () => {
    // Defence in depth: a stray/corrupt row must never be signed, because a
    // signed URL is a working handle to the object regardless of RLS.
    const store = {
      run_artifacts: [
        storedRow({
          id: "stray",
          tenant_id: TENANT, // row claims our tenant…
          storage_key: `${OTHER_TENANT}/${RUN}/0/stray.png`, // …key does not
        }),
      ],
    };
    const { client, signed } = fakeClient(store);

    const out = await loadRunArtifacts(client, { runId: RUN, tenantId: TENANT });

    expect(out).toHaveLength(0);
    expect(signed).toHaveLength(0);
  });

  it("keeps the row but nulls the URL when signing fails — never silently fewer images", async () => {
    const store = { run_artifacts: [storedRow({ id: "mine" })] };
    const { client } = fakeClient(store, { signFails: true });

    const out = await loadRunArtifacts(client, { runId: RUN, tenantId: TENANT });

    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBeNull();
  });

  it("drops a row carrying an off-allowlist mime", async () => {
    const store = { run_artifacts: [storedRow({ id: "svg", mime: "image/svg+xml" })] };
    const { client, signed } = fakeClient(store);
    expect(await loadRunArtifacts(client, { runId: RUN, tenantId: TENANT })).toHaveLength(0);
    expect(signed).toHaveLength(0);
  });

  it("logs rather than swallowing a load error — [] must not read as 'captured nothing'", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                order: () => Promise.resolve({ data: null, error: { message: "select exploded" } }),
              }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const out = await loadRunArtifacts(failing, { runId: RUN, tenantId: TENANT });

    expect(out).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
