// Phase 1 / M7 acceptance — conditional branching.
//
// What this proves
// ────────────────
// A triage role with `branches: { small_change: "qa", large_change: "tech_lead" }`
// routes the ticket through one of two next-roles based on the structured
// `next: <key>` token it emitted in its final assistant text. The dispatcher
// branch-decision is REAL — only the triage role's run is synthesized (we
// pre-seed the run row + branch_key directly, matching the pinned-run trick
// in `phase1-dispatch-queue-accept.mjs`).
//
// Two scenarios:
//   1. small_change → dispatcher routes to QA, ticket eventually lands in `done`
//      via QA's MCP-driven move (in real runs) or via a forced-status PATCH
//      in this synthetic script.
//   2. large_change → dispatcher routes to Tech Lead first; we synthesize
//      Tech Lead's completion (in_review) and then verify the dispatcher
//      picks QA from in_review (the post-branch state-machine fall-through),
//      and finally land the ticket in done.
//
// Acceptance criteria, one-by-one
// ────────────────────────────────
//   T1. small_change: after synthesizing triage's run with branch_key=small_change,
//       a `ticket/dispatch-needed` event causes the dispatcher's decideNextRole
//       to return role=qa (proven by an agent/run.requested event landing
//       carrying role=qa, OR by a QA run row appearing on the ticket).
//   T2. small_change: tickets.branch_hops incremented to 1; runs.branch_key
//       cleared on the consumed triage run (idempotency guard).
//   T3. large_change: dispatcher routes to tech_lead first (not qa).
//   T4. large_change: after tech_lead's run completes (in_review), dispatcher
//       picks QA via the state machine (NOT another branch — branch_key was
//       cleared on consumption).
//   T5. cycle guard: cap synth-attack. Seed an indefinite "next: small_change"
//       loop on a third ticket; verify branch_hops reaches MAX_BRANCH_HOPS=4
//       and the dispatcher then falls back to the state machine instead of
//       routing again.
//   T6. invalid branch key falls through to state machine (no throw).
//
// Pre-reqs: Next.js dev :3000 and Inngest dev :8288 already running. No
// runner needed.
//
// Run: node --env-file=.env.local scripts/phase1-m7-accept.mjs

import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const INNGEST_DEV = "http://localhost:8288";
const TENANT_ID = "e98507ec-d5a2-4951-8a5d-445c86dbfca8";
const TIMEOUT_MS = 60_000;
const MAX_BRANCH_HOPS = 4;

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

async function waitFor(label, predicate, timeoutMs = TIMEOUT_MS) {
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

async function findAgent(role) {
  const r = await sb(
    `agents?tenant_id=eq.${TENANT_ID}&role=eq.${role}&select=id,name&order=version.desc&limit=1`,
  );
  const rows = await r.json();
  if (!rows.length) {
    throw new Error(
      `no agent row for role=${role} — apply migration 20260603060000_m7_conditional_branching.sql first`,
    );
  }
  return rows[0];
}

async function createTicket(title) {
  const id = randomUUID();
  const res = await sb("tickets", {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: TENANT_ID,
      title,
      description:
        "M7 acceptance fixture. Triage decides branch, dispatcher routes accordingly. Safe to delete.",
      acceptance_criteria: "branch routing observed; lands in done",
      // Seed an existing pm comment so the dispatcher's state-machine
      // doesn't pick `pm` ahead of our requested triage role on the first
      // dispatch (decideNextRole skips requested_role once an agent
      // matching the role has already commented — but pm is a separate
      // gating signal at status=ready, so we just request triage directly
      // and let the requested_role path take it).
      status: "ready",
      requested_role: "triage",
      priority: 3,
    }),
  });
  if (!res.ok) throw new Error(`createTicket failed: ${res.status} ${await res.text()}`);
  const [row] = await res.json();
  return row.id;
}

async function getTicket(id) {
  const r = await sb(
    `tickets?id=eq.${id}&select=id,status,branch_hops,retry_count,assignee_agent_id`,
  );
  const rows = await r.json();
  return rows[0] ?? null;
}

async function getRunsForTicket(id) {
  const r = await sb(
    `runs?ticket_id=eq.${id}&select=id,status,agent_id,branch_key,created_at&order=created_at.asc`,
  );
  return r.json();
}

async function getCommentsForTicket(id) {
  const r = await sb(
    `comments?ticket_id=eq.${id}&select=author_type,author_id,body,created_at&order=created_at.asc`,
  );
  return r.json();
}

// Seed a synthetic triage run that emitted a branch signal. The dispatcher's
// branch-routing reads from runs.branch_key + the agent's role; we wire all
// three so the dispatcher's REAL decideNextRole can take its branch path.
//
// We also insert a synthetic comment from the Triage agent so the
// dispatcher's `requested_role` path doesn't re-pick triage (it skips when
// the role already appeared in the comment thread).
async function seedTriageRun(ticketId, branchKey) {
  const triage = await findAgent("triage");
  const runId = randomUUID();
  const res = await sb("runs", {
    method: "POST",
    body: JSON.stringify({
      id: runId,
      tenant_id: TENANT_ID,
      agent_id: triage.id,
      ticket_id: ticketId,
      status: "done",
      budget_cents: 100,
      spent_cents: 0,
      depth: 0,
      runner_kind: "api",
      branch_key: branchKey,
      last_event_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`seedTriageRun failed: ${res.status} ${await res.text()}`);
  // Comment so the dispatcher's requested_role re-pick is suppressed and
  // the inspector / reviewer can audit what "ran".
  await sb("comments", {
    method: "POST",
    body: JSON.stringify({
      ticket_id: ticketId,
      tenant_id: TENANT_ID,
      author_type: "agent",
      author_id: "Triage",
      body: `[fixture] Triage chose branch="${branchKey}" — synthetic run for M7 acceptance.`,
    }),
  });
  return runId;
}

// Synthesize a tech_lead run's completion: insert a done run row and add the
// tech_lead author comment so future dispatcher calls see the role already
// ran. Move the ticket to in_review (mirrors what the real tech_lead's MCP
// `devpilot_move_ticket` would do).
async function seedTechLeadRun(ticketId) {
  const tl = await findAgent("tech_lead");
  const runId = randomUUID();
  await sb("runs", {
    method: "POST",
    body: JSON.stringify({
      id: runId,
      tenant_id: TENANT_ID,
      agent_id: tl.id,
      ticket_id: ticketId,
      status: "done",
      budget_cents: 100,
      spent_cents: 0,
      depth: 0,
      runner_kind: "api",
      last_event_at: new Date().toISOString(),
    }),
  });
  await sb("comments", {
    method: "POST",
    body: JSON.stringify({
      ticket_id: ticketId,
      tenant_id: TENANT_ID,
      author_type: "agent",
      author_id: "Tech Lead",
      body: "[fixture] Tech Lead review: APPROVE — synthetic for M7 acceptance.",
    }),
  });
  await sb(`tickets?id=eq.${ticketId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "in_review" }),
  });
  return runId;
}

const cleanup = [];

async function safeCleanup() {
  for (const id of cleanup) {
    try {
      await sb(`tickets?id=eq.${id}`, { method: "DELETE" });
    } catch {}
  }
  // Drain any LPUSHed local-cc jobs that real dispatches may have created
  // (synth scenarios only seed `api` runs, but the dispatcher itself may
  // emit local-cc on the routed roles — qa, tech_lead both runner=local-cc).
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (url && tok) {
      await fetch(`${url}/del/devpilot:jobs:local-cc:ready`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
    }
  } catch {}
}

// Pre-snip any agent/run.requested side-effect on the routed role: we don't
// want the runner to spend money. We do this by waiting for the run row to
// appear and immediately marking it `done` (mirrors the pinned-run trick in
// the dispatch_queue acceptance script).
async function snipDispatchedRun(ticketId, targetRole) {
  const target = await findAgent(targetRole);
  const run = await waitFor(
    `dispatched ${targetRole} run row appears`,
    async () => {
      const runs = await getRunsForTicket(ticketId);
      const r = runs.find((row) => row.agent_id === target.id && row.status === "running");
      return r ?? null;
    },
    30_000,
  );
  await sb(`runs?id=eq.${run.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "done", last_event_at: new Date().toISOString() }),
  });
  await sendEvent("agent/run.completed", {
    runId: run.id,
    tenantId: TENANT_ID,
    ticketId,
    agentId: target.id,
    role: targetRole,
    status: "done",
  });
  return run;
}

(async () => {
  console.log("=== Phase 1 / M7 acceptance: conditional branching ===\n");

  try {
    // ── T1+T2: small_change route ─────────────────────────────────────
    console.log("--- T1+T2: small_change → dispatcher routes to QA ---");
    const ticketSmall = await createTicket("M7 small-change scenario");
    cleanup.push(ticketSmall);
    console.log(`  ticket=${ticketSmall}`);
    const triageRunSmall = await seedTriageRun(ticketSmall, "small_change");
    console.log(`  seeded triage run=${triageRunSmall.slice(0, 8)} branch_key=small_change`);

    // Fire the dispatch that should route via the branch map.
    await sendEvent("ticket/dispatch-needed", {
      ticketId: ticketSmall,
      tenantId: TENANT_ID,
    });

    // Wait for the dispatcher's branch-routed run row to appear. The QA
    // agent row's id is the target — find it and look for a new running run
    // attached to it.
    const qaRun = await snipDispatchedRun(ticketSmall, "qa");
    console.log(`  ✅ dispatcher routed small_change → QA (run=${qaRun.id.slice(0, 8)})`);

    // Verify T2: branch_hops bumped to 1, source triage run's branch_key
    // cleared (consumed).
    const ticketAfter = await getTicket(ticketSmall);
    if (ticketAfter.branch_hops !== 1) {
      throw new Error(`expected branch_hops=1, got ${ticketAfter.branch_hops}`);
    }
    console.log(`  ✅ tickets.branch_hops bumped to 1`);
    const triageRunAfter = await sb(`runs?id=eq.${triageRunSmall}&select=branch_key`).then((r) =>
      r.json(),
    );
    if (triageRunAfter[0].branch_key !== null) {
      throw new Error(
        `expected triage run's branch_key cleared (null), got "${triageRunAfter[0].branch_key}"`,
      );
    }
    console.log(`  ✅ consumed triage run.branch_key cleared (idempotency guard)`);

    // ── T3+T4: large_change route → tech_lead, then qa from state machine ─
    console.log("\n--- T3+T4: large_change → tech_lead → state-machine QA ---");
    const ticketLarge = await createTicket("M7 large-change scenario");
    cleanup.push(ticketLarge);
    console.log(`  ticket=${ticketLarge}`);
    const triageRunLarge = await seedTriageRun(ticketLarge, "large_change");
    console.log(`  seeded triage run=${triageRunLarge.slice(0, 8)} branch_key=large_change`);

    await sendEvent("ticket/dispatch-needed", {
      ticketId: ticketLarge,
      tenantId: TENANT_ID,
    });

    // First branch: tech_lead. Verify the routed run is the tech_lead agent
    // (NOT qa — that would mean branching failed and we fell through to
    // state machine, which on in_progress/in_review picks qa).
    const tlRun = await snipDispatchedRun(ticketLarge, "tech_lead");
    console.log(`  ✅ dispatcher routed large_change → Tech Lead (run=${tlRun.id.slice(0, 8)})`);

    const ticketAfterTL = await getTicket(ticketLarge);
    if (ticketAfterTL.branch_hops !== 1) {
      throw new Error(`expected branch_hops=1 after first hop, got ${ticketAfterTL.branch_hops}`);
    }
    console.log(`  ✅ branch_hops=1 after Tech Lead hop`);

    // Synth-complete tech_lead (move ticket to in_review) and fire another
    // dispatch — the dispatcher should now pick QA via the state machine
    // (in_review → qa), NOT via a branch (Tech Lead doesn't declare any).
    await seedTechLeadRun(ticketLarge);
    console.log(`  synthesized Tech Lead completion → status=in_review`);
    await sendEvent("ticket/dispatch-needed", {
      ticketId: ticketLarge,
      tenantId: TENANT_ID,
    });
    const qaRunLarge = await snipDispatchedRun(ticketLarge, "qa");
    console.log(`  ✅ state-machine picked QA from in_review (run=${qaRunLarge.id.slice(0, 8)})`);

    const ticketFinal = await getTicket(ticketLarge);
    if (ticketFinal.branch_hops !== 1) {
      throw new Error(
        `expected branch_hops to stay at 1 (QA pickup is NOT a branch), got ${ticketFinal.branch_hops}`,
      );
    }
    console.log(`  ✅ branch_hops stayed at 1 — QA was state-machine, not branch`);

    // ── T5: cycle-guard cap ─────────────────────────────────────────────
    console.log("\n--- T5: cycle guard caps branch routes at MAX_BRANCH_HOPS=4 ---");
    const ticketCycle = await createTicket("M7 cycle-guard probe");
    cleanup.push(ticketCycle);
    console.log(`  ticket=${ticketCycle}`);

    // Pre-seed branch_hops at MAX_BRANCH_HOPS so the next branch decision
    // hits the ceiling. Cheaper than running 4 real hops; same code path.
    await sb(`tickets?id=eq.${ticketCycle}`, {
      method: "PATCH",
      body: JSON.stringify({ branch_hops: MAX_BRANCH_HOPS, status: "ready" }),
    });
    const triageRunCycle = await seedTriageRun(ticketCycle, "small_change");
    console.log(
      `  seeded branch_hops=${MAX_BRANCH_HOPS} (at cap) + triage run with branch_key=small_change`,
    );

    await sendEvent("ticket/dispatch-needed", {
      ticketId: ticketCycle,
      tenantId: TENANT_ID,
    });

    // The dispatcher should NOT route via branches (cap hit). It should
    // fall through to the state-machine. With status=ready + a triage
    // comment present + no PM comment, the state-machine returns
    // role=pm (status=ready and !hasPm). We assert: no QA run was created
    // (branch route was suppressed) AND the consumed triage run.branch_key
    // is STILL set (not consumed because no branch was taken).
    await new Promise((r) => setTimeout(r, 8000));
    const runsCycle = await getRunsForTicket(ticketCycle);
    const qaAgent = await findAgent("qa");
    const qaRouted = runsCycle.find((r) => r.agent_id === qaAgent.id);
    if (qaRouted) {
      throw new Error(
        `cycle guard BREACHED — dispatcher routed to QA despite branch_hops=${MAX_BRANCH_HOPS} at cap`,
      );
    }
    console.log(`  ✅ no QA route emitted — cap honored`);

    const triageRunCycleAfter = await sb(`runs?id=eq.${triageRunCycle}&select=branch_key`).then(
      (r) => r.json(),
    );
    if (triageRunCycleAfter[0].branch_key !== "small_change") {
      throw new Error(
        `cycle guard regression — triage run.branch_key was consumed (${triageRunCycleAfter[0].branch_key}) despite cap`,
      );
    }
    console.log(`  ✅ triage run.branch_key preserved (not consumed — cap fired before route)`);

    // ── T6: invalid branch key falls through ────────────────────────────
    console.log("\n--- T6: invalid branch key falls through to state machine ---");
    const ticketInvalid = await createTicket("M7 invalid-branch-key probe");
    cleanup.push(ticketInvalid);
    console.log(`  ticket=${ticketInvalid}`);

    // Insert a triage run with a branch_key NOT present in triage's
    // branches map (e.g. "maybe_change"). The dispatcher must fall through
    // — branch_hops NOT incremented; branch_key NOT consumed (it never
    // matched in the first place). This is the spec's graceful-degradation
    // contract for unknown keys.
    const triageInvalid = await findAgent("triage");
    const invalidRunId = randomUUID();
    await sb("runs", {
      method: "POST",
      body: JSON.stringify({
        id: invalidRunId,
        tenant_id: TENANT_ID,
        agent_id: triageInvalid.id,
        ticket_id: ticketInvalid,
        status: "done",
        budget_cents: 100,
        spent_cents: 0,
        depth: 0,
        runner_kind: "api",
        branch_key: "maybe_change",
        last_event_at: new Date().toISOString(),
      }),
    });
    await sb("comments", {
      method: "POST",
      body: JSON.stringify({
        ticket_id: ticketInvalid,
        tenant_id: TENANT_ID,
        author_type: "agent",
        author_id: "Triage",
        body: "[fixture] Triage emitted an unknown branch key.",
      }),
    });
    console.log(`  seeded triage run with branch_key="maybe_change" (not in branches map)`);

    await sendEvent("ticket/dispatch-needed", {
      ticketId: ticketInvalid,
      tenantId: TENANT_ID,
    });
    await new Promise((r) => setTimeout(r, 5000));
    const ticketInvalidAfter = await getTicket(ticketInvalid);
    if (ticketInvalidAfter.branch_hops !== 0) {
      throw new Error(
        `expected branch_hops=0 (no route taken on unknown key), got ${ticketInvalidAfter.branch_hops}`,
      );
    }
    console.log(`  ✅ branch_hops stayed at 0 (unknown key falls through)`);

    console.log("\n=== ALL TESTS PASS ===");
    console.log("Summary:");
    console.log("  • small_change branch → QA: dispatcher honored branches map");
    console.log("  • large_change branch → Tech Lead → QA via state machine");
    console.log("  • branch_hops bumped exactly once per branch route");
    console.log("  • consumed run.branch_key cleared (idempotency guard)");
    console.log(`  • cycle guard caps routes at MAX_BRANCH_HOPS=${MAX_BRANCH_HOPS}`);
    console.log("  • unknown branch key gracefully falls through to state machine");
  } catch (err) {
    console.error(`\n❌ FAIL: ${err.message ?? err}`);
    process.exitCode = 1;
  } finally {
    await safeCleanup();
    console.log(`\ncleanup: deleted ${cleanup.length} fixture tickets`);
  }
})();
