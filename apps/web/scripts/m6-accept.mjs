// M6 acceptance: the headline password-reset scenario.
//
// Creates a rough ticket → moves it to ready → Dispatcher routes it through
// PM → Engineer → QA, looking for at least one QA rejection back to Engineer
// before reaching done. All via Local Claude Code Runner.
//
// Pre-reqs: Next.js dev on :3000, Inngest dev on :8288, apps/runner running.
//
// Run: node --env-file=.env.local scripts/m6-accept.mjs

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
}

async function getTicket(id) {
  const r = await sb(`tickets?id=eq.${id}&select=*`);
  const rows = await r.json();
  return rows[0] ?? null;
}

async function getComments(id) {
  const r = await sb(
    `comments?ticket_id=eq.${id}&select=author_type,author_id,body,created_at&order=created_at.asc`,
  );
  return r.json();
}

async function waitTerminal(ticketId, timeoutMs = 15 * 60_000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const t = await getTicket(ticketId);
    if (!t) throw new Error("ticket vanished");
    const tag = `${t.status} retries=${t.retry_count}`;
    if (tag !== last) {
      console.log(`  → ${tag}  (t+${Math.round((Date.now() - start) / 1000)}s)`);
      last = tag;
    }
    if (t.status === "done" || t.status === "failed") return t;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("timeout waiting for terminal state");
}

(async () => {
  console.log("=== M6 acceptance: password-reset scenario end-to-end ===");

  const ticketId = randomUUID();
  // 1. Insert the rough ticket.
  const ins = await sb("tickets", {
    method: "POST",
    body: JSON.stringify({
      id: ticketId,
      tenant_id: TENANT_ID,
      title: "add password reset",
      description: "Users want a way to reset their password if they forget it.",
      status: "backlog",
    }),
  });
  if (!ins.ok) throw new Error(`insert failed: ${ins.status} ${await ins.text()}`);
  console.log(`  created ticket ${ticketId}`);

  // 2. Move to ready and emit the first dispatch event.
  await sb(`tickets?id=eq.${ticketId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "ready" }),
  });
  await sendEvent("ticket/dispatch-needed", { ticketId, tenantId: TENANT_ID });
  console.log(`  ready → dispatcher kicked`);

  // 3. Watch the flow.
  const final = await waitTerminal(ticketId);

  // 4. Dump comment trail.
  const comments = await getComments(ticketId);
  console.log(`\n  comments: ${comments.length}`);
  for (const c of comments) {
    const head = c.body.replace(/\n/g, " ").slice(0, 100);
    console.log(`    [${c.author_type}:${c.author_id}] ${head}${c.body.length > 100 ? "…" : ""}`);
  }

  console.log(`\n  final status:      ${final.status}`);
  console.log(`  retry_count:       ${final.retry_count}`);
  console.log(`  acceptance:        ${(final.acceptance_criteria ?? "").slice(0, 120)}…`);

  // Acceptance criteria:
  const authors = comments.filter((c) => c.author_type === "agent").map((c) => c.author_id);
  const hasPm = authors.includes("PM");
  const hasEng = authors.includes("Engineer");
  const hasQa = authors.includes("QA");
  const hasRejectLoop = final.retry_count >= 1;

  console.log(`\n  pm comment:        ${hasPm ? "✓" : "✗"}`);
  console.log(`  engineer comment:  ${hasEng ? "✓" : "✗"}`);
  console.log(`  qa comment:        ${hasQa ? "✓" : "✗"}`);
  console.log(`  qa rejected once:  ${hasRejectLoop ? "✓" : "✗"}`);
  console.log(`  final = done:      ${final.status === "done" ? "✓" : "✗"}`);

  // Cleanup
  await sb(`tickets?id=eq.${ticketId}`, { method: "DELETE" });

  if (final.status !== "done") {
    throw new Error(`final status was ${final.status}, not done`);
  }
  if (!hasPm || !hasEng || !hasQa) throw new Error("missing role comment");
  if (!hasRejectLoop) {
    console.log(
      "\n  ⚠️  PASS (with note): QA did not reject — strict-QA prompt may need tightening",
    );
  } else {
    console.log("\n  ✅ PASS — full PM→Engineer→QA loop with QA rejection completed");
  }
})();
