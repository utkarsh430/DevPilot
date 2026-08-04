// Phase 1 / M9 acceptance — supervision strategies.
//
// Three scenarios:
//   A. restart_n_times:2 — a 0-budget run fails immediately; the supervision
//      handler spawns attempt #1 (also 0-budget → fails); spawns attempt #2
//      (also 0-budget → fails); refuses #3 because the cap is exhausted.
//      Verify: original + 2 children all status=failed, no third child.
//   B. let_it_crash — a 0-budget run fails; NO child is spawned.
//   C. escalate_to_human — a 0-budget run attached to a ticket fails;
//      ticket transitions to input_required with a `supervision` system
//      comment.
//
// Pre-reqs: Next.js dev :3000 + Inngest dev :8288.
// Run: node --env-file=.env.local scripts/phase1-m9-accept.mjs

import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const INNGEST_DEV = "http://localhost:8288";
const TENANT_ID = "e98507ec-d5a2-4951-8a5d-445c86dbfca8";
const TIMEOUT_MS = 90_000;

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
  const r = await fetch(`${INNGEST_DEV}/e/dev`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data }),
  });
  if (!r.ok) throw new Error(`event ${name} failed: ${r.status} ${await r.text()}`);
}

async function insertRun({ runId, ticketId, strategy, budgetCents = 0 }) {
  const res = await sb("runs", {
    method: "POST",
    body: JSON.stringify({
      id: runId,
      tenant_id: TENANT_ID,
      ticket_id: ticketId ?? null,
      agent_id: null,
      parent_run_id: null,
      depth: 0,
      attempt_index: 0,
      status: "running",
      budget_cents: budgetCents,
      spent_cents: 0,
      runner_kind: "api",
      supervision_strategy: strategy,
    }),
  });
  if (!res.ok) throw new Error(`insertRun: ${res.status} ${await res.text()}`);
}

async function getRun(runId) {
  const r = await sb(`runs?id=eq.${runId}&select=*`);
  const rows = await r.json();
  return rows[0] ?? null;
}

async function getChildrenChain(originalRunId) {
  // Walk parent_run_id chain via BFS.
  const all = [];
  let frontier = [originalRunId];
  for (let i = 0; i < 10 && frontier.length > 0; i++) {
    const r = await sb(
      `runs?parent_run_id=in.(${frontier.join(",")})&select=id,parent_run_id,attempt_index,status,supervision_strategy`,
    );
    const rows = await r.json();
    if (rows.length === 0) break;
    all.push(...rows);
    frontier = rows.map((r) => r.id);
  }
  return all;
}

async function waitFor(label, predicate, timeoutMs = TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

async function fireFailedRun({ strategy, ticketId, prompt }) {
  // We fire a run via agent/run.requested. budget=0 → assertCanProceed
  // throws on the first step → Inngest treats the function as failed →
  // runAgentFailed fires → applySupervisionStrategy reads the strategy.
  const runId = randomUUID();
  await insertRun({ runId, ticketId, strategy, budgetCents: 0 });
  await sendEvent("agent/run.requested", {
    runId,
    tenantId: TENANT_ID,
    ticketId: ticketId ?? undefined,
    prompt: prompt ?? "irrelevant — budget=0 guarantees failure",
    iterations: 1,
    modelTier: "cheap",
    budgetCents: 0,
    runnerPolicy: "api",
  });
  return runId;
}

async function testRestart() {
  console.log("\n--- Test A: restart_n_times:2 ---");
  const runId = await fireFailedRun({ strategy: "restart_n_times:2" });
  // Wait for the original + 2 attempts to settle to failed.
  await waitFor("original failed", async () => {
    const r = await getRun(runId);
    return r && r.status === "failed" ? r : null;
  });
  // Wait for the descendant chain to grow to 2 (attempt 1 + attempt 2).
  const chain = await waitFor("2 retries spawned", async () => {
    const c = await getChildrenChain(runId);
    return c.length >= 2 ? c : null;
  });
  // Verify no third attempt — strategy cap is N=2.
  await new Promise((r) => setTimeout(r, 8000));
  const finalChain = await getChildrenChain(runId);
  const attemptIndices = finalChain.map((r) => r.attempt_index).sort();
  console.log(
    `  chain length=${finalChain.length} attempt_indices=${JSON.stringify(attemptIndices)}`,
  );
  if (finalChain.length !== 2) {
    throw new Error(`expected exactly 2 retries, got ${finalChain.length}`);
  }
  if (JSON.stringify(attemptIndices) !== JSON.stringify([1, 2])) {
    throw new Error(`expected attempt_index=[1,2], got ${attemptIndices}`);
  }
  console.log("  ✅ PASS");
  // Cleanup: delete the chain (children first).
  for (const c of finalChain.reverse()) {
    await sb(`runs?id=eq.${c.id}`, { method: "DELETE" });
  }
  await sb(`runs?id=eq.${runId}`, { method: "DELETE" });
}

async function testLetItCrash() {
  console.log("\n--- Test B: let_it_crash ---");
  const runId = await fireFailedRun({ strategy: "let_it_crash" });
  await waitFor("original failed", async () => {
    const r = await getRun(runId);
    return r && r.status === "failed" ? r : null;
  });
  await new Promise((r) => setTimeout(r, 4000));
  const chain = await getChildrenChain(runId);
  console.log(`  chain length=${chain.length}`);
  if (chain.length !== 0) {
    throw new Error(`expected 0 children, got ${chain.length}`);
  }
  console.log("  ✅ PASS");
  await sb(`runs?id=eq.${runId}`, { method: "DELETE" });
}

async function testEscalate() {
  console.log("\n--- Test C: escalate_to_human ---");
  const ticketId = randomUUID();
  const r1 = await sb("tickets", {
    method: "POST",
    body: JSON.stringify({
      id: ticketId,
      tenant_id: TENANT_ID,
      title: "supervision escalate test",
      description: "fixture",
      status: "in_progress",
    }),
  });
  if (!r1.ok) throw new Error(`ticket insert: ${r1.status}`);

  const runId = await fireFailedRun({
    strategy: "escalate_to_human",
    ticketId,
  });

  await waitFor("original failed", async () => {
    const r = await getRun(runId);
    return r && r.status === "failed" ? r : null;
  });
  // The supervision branch transitions the ticket → input_required and
  // writes a system comment from author_id='supervision'.
  const ticket = await waitFor("ticket → input_required", async () => {
    const r = await sb(`tickets?id=eq.${ticketId}&select=status`);
    const rows = await r.json();
    return rows[0]?.status === "input_required" ? rows[0] : null;
  });
  const commentsRes = await sb(
    `comments?ticket_id=eq.${ticketId}&author_id=eq.supervision&select=body`,
  );
  const comments = await commentsRes.json();
  console.log(`  ticket status=${ticket.status}  supervision-comments=${comments.length}`);
  if (comments.length === 0) {
    throw new Error("no supervision-authored comment found");
  }
  console.log("  ✅ PASS");
  // Cleanup.
  await sb(`tickets?id=eq.${ticketId}`, { method: "DELETE" });
  await sb(`runs?id=eq.${runId}`, { method: "DELETE" });
}

(async () => {
  console.log("=== Phase 1 / M9 acceptance — supervision strategies ===");
  try {
    await testRestart();
    await testLetItCrash();
    await testEscalate();
    console.log("\n=== ALL TESTS PASS ===");
  } catch (err) {
    console.error(`\n❌ FAIL: ${err.message ?? err}`);
    process.exit(1);
  }
})();
