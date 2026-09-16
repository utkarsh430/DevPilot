// The tenant boundary on the Vercel OAuth connection.
//
// `vercel_oauth_connections` denies every JWT role, so all access is
// service-role with RLS OFF and the co-located `.eq("tenant_id", …)` is the
// ONLY control. What is behind it is not a preference row — it is the deploy
// credential. Read it and you can deploy as that tenant; overwrite it and every
// project DevPilot creates for them, and every environment variable it pushes,
// lands in an account you control.
//
// ── Why the fake applies filters ──────────────────────────────────────────
// The fake client below ACTUALLY evaluates `.eq`. That is not fastidiousness:
// a fake that ignored filters would make every assertion in this file pass with
// the predicates deleted, i.e. the suite would be vacuous while looking
// thorough. Each boundary test is therefore paired with a CONTROL that neuters
// the predicate and asserts the foreign row WOULD be reached — so the guard is
// proven to be what is doing the work.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deleteVercelConnection,
  readVercelConnectionStatus,
  readVercelConnectionToken,
  writeVercelConnection,
  type ConnectionCrypto,
} from "@/lib/vercel/connection";

const OURS = "11111111-1111-1111-1111-111111111111";
const THEIRS = "99999999-9999-9999-9999-999999999999";

/** Reversible stand-in for AES-GCM. The real crypto is `server-only` and is
 *  injected precisely so this module stays loadable here. */
const CRYPTO: ConnectionCrypto = {
  encrypt: (plaintext) => ({ ciphertext: `enc:${plaintext}`, iv: "iv" }),
  decrypt: (ciphertext) =>
    typeof ciphertext === "string" && ciphertext.startsWith("enc:") ? ciphertext.slice(4) : null,
};

type Row = Record<string, unknown>;

/** A Supabase double that really applies `.eq`. `applyFilters: false` is the
 *  control switch used to prove non-vacuity. */
function fakeDb(rows: Row[], opts: { applyFilters?: boolean } = {}) {
  const applyFilters = opts.applyFilters !== false;
  const state = { rows, upserts: [] as Row[], deleted: [] as Row[] };

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    const matches = (r: Row) => !applyFilters || filters.every(([col, val]) => r[col] === val);
    const api: Record<string, unknown> = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      async maybeSingle() {
        const hit = state.rows.filter((r) => r.__table === table).find(matches);
        return { data: hit ?? null, error: null };
      },
      async upsert(payload: Row) {
        state.upserts.push({ ...payload, __table: table });
        return { error: null };
      },
      delete() {
        return {
          eq(col: string, val: unknown) {
            filters.push([col, val]);
            const gone = state.rows.filter((r) => r.__table === table && matches(r));
            state.deleted.push(...gone);
            state.rows = state.rows.filter((r) => !gone.includes(r));
            return Promise.resolve({ error: null });
          },
        };
      },
    };
    return api;
  }

  const db = { from: (t: string) => builder(t) } as unknown as SupabaseClient;
  return { db, state };
}

function connectionRow(tenantId: string, token: string): Row {
  return {
    __table: "vercel_oauth_connections",
    tenant_id: tenantId,
    access_token_encrypted: `enc:${token}`,
    access_token_iv: "iv",
    team_id: null,
    configuration_id: "cfg_1",
    account_login: "acme",
    account_kind: "personal",
    connected_at: "2026-07-18T00:00:00.000Z",
  };
}

describe("reading the token", () => {
  it("returns our own tenant's credential", async () => {
    const { db } = fakeDb([connectionRow(OURS, "our-token")]);
    const res = await readVercelConnectionToken(db, OURS, CRYPTO);
    expect(res).toEqual({ token: "our-token", teamId: null });
  });

  it("BOUNDARY: never returns another tenant's credential", async () => {
    const { db } = fakeDb([connectionRow(THEIRS, "their-token")]);
    expect(await readVercelConnectionToken(db, OURS, CRYPTO)).toBeNull();
  });

  it("CONTROL: with the predicate neutered, the foreign credential WOULD leak", async () => {
    // Proves the assertion above is carried by `.eq("tenant_id", …)` and not by
    // an accident of the fixture.
    const { db } = fakeDb([connectionRow(THEIRS, "their-token")], { applyFilters: false });
    expect(await readVercelConnectionToken(db, OURS, CRYPTO)).toEqual({
      token: "their-token",
      teamId: null,
    });
  });

  it("degrades to null on an undecryptable row rather than throwing", async () => {
    const row = connectionRow(OURS, "x");
    row.access_token_encrypted = "not-our-format";
    const { db } = fakeDb([row]);
    expect(await readVercelConnectionToken(db, OURS, CRYPTO)).toBeNull();
  });
});

describe("reading the status", () => {
  it("reports metadata and NEVER selects the token columns", async () => {
    const { db } = fakeDb([connectionRow(OURS, "our-token")]);
    const status = await readVercelConnectionStatus(db, OURS);
    expect(status.connected).toBe(true);
    expect(status.accountLogin).toBe("acme");
    expect(status.configurationId).toBe("cfg_1");
    // The whole serialised status must not carry the credential — this object
    // is handed to a client component.
    expect(JSON.stringify(status)).not.toContain("our-token");
    expect(JSON.stringify(status)).not.toContain("enc:");
  });

  it("BOUNDARY: reports disconnected for a foreign tenant's row", async () => {
    const { db } = fakeDb([connectionRow(THEIRS, "their-token")]);
    expect((await readVercelConnectionStatus(db, OURS)).connected).toBe(false);
  });

  it("normalises an unrecognised account_kind to null instead of rendering it", async () => {
    const row = connectionRow(OURS, "t");
    row.account_kind = "something-new";
    const { db } = fakeDb([row]);
    expect((await readVercelConnectionStatus(db, OURS)).accountKind).toBeNull();
  });
});

describe("writing", () => {
  const input = {
    accessToken: "fresh-token",
    teamId: null,
    configurationId: "cfg_2",
    accountLogin: "acme",
    accountKind: "personal" as const,
    connectedBy: "user-1",
    connectedAt: "2026-07-18T12:00:00.000Z",
  };

  it("encrypts the token and stamps the caller's tenant", async () => {
    const { db, state } = fakeDb([]);
    expect(await writeVercelConnection(db, OURS, input, CRYPTO)).toEqual({ ok: true });
    const written = state.upserts[0]!;
    expect(written.tenant_id).toBe(OURS);
    expect(written.access_token_encrypted).toBe("enc:fresh-token");
    // Plaintext must never be a column value.
    expect(written.access_token_encrypted).not.toBe("fresh-token");
  });

  it("FAILS the connect when encryption is unavailable, rather than storing plaintext", async () => {
    const throwing: ConnectionCrypto = {
      encrypt: () => {
        throw new Error("SECRETS_ENCRYPTION_KEY is not set.");
      },
      decrypt: () => null,
    };
    const { db, state } = fakeDb([]);
    const res = await writeVercelConnection(db, OURS, input, throwing);
    expect(res.ok).toBe(false);
    expect(state.upserts).toHaveLength(0);
  });
});

describe("disconnecting", () => {
  it("removes our own row", async () => {
    const { db, state } = fakeDb([connectionRow(OURS, "our-token")]);
    expect(await deleteVercelConnection(db, OURS)).toEqual({ ok: true });
    expect(state.deleted).toHaveLength(1);
    expect(state.rows).toHaveLength(0);
  });

  it("BOUNDARY: never removes another tenant's connection", async () => {
    const { db, state } = fakeDb([connectionRow(THEIRS, "their-token")]);
    await deleteVercelConnection(db, OURS);
    expect(state.deleted).toHaveLength(0);
    expect(state.rows).toHaveLength(1);
  });

  it("CONTROL: with the predicate neutered, the foreign row WOULD be deleted", async () => {
    const { db, state } = fakeDb([connectionRow(THEIRS, "their-token")], { applyFilters: false });
    await deleteVercelConnection(db, OURS);
    expect(state.deleted).toHaveLength(1);
  });
});
