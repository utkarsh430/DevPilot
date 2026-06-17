// Phase 1 / Phase 2-foundation — dispatch_queue acceptance.
//
// What this proves
// ────────────────
// 1. Enqueue: when the dispatcher hits a role's WIP cap it writes a row into
//    `dispatch_queue` and leaves the ticket in ready/backlog instead of
//    silently dropping it (the Wave-3 hotfix behavior).
// 2. Idempotency: re-emitting `ticket/dispatch-needed` for the same ticket
//    while it's already pending does NOT create a second queue row (the
//    unique partial index on (ticket_id, agent_id) WHERE pending guards this).
// 3. Drain: when `agent/run.completed` fires for that agent and capacity
//    frees up, the drain function claims the next pending row and re-emits
//    `ticket/dispatch-needed`, which goes through the dispatcher normally.
// 4. Bounded fan-out: a single completion event drains AT MOST ONE row, so
//    a queue with K pending tickets needs K completion events to fully
//    drain. This is the explicit guard against the 2026-06-02 runaway shape.
// 5. Stale-ticket cancellation: a queue row whose ticket has been moved to
//    a terminal state is cancelled, not re-dispatched.
//
// We simulate WIP saturation by inserting "pinned" run rows directly with
// status='running' for the agent under test. This avoids running real
// Claude / API steps end-to-end — the dispatcher only cares about
// runs.status counts, and the drain only cares about the completion event.
// Net effect: the entire script runs in ~30s instead of ~15min.
//
// Pre-reqs: Next.js dev :3000 (route handlers) and Inngest dev :8288 (so
// events route to dispatcher + dispatchOnRunComplete). No runner needed.
// Run: node --env-file=.env.local scripts/phase1-dispatch-queue-accept.mjs

import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const INNGEST_DEV = "http://localhost:8288";
const TENANT_ID = "e98507ec-d5a2-4951-8a5d-445c86dbfca8";
const ROLE = "techwriter"; // any materialised agent is fine; techwriter is light.

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
  if (!res.ok) throw new Error(`event send ${name} failed: ${res.status} ${await res.text()}`);
}

async function findAgent(role) {
  const r = await sb(
    `agents?tenant_id=eq.${TENANT_ID}&role=eq.${role}&select=id,config&order=version.desc&limit=1`,
  );
  const rows = await r.json();
  if (!rows.length)
    throw new Error(`no agent row for role=${role} — run migration 20260603010000 first`);
  return rows[0];
}

async function patchAgentConfig(agentId, config) {
  await sb(`agents?id=eq.${agentId}`, {
    method: "PATCH",
    body: JSON.stringify({ config }),
  });
}

async function insertPinnedRun(agentId) {
  const runId = randomUUID();
  const res = await sb("runs", {
    method: "POST",
    body: JSON.stringify({
      id: runId,
      tenant_id: TENANT_ID,
      agent_id: agentId,
      ticket_id: null,
      status: "running",
      budget_cents: 100,
      spent_cents: 0,
      depth: 0,
      runner_kind: "api",
    }),
  });
  if (!res.ok) throw new Error(`pin run failed: ${res.status} ${await res.text()}`);
  return runId;
}

async function completePinnedRun(runId, agentId) {
  // Flip the row to done so the drain's WIP check sees capacity.
  await sb(`runs?id=eq.${runId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "done", last_event_at: new Date().toISOString() }),
  });
  // Then fire the completion event the drain function listens for.
  await sendEvent("agent/run.completed", {
    runId,
    tenantId: TENANT_ID,
    agentId,
    status: "done",
  });
}

async function createTicket(title) {
  const id = randomUUID();
  const res = await sb("tickets", {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: TENANT_ID,
      title,
      description: "dispatch_queue acceptance fixture — safe to delete.",
      status: "ready",
      requested_role: ROLE,
      priority: 3,
    }),
  });
  if (!res.ok) throw new Error(`create ticket failed: ${res.status} ${await res.text()}`);
  return id;
}

async function getQueuePending(agentId) {
  const r = await sb(
    `dispatch_queue?tenant_id=eq.${TENANT_ID}&agent_id=eq.${agentId}&status=eq.pending&select=id,ticket_id,priority,enqueued_at,wip_limit_snapshot`,
  );
  return r.json();
}

async function getQueueAll(agentId) {
  const r = await sb(
    `dispatch_queue?tenant_id=eq.${TENANT_ID}&agent_id=eq.${agentId}&select=id,ticket_id,status,priority,cancel_reason&order=enqueued_at.asc`,
  );
  return r.json();
}

async function getTicket(id) {
  const r = await sb(`tickets?id=eq.${id}&select=status`);
  const rows = await r.json();
  return rows[0] ?? null;
}

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

(async () => {
  console.log("=== Phase 1 — dispatch_queue acceptance ===\n");

  const agent = await findAgent(ROLE);
  const originalConfig = agent.config ?? {};
  console.log(`  using ${ROLE} agent=${agent.id}`);

  const pinnedRunIds = [];
  const ticketIds = [];

  try {
    // ── Setup ── shrink the agent's wip_limit to 1 and pin a synthetic
    // run so the dispatcher sees capacity as fully saturated.
    await patchAgentConfig(agent.id, { ...originalConfig, wip_limit: 1 });
    const pinned1 = await insertPinnedRun(agent.id);
    pinnedRunIds.push(pinned1);
    console.log(`  pinned run #1 → status=running  (wip 1/1)`);

    // ── Test 1: enqueue on WIP ──
    console.log("\n--- Test 1: enqueue on WIP saturation ---");
    const tA = await createTicket("dispatch-queue: ticket A");
    ticketIds.push(tA);
    await sendEvent("ticket/dispatch-needed", { ticketId: tA, tenantId: TENANT_ID });

    const queueRows = await waitFor("ticket A enqueued", async () => {
      const rows = await getQueuePending(agent.id);
      return rows.find((r) => r.ticket_id === tA) ? rows : null;
    });
    console.log(`  ✅ ticket A enqueued, queue depth=${queueRows.length}`);
    if (queueRows[0].wip_limit_snapshot !== 1) {
      throw new Error(`expected wip_limit_snapshot=1, got ${queueRows[0].wip_limit_snapshot}`);
    }

    // ── Test 2: idempotency ──
    console.log("\n--- Test 2: idempotent re-dispatch on already-queued ticket ---");
    await sendEvent("ticket/dispatch-needed", { ticketId: tA, tenantId: TENANT_ID });
    await new Promise((r) => setTimeout(r, 2000));
    const dupCheck = await getQueuePending(agent.id);
    const tAEntries = dupCheck.filter((r) => r.ticket_id === tA);
    if (tAEntries.length !== 1) {
      throw new Error(`expected exactly 1 pending entry for ticket A, got ${tAEntries.length}`);
    }
    console.log(`  ✅ no duplicate row (still 1 pending for ticket A)`);

    // ── Test 3: bounded drain — enqueue a SECOND ticket, then complete the
    //          pinned run. Drain should release ONLY ONE of the two queued
    //          tickets (one-per-completion guard against runaway).
    console.log("\n--- Test 3: bounded drain (1 release per completion) ---");
    const tB = await createTicket("dispatch-queue: ticket B");
    ticketIds.push(tB);
    await sendEvent("ticket/dispatch-needed", { ticketId: tB, tenantId: TENANT_ID });
    await waitFor("ticket B enqueued", async () => {
      const rows = await getQueuePending(agent.id);
      return rows.find((r) => r.ticket_id === tB) ? rows : null;
    });
    console.log("  both A and B pending; freeing one capacity slot…");

    await completePinnedRun(pinned1, agent.id);

    // After ONE completion event, exactly ONE of (A, B) should leave the queue.
    // The order is FIFO by enqueued_at, so A (queued first) should go first.
    await new Promise((r) => setTimeout(r, 6000));
    const afterDrain = await getQueuePending(agent.id);
    const aStill = afterDrain.find((r) => r.ticket_id === tA);
    const bStill = afterDrain.find((r) => r.ticket_id === tB);
    if (aStill && bStill) {
      throw new Error("drain did not release ANY ticket — expected exactly 1");
    }
    if (!aStill && !bStill) {
      throw new Error("drain released BOTH tickets — runaway shape, expected exactly 1");
    }
    const released = !aStill ? "A" : "B";
    console.log(`  ✅ exactly one released (${released}); the other is still pending`);

    // The released ticket should land in dispatcher again. With wip_limit=1
    // and no new pinned run, dispatcher will create a new in-flight run for
    // the released ticket. We don't wait for that run to *complete* — just
    // verify the ticket moved out of `ready` OR a runs row exists.
    const releasedTicketId = !aStill ? tA : tB;
    const stillPending = !aStill ? tB : tA;
    const dispatched = await waitFor(
      "released ticket has a run row OR moved out of ready",
      async () => {
        const t = await getTicket(releasedTicketId);
        if (t && t.status !== "ready") return { reason: "status-moved", status: t.status };
        const r = await sb(`runs?ticket_id=eq.${releasedTicketId}&select=id,status&limit=1`);
        const runs = await r.json();
        if (runs.length > 0) return { reason: "run-created", runStatus: runs[0].status };
        return null;
      },
      45_000,
    );
    console.log(`  ✅ released ticket picked up (${JSON.stringify(dispatched)})`);

    // ── Test 4: stale-ticket cancellation. Mark the still-pending ticket
    //          as `done` directly, then re-fire a completion. Drain should
    //          claim it, see terminal state, and cancel rather than dispatch.
    console.log("\n--- Test 4: stale-ticket cancellation on terminal status ---");
    // Released-ticket cleanup: Test 3's dispatcher emitted a real
    // agent/run.requested for the released ticket. Without the runner worker
    // running, that run sits in `status=running` forever and pins WIP at the
    // cap, which would make the drain in this test return "still-over-wip"
    // before it ever claims a queue row. Force-complete the orphan run.
    await sb(`runs?ticket_id=eq.${releasedTicketId}&status=eq.running`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "done",
        last_event_at: new Date().toISOString(),
      }),
    });
    // PATCH directly to bypass transitionTicket (we WANT the queue row to
    // survive into the drain so we can prove the drain cancels it).
    await sb(`tickets?id=eq.${stillPending}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done" }),
    });
    // The released ticket's run is the one we'd want to "complete" to
    // trigger another drain. Pin a synthetic run so we have something
    // controllable.
    const pinned2 = await insertPinnedRun(agent.id);
    pinnedRunIds.push(pinned2);
    await completePinnedRun(pinned2, agent.id);

    await waitFor(
      "stale queue entry cancelled",
      async () => {
        const rows = await getQueueAll(agent.id);
        const entry = rows.find((r) => r.ticket_id === stillPending && r.status === "cancelled");
        return entry ?? null;
      },
      30_000,
    );
    console.log(`  ✅ stale queue entry cancelled (not re-dispatched)`);

    console.log("\n=== ALL TESTS PASS ===");
  } catch (err) {
    console.error(`\n❌ FAIL: ${err.message ?? err}`);
    try {
      const finalState = await getQueueAll(agent.id);
      console.error(`  final queue state: ${JSON.stringify(finalState, null, 2)}`);
    } catch {}
    process.exit(1);
  } finally {
    // Restore agent config to its pre-test state.
    await patchAgentConfig(agent.id, originalConfig);
    // Hard-delete the synthetic runs + tickets so the board stays clean.
    for (const id of pinnedRunIds) {
      await sb(`runs?id=eq.${id}`, { method: "DELETE" });
    }
    for (const id of ticketIds) {
      await sb(`tickets?id=eq.${id}`, { method: "DELETE" });
    }
    // Any queue rows referencing these tickets cascade out via FK.
    // Drain the local-cc Redis queue: Test 3's drain emits a REAL
    // agent/run.requested for the released ticket, which the dispatcher
    // turns into an LPUSH onto devpilot:jobs:local-cc:ready. If the runner is
    // running it consumes that job and burns ~$0.05 against a now-deleted
    // ticket. Best-effort DEL keeps the test self-contained.
    try {
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (url && tok) {
        await fetch(`${url}/del/devpilot:jobs:local-cc:ready`, {
          headers: { Authorization: `Bearer ${tok}` },
        });
      }
    } catch {
      /* drain is best-effort; tests pass regardless */
    }
    console.log(
      `\ncleanup: restored ${ROLE} config, deleted ${pinnedRunIds.length} pinned runs + ${ticketIds.length} fixture tickets, drained local-cc queue`,
    );
  }
})();
