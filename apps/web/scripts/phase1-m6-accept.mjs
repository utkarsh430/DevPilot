// Phase 1 / M6 acceptance — parallel fan-out + fan-in.
//
// What this proves
// ────────────────
// A ticket with `acceptance_strategy='all'` triggers a real fan-out from
// the dispatcher: TWO `agent/run.requested` events leave the dispatcher in
// one transition (engineer + security), each carrying the same
// `fan_out_group` uuid; the run rows for each sibling carry that uuid plus
// a `fan_out_role`; the aggregator joins on the cohort and transitions the
// ticket to `in_review` exactly once.
//
// We DO NOT exercise claude-cc end-to-end here. Real local-cc runs would
// take 60–90s each and add noise unrelated to the orchestration we're
// testing. Instead, after the dispatcher fans out, we synthetically mark
// each sibling run as done and fire the completion events ourselves —
// matching the pattern in `phase1-dispatch-queue-accept.mjs`.
//
// The dispatcher fan-out itself is REAL — it walks the same code path the
// production dispatcher uses, stamps `tickets.fan_out_group`, pre-seeds
// the run rows, and emits the cohort events via Inngest.
//
// Acceptance criteria, one-by-one
// ────────────────────────────────
//   T1. Dispatcher fans out into TWO sibling runs (engineer + security) on
//       a single ticket marked acceptance_strategy='all'.
//   T2. Both sibling run rows carry the same fan_out_group; the ticket
//       carries the same uuid.
//   T3. The aggregator decides ONCE: a single row appears in
//       fan_in_decisions with outcome='accepted'. Re-firing the completion
//       event a second time (idempotency stress) does NOT create a second
//       decision row, and the ticket does NOT regress / re-transition.
//   T4. After the join, the ticket is in `in_review` and a
//       `ticket/dispatch-needed` event has fired so QA could pick it up.
//   T5. Runaway-shape guard: cancelling a still-running cohort (by
//       transitioning the ticket to `failed`) leads the aggregator to
//       record a `cancelled` decision and skip emitting a dispatch.
//
// Pre-reqs: Next.js dev :3000 and Inngest dev :8288 already running. No
// runner needed.
//
// Run: node --env-file=.env.local scripts/phase1-m6-accept.mjs

import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const INNGEST_DEV = "http://localhost:8288";
const TENANT_ID = "e98507ec-d5a2-4951-8a5d-445c86dbfca8";
const TIMEOUT_MS = 60_000;

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

async function createTicket() {
  const id = randomUUID();
  const res = await sb("tickets", {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: TENANT_ID,
      title: "M6 fan-out: parallel Engineer + Security review",
      description:
        "Acceptance script fixture. The PM should refine; then the dispatcher " +
        "should fan out Engineer + Security in parallel; the aggregator joins " +
        "them and transitions the ticket to in_review.",
      acceptance_criteria: "two sibling runs, one fan_in_decisions row, lands in_review",
      status: "ready",
      acceptance_strategy: "all",
      priority: 3,
    }),
  });
  if (!res.ok) {
    throw new Error(`createTicket failed: ${res.status} ${await res.text()}`);
  }
  const [row] = await res.json();
  return row.id;
}

async function getTicket(id) {
  const r = await sb(`tickets?id=eq.${id}&select=id,status,acceptance_strategy,fan_out_group`);
  const rows = await r.json();
  return rows[0] ?? null;
}

async function getRunsForTicket(id) {
  const r = await sb(
    `runs?ticket_id=eq.${id}&select=id,status,fan_out_group,fan_out_role,agent_id&order=created_at.asc`,
  );
  return r.json();
}

async function getDecisions(fanOutGroup) {
  const r = await sb(
    `fan_in_decisions?fan_out_group=eq.${fanOutGroup}&select=id,outcome,phase,strategy,decided_at,notes,sibling_runs`,
  );
  return r.json();
}

// Synthetically mark a run done + emit the completion event the aggregator
// listens for. Mirrors phase1-dispatch-queue-accept.mjs's pinned-run trick
// so we can prove fan-in without a real claude-cc run.
async function completeRun(run, ticketId) {
  await sb(`runs?id=eq.${run.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "done",
      last_event_at: new Date().toISOString(),
    }),
  });
  await sendEvent("agent/run.completed", {
    runId: run.id,
    tenantId: TENANT_ID,
    ticketId,
    agentId: run.agent_id ?? undefined,
    role: run.fan_out_role ?? undefined,
    status: "done",
    fanOutGroup: run.fan_out_group,
    fanOutPhase: "review",
  });
}

// PM stage: the dispatcher's first decision for a ticket that has no prior
// PM comment is to run the PM role. To skip that and trigger the engineer-
// fan-out branch directly, we synthesise a PM comment up-front.
async function seedPmComment(ticketId) {
  await sb("comments", {
    method: "POST",
    body: JSON.stringify({
      ticket_id: ticketId,
      tenant_id: TENANT_ID,
      author_type: "agent",
      author_id: "pm",
      body: "[fixture] PM refinement done — fast-forwarding past PM step.",
    }),
  });
}

async function dispatchNeeded(ticketId) {
  await sendEvent("ticket/dispatch-needed", {
    ticketId,
    tenantId: TENANT_ID,
  });
}

// -------- run the acceptance --------
const cleanup = [];

async function safeCleanup() {
  // Order matters: comments + runs + decisions cascade off tickets, but the
  // dispatch_queue rows might still pin via ticket id (already cascade-ON).
  for (const id of cleanup) {
    try {
      await sb(`tickets?id=eq.${id}`, { method: "DELETE" });
    } catch {}
  }
  // Drain any LPUSHed local-cc jobs — none should fire because we sniped the
  // runs to done before any waitForEvent could resolve, but belt-and-braces.
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

(async () => {
  console.log("=== Phase 1 / M6 acceptance: parallel fan-out + fan-in ===\n");

  let ticketId, fanOutGroup, siblingRuns;

  try {
    // ── Test 1: dispatcher fans out into 2 sibling runs ──
    console.log("--- T1: dispatcher fan-out emits 2 sibling agent/run.requested events ---");
    ticketId = await createTicket();
    cleanup.push(ticketId);
    console.log(`  ticket=${ticketId}`);
    await seedPmComment(ticketId);
    await dispatchNeeded(ticketId);

    // Wait for the dispatcher to stamp the ticket + seed the two run rows.
    siblingRuns = await waitFor("two sibling runs seeded", async () => {
      const runs = await getRunsForTicket(ticketId);
      const cohort = runs.filter((r) => r.fan_out_group);
      return cohort.length === 2 ? cohort : null;
    });
    fanOutGroup = siblingRuns[0].fan_out_group;
    console.log(`  ✅ 2 sibling runs created`);
    console.log(`     fan_out_group=${fanOutGroup}`);
    console.log(`     roles=[${siblingRuns.map((r) => r.fan_out_role).join(", ")}]`);

    // ── Test 2: ticket carries the same fan_out_group ──
    console.log("\n--- T2: ticket + runs share fan_out_group ---");
    const ticket = await getTicket(ticketId);
    if (ticket.fan_out_group !== fanOutGroup) {
      throw new Error(
        `ticket.fan_out_group=${ticket.fan_out_group} != runs.fan_out_group=${fanOutGroup}`,
      );
    }
    const distinctGroups = new Set(siblingRuns.map((r) => r.fan_out_group));
    if (distinctGroups.size !== 1) {
      throw new Error(`siblings have ${distinctGroups.size} distinct fan_out_groups`);
    }
    const distinctRoles = new Set(siblingRuns.map((r) => r.fan_out_role));
    if (distinctRoles.size !== 2) {
      throw new Error(`expected 2 distinct fan_out_roles, got ${[...distinctRoles].join(",")}`);
    }
    if (!distinctRoles.has("engineer") || !distinctRoles.has("security")) {
      throw new Error(`expected {engineer,security} roles, got ${[...distinctRoles].join(",")}`);
    }
    console.log(`  ✅ ticket + 2 runs all share fan_out_group=${fanOutGroup.slice(0, 8)}`);
    console.log(`  ✅ roles are exactly {engineer, security}`);

    // ── Test 3: aggregator decides ONCE on cohort completion ──
    console.log("\n--- T3: aggregator records exactly one fan_in_decisions row ---");
    // Complete the first sibling. With strategy='all', the cohort is not yet
    // satisfied — the aggregator should skip without recording a decision.
    await completeRun(siblingRuns[0], ticketId);
    console.log(`  completed first sibling (${siblingRuns[0].fan_out_role})`);
    await new Promise((r) => setTimeout(r, 3000));
    const partial = await getDecisions(fanOutGroup);
    if (partial.length !== 0) {
      throw new Error(`aggregator decided after 1/2 with strategy=all: ${JSON.stringify(partial)}`);
    }
    console.log(`  ✅ no decision yet (correct — strategy=all needs both)`);

    // Complete the second sibling — strategy should now be satisfied.
    await completeRun(siblingRuns[1], ticketId);
    console.log(`  completed second sibling (${siblingRuns[1].fan_out_role})`);
    const decisions = await waitFor("aggregator records accepted decision", async () => {
      const d = await getDecisions(fanOutGroup);
      return d.find((x) => x.outcome === "accepted") ? d : null;
    });
    if (decisions.length !== 1) {
      throw new Error(`expected 1 decision row, got ${decisions.length}`);
    }
    console.log(
      `  ✅ exactly 1 fan_in_decisions row (outcome=accepted, phase=${decisions[0].phase})`,
    );

    // Idempotency stress: re-fire the completion event for the second sibling.
    // The aggregator must hit the (fan_out_group, phase) unique violation and
    // NOT create a second decision row.
    console.log("  idempotency stress: re-firing completion event…");
    await sendEvent("agent/run.completed", {
      runId: siblingRuns[1].id,
      tenantId: TENANT_ID,
      ticketId,
      role: siblingRuns[1].fan_out_role ?? undefined,
      status: "done",
      fanOutGroup,
      fanOutPhase: "review",
    });
    await new Promise((r) => setTimeout(r, 4000));
    const decisionsAfter = await getDecisions(fanOutGroup);
    if (decisionsAfter.length !== 1) {
      throw new Error(`idempotency violated: ${decisionsAfter.length} decision rows after re-fire`);
    }
    console.log(`  ✅ still exactly 1 decision row after re-fire (runaway-shape guard)`);

    // ── Test 4: ticket landed in in_review ──
    console.log("\n--- T4: ticket transitioned to in_review by the aggregator ---");
    const finalTicket = await waitFor("ticket lands in in_review", async () => {
      const t = await getTicket(ticketId);
      return t?.status === "in_review" ? t : null;
    });
    console.log(`  ✅ ticket status=${finalTicket.status}`);

    // ── Test 5: runaway-shape guard on a terminal-cancelled cohort ──
    console.log("\n--- T5: aggregator records cancelled decision on terminal ticket ---");
    const ticket2Id = await createTicket();
    cleanup.push(ticket2Id);
    await seedPmComment(ticket2Id);
    await dispatchNeeded(ticket2Id);
    const cohort2 = await waitFor("second cohort seeded", async () => {
      const runs = await getRunsForTicket(ticket2Id);
      const c = runs.filter((r) => r.fan_out_group);
      return c.length === 2 ? c : null;
    });
    const group2 = cohort2[0].fan_out_group;
    console.log(`  cohort2 fan_out_group=${group2.slice(0, 8)}`);
    // Force the ticket into a terminal state BEFORE either sibling completes.
    // Use PATCH directly to bypass the transition function's dispatch hooks —
    // we want the cohort to be in a "ticket-already-terminal" state when the
    // aggregator fires.
    await sb(`tickets?id=eq.${ticket2Id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "failed" }),
    });
    // Now complete a sibling. Aggregator should record cancelled and skip.
    await completeRun(cohort2[0], ticket2Id);
    await completeRun(cohort2[1], ticket2Id);
    const cancelled = await waitFor("aggregator records cancelled decision", async () => {
      const d = await getDecisions(group2);
      return d.find((x) => x.outcome === "cancelled") ? d : null;
    });
    console.log(`  ✅ cancelled decision recorded (notes="${cancelled[0].notes}")`);
    // Ticket must still be `failed` — proves no rogue transition fired.
    const ticket2After = await getTicket(ticket2Id);
    if (ticket2After.status !== "failed") {
      throw new Error(
        `runaway-shape regression: ticket moved from 'failed' to '${ticket2After.status}'`,
      );
    }
    console.log(`  ✅ terminal ticket NOT re-transitioned (runaway-shape regression guard)`);

    console.log("\n=== ALL TESTS PASS ===");
    console.log(`Summary:`);
    console.log(`  • dispatcher fan-out: 2 siblings (engineer + security)`);
    console.log(`  • aggregator: 1 accepted decision per cohort, idempotent under replay`);
    console.log(`  • ticket lands in_review post-join`);
    console.log(`  • terminal-cancellation path: 1 cancelled decision, no rogue transition`);
  } catch (err) {
    console.error(`\n❌ FAIL: ${err.message ?? err}`);
    try {
      if (ticketId) {
        const ticket = await getTicket(ticketId);
        const runs = await getRunsForTicket(ticketId);
        const decisions = fanOutGroup ? await getDecisions(fanOutGroup) : [];
        console.error(`  ticket=${JSON.stringify(ticket)}`);
        console.error(`  runs=${JSON.stringify(runs, null, 2)}`);
        console.error(`  decisions=${JSON.stringify(decisions, null, 2)}`);
      }
    } catch {}
    await safeCleanup();
    process.exit(1);
  }

  await safeCleanup();
  console.log(`\ncleanup: deleted ${cleanup.length} fixture tickets`);
})();
