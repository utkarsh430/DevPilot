// Phase 2.5++ / Slice A — Per-project secrets vault acceptance.
//
// UPDATED 2026-06-14: the pgcrypto security-definer RPCs (set_project_secret /
// get_project_secrets_json / delete_project_secret) were retired in favour of
// app-layer AES-256-GCM (@/lib/secrets/crypto) with DIRECT table access. This
// test now drives the REAL `lib/projects/secrets.ts` functions and asserts the
// stored value is opaque (AES) at rest — instead of round-tripping the dropped
// RPCs.
//
// Because it imports server-only TypeScript, it must run under tsx with the
// `react-server` condition (so the `server-only` import resolves to its empty
// module). From apps/web:
//   TSX=$(node -e "console.log(require.resolve('tsx',{paths:['../runner']}))")
//   node --import "$TSX" --conditions=react-server --env-file=.env.local \
//     scripts/phase2-5-project-secrets-accept.mts
//
// What this proves
// ────────────────
// 1. Schema: `project_secrets` has `value_encrypted` + `value_iv`, and the
//    dropped `set_project_secret` RPC is gone (PostgREST 404).
// 2. Round-trip via the real helpers: setProjectSecret → loadProjectSecretsJson
//    returns the value; bulk set = 3 keys; deleteProjectSecret removes one.
// 3. At rest: `value_encrypted`/`value_iv` are non-null, the IV is 12 bytes, and
//    the ciphertext does NOT contain the plaintext (opaque).
// 4. The devpilot_request_secret route writes metadata.kind='secret_request' AND
//    parks the ticket in input_required (unchanged by the crypto swap).
//
// Pre-reqs:
//   • NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY + SECRETS_ENCRYPTION_KEY.
//   • DEVPILOT_RUNNER_REGISTRATION_KEY (the request-secret route's auth gate).
//   • Next.js dev :3000 (for Test 4).
//   • Migration 20260618000000_app_layer_aes.sql applied.
//
// Exit codes: 0 = pass · 1 = test failure · 2 = environment/setup not satisfied.

import "./_legacy-env.mjs"; // legacy ACE_* env aliases (transitional)
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  setProjectSecret,
  loadProjectSecretsJson,
  deleteProjectSecret,
} from "../lib/projects/secrets.ts";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const RUNNER_KEY = process.env.DEVPILOT_RUNNER_REGISTRATION_KEY;
const ENGINE_URL = process.env.LOCAL_CC_ENGINE_URL ?? "http://localhost:3000";

if (!SUPABASE_URL || !SECRET) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY — exit 2");
  process.exit(2);
}
if (!process.env.SECRETS_ENCRYPTION_KEY) {
  console.error("missing SECRETS_ENCRYPTION_KEY (writes require it) — exit 2");
  process.exit(2);
}
if (!RUNNER_KEY) {
  console.error("missing DEVPILOT_RUNNER_REGISTRATION_KEY — exit 2");
  process.exit(2);
}

const sb = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const pg = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function pickTenant(): Promise<string> {
  if (process.env.DEVPILOT_TEST_TENANT_ID) return process.env.DEVPILOT_TEST_TENANT_ID;
  const r = await pg.query("select id::text as id from public.tenants order by created_at limit 1");
  if (r.rowCount === 0) throw new Error("no tenants exist to attach the fixture project to");
  return r.rows[0].id;
}

async function seedProject(tenantId: string, name: string): Promise<string> {
  const id = randomUUID();
  const r = await sb("projects", {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: tenantId,
      name,
      description: "Slice A acceptance fixture — safe to delete.",
      default_branch: "main",
    }),
  });
  if (!r.ok) throw new Error(`seed project failed: ${r.status} ${await r.text()}`);
  return id;
}

async function seedTicket(tenantId: string, projectId: string, title: string): Promise<string> {
  const id = randomUUID();
  const r = await sb("tickets", {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: tenantId,
      project_id: projectId,
      title,
      description: "Slice A acceptance fixture — safe to delete.",
      status: "in_progress",
      priority: 3,
    }),
  });
  if (!r.ok) throw new Error(`seed ticket failed: ${r.status} ${await r.text()}`);
  return id;
}

async function cleanup({ projectIds, ticketIds }: { projectIds: string[]; ticketIds: string[] }) {
  for (const id of ticketIds) {
    await sb(`comments?ticket_id=eq.${id}`, { method: "DELETE" });
    await sb(`tickets?id=eq.${id}`, { method: "DELETE" });
  }
  for (const id of projectIds) {
    await sb(`project_secrets?project_id=eq.${id}`, { method: "DELETE" });
    await sb(`projects?id=eq.${id}`, { method: "DELETE" });
  }
}

(async () => {
  console.log("=== Slice A — Project Secrets vault (app-layer AES) ===\n");
  const projectIds: string[] = [];
  const ticketIds: string[] = [];
  await pg.connect();

  try {
    const tenantId = await pickTenant();
    console.log(`using tenant=${tenantId.slice(0, 8)}…`);

    // ── Test 1: new schema present + old RPC gone ─────────────────────────
    console.log("\n--- Test 1: schema (value_encrypted + value_iv) + RPC retired ---");
    const cols = await pg.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='project_secrets'
          and column_name in ('value_encrypted','value_iv')`,
    );
    const haveCols = new Set(cols.rows.map((r) => r.column_name));
    assert(
      haveCols.has("value_encrypted") && haveCols.has("value_iv"),
      `project_secrets must have value_encrypted + value_iv (got ${[...haveCols].join(",")})`,
    );
    console.log("  ✓ value_encrypted + value_iv columns present");
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/set_project_secret`, {
      method: "POST",
      headers: {
        apikey: SECRET,
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_project_id: randomUUID(),
        p_secret_key: "X",
        p_value: "x",
        p_user_id: null,
      }),
    });
    assert(
      rpcRes.status === 404,
      `expected set_project_secret RPC to be gone (404), got ${rpcRes.status}`,
    );
    console.log("  ✓ dropped set_project_secret RPC returns 404");

    // ── Test 2: round-trip through the real helpers ───────────────────────
    console.log("\n--- Test 2: round-trip via setProjectSecret/loadProjectSecretsJson ---");
    const proj = await seedProject(tenantId, "slice-a-accept");
    projectIds.push(proj);
    console.log(`  seeded project=${proj.slice(0, 8)}`);

    const DBURL = "postgres://test/accept";
    await setProjectSecret({
      projectId: proj,
      secretKey: "DATABASE_URL",
      value: DBURL,
      userId: null,
    });
    const got1 = JSON.parse((await loadProjectSecretsJson(proj)) ?? "null");
    assert(
      got1 && got1.DATABASE_URL === DBURL,
      `expected {DATABASE_URL:'${DBURL}'}, got ${JSON.stringify(got1)}`,
    );
    console.log("  ✓ set + load returned the matching value");

    await setProjectSecret({
      projectId: proj,
      secretKey: "STRIPE_API_KEY",
      value: "sk_test_xxx",
      userId: null,
    });
    await setProjectSecret({
      projectId: proj,
      secretKey: "NEXT_PUBLIC_API_BASE",
      value: "https://api.example.test",
      userId: null,
    });
    const got3 = JSON.parse((await loadProjectSecretsJson(proj)) ?? "null");
    assert(Object.keys(got3).length === 3, `expected 3 keys, got ${Object.keys(got3).length}`);
    console.log("  ✓ bulk set returned 3 entries");

    await deleteProjectSecret({ projectId: proj, secretKey: "STRIPE_API_KEY" });
    const got2 = JSON.parse((await loadProjectSecretsJson(proj)) ?? "null");
    assert(
      !("STRIPE_API_KEY" in got2) && Object.keys(got2).length === 2,
      `expected 2 keys after delete, got ${JSON.stringify(got2)}`,
    );
    console.log("  ✓ delete removed the key");

    // ── Test 3: encryption at rest (opaque AES) ───────────────────────────
    console.log("\n--- Test 3: at rest — value_encrypted/value_iv opaque ---");
    const raw = await pg.query(
      `select value_encrypted, value_iv from public.project_secrets
        where project_id = $1 and secret_key = 'DATABASE_URL'`,
      [proj],
    );
    assert(raw.rowCount === 1, "expected the DATABASE_URL row to exist");
    const { value_encrypted: enc, value_iv: iv } = raw.rows[0] as {
      value_encrypted: Buffer;
      value_iv: Buffer;
    };
    assert(
      Buffer.isBuffer(enc) && enc.length >= 17,
      `value_encrypted must be >=17 bytes (ct+tag), got ${enc?.length}`,
    );
    assert(
      Buffer.isBuffer(iv) && iv.length === 12,
      `value_iv must be a 12-byte GCM nonce, got ${iv?.length}`,
    );
    assert(
      !enc.includes(Buffer.from(DBURL, "utf8")),
      "ciphertext must NOT contain the plaintext (not opaque!)",
    );
    console.log(`  ✓ ct=${enc.length}B, iv=${iv.length}B, plaintext absent from ciphertext`);

    // ── Test 4: devpilot_request_secret route (unchanged) ──────────────────────
    console.log("\n--- Test 4: devpilot_request_secret POST writes structured comment ---");
    const ticket = await seedTicket(tenantId, proj, "Slice A — secret request smoke");
    ticketIds.push(ticket);
    const res = await fetch(`${ENGINE_URL}/api/runners/tools/request-secret`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-devpilot-runner-key": RUNNER_KEY },
      body: JSON.stringify({
        ticketId: ticket,
        keys: ["DATABASE_URL", "STRIPE_API_KEY"],
        rationale: "pnpm build exited 1 — missing required env values",
        role: "verifier",
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`route returned ${res.status}: ${body}`);
    const { commentId } = JSON.parse(body) as { commentId: string };
    assert(typeof commentId === "string", `expected commentId string, got ${body}`);
    console.log(`  ✓ route returned 200 with commentId=${commentId.slice(0, 8)}`);

    const cRows = await (
      await sb(`comments?id=eq.${commentId}&select=author_type,author_id,body,metadata`)
    ).json();
    assert(cRows.length === 1, "expected exactly 1 comment row");
    const c = cRows[0];
    assert(c.author_type === "agent", `expected author_type=agent, got ${c.author_type}`);
    assert(c.author_id === "verifier", `expected author_id=verifier, got ${c.author_id}`);
    assert(
      c.metadata?.kind === "secret_request",
      `expected metadata.kind=secret_request, got ${JSON.stringify(c.metadata)}`,
    );
    assert(
      Array.isArray(c.metadata?.keys) && c.metadata.keys.length === 2,
      `expected 2 keys in metadata, got ${JSON.stringify(c.metadata?.keys)}`,
    );
    assert(
      c.metadata?.project_id === proj,
      `expected project_id=${proj}, got ${c.metadata?.project_id}`,
    );
    console.log("  ✓ comment row has correct metadata.kind / keys / project_id");

    const tRows = await (await sb(`tickets?id=eq.${ticket}&select=status`)).json();
    assert(
      tRows[0]?.status === "input_required",
      `expected ticket status=input_required, got ${tRows[0]?.status}`,
    );
    console.log("  ✓ ticket parked in input_required");

    console.log("\n=== Slice A acceptance PASS ===");
    await cleanup({ projectIds, ticketIds });
    await pg.end().catch(() => {});
    process.exit(0);
  } catch (err) {
    console.error(`\n✗ Slice A acceptance FAIL: ${(err as Error).message}`);
    await cleanup({ projectIds, ticketIds });
    await pg.end().catch(() => {});
    process.exit(1);
  }
})();
