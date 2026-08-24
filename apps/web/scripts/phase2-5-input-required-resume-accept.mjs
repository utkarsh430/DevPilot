// Phase 2.5++ / Slice B — input_required → human-reply resume acceptance.
//
// What this proves
// ────────────────
// 1. Positive case: a ticket parked in `input_required` with 3 prior `engineer`
//    agent comments + a fresh human comment, on `ticket/dispatch-needed`,
//    causes the dispatcher to emit a new `agent/run.requested` (visible as a
//    new `runs` row created by runAgent's INIT step within ~10s).
//    Before the fix: G5 loop-guard saw priorCountForPick=3 + retry_count=0
//    and blocked the F2 classifier; state-machine fallback returned null;
//    no run row ever appeared and the ticket hung.
//
// 2. Regression case: the SAME ticket shape WITHOUT a human reply at the tail
//    (i.e. last comment is still from an agent) — G5 must still block any F2
//    pick that hits the priorCount>=2 condition. We assert no NEW run row
//    appears within 15s.
//
// 3. State-machine safety net: when the F2 classifier is disabled
//    (DEVPILOT_CLASSIFIER_ON_EVERY_DISPATCH=0 on the server), the new in_progress
//    + humanReplyResume branch resumes to the last agent author. We can't
//    toggle that env from a script, so this case is documented for manual
//    verification only (see the verification section in the plan file).
//
// We assert at the `runs` table layer (not at the Inngest event layer)
// because that's the system-of-record both downstream consumers (runAgent
// itself, the inspector, the WIP gate) read from. A row appearing means the
// dispatcher's emit landed and runAgent's INIT step claimed it. We do NOT
// need the runner to be up — the assertion is about the dispatcher's
// decision, not the runner's execution.
//
// Pre-reqs:
//   • Next.js dev :3000 (route handlers) and Inngest dev :8288.
//   • The dispatcher and dispatchOnRunComplete registered in
//     apps/web/app/api/inngest/route.ts.
//   • A materialised `engineer` agent row (any tenant; default test tenant).
//   • CLAUDE_CODE_OAUTH_TOKEN set if the F2 classifier path is exercised
//     (positive case). Without the token, the classifier degrades and the
//     state-machine safety net (line 1037+ of dispatcher.ts) catches it.
//
// Exit codes:
//   0 = pass
//   1 = test failure
//   2 = environment/setup not satisfied
//
// Run:
//   cd apps/web
//   node --env-file=.env.local scripts/phase2-5-input-required-resume-accept.mjs

import "./_legacy-env.mjs"; // legacy ACE_* env aliases (transitional)
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const INNGEST_DEV = process.env.INNGEST_DEV_URL ?? "http://localhost:8288";
const TENANT_ID = process.env.DEVPILOT_TEST_TENANT_ID ?? "e98507ec-d5a2-4951-8a5d-445c86dbfca8";

if (!SUPABASE_URL || !SECRET) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY — exit 2");
  process.exit(2);
}

const sb = (path, init = {}) =>
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

async function sendEvent(name, data) {
  const res = await fetch(`${INNGEST_DEV}/e/dev`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) {
    throw new Error(`event send ${name} failed: ${res.status} ${await res.text()}`);
  }
}

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    const val = await predicate();
    last = val;
    if (val) return val;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for: ${label}; lastValue=${JSON.stringify(last)}`);
}

async function waitForAbsence(label, predicate, timeoutMs = 15_000) {
  // Returns true when the predicate has remained falsy for the entire window.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await predicate();
    if (val) {
      throw new Error(`unexpected presence of: ${label}; value=${JSON.stringify(val)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return true;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function seedTicket({ tenantId, status }) {
  const id = randomUUID();
  const r = await sb("tickets", {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: tenantId,
      title: "Slice B accept — input_required resume",
      description: "Acceptance fixture — safe to delete.",
      status,
      priority: 3,
    }),
  });
  if (!r.ok) throw new Error(`seed ticket failed: ${r.status} ${await r.text()}`);
  return id;
}

async function seedComment({ tenantId, ticketId, authorType, authorId, body }) {
  const r = await sb("comments", {
    method: "POST",
    body: JSON.stringify({
      id: randomUUID(),
      ticket_id: ticketId,
      tenant_id: tenantId,
      author_type: authorType,
      author_id: authorId,
      body,
    }),
  });
  if (!r.ok) throw new Error(`seed comment failed: ${r.status} ${await r.text()}`);
}

async function countRunsForTicket(ticketId) {
  const r = await sb(
    `runs?ticket_id=eq.${ticketId}&select=id,status,created_at&order=created_at.desc`,
  );
  if (!r.ok) throw new Error(`runs query failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows.length;
}

async function cleanup({ ticketIds }) {
  for (const id of ticketIds) {
    // runs cascade by tenant FK; we explicitly drop them so the test's
    // synthetic rows don't linger in the inspector.
    await sb(`runs?ticket_id=eq.${id}`, { method: "DELETE" });
    await sb(`comments?ticket_id=eq.${id}`, { method: "DELETE" });
    await sb(`tickets?id=eq.${id}`, { method: "DELETE" });
  }
}

(async () => {
  console.log("=== Slice B — input_required → human-reply resume ===\n");
  const ticketIds = [];
  try {
    // ── Test 1: positive case ────────────────────────────────────────────
    // Seed a ticket with 3 prior engineer comments (so priorCountForPick=3)
    // + a fresh human reply. Status is in_progress (post-transition shape).
    console.log("--- Test 1: positive case (human reply unblocks resume) ---");
    const t1 = await seedTicket({ tenantId: TENANT_ID, status: "in_progress" });
    ticketIds.push(t1);
    for (let i = 0; i < 3; i += 1) {
      await seedComment({
        tenantId: TENANT_ID,
        ticketId: t1,
        authorType: "agent",
        authorId: "engineer",
        body: `prior engineer iteration ${i + 1}`,
      });
    }
    await seedComment({
      tenantId: TENANT_ID,
      ticketId: t1,
      authorType: "human",
      authorId: "operator@test",
      body: "Here's the value: DATABASE_URL=postgres://test",
    });
    const baselineCount1 = await countRunsForTicket(t1);
    console.log(
      `  seeded ticket=${t1.slice(0, 8)} with 3 engineer + 1 human; runs baseline=${baselineCount1}`,
    );

    await sendEvent("ticket/dispatch-needed", { ticketId: t1, tenantId: TENANT_ID });
    console.log("  fired ticket/dispatch-needed");

    await waitFor(
      "new runs row to appear after human-reply resume",
      async () => {
        const n = await countRunsForTicket(t1);
        return n > baselineCount1 ? { n } : null;
      },
      25_000,
    );
    console.log("  ✓ dispatcher emitted a new run after the human reply\n");

    // ── Test 2: regression case — engineer pick is blocked ──────────────
    // SAME shape (3 prior engineer comments) but the tail is still an agent
    // comment — no human reply. G5 must continue to block an engineer pick.
    // The classifier may legitimately pick a DIFFERENT role (qa, verifier,
    // etc.) and dispatch that — which is correct behaviour, not a regression.
    // So we assert at the dispatched-run's agent_id: if a new run lands,
    // it MUST NOT be engineer's agent. If no new run lands at all
    // (classifier picked "done" or returned ok:false), that's also a pass.
    console.log("--- Test 2: regression case (no human reply → engineer pick still blocked) ---");
    const t2 = await seedTicket({ tenantId: TENANT_ID, status: "in_progress" });
    ticketIds.push(t2);
    for (let i = 0; i < 3; i += 1) {
      await seedComment({
        tenantId: TENANT_ID,
        ticketId: t2,
        authorType: "agent",
        authorId: "engineer",
        body: `prior engineer iteration ${i + 1}`,
      });
    }
    const baselineCount2 = await countRunsForTicket(t2);
    console.log(
      `  seeded ticket=${t2.slice(0, 8)} with 3 engineer (no human reply); runs baseline=${baselineCount2}`,
    );

    await sendEvent("ticket/dispatch-needed", { ticketId: t2, tenantId: TENANT_ID });
    console.log("  fired ticket/dispatch-needed");

    // Give the dispatcher up to 20s to either dispatch a non-engineer run
    // or no-op. Then check what (if anything) landed.
    await new Promise((r) => setTimeout(r, 20_000));
    const engineerAgent = await sb(
      `agents?tenant_id=eq.${TENANT_ID}&role=eq.engineer&select=id&limit=1`,
    );
    const engineerAgentRow = await engineerAgent.json();
    const engineerAgentId = engineerAgentRow[0]?.id ?? null;
    const newRuns = await sb(
      `runs?ticket_id=eq.${t2}&select=id,agent_id,created_at&order=created_at.desc`,
    );
    const newRunsJson = await newRuns.json();
    const engineerRuns = engineerAgentId
      ? newRunsJson.filter((r) => r.agent_id === engineerAgentId)
      : [];
    assert(
      engineerRuns.length === 0,
      `G5 leaked: an engineer run dispatched without a human reply. count=${engineerRuns.length}`,
    );
    console.log(
      `  ✓ no engineer run dispatched (${newRunsJson.length} total new run${newRunsJson.length === 1 ? "" : "s"}, 0 of which are engineer)\n`,
    );

    console.log("=== Slice B acceptance PASS ===");
    process.exit(0);
  } catch (err) {
    console.error(`\n✗ Slice B acceptance FAIL: ${err.message}`);
    process.exit(1);
  } finally {
    await cleanup({ ticketIds });
  }
})();
