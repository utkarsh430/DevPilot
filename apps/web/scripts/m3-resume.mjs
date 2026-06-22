// M3 resume test — send a 3-iteration run, wait for the first step to
// checkpoint, then orchestrator (shell wrapper) kills Next.js mid-flight.
// This script just sends the event and prints the runId; the orchestrator
// monitors run_steps row count.

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

const cmd = process.argv[2];

async function send() {
  const runId = randomUUID();
  const res = await fetch(`${INNGEST_DEV}/e/dev`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "agent/run.requested",
      data: {
        runId,
        tenantId: TENANT_ID,
        prompt: "Write one short sentence about durable execution.",
        iterations: 3,
        modelTier: "cheap",
        budgetCents: 500,
      },
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  console.log(runId);
}

async function status(runId) {
  const r = await sb(`runs?id=eq.${runId}&select=status,spent_cents`);
  const rows = await r.json();
  const s = await sb(`run_steps?run_id=eq.${runId}&select=idx,created_at&order=idx.asc`);
  const steps = await s.json();
  console.log(JSON.stringify({ run: rows[0], steps }, null, 2));
}

async function cleanup(runId) {
  await sb(`runs?id=eq.${runId}`, { method: "DELETE" });
  console.log("deleted");
}

if (cmd === "send") await send();
else if (cmd === "status") await status(process.argv[3]);
else if (cmd === "cleanup") await cleanup(process.argv[3]);
else throw new Error("usage: m3-resume.mjs send | status <id> | cleanup <id>");
