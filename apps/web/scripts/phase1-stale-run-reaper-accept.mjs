// Phase 1 (post-M16) acceptance — Stale-run reaper.
//
// What this proves
// ────────────────
// 1. Inserting a synthetic `runs` row with status='running' and last_event_at
//    well past the configured threshold (default 15 min) places a candidate
//    in the reaper's scan window.
// 2. Triggering the reaper via `internal/reap-stale-runs` (the manual-trigger
//    event the function listens on alongside the cron) marks the row failed
//    within ~10s.
// 3. The reaper writes a `run_steps` audit row at idx=99_996 with
//    kind='system' and payload.kind='stale-run-reaped' carrying the threshold
//    and the original last_event_at.
// 4. A second trigger is a no-op: the conditional UPDATE matches zero rows
//    and no duplicate audit step is written.
//
// Pre-reqs
// ────────
// • NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY in apps/web/.env.local.
// • Inngest dev :8288 running (the function lives behind the same
//   /api/inngest webhook).
// • Next dev :3000 running (so /api/inngest is reachable when Inngest dev
//   invokes the function).
// • The `staleRunReaper` function must be registered in
//   apps/web/app/api/inngest/route.ts. The script does NOT register it.
//
// Exit codes:
//   0 = pass
//   1 = test failure
//   2 = environment/setup not satisfied
//
// Run:
//   cd apps/web
//   node --env-file=.env.local scripts/phase1-stale-run-reaper-accept.mjs

import "./_legacy-env.mjs"; // legacy ACE_* env aliases (transitional)
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const INNGEST_DEV = process.env.INNGEST_DEV_URL ?? "http://localhost:8288";
const TENANT_ID = process.env.DEVPILOT_TEST_TENANT_ID ?? "e98507ec-d5a2-4951-8a5d-445c86dbfca8";
const THRESHOLD_MINUTES = Number(process.env.DEVPILOT_STALE_RUN_THRESHOLD_MINUTES ?? "15");

if (!SUPABASE_URL || !SECRET) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in env — exit 2");
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

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    const val = await predicate();
    last = val;
    if (val) return val;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timeout waiting for: ${label}; lastValue=${JSON.stringify(last)}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function seedStaleRun({ tenantId, ageMinutes }) {
  const runId = randomUUID();
  const lastEventAt = new Date(Date.now() - ageMinutes * 60_000).toISOString();
  const r = await sb("runs", {
    method: "POST",
    body: JSON.stringify({
      id: runId,
      tenant_id: tenantId,
      // agent_id intentionally null — the reaper does not require an agent
      // and the dispatcher's concurrency key uses "no-agent" as fallback.
      // ticket_id intentionally null — keeps the synthetic row well outside
      // any real ticket's history.
      budget_cents: 100,
      spent_cents: 0,
      status: "running",
      runner_kind: "api",
      depth: 0,
      last_event_at: lastEventAt,
    }),
  });
  if (!r.ok) throw new Error(`seedStaleRun: ${r.status} ${await r.text()}`);
  return { runId, lastEventAt };
}

async function getRun(runId) {
  const r = await sb(`runs?id=eq.${runId}&select=id,status,last_event_at,tenant_id`);
  const rows = await r.json();
  return rows[0] ?? null;
}

async function getReapAuditSteps(runId) {
  const r = await sb(`run_steps?run_id=eq.${runId}&idx=eq.99996&select=run_id,idx,kind,payload`);
  return r.json();
}

async function deleteRun(runId) {
  // run_steps cascades on run delete via FK, but be explicit so we don't
  // rely on the migration's ON DELETE clause being permissive.
  await sb(`run_steps?run_id=eq.${runId}`, { method: "DELETE" });
  await sb(`runs?id=eq.${runId}`, { method: "DELETE" });
}

const cleanup = { runIds: [] };

(async () => {
  console.log("=== Phase 1 / stale-run-reaper acceptance ===\n");
  console.log(`  tenant=${TENANT_ID} threshold=${THRESHOLD_MINUTES}m inngest=${INNGEST_DEV}\n`);

  try {
    // ── T1: insert a stale `running` run (well past threshold) ──
    console.log(
      `--- T1: insert synthetic run with last_event_at = ${THRESHOLD_MINUTES + 5}min ago ---`,
    );
    const { runId, lastEventAt } = await seedStaleRun({
      tenantId: TENANT_ID,
      ageMinutes: THRESHOLD_MINUTES + 5,
    });
    cleanup.runIds.push(runId);
    console.log(`  seeded run=${runId.slice(0, 8)} last_event_at=${lastEventAt}`);

    // ── T2: trigger the reaper ──
    console.log("\n--- T2: trigger internal/reap-stale-runs ---");
    await sendEvent("internal/reap-stale-runs", {});
    console.log("  event sent");

    // ── T3: wait for the run to flip to failed ──
    console.log("\n--- T3: wait for runs.status='failed' ---");
    await waitFor(
      "run reaped",
      async () => {
        const row = await getRun(runId);
        if (row?.status === "failed") return row;
        return null;
      },
      60_000,
    );
    console.log(`  ✓ run ${runId.slice(0, 8)} status='failed'`);

    // ── T4: assert audit step at idx=99_996 ──
    console.log("\n--- T4: assert audit run_steps row at idx=99996 ---");
    const steps = await getReapAuditSteps(runId);
    assert(steps.length === 1, `expected exactly 1 audit step at idx=99996; got ${steps.length}`);
    const step = steps[0];
    assert(step.kind === "system", `kind=${step.kind} expected 'system'`);
    assert(
      step.payload?.kind === "stale-run-reaped",
      `payload.kind=${step.payload?.kind} expected 'stale-run-reaped'`,
    );
    assert(
      step.payload?.thresholdMinutes === THRESHOLD_MINUTES,
      `payload.thresholdMinutes=${step.payload?.thresholdMinutes} expected ${THRESHOLD_MINUTES}`,
    );
    // Compare as instants — Postgres returns `+00:00` suffix while Date#toISOString
    // emits `Z`. Same moment, different ISO representation.
    const payloadTs = Date.parse(step.payload?.last_event_at ?? "");
    const expectedTs = Date.parse(lastEventAt);
    assert(
      Number.isFinite(payloadTs) && payloadTs === expectedTs,
      `payload.last_event_at=${step.payload?.last_event_at} expected equiv to ${lastEventAt}`,
    );
    console.log(
      `  ✓ audit step: kind=${step.kind} payload.kind=${step.payload.kind} threshold=${step.payload.thresholdMinutes}m`,
    );

    // ── T5: re-trigger; the conditional update must no-op ──
    console.log("\n--- T5: re-trigger reaper (idempotency check) ---");
    await sendEvent("internal/reap-stale-runs", {});
    // Give the function a moment to run and (correctly) write nothing.
    await new Promise((r) => setTimeout(r, 4000));
    const stepsAfter = await getReapAuditSteps(runId);
    assert(
      stepsAfter.length === 1,
      `idempotency violated: expected 1 audit step after re-trigger; got ${stepsAfter.length}`,
    );
    console.log(`  ✓ no duplicate audit step — reaper is idempotent`);

    console.log("\n=== stale-run-reaper acceptance: PASS ===");
    process.exit(0);
  } catch (err) {
    console.error("\n!!! FAIL:", err?.stack ?? err);
    process.exit(1);
  } finally {
    console.log("\n--- cleanup ---");
    try {
      for (const id of cleanup.runIds) await deleteRun(id);
      console.log(`  deleted ${cleanup.runIds.length} test run(s) + audit steps`);
    } catch (e) {
      console.warn("  cleanup partial failure:", e?.message ?? e);
    }
  }
})();
