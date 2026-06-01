// M4 acceptance: a PM-like refinement run via ApiRunner end-to-end.
//
// Run with:
//   node --env-file=.env.local scripts/m4-accept.mjs

import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const INNGEST_DEV = "http://localhost:8288";
const TENANT_ID = "e98507ec-d5a2-4951-8a5d-445c86dbfca8";

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

async function waitDone(runId, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await sb(`runs?id=eq.${runId}&select=status,runner_kind,spent_cents`);
    const rows = await r.json();
    if (rows[0] && (rows[0].status === "done" || rows[0].status === "failed")) return rows[0];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for run ${runId}`);
}

(async () => {
  console.log("=== M4 acceptance: ApiRunner end-to-end refinement ===");

  const runId = randomUUID();
  await sendEvent("agent/run.requested", {
    runId,
    tenantId: TENANT_ID,
    prompt:
      "Rough ticket: 'add password reset'. Turn this into a clear ticket with: a one-line title, " +
      "two sentences of description, and three concrete acceptance criteria as bullet points.",
    systemPrompt:
      "You are a product manager. Refine rough engineering asks into clear, scoped tickets that " +
      "an engineer can pick up without follow-up questions.",
    iterations: 1,
    modelTier: "cheap",
    runnerPolicy: "api",
    budgetCents: 500,
  });

  const run = await waitDone(runId);
  console.log(`  run.status=${run.status}`);
  console.log(`  run.runner_kind=${run.runner_kind}`);
  console.log(`  run.spent_cents=${run.spent_cents}¢`);

  if (run.status !== "done") throw new Error(`expected done, got ${run.status}`);
  if (run.runner_kind !== "api")
    throw new Error(`expected runner_kind=api, got ${run.runner_kind}`);

  // Read the agent's output back from run_steps to confirm sensible content.
  const stepsRes = await sb(
    `run_steps?run_id=eq.${runId}&kind=eq.think&select=payload&order=idx.asc`,
  );
  const steps = await stepsRes.json();
  const text = steps[0]?.payload?.text ?? "";
  console.log("\n  ---refined ticket---\n");
  console.log("  " + text.split("\n").join("\n  "));
  console.log("\n  --------------------");

  if (text.length < 80) throw new Error("output suspiciously short for a refinement");

  // Cleanup
  await sb(`runs?id=eq.${runId}`, { method: "DELETE" });
  console.log("\n✅ PASS");
})();
