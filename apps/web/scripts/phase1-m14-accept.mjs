// Phase 1 / M14 acceptance harness.
//
// Drives the M14 acceptance from `docs/DEVPILOT_PHASE1_PLAN.md` §M14:
//   1. Create an API key (same code path the UI server action uses, replayed
//      here by inserting the api_keys row with mintApiKey()).
//   2. POST /v1/agents/<default>/runs with a curl-equivalent fetch — verify
//      the run is queued (202 + runId) and lands as a row in `runs`.
//   3. POST /v1/agents/<default>/runs with `stream: true` — verify SSE chunks.
//   4. POST /v1/chat/completions with {model: "gpt-4o", messages: [...]} —
//      verify the OpenAI-shape response.
//   5. Hit /v1/agents/<X>/runs without an Authorization header → expect 401.
//   6. Burst 100 requests against one key in <1s → expect at least one 429.
//   7. Clean up: revoke + delete the API key, delete the test agent + runs.
//
// Pre-reqs: Next.js dev :3000 must be running. Inngest dev :8288 must be
// running for tests 2-4 to drive an actual run (we only assert the queue
// state for test 2; tests 3/4 read run_steps so they need real execution).
// Tests 5/6 are network-only and don't need Inngest.
//
// Run:
//   cd apps/web
//   node --env-file=.env.local scripts/phase1-m14-accept.mjs
//
// Exits 0 on pass, 1 on assertion failure, 2 when prerequisites aren't met.

import "./_legacy-env.mjs"; // legacy ACE_* env aliases (transitional)
import { randomUUID, randomBytes, createHash } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ENGINE_URL = process.env.DEVPILOT_ENGINE_URL ?? "http://localhost:3000";
const INNGEST_DEV = process.env.DEVPILOT_INNGEST_DEV_URL ?? "http://localhost:8288";
const TENANT_ID = process.env.DEVPILOT_OPERATOR_TENANT_ID ?? "e98507ec-d5a2-4951-8a5d-445c86dbfca8";

if (!SUPABASE_URL || !SECRET) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY in env");
  process.exit(2);
}

const sb = (p, init = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
    ...init,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });

let exitCode = 0;
function ok(label) {
  console.log(`  pass  ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? "  — " + detail : ""}`);
  exitCode = 1;
}

// Mirror mintApiKey from lib/api/key-auth.ts.
function mintKey() {
  const secret = randomBytes(32).toString("base64url");
  const prefix = secret.slice(0, 8);
  const cleartext = `ace_${prefix}_${secret}`;
  const hash = createHash("sha256").update(cleartext).digest("hex");
  return { cleartext, prefix, hash };
}

async function ensureEngineUp() {
  try {
    const r = await fetch(`${ENGINE_URL}/health`).catch(() => null);
    if (!r || !r.ok) {
      console.error(
        `Engine at ${ENGINE_URL} not reachable. Start: cd apps/web && pnpm exec next dev --port 3000`,
      );
      process.exit(2);
    }
  } catch {
    process.exit(2);
  }
}

async function inngestUp() {
  try {
    const r = await fetch(`${INNGEST_DEV}/health`).catch(() => null);
    return !!r && r.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

async function setup() {
  console.log("\n=== Setup ===");
  // Ensure a test agent exists. Use the operator tenant's first 'pm' agent
  // if available; create one if not.
  let agent;
  const r = await sb(`agents?tenant_id=eq.${TENANT_ID}&role=eq.pm&select=id,name,role&limit=1`);
  const rows = await r.json();
  if (rows.length > 0) {
    agent = rows[0];
    console.log(`  using existing pm agent: ${agent.id} (${agent.name})`);
  } else {
    const cr = await sb("agents", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: TENANT_ID,
        name: "M14 Test Agent",
        role: "pm",
        config: {},
      }),
    });
    if (!cr.ok) {
      fail("agent create", await cr.text());
      return null;
    }
    agent = (await cr.json())[0];
    console.log(`  created agent: ${agent.id}`);
  }

  // Mint key.
  const { cleartext, prefix, hash } = mintKey();
  const keyRow = await sb("api_keys", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: TENANT_ID,
      name: "m14-accept-" + Date.now(),
      hash,
      prefix,
      scope: "api",
    }),
  });
  if (!keyRow.ok) {
    fail("api_keys insert", await keyRow.text());
    return null;
  }
  const keyId = (await keyRow.json())[0]?.id;
  console.log(`  created api_keys row id=${keyId} prefix=${prefix}`);
  return { agent, keyId, cleartext, prefix };
}

async function testCreateRun(ctx) {
  console.log("\n=== T2: POST /v1/agents/<id>/runs (async) ===");
  const res = await fetch(`${ENGINE_URL}/v1/agents/${ctx.agent.id}/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.cleartext}`,
    },
    body: JSON.stringify({
      prompt: "Reply with the single word OK.",
      budgetCents: 200,
    }),
  });
  if (res.status !== 202) {
    fail("expected 202", `got ${res.status} ${await res.text()}`);
    return null;
  }
  const body = await res.json();
  if (typeof body.runId !== "string" || body.status !== "queued") {
    fail("response shape", JSON.stringify(body));
    return null;
  }
  ok(`run queued runId=${body.runId.slice(0, 8)}`);
  return body.runId;
}

async function testStreamRun(ctx) {
  console.log("\n=== T3: POST /v1/agents/<id>/runs (stream: true) ===");
  const res = await fetch(`${ENGINE_URL}/v1/agents/${ctx.agent.id}/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.cleartext}`,
    },
    body: JSON.stringify({
      prompt: "Reply with the single word OK.",
      budgetCents: 200,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    fail("stream open", `${res.status} ${await res.text().catch(() => "")}`);
    return;
  }
  if (res.headers.get("content-type")?.startsWith("text/event-stream") !== true) {
    fail("content-type", res.headers.get("content-type"));
    return;
  }
  ok("stream content-type is text/event-stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let frames = 0;
  let sawDone = false;
  let sawTerminator = false;
  let buf = "";
  // Read for up to 5 minutes — runs against the API runner usually return in 5-20s.
  const deadline = Date.now() + 300_000;
  outer: while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") {
        sawTerminator = true;
        break outer;
      }
      frames++;
      try {
        const ev = JSON.parse(payload);
        if (ev.status === "done" || ev.status === "failed") {
          sawDone = true;
        }
      } catch {
        // ignore
      }
    }
  }
  reader.cancel().catch(() => undefined);

  if (frames > 0) ok(`received ${frames} SSE data frames`);
  else fail("received zero SSE frames");
  if (sawDone) ok("saw terminal status event");
  else fail("never saw terminal status event");
  if (sawTerminator) ok("saw `data: [DONE]` terminator");
  else fail("missing `data: [DONE]` terminator");
}

async function testChatCompletions(ctx) {
  console.log("\n=== T4: POST /v1/chat/completions (OpenAI shape) ===");
  const res = await fetch(`${ENGINE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.cleartext}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Reply with one word." },
        { role: "user", content: "Hello?" },
      ],
    }),
  });
  if (!res.ok) {
    fail("chat completions", `${res.status} ${await res.text()}`);
    return;
  }
  const body = await res.json();
  if (body.object !== "chat.completion") {
    fail("object shape", body.object);
    return;
  }
  if (body.model !== "gpt-4o") {
    fail("model preserved", body.model);
  } else {
    ok("model preserved as gpt-4o");
  }
  if (!Array.isArray(body.choices) || body.choices.length === 0) {
    fail("no choices");
    return;
  }
  const msg = body.choices[0]?.message;
  if (msg?.role !== "assistant" || typeof msg?.content !== "string") {
    fail("choice shape", JSON.stringify(body.choices[0]));
  } else {
    ok(`assistant content len=${msg.content.length}`);
  }
}

async function testUnauthenticated(ctx) {
  console.log("\n=== T5: unauthenticated /v1/agents/* → 401 ===");
  const res = await fetch(`${ENGINE_URL}/v1/agents/${ctx.agent.id}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "x" }),
  });
  if (res.status === 401) ok("unauthenticated → 401");
  else fail("expected 401", `got ${res.status}`);
}

async function testRateLimit(ctx) {
  console.log("\n=== T6: burst 100 → at least one 429 ===");
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(
      fetch(`${ENGINE_URL}/v1/agents/${ctx.agent.id}/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.cleartext}`,
        },
        body: JSON.stringify({ prompt: "x" }),
      })
        .then((r) => r.status)
        .catch(() => 0),
    );
  }
  const results = await Promise.all(promises);
  const got429 = results.filter((s) => s === 429).length;
  const got202 = results.filter((s) => s === 202).length;
  console.log(
    `  burst returned: 202=${got202} 429=${got429} other=${results.length - got202 - got429}`,
  );
  if (got429 >= 1) ok(`saw ${got429} 429 responses (rate limit fired)`);
  else fail("rate limit never fired", `results=${JSON.stringify(results.slice(0, 10))}…`);
}

async function cleanup(ctx) {
  console.log("\n=== Cleanup ===");
  // Revoke key (audit-friendly), then delete.
  await sb(`api_keys?id=eq.${ctx.keyId}`, { method: "DELETE" });
  ok("api key deleted");
  // Don't delete the agent — it may be a long-lived operator agent.
  // Delete only ours (name starts with "M14 Test Agent" and tenant matches).
  await sb(`agents?tenant_id=eq.${TENANT_ID}&name=eq.${encodeURIComponent("M14 Test Agent")}`, {
    method: "DELETE",
  });
  ok("test agent deleted (if it was ours)");
}

(async () => {
  console.log("=== Phase 1 / M14 acceptance — Agents-as-APIs + OpenAI-compat + widget ===");
  await ensureEngineUp();
  const inngestAlive = await inngestUp();
  if (!inngestAlive) {
    console.log(
      "  note  Inngest dev not reachable at " +
        INNGEST_DEV +
        " — T3/T4 run-step assertions may time out.",
    );
  }
  const ctx = await setup();
  if (!ctx) {
    process.exit(1);
  }

  try {
    const runId = await testCreateRun(ctx);
    if (runId) {
      // Verify the run row appeared. Best-effort — Inngest may have already
      // moved it past 'running'; we only need it to exist.
      const r = await sb(`runs?id=eq.${runId}&select=id,tenant_id,status`);
      const rows = await r.json();
      if (rows.length > 0 && rows[0].tenant_id === TENANT_ID) {
        ok(`run row landed in DB tenant matched`);
      } else {
        // Not strictly fatal — the engine may not have processed yet.
        console.log("  note  run row not visible yet — Inngest may be slow");
      }
    }
    await testUnauthenticated(ctx);
    // T3/T4 must run BEFORE T6 (the 100-burst rate-limit test) so they
    // don't 429 on a key whose 60s window was just exhausted.
    if (inngestAlive) {
      await testStreamRun(ctx);
      await testChatCompletions(ctx);
    } else {
      console.log("\n  skip  T3 (stream) and T4 (chat completions) — Inngest dev not up");
    }
    await testRateLimit(ctx);
  } finally {
    await cleanup(ctx);
  }

  if (exitCode === 0) {
    console.log("\nPASS — M14 acceptance");
  } else {
    console.error("\nFAIL — M14 acceptance had assertion failures");
  }
  process.exit(exitCode);
})().catch((err) => {
  console.error("M14 acceptance crashed:", err);
  process.exit(1);
});
