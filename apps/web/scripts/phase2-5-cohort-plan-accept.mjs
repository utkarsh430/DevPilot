// Phase 2.5 / M6 acceptance — cohort_plan multi-cohort fan-out.
//
// What this proves
// ────────────────
// Modelled on `phase1-m6-accept.mjs`. We seed a ticket carrying a
// `cohort_plan` jsonb (the Phase 2.5 contract) and confirm the dispatcher
// reads it, picks the first cohort whose `trigger_role` matches the
// deterministic next role, and seeds N sibling `runs` rows with the new
// `cohort_key` + `cohort_depth` columns. The cohort_plan also names a
// nested cohort to prove `parseCohortPlan` accepts and validates the
// full shape; the nested cohort is not exercised end-to-end here because
// firing it cleanly requires the aggregator + dispatcher chain after
// `cohort A` joins, which itself needs simulated sibling completions —
// see the operator-driven verification block in the plan
// (`/Users/ethan-hunt/.claude/plans/when-i-i-got-crystalline-tulip.md`,
// §Verification step 5).
//
// We DO NOT exercise claude-cc end-to-end — same reasoning as the M6
// script. The dispatcher fan-out itself is REAL: it walks the same code
// path the production dispatcher uses, stamps `tickets.fan_out_group`,
// pre-seeds the run rows (now with `cohort_key`/`cohort_depth`), and
// emits the cohort events via Inngest. We then synthetically complete
// the cohort to prove the aggregator records the decision under
// `phase=<cohort_key>` rather than the legacy `phase='review'`.
//
// Acceptance criteria
// ───────────────────
//   T0. Schema: `tickets.cohort_plan`, `runs.cohort_key`,
//       `runs.cohort_depth` columns exist. (Sanity probe — fails fast if
//       the migration hasn't been applied.)
//   T1. Dispatcher fans out cohort A: TWO sibling runs (engineer +
//       security) seeded against the cohort_plan-bearing ticket.
//   T2. Both sibling rows carry `cohort_key='review'`, `cohort_depth=0`,
//       and the same `fan_out_group` uuid.
//   T3. After synthetically completing both siblings, the aggregator
//       records a `fan_in_decisions` row with `phase='review'` (= the
//       cohort_key, NOT the legacy 'review' default which the M6 path
//       also produces — this script proves the new path took
//       precedence by also asserting `runs.cohort_key IS NOT NULL`).
//   T4. Re-firing one completion event a second time is a no-op (no
//       duplicate decision rows).
//
// Pre-reqs
// ────────
// • Migration `20260603190000_phase2_5_cohort_plan.sql` applied
//   (`supabase db push`).
// • NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY in apps/web/.env.local.
// • Next dev :3000 running, Inngest dev :8288 running. No runner needed.
// • The Phase 2.5 dispatcher / fan-out / aggregator changes deployed
//   (they are by definition if the migration ran on the same head).
//
// Exit codes:
//   0 = pass
//   1 = test failure
//   2 = environment/setup not satisfied (incl. migration not applied)
//
// Run:
//   cd apps/web
//   node --env-file=.env.local scripts/phase2-5-cohort-plan-accept.mjs

import "./_legacy-env.mjs"; // legacy ACE_* env aliases (transitional)
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const INNGEST_DEV = process.env.INNGEST_DEV_URL ?? "http://localhost:8288";
const TENANT_ID = process.env.DEVPILOT_TEST_TENANT_ID ?? "e98507ec-d5a2-4951-8a5d-445c86dbfca8";
const TIMEOUT_MS = 60_000;

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

async function waitFor(label, predicate, timeoutMs = TIMEOUT_MS) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    const val = await predicate();
    last = val;
    if (val) return val;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`timeout waiting for: ${label}; lastValue=${JSON.stringify(last)}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// The cohort_plan we'll seed onto the ticket. Matches the headline example
// from the plan: PM triggers `review` (engineer + security, all, fan-in to
// qa); security triggers `deep_review` (appsec_engineer + compliance_grc,
// quorum(1), fan-in null).
const COHORT_PLAN = {
  version: 1,
  cohorts: [
    {
      cohort_key: "review",
      members: ["engineer", "security"],
      acceptance_strategy: "all",
      fan_in_role: "qa",
      parent_cohort_key: null,
      trigger_role: "pm",
    },
    {
      cohort_key: "deep_review",
      members: ["appsec_engineer", "compliance_grc"],
      acceptance_strategy: "quorum(1)",
      fan_in_role: null,
      parent_cohort_key: "review",
      trigger_role: "security",
    },
  ],
};

// T0 — migration applied? Probe column existence by selecting one row with
// the new columns. PostgREST returns a `42703` if the column is missing.
async function assertSchema() {
  const probes = [
    { tbl: "tickets", col: "cohort_plan" },
    { tbl: "runs", col: "cohort_key" },
    { tbl: "runs", col: "cohort_depth" },
  ];
  for (const { tbl, col } of probes) {
    const r = await sb(`${tbl}?select=${col}&limit=1`);
    if (r.status === 400 || r.status === 404) {
      const body = await r.text();
      console.error(
        `T0 schema probe: missing ${tbl}.${col} — apply migration 20260603190000 first. (${r.status} ${body})`,
      );
      process.exit(2);
    }
    if (!r.ok) {
      console.error(`T0 schema probe ${tbl}.${col} unexpected: ${r.status}`);
      process.exit(2);
    }
  }
}

async function createTicket() {
  const id = randomUUID();
  const res = await sb("tickets", {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: TENANT_ID,
      title: "M6 cohort_plan: PM triggers review cohort",
      description:
        "Acceptance script fixture. Cohort plan attached at ticket-creation " +
        "time so the dispatcher fans out cohort A on first dispatch instead " +
        "of running pm linearly. Engineer + Security spawn as siblings; " +
        "deep_review hangs off the security leaf.",
      acceptance_criteria:
        "two sibling runs, cohort_key=review, cohort_depth=0, fan_in_decisions row with phase=review",
      status: "ready",
      priority: 3,
      cohort_plan: COHORT_PLAN,
    }),
  });
  if (!res.ok) {
    throw new Error(`createTicket failed: ${res.status} ${await res.text()}`);
  }
  const [row] = await res.json();
  return row.id;
}

async function getTicket(id) {
  const r = await sb(`tickets?id=eq.${id}&select=id,status,fan_out_group,cohort_plan`);
  const rows = await r.json();
  return rows[0] ?? null;
}

async function getRunsForTicket(id) {
  const r = await sb(
    `runs?ticket_id=eq.${id}&select=id,status,fan_out_group,fan_out_role,cohort_key,cohort_depth,agent_id,parent_run_id&order=created_at.asc`,
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
// listens for. Mirrors phase1-m6-accept.mjs's pinned-run trick.
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
    fanOutGroup: run.fan_out_group ?? undefined,
    fanOutPhase: run.cohort_key ?? undefined,
  });
}

async function cleanup(ticketId) {
  // FK chain: fan_in_decisions → runs → tickets. Delete in reverse.
  const runs = await getRunsForTicket(ticketId);
  for (const r of runs) {
    await sb(`fan_in_decisions?fan_out_group=eq.${r.fan_out_group}`, {
      method: "DELETE",
    });
  }
  await sb(`runs?ticket_id=eq.${ticketId}`, { method: "DELETE" });
  await sb(`comments?ticket_id=eq.${ticketId}`, { method: "DELETE" });
  await sb(`run_steps?run_id=in.(${runs.map((r) => `"${r.id}"`).join(",") || '""'})`, {
    method: "DELETE",
  });
  await sb(`tickets?id=eq.${ticketId}`, { method: "DELETE" });
}

async function main() {
  console.log("─── Phase 2.5 / M6 — cohort_plan acceptance ───");

  // T0 — migration applied
  console.log("[T0] probing schema for cohort_plan / cohort_key / cohort_depth…");
  await assertSchema();
  console.log("    ✓ migration columns present");

  // Seed
  console.log("[seed] creating ticket with cohort_plan attached…");
  const ticketId = await createTicket();
  console.log(`    ticket id=${ticketId}`);

  let pass = false;
  try {
    // Kick the dispatcher
    await sendEvent("ticket/dispatch-needed", {
      ticketId,
      tenantId: TENANT_ID,
    });

    // T1 + T2 — cohort A seeded
    console.log("[T1/T2] waiting for cohort A fan-out (engineer + security)…");
    const seeded = await waitFor("two sibling runs with cohort_key='review'", async () => {
      const runs = await getRunsForTicket(ticketId);
      const reviewRuns = runs.filter((r) => r.cohort_key === "review");
      if (reviewRuns.length >= 2) return reviewRuns;
      return null;
    });
    assert(seeded.length === 2, `expected exactly 2 runs in cohort 'review', got ${seeded.length}`);
    const roles = new Set(seeded.map((r) => r.fan_out_role));
    assert(
      roles.has("engineer") && roles.has("security"),
      `expected members {engineer, security}, got {${[...roles].join(",")}}`,
    );
    const groups = new Set(seeded.map((r) => r.fan_out_group));
    assert(groups.size === 1, `expected one fan_out_group across siblings, got ${groups.size}`);
    const depths = new Set(seeded.map((r) => r.cohort_depth));
    assert(
      depths.size === 1 && depths.has(0),
      `expected cohort_depth=0 for top-level cohort, got [${[...depths].join(",")}]`,
    );
    console.log(`    ✓ cohort A seeded: 2 siblings, cohort_key=review, cohort_depth=0`);
    const fanOutGroupA = [...groups][0];

    // Verify ticket still bears the cohort_plan it was created with.
    const ticketAfter = await getTicket(ticketId);
    assert(ticketAfter?.cohort_plan?.cohorts?.length === 2, `ticket cohort_plan lost or rewritten`);

    // T3 — synthetic completion → aggregator records decision phase=review
    // 5s buffer so runAgent's INIT step (run-agent.ts:75 upserts status='running'
    // by id) has finished before our PATCH lands; otherwise INIT races with PATCH
    // and overwrites our 'done' back to 'running'.
    console.log("[T3] settling 5s for runAgent INIT to finish, then completing siblings…");
    await new Promise((r) => setTimeout(r, 5_000));
    for (const r of seeded) {
      await completeRun(r, ticketId);
    }
    const decisions = await waitFor("fan_in_decisions row with phase=review", async () => {
      const ds = await getDecisions(fanOutGroupA);
      return ds.length >= 1 ? ds : null;
    });
    const reviewDecision = decisions.find((d) => d.phase === "review");
    assert(
      reviewDecision,
      `expected fan_in_decisions row with phase='review', got phases=[${decisions.map((d) => d.phase).join(",")}]`,
    );
    assert(
      reviewDecision.outcome === "accepted",
      `expected outcome='accepted', got '${reviewDecision.outcome}'`,
    );
    console.log(`    ✓ aggregator recorded decision phase='review' outcome='accepted'`);

    // T4 — idempotency on re-fire
    console.log("[T4] re-firing one completion event — should be a no-op…");
    await completeRun(seeded[0], ticketId);
    await new Promise((r) => setTimeout(r, 3_000));
    const decisionsAfterReplay = await getDecisions(fanOutGroupA);
    assert(
      decisionsAfterReplay.length === decisions.length,
      `re-fire created duplicate decision rows: before=${decisions.length} after=${decisionsAfterReplay.length}`,
    );
    console.log("    ✓ idempotency held on completion replay");

    pass = true;
  } catch (err) {
    console.error("✗ FAIL", err.message);
    if (err.stack) console.error(err.stack);
    pass = false;
  } finally {
    console.log("[cleanup] deleting fixtures…");
    try {
      await cleanup(ticketId);
    } catch (e) {
      console.warn(`cleanup failed: ${e.message}`);
    }
  }

  if (pass) {
    console.log("─── ACCEPTANCE PASS ───");
    process.exit(0);
  } else {
    console.error("─── ACCEPTANCE FAIL ───");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("uncaught:", err);
  process.exit(1);
});
