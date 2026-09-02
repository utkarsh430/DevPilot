// Phase 2.5+ / M7 acceptance — Plan-mode "ultra plan" surface.
//
// REVISION 2026-06-04 — runner-route architecture
// ─────────────────────────────────────────────────
// The plan-mode actions are fire-and-forget event emitters. The actual
// LLM work happens in durable Inngest functions
// (apps/web/lib/plan/inngest.ts) behind the runner bridge
// (apps/web/lib/plan/runner-bridge.ts). The bridge picks:
//
//   • local-cc — when CLAUDE_CODE_OAUTH_TOKEN is set AND at least one
//     runner row for the tenant has heartbeated within the last 2
//     minutes. Mirrors lib/engine/run-agent.ts: LPUSHes a job to the
//     devpilot:jobs:local-cc:ready queue and waits on `runner/step-result`.
//   • api — fallback when no local-cc subscription/runner is reachable.
//     Uses the per-token ApiRunner (apps/web/lib/runners/api.ts) and
//     inserts a single role='system' warning into the chat.
//
// This script polls the DB for the durable functions' side effects
// (assistant messages, session status transitions, proposed tickets)
// rather than awaiting an inline response — actions return immediately.
//
// What this proves
// ────────────────
// 1. `startPlanSessionAction` (via the internal RPC at /api/internal/plan-test):
//    creates a `planning_sessions` row, inserts the operator's opening
//    `planning_messages` row, and emits `plan/lead-reply.requested`. The
//    durable `planLeadReplyFn` persists the Lead's first assistant reply;
//    spent_cents > 0 follows.
// 2. `sendPlanMessageAction` appends a user message and emits the lead
//    event a second time; a fresh Lead reply lands via the function.
// 3. `buildPlanUltraAction` transitions the session from `discussing` →
//    `planning`, emits `plan/build-orchestrator.requested`, and the
//    orchestrator + 3 panels + consolidator drive the session to
//    `planned` with `planning_proposed_tickets` rows.
// 4. `commitPlanAction({mode:"all"})` bulk-inserts `tickets` rows in
//    Backlog with the correct `project_id`. Dependency rows land in
//    `ticket_dependencies` if any depends_on_ordinals were emitted.
// 5. Self-cleans on success OR failure: deletes the session (cascades
//    messages + proposed tickets), the committed tickets + their
//    dependency rows, and the test project.
//
// Transport choice
// ────────────────
// The five server actions live in `apps/web/app/(app)/plan/actions.ts` and
// are gated by `requireUser()` + `requireTenantId()` which both read from
// the Supabase Auth session cookie. A standalone Node script has no such
// session, so directly importing the actions would redirect to /login.
//
// Instead we go through a thin internal POST route at
// `/api/internal/plan-test` (mirrors the `runners/register` runner-key
// pattern: gated by `x-devpilot-runner-key` so anonymous browsers can't hit it).
// The route re-implements the auth-gated wrappers against the service
// client BUT preserves the Inngest event emit + cost-gate + DB paths
// verbatim from the production actions.
//
// Pre-reqs
// ────────
// • Migration `20260603200000_phase2_5_planning_sessions.sql` applied.
// • Migration `20260603210000_phase2_5_planner_runs_link.sql` applied.
// • NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY in apps/web/.env.local.
// • Next dev :3000 running (so /api/internal/plan-test is reachable).
// • Inngest dev running (so the registered plan-mode functions consume
//   the emitted events).
// • Either CLAUDE_CODE_OAUTH_TOKEN + a heartbeating runner (local-cc
//   path) OR ANTHROPIC_API_KEY (api fallback). The script doesn't care
//   which; if both are missing the runner-bridge raises
//   PLANNER_NO_RUNNER and the lead-reply step fails fast.
// • DEVPILOT_RUNNER_REGISTRATION_KEY set (script proves auth header carries
//   the runner key — same trust as runner-register).
// • DEVPILOT_PLAN_SESSION_MAX_CENTS >= 100 (default; the build step needs
//   headroom for 3 panels + consolidator).
//
// Exit codes:
//   0 = pass
//   1 = test failure
//   2 = environment/setup not satisfied
//
// Run:
//   cd apps/web
//   node --env-file=.env.local scripts/phase2-5-plan-session-accept.mjs

import "./_legacy-env.mjs"; // legacy ACE_* env aliases (transitional)
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const RUNNER_KEY = process.env.DEVPILOT_RUNNER_REGISTRATION_KEY;
const ENGINE_URL = process.env.LOCAL_CC_ENGINE_URL ?? "http://localhost:3000";
const TENANT_ID = process.env.DEVPILOT_TEST_TENANT_ID ?? "e98507ec-d5a2-4951-8a5d-445c86dbfca8";
const USER_ID = process.env.DEVPILOT_TEST_USER_ID ?? "00000000-0000-0000-0000-000000000000";
// Default polling timeout used by the catch-all `waitFor` helper. Each
// step that needs a different ceiling passes an explicit timeoutMs.
const TIMEOUT_MS = 60_000;
// Per-step polling timeouts. The plan goes through the runner bridge so
// latency depends on the picked policy (local-cc may queue, api responds
// in seconds). Bumped from the original synchronous shape:
//   - first lead reply: durable function + LLM call → 60s
//   - second lead reply: same as above → 60s
//   - build → planned: 3 panels + consolidator, fan-out via step.invoke
//     → 180s
const LEAD_FIRST_TIMEOUT_MS = 60_000;
const LEAD_SECOND_TIMEOUT_MS = 60_000;
// Bumped from 180s after live measurement: a successful build with 3
// parallel panels + 1 consolidator via `claude -p` on the OAuth
// subscription takes ~9 min end-to-end (panels ~4 min, consolidator
// ~4 min on a 13K-char response). 600s leaves headroom; users on the
// api fallback path will see ~30-60s instead.
const BUILD_TIMEOUT_MS = 600_000;

if (!SUPABASE_URL || !SECRET) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in env — exit 2");
  process.exit(2);
}
if (!RUNNER_KEY) {
  console.error("missing DEVPILOT_RUNNER_REGISTRATION_KEY in env — exit 2");
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

async function planTest(op, payload) {
  const res = await fetch(`${ENGINE_URL}/api/internal/plan-test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-devpilot-runner-key": RUNNER_KEY,
    },
    body: JSON.stringify({ op, tenantId: TENANT_ID, userId: USER_ID, ...payload }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`plan-test ${op}: non-JSON ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`plan-test ${op}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

async function waitFor(label, predicate, timeoutMs = TIMEOUT_MS) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    const val = await predicate();
    last = val;
    if (val) return val;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timeout waiting for: ${label}; lastValue=${JSON.stringify(last).slice(0, 200)}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ─── DB probes ──────────────────────────────────────────────────────────────

async function assertSchema() {
  const probes = [
    "planning_sessions?select=id&limit=1",
    "planning_messages?select=id&limit=1",
    "planning_proposed_tickets?select=id&limit=1",
  ];
  for (const p of probes) {
    const r = await sb(p);
    if (r.status === 400 || r.status === 404) {
      const body = await r.text();
      console.error(
        `T0 schema probe failed for ${p} — apply migration 20260603200000 first. (${r.status} ${body.slice(0, 200)})`,
      );
      process.exit(2);
    }
    if (!r.ok) {
      console.error(`T0 schema probe ${p}: unexpected ${r.status}`);
      process.exit(2);
    }
  }
}

async function getSession(id) {
  const r = await sb(
    `planning_sessions?id=eq.${id}&select=id,status,spent_cents,project_id,goal_summary`,
  );
  const rows = await r.json();
  return rows[0] ?? null;
}

async function getMessages(sessionId) {
  const r = await sb(
    `planning_messages?session_id=eq.${sessionId}&select=id,role,agent_role,content&order=created_at.asc`,
  );
  return r.json();
}

async function getProposedTickets(sessionId) {
  const r = await sb(
    `planning_proposed_tickets?session_id=eq.${sessionId}&select=id,ordinal,title,requested_role,depends_on_ordinals,selected,committed_ticket_id&order=ordinal.asc`,
  );
  return r.json();
}

async function getTickets(ids) {
  if (ids.length === 0) return [];
  const r = await sb(
    `tickets?id=in.(${ids.map((i) => `"${i}"`).join(",")})&select=id,title,status,project_id,requested_role`,
  );
  return r.json();
}

async function ensureProject() {
  const id = randomUUID();
  const r = await sb("projects", {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: TENANT_ID,
      name: "M7-plan-acceptance fixture",
      description: "Auto-created by phase2-5-plan-session-accept.mjs",
    }),
  });
  if (!r.ok) {
    throw new Error(`ensureProject failed: ${r.status} ${await r.text()}`);
  }
  const [row] = await r.json();
  return row.id;
}

// ─── cleanup ────────────────────────────────────────────────────────────────

async function cleanup({ sessionId, projectId, committedTicketIds }) {
  // Order: dependency rows → committed tickets → proposed tickets +
  // messages (cascade via session) → session → project. The migration
  // sets ON DELETE CASCADE from planning_sessions, so dropping the
  // session takes its messages + proposed tickets with it. Committed
  // tickets are independent rows and need an explicit delete.
  try {
    if (committedTicketIds && committedTicketIds.length > 0) {
      const idList = committedTicketIds.map((i) => `"${i}"`).join(",");
      // ticket_dependencies cascades on ticket delete via FK, but be
      // explicit just in case.
      await sb(`ticket_dependencies?ticket_id=in.(${idList})`, { method: "DELETE" });
      await sb(`ticket_dependencies?blocks_ticket_id=in.(${idList})`, { method: "DELETE" });
      await sb(`tickets?id=in.(${idList})`, { method: "DELETE" });
    }
    if (sessionId) {
      await sb(`planning_sessions?id=eq.${sessionId}`, { method: "DELETE" });
    }
    if (projectId) {
      await sb(`projects?id=eq.${projectId}`, { method: "DELETE" });
    }
  } catch (e) {
    console.warn(`cleanup partial failure: ${e?.message ?? e}`);
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

const state = { sessionId: null, projectId: null, committedTicketIds: [] };

(async () => {
  console.log("=== Phase 2.5+ / M7 — Plan-mode session acceptance ===\n");
  console.log(`  engine=${ENGINE_URL} tenant=${TENANT_ID} user=${USER_ID}\n`);

  try {
    // T0 — schema
    console.log("--- T0: schema probe ---");
    await assertSchema();
    console.log("  ✓ planning_sessions, planning_messages, planning_proposed_tickets present");

    // T1 — seed project
    console.log("\n--- T1: create test project ---");
    state.projectId = await ensureProject();
    console.log(`  ✓ project=${state.projectId.slice(0, 8)}`);

    // T2 — startPlanSessionAction
    console.log("\n--- T2: startPlanSessionAction (oss flavor, opening message) ---");
    const startRes = await planTest("start", {
      projectId: state.projectId,
      stackFlavor: "oss",
      stackPreferences: "Postgres OK, no AWS",
      openingMessage: "I want to add Stripe billing to the app",
    });
    assert(startRes.ok, `start returned ok=false: ${startRes.error ?? "no reason"}`);
    state.sessionId = startRes.sessionId;
    console.log(`  ✓ session=${state.sessionId.slice(0, 8)}`);

    // T3 — Lead's first reply persisted; spent > 0
    //
    // After REVISION 2026-06-04 the start action returns immediately after
    // emitting `plan/lead-reply.requested`; the durable `planLeadReplyFn`
    // posts the assistant message via the runner bridge. Poll for up to
    // 60s — local-cc has queueing latency, api fallback is faster.
    console.log("\n--- T3: poll for Lead's first reply + spent_cents > 0 ---");
    const sessionAfterStart = await waitFor(
      "session.spent_cents > 0 and assistant message present",
      async () => {
        const s = await getSession(state.sessionId);
        const m = await getMessages(state.sessionId);
        if (
          s &&
          s.spent_cents > 0 &&
          m.some((x) => x.role === "assistant" && x.agent_role === "lead")
        ) {
          return { s, m };
        }
        return null;
      },
      LEAD_FIRST_TIMEOUT_MS,
    );
    console.log(
      `  ✓ Lead assistant message present, spent_cents=${sessionAfterStart.s.spent_cents}`,
    );

    // T4 — sendPlanMessageAction
    //
    // The send action is also fire-and-forget. Poll until a second Lead
    // assistant message lands (we saw 1 after T3, expect ≥2 here).
    console.log("\n--- T4: sendPlanMessageAction (follow-up message) ---");
    const sendRes = await planTest("send", {
      sessionId: state.sessionId,
      content:
        "Use the M5 metering hook for usage tracking. Use Postgres for storing billing events.",
    });
    assert(sendRes.ok, `send returned ok=false: ${sendRes.error ?? "no reason"}`);
    const afterSend = await waitFor(
      "second Lead assistant reply",
      async () => {
        const m = await getMessages(state.sessionId);
        const replies = m.filter((x) => x.role === "assistant" && x.agent_role === "lead");
        return replies.length >= 2 ? m : null;
      },
      LEAD_SECOND_TIMEOUT_MS,
    );
    const assistantReplies = afterSend.filter(
      (m) => m.role === "assistant" && m.agent_role === "lead",
    );
    console.log(`  ✓ second Lead reply present (total Lead replies=${assistantReplies.length})`);

    // T5 — buildPlanUltraAction
    console.log("\n--- T5: buildPlanUltraAction (ultra panel) ---");
    const buildRes = await planTest("build", { sessionId: state.sessionId });
    assert(buildRes.ok, `build returned ok=false: ${buildRes.error ?? "no reason"}`);

    // T6 — session lands in 'planned' with ≥1 proposed ticket
    //
    // The orchestrator fans out three panels via step.invoke then calls
    // the consolidator. End-to-end this is the slowest step in the
    // script — give it 180s.
    console.log("\n--- T6: poll until session.status='planned' AND proposed tickets > 0 ---");
    const planned = await waitFor(
      "session 'planned' with proposed tickets",
      async () => {
        const s = await getSession(state.sessionId);
        if (!s || s.status !== "planned") return null;
        const p = await getProposedTickets(state.sessionId);
        if (p.length < 1) return null;
        return { s, p };
      },
      BUILD_TIMEOUT_MS,
    );
    console.log(
      `  ✓ status=planned, ${planned.p.length} proposed ticket(s), spent_cents=${planned.s.spent_cents}`,
    );

    // T7 — asserts on proposed tickets
    console.log("\n--- T7: assert proposed ticket shape ---");
    const validRoleSlugs = new Set([
      // Minimal subset we KNOW must accept. Full catalog is enforced server-
      // side via Zod; here we just sanity-check non-empty + non-junk.
      "pm",
      "engineer",
      "qa",
      "tech_lead",
      "security",
      "frontend_engineer",
      "backend_engineer",
      "fullstack_engineer",
      "devops",
      "sre",
      "cloud_engineer",
      "platform_engineer",
      "dba",
      "security_engineer",
      "appsec_engineer",
      "designer",
      "product_designer",
      "product_manager",
      "techwriter",
      "data_scientist",
      "data_analyst",
      "ml_engineer",
      "analytics_engineer",
      "dataeng",
      "staff_engineer",
      "software_architect",
      "ux_designer",
      "ui_designer",
      "ux_researcher",
      "triage",
      "cto",
      "vp_engineering",
      "engineering_manager",
      "technical_product_manager",
      "product_owner",
      "mobile_engineer",
      "qa_automation_engineer",
      "sdet",
      "compliance_grc",
      "sales_account_executive",
      "solutions_engineer",
      "customer_success_manager",
      "implementation_specialist",
      "technical_support_engineer",
      "marketing_manager",
      "project_program_manager",
      "scrum_master",
      "business_analyst",
      "it_admin",
      "project_scaffolder",
    ]);
    const firstNonEmpty = planned.p.find((t) => (t.title ?? "").trim().length > 0);
    assert(firstNonEmpty, "no proposed ticket has a non-empty title");
    assert(
      validRoleSlugs.has(firstNonEmpty.requested_role),
      `first non-empty proposed ticket requested_role='${firstNonEmpty.requested_role}' not in catalog`,
    );
    assert(planned.s.spent_cents > 0, `spent_cents=${planned.s.spent_cents}, expected > 0`);
    console.log(
      `  ✓ first ticket: ordinal=${firstNonEmpty.ordinal} role='${firstNonEmpty.requested_role}' title="${firstNonEmpty.title.slice(0, 60)}…"`,
    );
    console.log(`  ✓ spent_cents=${planned.s.spent_cents} > 0`);

    // T8 — commitPlanAction({mode:"all"})
    console.log("\n--- T8: commitPlanAction({mode:'all'}) ---");
    const commitRes = await planTest("commit", {
      sessionId: state.sessionId,
      mode: "all",
    });
    assert(commitRes.ok, `commit returned ok=false: ${commitRes.error ?? "no reason"}`);
    assert(
      Array.isArray(commitRes.ticketIds) && commitRes.ticketIds.length === planned.p.length,
      `commit ticket count mismatch: returned=${commitRes.ticketIds?.length} expected=${planned.p.length}`,
    );
    state.committedTicketIds = commitRes.ticketIds;
    console.log(`  ✓ committed ${commitRes.ticketIds.length} ticket(s)`);

    // T9 — committed tickets exist with correct project_id and status='backlog'
    console.log("\n--- T9: assert committed tickets exist with project_id + status='backlog' ---");
    const tickets = await getTickets(state.committedTicketIds);
    assert(
      tickets.length === state.committedTicketIds.length,
      `expected ${state.committedTicketIds.length} ticket rows, got ${tickets.length}`,
    );
    for (const t of tickets) {
      assert(t.status === "backlog", `ticket ${t.id} status='${t.status}', expected 'backlog'`);
      assert(
        t.project_id === state.projectId,
        `ticket ${t.id} project_id='${t.project_id}', expected '${state.projectId}'`,
      );
    }
    console.log(
      `  ✓ all ${tickets.length} tickets carry project_id=${state.projectId.slice(0, 8)} and status='backlog'`,
    );

    // T10 — session is committed
    console.log("\n--- T10: session status='committed' ---");
    const finalSession = await getSession(state.sessionId);
    assert(
      finalSession?.status === "committed",
      `session.status='${finalSession?.status}', expected 'committed'`,
    );
    console.log(`  ✓ session.status='committed'`);

    console.log("\n=== ALL TESTS PASS ===");
    console.log(`Summary:`);
    console.log(`  • session created + Lead's first reply persisted, spent_cents > 0`);
    console.log(`  • follow-up Lead reply persisted`);
    console.log(`  • ultra panel produced ${planned.p.length} proposed ticket(s)`);
    console.log(
      `  • commit landed ${tickets.length} tickets in backlog for project ${state.projectId.slice(0, 8)}`,
    );
    console.log(`  • final session.spent_cents=${planned.s.spent_cents}¢`);
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ FAIL: ${err?.stack ?? err?.message ?? err}`);
    process.exit(1);
  } finally {
    console.log("\n--- cleanup ---");
    await cleanup(state);
    console.log(
      `  cleanup: session=${state.sessionId?.slice(0, 8) ?? "n/a"} project=${state.projectId?.slice(0, 8) ?? "n/a"} tickets=${state.committedTicketIds.length}`,
    );
  }
})();
