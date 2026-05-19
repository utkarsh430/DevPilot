// M3 acceptance harness.
//
// 1. Low-budget run halts at status=failed.
// 2. Normal-budget multi-iteration run completes at status=done.
// (Mid-flight resume is verified manually — separate steps below.)
//
// Run with:
//   node --env-file=.env.local scripts/m3-accept.mjs

import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const INNGEST_DEV = "http://localhost:8288";
const TENANT_ID = "e98507ec-d5a2-4951-8a5d-445c86dbfca8"; // primary user tenant

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
  if (!res.ok) throw new Error(`event send failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getRun(runId) {
  const r = await sb(`runs?id=eq.${runId}&select=id,status,spent_cents,budget_cents`);
  const rows = await r.json();
  return rows[0] ?? null;
}

async function countSteps(runId) {
  const r = await sb(`run_steps?run_id=eq.${runId}&select=id&limit=100`);
  const rows = await r.json();
  return rows.length;
}

async function waitForStatus(runId, predicate, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = await getRun(runId);
    if (run && predicate(run)) return run;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for run ${runId}`);
}

// ---------- Test A: low-budget run halts ----------
async function testA_lowBudget() {
  console.log("\n=== Test A: low-budget (0¢) → failed ===");
  const runId = randomUUID();
  await sendEvent("agent/run.requested", {
    runId,
    tenantId: TENANT_ID,
    prompt: "Reply with one word: OK.",
    iterations: 1,
    modelTier: "cheap",
    budgetCents: 0,
  });
  const run = await waitForStatus(runId, (r) => r.status === "failed" || r.status === "done");
  console.log(`  run.status=${run.status}  spent=${run.spent_cents}¢  budget=${run.budget_cents}¢`);
  const steps = await countSteps(runId);
  console.log(`  steps written: ${steps}`);
  if (run.status !== "failed") throw new Error(`expected failed, got ${run.status}`);
  console.log("  ✅ PASS");
  return runId;
}

// ---------- Test B: normal budget, 2 iters → done ----------
async function testB_completes() {
  console.log("\n=== Test B: normal budget, 2 iterations → done ===");
  const runId = randomUUID();
  await sendEvent("agent/run.requested", {
    runId,
    tenantId: TENANT_ID,
    prompt: "Write one short sentence about Alan Turing.",
    iterations: 2,
    modelTier: "cheap",
    budgetCents: 500,
  });
  const run = await waitForStatus(runId, (r) => r.status === "done" || r.status === "failed");
  console.log(`  run.status=${run.status}  spent=${run.spent_cents}¢  budget=${run.budget_cents}¢`);
  const steps = await countSteps(runId);
  console.log(`  steps written: ${steps}`);
  if (run.status !== "done") throw new Error(`expected done, got ${run.status}`);
  if (steps !== 2) throw new Error(`expected 2 think steps, got ${steps}`);
  console.log("  ✅ PASS");
  return runId;
}

(async () => {
  const ids = [];
  try {
    ids.push(await testA_lowBudget());
    ids.push(await testB_completes());
  } finally {
    // Clean test runs (cascade kills run_steps).
    for (const id of ids) {
      await sb(`runs?id=eq.${id}`, { method: "DELETE" });
    }
    console.log("\ncleanup: deleted", ids.length, "test runs");
  }
})();
