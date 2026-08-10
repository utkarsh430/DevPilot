// Phase 1 / M4 acceptance: each of the four new built-in roles (DevOps,
// Tech Writer, Designer, Data Engineer) picks up a representative ticket
// end-to-end. The ticket's `requested_role` column drives explicit role
// assignment so the scenario doesn't depend on an LLM classifier (the
// plan's Phase-2 piece).
//
// (Phase 0 already had its own m4-accept.mjs covering the ApiRunner — this
// file is the Phase 1 M4 since the milestone numbering restarts each phase.)
//
// Each scenario is considered PASS if:
//   - the requested-role agent posts a comment (proves it picked the ticket up)
//   - the ticket reaches at least `in_review` (proves the role's MCP
//     `devpilot_move_ticket` call landed)
//   - within a generous timeout
//
// Full QA-loop completion to `done` is optional per role; we don't gate the
// script on it because docs/design tickets QA-reviewed by a code-leaning QA
// prompt take longer and add noise to the per-role signal.
//
// Pre-reqs: Next.js dev :3000, Inngest dev :8288, apps/runner running.
// Run: node --env-file=.env.local scripts/phase1-roles-accept.mjs

import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const INNGEST_DEV = "http://localhost:8288";
const TENANT_ID = "e98507ec-d5a2-4951-8a5d-445c86dbfca8";
const PER_ROLE_TIMEOUT_MS = 8 * 60_000;

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

const SCENARIOS = [
  {
    role: "devops",
    title: "Add canary deploy guardrails for the engine",
    description:
      "We deploy the engine to Vercel and need a canary rollout (10%/50%/100%) gated on error rate and p95 latency, with an automatic rollback trigger if either crosses threshold.",
    expectedAgentIds: ["devops", "DevOps", "claude"],
  },
  {
    role: "techwriter",
    title: "Write release notes for DevPilot Phase 1",
    description:
      "Draft public-facing release notes covering supervisor trees (capped), MCP board tools, the new built-in roles, and the cost-velocity circuit breaker. Audience: existing operators upgrading from Phase 0.",
    expectedAgentIds: ["techwriter", "Tech Writer", "claude"],
  },
  {
    role: "designer",
    title: "Spec the Run Inspector's live-step UI for parallel children",
    description:
      "When a Supervisor spawns N children in parallel, the inspector should render a tree with sibling branches updating live. Spec the layout, state matrix, accessibility, interaction notes, and any copy strings.",
    expectedAgentIds: ["designer", "Designer", "claude"],
  },
  {
    role: "dataeng",
    title: "Add a `dispatch_queue` table for Phase 2 WIP release",
    description:
      "Design the schema (with RLS), indexes, and a forward-only migration for a dispatch_queue that releases tickets when an agent's WIP drops below its limit. Include a per-tenant dequeue query and a data-quality check.",
    expectedAgentIds: ["dataeng", "Data Engineer", "claude"],
  },
];

async function runScenario({ role, title, description, expectedAgentIds }) {
  const ticketId = randomUUID();
  console.log(`\n--- role=${role} ticket=${ticketId} ---`);
  console.log(`  title: ${title}`);

  const ins = await sb("tickets", {
    method: "POST",
    body: JSON.stringify({
      id: ticketId,
      tenant_id: TENANT_ID,
      title,
      description,
      status: "backlog",
      requested_role: role,
    }),
  });
  if (!ins.ok) throw new Error(`insert failed: ${ins.status} ${await ins.text()}`);

  await sb(`tickets?id=eq.${ticketId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "ready" }),
  });
  await sendEvent("ticket/dispatch-needed", { ticketId, tenantId: TENANT_ID });

  const start = Date.now();
  let last = "";
  let advanced = false;
  let commented = false;
  // Pass criteria fires as soon as both signals are present. We then keep
  // polling — but for *run terminality*, not pass — so we don't delete the
  // ticket while claude's tool-use loop or runAgent's role-post step is
  // still mid-flight (the original cleanup raced both and left orphan runs
  // in `running` plus 404s in claude's logs).
  while (Date.now() - start < PER_ROLE_TIMEOUT_MS) {
    const t = await getTicket(ticketId);
    if (!t) throw new Error("ticket vanished");
    const tag = `${t.status} retries=${t.retry_count}`;
    if (tag !== last) {
      console.log(`  → ${tag}  (t+${Math.round((Date.now() - start) / 1000)}s)`);
      last = tag;
    }
    if (!advanced && t.status !== "backlog" && t.status !== "ready") advanced = true;
    if (!commented) {
      const comments = await getComments(ticketId);
      commented = comments.some(
        (c) => c.author_type === "agent" && expectedAgentIds.includes(c.author_id),
      );
    }
    if (commented && advanced) {
      // Pass criteria met. Wait for the role's run to settle (done/failed)
      // before cleanup so we don't race claude or runAgent.
      const runsRes = await sb(
        `runs?ticket_id=eq.${ticketId}&order=created_at.desc&limit=1&select=status`,
      );
      const runs = await runsRes.json();
      const runStatus = runs[0]?.status;
      if (runStatus === "done" || runStatus === "failed") break;
    }
    if (t.status === "done" || t.status === "failed") break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  const final = await getTicket(ticketId);
  const comments = await getComments(ticketId);
  const pass = advanced && commented;

  console.log(
    `  ${pass ? "✅" : "⚠️"} ` +
      `advanced=${advanced} commented=${commented} ` +
      `finalStatus=${final.status} ` +
      `authors=[${Array.from(
        new Set(comments.filter((c) => c.author_type === "agent").map((c) => c.author_id)),
      ).join(", ")}]`,
  );

  // Cleanup: delete the ticket so its runs/comments cascade out. Safe now
  // that the run has settled (or the loop timed out).
  await sb(`tickets?id=eq.${ticketId}`, { method: "DELETE" });
  return { role, pass, finalStatus: final.status };
}

(async () => {
  console.log("=== Phase 1 / M4 acceptance: four new built-in roles ===");
  const results = [];
  for (const s of SCENARIOS) {
    try {
      results.push(await runScenario(s));
    } catch (err) {
      console.error(`  ❌ role=${s.role} threw: ${err.message ?? err}`);
      results.push({ role: s.role, pass: false, error: String(err.message ?? err) });
    }
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(`  ${r.pass ? "✅" : "❌"} ${r.role} (status=${r.finalStatus ?? "n/a"})`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} roles passed`);
  if (passed < results.length) process.exit(1);
})();
