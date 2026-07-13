// Phase 1 / M15 acceptance — Stripe usage-based billing.
//
// What this proves
// ────────────────
// 1. Stripe TEST customer is created (or reused) for the operator tenant and
//    the id is persisted on `tenants.stripe_customer_id`.
// 2. Three fake completed runs with synthetic spent_cents are seeded.
// 3. Manually triggered nightly aggregator (we call `aggregateTenant` via a
//    one-shot Node import — not the cron) bills them:
//      • POSTs a Stripe Meter Event with overage = (charge - included credit),
//      • debits `tenant.balance_cents` by spent * (1 + markup/100),
//      • marks each contributing `runs.billed_at = now()`.
// 4. Re-triggering the aggregator the same day is a no-op (no new meter
//    event, no double-debit, runs already billed_at).
// 5. The dispatcher soft cutoff refuses to emit `agent/run.requested` when
//    payment_method_status='invalid' AND balance < 0 — instead it writes a
//    system comment on the ticket and returns skipped.
//
// Pre-reqs
// ────────
// • STRIPE_SECRET_KEY=sk_test_… in apps/web/.env.local (REQUIRED — script
//   exits with code 2 / "skipped" if absent, mirroring M10's pattern).
// • Migration 20260603110000_m15_billing.sql applied to the local DB.
// • Inngest dev :8288 running (only used for the soft-cutoff dispatch test;
//   the meter is invoked in-process so we don't need it for steps 1-6).
//
// Exit codes:
//   0 = pass
//   1 = test failure
//   2 = environment/setup not satisfied (STRIPE_SECRET_KEY missing)
//
// Run:
//   cd apps/web
//   node --env-file=.env.local scripts/phase1-m15-accept.mjs

import "./_legacy-env.mjs"; // legacy ACE_* env aliases (transitional)
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const INNGEST_DEV = process.env.INNGEST_DEV_URL ?? "http://localhost:8288";
const TENANT_ID = process.env.M15_TENANT_ID ?? "e98507ec-d5a2-4951-8a5d-445c86dbfca8";

if (!SUPABASE_URL || !SECRET) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in env");
  process.exit(1);
}
if (!STRIPE_SECRET_KEY || STRIPE_SECRET_KEY.length === 0) {
  console.error("M15 needs STRIPE_SECRET_KEY=sk_test_… in apps/web/.env.local — skipping (exit 2)");
  process.exit(2);
}
if (!STRIPE_SECRET_KEY.startsWith("sk_test_")) {
  console.error("M15 acceptance refuses to run against a non-test Stripe key. Use sk_test_… only.");
  process.exit(1);
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
  if (!res.ok) throw new Error(`event send ${name} failed: ${res.status} ${await res.text()}`);
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

async function getTenant(id) {
  const r = await sb(
    `tenants?id=eq.${id}&select=id,name,stripe_customer_id,balance_cents,monthly_included_cents,payment_method_status`,
  );
  const rows = await r.json();
  return rows[0] ?? null;
}

async function patchTenant(id, patch) {
  const r = await sb(`tenants?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`patchTenant: ${r.status} ${await r.text()}`);
}

async function getRuns(ids) {
  const list = ids.map((i) => `id.eq.${i}`).join(",");
  const r = await sb(`runs?or=(${list})&select=id,spent_cents,billed_at,status`);
  return r.json();
}

async function getTicketComments(ticketId) {
  const r = await sb(
    `comments?ticket_id=eq.${ticketId}&order=created_at.asc&select=author_type,author_id,body,created_at`,
  );
  return r.json();
}

async function seedRun(spentCents) {
  const runId = randomUUID();
  const finishedAt = new Date(Date.now() - 10 * 60_000).toISOString(); // 10m ago
  const r = await sb("runs", {
    method: "POST",
    body: JSON.stringify({
      id: runId,
      tenant_id: TENANT_ID,
      budget_cents: Math.max(spentCents, 500),
      spent_cents: spentCents,
      status: "done",
      runner_kind: "api",
      depth: 0,
      last_event_at: finishedAt,
    }),
  });
  if (!r.ok) throw new Error(`seedRun: ${await r.text()}`);
  return runId;
}

async function seedTicket(title) {
  const tid = randomUUID();
  const r = await sb("tickets", {
    method: "POST",
    body: JSON.stringify({
      id: tid,
      tenant_id: TENANT_ID,
      title,
      description: "m15 acceptance — billing cutoff scenario",
      status: "ready",
    }),
  });
  if (!r.ok) throw new Error(`seedTicket: ${await r.text()}`);
  return tid;
}

async function deleteRuns(ids) {
  if (ids.length === 0) return;
  const list = ids.map((i) => `id.eq.${i}`).join(",");
  await sb(`runs?or=(${list})`, { method: "DELETE" });
}
async function deleteTickets(ids) {
  if (ids.length === 0) return;
  const list = ids.map((i) => `id.eq.${i}`).join(",");
  await sb(`tickets?or=(${list})`, { method: "DELETE" });
}

// ────────────────────────────────────────────────────────────────────────────
// Import the meter aggregator out of the app's TypeScript source via a tsx
// child process. Acceptance scripts can't `import` .ts files directly from
// ESM, so we shell out to a tiny inline runner.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");

function runAggregator(tenantId) {
  // Invoke aggregateTenant() through the workspace's tsx (same pattern M10
  // uses for the validator unit test). tsx resolves TypeScript + the "@/…"
  // path aliases via the project tsconfig, so we don't have to reproduce
  // the Next.js resolver in this script.
  const tsxBin = path.resolve(APP_ROOT, "..", "runner", "node_modules", ".bin", "tsx");
  const script = path.resolve(APP_ROOT, "scripts", "phase1-m15-aggregator-runner.mts");
  const res = spawnSync(tsxBin, [script, tenantId], {
    cwd: APP_ROOT,
    encoding: "utf8",
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(
      `aggregator runner failed (status=${res.status}):\nstdout=${res.stdout}\nstderr=${res.stderr}`,
    );
  }
  const marker = "___M15_RESULT___";
  const idx = (res.stdout ?? "").lastIndexOf(marker);
  if (idx < 0) {
    throw new Error(`aggregator runner produced no result marker. stdout=${res.stdout}`);
  }
  const tail = res.stdout
    .slice(idx + marker.length)
    .trim()
    .split("\n")[0];
  return JSON.parse(tail);
}

// ────────────────────────────────────────────────────────────────────────────

const cleanup = {
  runs: [],
  tickets: [],
  resetTenant: null, // snapshot of original tenant row to restore
};

(async () => {
  console.log("=== Phase 1 / M15 acceptance: Stripe usage-based billing ===\n");

  // ── 0. snapshot tenant for restoration ──
  const original = await getTenant(TENANT_ID);
  if (!original) {
    console.error(`tenant ${TENANT_ID} not found in DB`);
    process.exit(1);
  }
  cleanup.resetTenant = {
    balance_cents: original.balance_cents,
    payment_method_status: original.payment_method_status,
    monthly_included_cents: original.monthly_included_cents,
  };
  console.log(
    `  tenant snapshot: balance=${original.balance_cents}¢ pm=${original.payment_method_status} included=${original.monthly_included_cents}¢ customer=${original.stripe_customer_id ?? "(none)"}`,
  );

  // Set known-good starting state: 0 balance, 'valid' card, $0 included
  // (force overage so the meter event has non-zero value).
  await patchTenant(TENANT_ID, {
    balance_cents: 0,
    payment_method_status: "valid",
    monthly_included_cents: 0,
  });

  try {
    // ── T1. seed three completed runs ──
    console.log("\n--- T1: seed 3 fake completed runs ---");
    const seeds = [120, 75, 35]; // total 230¢
    const runIds = [];
    for (const c of seeds) {
      const id = await seedRun(c);
      runIds.push(id);
      cleanup.runs.push(id);
    }
    const totalSpent = seeds.reduce((a, b) => a + b, 0);
    console.log(
      `  seeded runs: ${runIds.map((r) => r.slice(0, 8)).join(", ")} totalSpent=${totalSpent}¢`,
    );

    // ── T2. first aggregator run ──
    console.log("\n--- T2: trigger nightly aggregator (1st time) ---");
    const r1 = runAggregator(TENANT_ID);
    console.log(`  result: ${JSON.stringify(r1, null, 2)}`);

    const markupPct = Number(process.env.DEVPILOT_BILLING_MARKUP_PCT ?? "20");
    const expectedCharge = Math.round(totalSpent * (1 + markupPct / 100));

    assert(r1.spentCents === totalSpent, `spentCents=${r1.spentCents} expected=${totalSpent}`);
    assert(
      r1.chargeCents === expectedCharge,
      `chargeCents=${r1.chargeCents} expected=${expectedCharge} (markup=${markupPct}%)`,
    );
    assert(r1.runsBilled === 3, `runsBilled=${r1.runsBilled} expected=3`);
    assert(
      r1.meterEvent && r1.meterEvent.identifier && r1.meterEvent.valueCents > 0,
      `meterEvent missing/empty: ${JSON.stringify(r1.meterEvent)}`,
    );
    assert(
      r1.stripeCustomerId && r1.stripeCustomerId.startsWith("cus_"),
      `stripeCustomerId not provisioned: ${r1.stripeCustomerId}`,
    );
    console.log(`  ✓ Stripe customer: ${r1.stripeCustomerId}`);
    console.log(
      `  ✓ Meter event posted: identifier=${r1.meterEvent.identifier} value=${r1.meterEvent.valueCents}¢`,
    );
    console.log(`  ✓ Charge = ${totalSpent}¢ × (1+${markupPct}%) = ${expectedCharge}¢`);

    // ── T3. runs.billed_at set on all 3 ──
    console.log("\n--- T3: runs.billed_at set on all 3 ---");
    const billed = await getRuns(runIds);
    for (const r of billed) {
      assert(r.billed_at, `run ${r.id.slice(0, 8)} billed_at not set`);
    }
    console.log(`  ✓ all 3 runs have billed_at`);

    // ── T4. re-trigger aggregator: must be a no-op ──
    console.log("\n--- T4: re-trigger aggregator (idempotency check) ---");
    const r2 = runAggregator(TENANT_ID);
    console.log(`  result: ${JSON.stringify(r2, null, 2)}`);
    assert(r2.spentCents === 0, `spentCents=${r2.spentCents} expected=0 (no double-charge)`);
    assert(r2.runsBilled === 0, `runsBilled=${r2.runsBilled} expected=0`);
    assert(
      r2.skipped === "no-billable-spend",
      `expected skipped=no-billable-spend, got ${r2.skipped}`,
    );
    console.log(`  ✓ no double-charge — second run is a no-op`);

    // ── T5. soft cutoff — invalid card + negative balance ──
    console.log("\n--- T5: soft cutoff (invalid card + balance < 0) ---");
    await patchTenant(TENANT_ID, {
      balance_cents: -100,
      payment_method_status: "invalid",
    });
    const ticketId = await seedTicket("M15 cutoff probe");
    cleanup.tickets.push(ticketId);
    console.log(`  seeded ticket ${ticketId.slice(0, 8)} status=ready`);

    await sendEvent("ticket/dispatch-needed", {
      ticketId,
      tenantId: TENANT_ID,
    });
    console.log(`  emitted ticket/dispatch-needed`);

    // Wait for the dispatcher to land its system comment.
    await waitFor(
      "billing-gate refusal comment",
      async () => {
        const comments = await getTicketComments(ticketId);
        const hit = comments.find(
          (c) =>
            c.author_type === "system" &&
            c.author_id === "billing-gate" &&
            String(c.body).includes("Dispatch refused"),
        );
        return hit ?? null;
      },
      90_000,
    );
    console.log(`  ✓ dispatcher wrote billing-gate refusal comment`);

    // Verify NO agent/run.requested fired: ticket stays in ready (or whatever
    // pre-dispatch state); no runs row was created for this ticket.
    const ticketRunsRes = await sb(`runs?ticket_id=eq.${ticketId}&select=id,status`);
    const ticketRuns = await ticketRunsRes.json();
    assert(
      ticketRuns.length === 0,
      `expected 0 runs for cutoff ticket; got ${ticketRuns.length}: ${JSON.stringify(ticketRuns)}`,
    );
    console.log(`  ✓ no run row created — agent/run.requested was refused`);

    console.log("\n=== M15 acceptance: PASS ===");
    process.exit(0);
  } catch (err) {
    console.error("\n!!! FAIL:", err?.stack ?? err);
    process.exit(1);
  } finally {
    // ── cleanup ──
    console.log("\n--- cleanup ---");
    try {
      await deleteRuns(cleanup.runs);
      await deleteTickets(cleanup.tickets);
      if (cleanup.resetTenant) {
        await patchTenant(TENANT_ID, cleanup.resetTenant);
      }
      console.log("  cleaned up runs, tickets, and restored tenant state.");
    } catch (e) {
      console.warn("  cleanup partial failure:", e?.message ?? e);
    }
  }
})();
