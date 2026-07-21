// Phase 1 / M5 acceptance — JD-to-role synthesizer end-to-end.
//
// What this proves
// ────────────────
// 1. A custom role inserted into `agents` with `config.role_config` resolves
//    through `lib/roles/load.ts::loadRoleConfig` at dispatch time.
// 2. The dispatcher honors `tickets.requested_role` for the custom slug
//    (NOT in the built-in ROLES map) once an agents row exists.
// 3. The runAgent + postprocess path produces a tagged comment under the
//    role's `displayName` AND advances the ticket past `ready`.
// 4. Idempotent cleanup leaves the tenant in its pre-test state.
//
// We don't invoke the synthesizer action (Sonnet generateObject) from this
// script — it's a UI surface, tested manually, and would cost ~5¢ per run
// for no signal beyond "Anthropic responded with JSON". We insert the row
// directly, with a system prompt that exercises the same tool-driven
// contract (devpilot_comment + devpilot_move_ticket) that the synthesizer would emit.
//
// Pre-reqs: Next.js dev :3000, Inngest dev :8288, apps/runner running (the
// role's runnerPolicy is local-cc so the Claude Code worker drives it).
// Run: node --env-file=.env.local scripts/phase1-m5-accept.mjs

import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const INNGEST_DEV = "http://localhost:8288";
const TENANT_ID = "e98507ec-d5a2-4951-8a5d-445c86dbfca8";
const SLUG = "loc_reviewer";
const DISPLAY_NAME = "Localization Reviewer";
const TIMEOUT_MS = 8 * 60_000;

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

const SYSTEM_PROMPT =
  "You are a senior localization reviewer auditing UI string changes for " +
  "translation quality. The ticket UUID is provided in the user message as " +
  "`ticketId`. Read the ticket title / description; identify any strings that " +
  "will translate badly (idioms, contractions, hard-coded plurals, missing " +
  "ICU placeholders) and recommend wording that is easier for translators.\n\n" +
  "OUTPUT CONTRACT — you MUST do BOTH of these via MCP tool calls:\n" +
  "  1. Call `devpilot_comment` with `ticketId` and a `body` containing a short " +
  "review with bullet points: 'Findings', 'Suggested rewording', 'Glossary " +
  "matches'. Keep it under 200 words.\n" +
  '  2. Then call `devpilot_move_ticket` with `ticketId`, `status: "in_review"`, ' +
  'and a one-line `reason` summarising the review (e.g. "Reviewed 3 strings; ' +
  '2 idioms flagged").\n\n' +
  "Do not paste verdict text into your assistant message. The tool calls are " +
  "the binding action.";

async function findCustomAgent() {
  const r = await sb(`agents?tenant_id=eq.${TENANT_ID}&role=eq.${SLUG}&select=id,config`);
  const rows = await r.json();
  return rows[0] ?? null;
}

async function createCustomAgent() {
  const id = randomUUID();
  const r = await sb("agents", {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: TENANT_ID,
      name: DISPLAY_NAME,
      role: SLUG,
      config: {
        source: "m5-accept-script",
        role_config: {
          displayName: DISPLAY_NAME,
          systemPrompt: SYSTEM_PROMPT,
          modelTier: "default",
          runnerPolicy: "local-cc",
          onSuccessStatus: "in_review",
        },
      },
    }),
  });
  if (!r.ok) throw new Error(`create custom agent failed: ${r.status} ${await r.text()}`);
  return id;
}

async function createTicket() {
  const id = randomUUID();
  const r = await sb("tickets", {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: TENANT_ID,
      title: "Audit new sign-up CTA strings for translation",
      description:
        "We added three new strings to the sign-up flow: " +
        '1) "Let\'s get you set up" — likely idiom, ' +
        '2) "%d users joined this week" — hard-coded plural, ' +
        '3) "Try DevPilot — it\'s wild" — informal. ' +
        "Review each and suggest translation-friendly rewording.",
      status: "ready",
      requested_role: SLUG,
      priority: 3,
    }),
  });
  if (!r.ok) throw new Error(`create ticket failed: ${r.status} ${await r.text()}`);
  return id;
}

async function getTicket(id) {
  const r = await sb(`tickets?id=eq.${id}&select=status,retry_count`);
  return (await r.json())[0] ?? null;
}

async function getComments(id) {
  const r = await sb(
    `comments?ticket_id=eq.${id}&select=author_type,author_id,body,created_at&order=created_at.asc`,
  );
  return r.json();
}

async function getRuns(ticketId) {
  const r = await sb(
    `runs?ticket_id=eq.${ticketId}&select=id,status,agent_id&order=created_at.desc&limit=3`,
  );
  return r.json();
}

(async () => {
  console.log("=== Phase 1 / M5 acceptance — JD-to-role custom role dispatch ===\n");

  // Idempotent setup: re-use the row if a prior run left it behind.
  let agentId;
  const existing = await findCustomAgent();
  let createdAgentRow = false;
  if (existing) {
    agentId = existing.id;
    console.log(`  reusing existing ${SLUG} agent=${agentId}`);
  } else {
    agentId = await createCustomAgent();
    createdAgentRow = true;
    console.log(`  created ${SLUG} agent=${agentId}`);
  }

  const ticketId = await createTicket();
  console.log(`  filed ticket=${ticketId} requested_role=${SLUG}`);

  await sendEvent("ticket/dispatch-needed", { ticketId, tenantId: TENANT_ID });

  const start = Date.now();
  let advanced = false;
  let commented = false;
  let lastTag = "";
  let lastRunStatus = null;

  while (Date.now() - start < TIMEOUT_MS) {
    const t = await getTicket(ticketId);
    if (!t) throw new Error("ticket vanished");
    const tag = `${t.status} retries=${t.retry_count}`;
    if (tag !== lastTag) {
      console.log(`  → ${tag}  (t+${Math.round((Date.now() - start) / 1000)}s)`);
      lastTag = tag;
    }
    if (!advanced && t.status !== "ready" && t.status !== "backlog") advanced = true;
    if (!commented) {
      const comments = await getComments(ticketId);
      commented = comments.some(
        (c) =>
          c.author_type === "agent" &&
          (c.author_id === DISPLAY_NAME || c.author_id.toLowerCase().includes("localization")),
      );
    }
    const runs = await getRuns(ticketId);
    lastRunStatus = runs[0]?.status ?? null;

    if (commented && advanced) {
      if (lastRunStatus === "done" || lastRunStatus === "failed") break;
    }
    if (t.status === "done" || t.status === "failed") break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  const finalTicket = await getTicket(ticketId);
  const finalComments = await getComments(ticketId);
  const finalRuns = await getRuns(ticketId);
  const authors = Array.from(
    new Set(finalComments.filter((c) => c.author_type === "agent").map((c) => c.author_id)),
  );

  const pass = advanced && commented;
  console.log(
    `\n  ${pass ? "✅ PASS" : "❌ FAIL"} ` +
      `advanced=${advanced} commented=${commented} ` +
      `finalStatus=${finalTicket?.status} runStatus=${lastRunStatus} ` +
      `agentRoleOnRun=${finalRuns[0]?.agent_id?.slice(0, 8) ?? "null"} ` +
      `commentAuthors=[${authors.join(", ")}]`,
  );

  // Cleanup.
  await sb(`tickets?id=eq.${ticketId}`, { method: "DELETE" });
  if (createdAgentRow) {
    await sb(`agents?id=eq.${agentId}`, { method: "DELETE" });
    console.log(`  cleanup: deleted ticket + custom agent row`);
  } else {
    console.log(`  cleanup: deleted ticket (left pre-existing ${SLUG} agent intact)`);
  }

  if (!pass) process.exit(1);
})();
