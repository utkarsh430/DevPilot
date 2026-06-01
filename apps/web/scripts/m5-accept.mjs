// M5 acceptance: PM-like refinement run via the Local Claude Code Runner.
//
// Pre-reqs: Next.js dev on :3000, Inngest dev on :8288, apps/runner worker running.
//
// Run with:
//   node --env-file=.env.local scripts/m5-accept.mjs

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

async function waitDone(runId, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await sb(`runs?id=eq.${runId}&select=status,runner_kind,spent_cents`);
    const rows = await r.json();
    if (rows[0] && (rows[0].status === "done" || rows[0].status === "failed")) return rows[0];
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timeout waiting for run ${runId}`);
}

(async () => {
  console.log("=== M5 acceptance: Local Claude Code Runner end-to-end ===");

  // Sanity: at least one local-cc runner is heartbeating.
  const runnersRes = await sb(
    `runners?tenant_id=eq.${TENANT_ID}&kind=eq.local-cc&select=id,name,status,last_heartbeat_at&order=last_heartbeat_at.desc&limit=3`,
  );
  const runners = await runnersRes.json();
  console.log(`  visible local-cc runners: ${runners.length}`);
  for (const r of runners) console.log(`    - ${r.name} (status=${r.status})`);
  if (runners.length === 0) throw new Error("no local-cc runner registered");

  const runId = randomUUID();
  await sendEvent("agent/run.requested", {
    runId,
    tenantId: TENANT_ID,
    prompt:
      "Rough ticket: 'add password reset'. Turn this into a clear ticket with: a one-line title, " +
      "two sentences of description, and three concrete acceptance criteria as bullet points.",
    systemPrompt:
      "You are a product manager. Refine rough engineering asks into clear, scoped tickets.",
    iterations: 1,
    modelTier: "default",
    runnerPolicy: "local-cc",
    budgetCents: 1000,
  });

  const run = await waitDone(runId);
  console.log(`\n  run.status=${run.status}`);
  console.log(`  run.runner_kind=${run.runner_kind}`);
  console.log(`  run.spent_cents=${run.spent_cents}¢`);

  if (run.status !== "done") throw new Error(`expected done, got ${run.status}`);
  if (run.runner_kind !== "local-cc")
    throw new Error(`expected runner_kind=local-cc, got ${run.runner_kind}`);

  const stepsRes = await sb(
    `run_steps?run_id=eq.${runId}&kind=eq.think&select=payload&order=idx.asc`,
  );
  const steps = await stepsRes.json();
  const payload = steps[0]?.payload ?? {};
  const text = payload.text ?? "";
  console.log(`  model=${payload.model ?? "?"}`);
  console.log(`  runner_kind=${payload.runner_kind}`);
  console.log("\n  ---claude output---\n");
  console.log("  " + text.split("\n").join("\n  "));
  console.log("\n  -------------------");

  if (text.length < 80) throw new Error("output suspiciously short");

  await sb(`runs?id=eq.${runId}`, { method: "DELETE" });
  console.log("\n✅ PASS");
})();
