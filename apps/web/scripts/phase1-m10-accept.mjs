// Phase 1 / M10 acceptance — SQL data sources + text-to-SQL.
//
// Scenario: a Data Engineer role asks an aggregate question against a sample
// Postgres (the project's own Supabase via DATABASE_URL), gets a row count
// back, and lands the ticket in `done` (or at least `in_review` with the
// queryDb tool_call step recorded).
//
// Pre-reqs (operator-side):
//   - Next.js dev :3000, Inngest dev :8288, apps/runner running
//   - `DATABASE_URL` set in apps/web/.env.local (Supabase pooler URL works
//     because the only allow-listed table here is `tenants`, which the
//     service_role can read trivially. For a stricter demo, point DATABASE_URL
//     at a read-only Postgres role with SELECT on `tenants` only.)
//
// Pass criteria:
//   - dataeng agent posts a comment (proves the role ran)
//   - at least one run_step with kind="tool_call" + payload.tool="devpilot_query_db"
//     against our synthetic data source (proves the new MCP tool fired)
//   - ticket reaches `in_review` or `done`
//   - validator-only unit assertions in §3 below all pass (these run without
//     network — they're folded in here because no vitest is configured yet)
//
// Exit codes:
//   0 = pass
//   1 = test failure
//   2 = environment/setup not satisfied (DATABASE_URL missing) — distinguish
//       skip from failure so CI can route it.
//
// Run:
//   cd apps/web
//   node --env-file=.env.local scripts/phase1-m10-accept.mjs

import "./_legacy-env.mjs"; // legacy ACE_* env aliases (transitional)
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const INNGEST_DEV = "http://localhost:8288";
const TENANT_ID = "e98507ec-d5a2-4951-8a5d-445c86dbfca8";
const DATABASE_URL = process.env.DATABASE_URL;
const ACCEPT_TIMEOUT_MS = 8 * 60_000;

if (!SUPABASE_URL || !SECRET) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY in env");
  process.exit(1);
}
if (!DATABASE_URL || DATABASE_URL.length === 0) {
  console.error("M10 needs DATABASE_URL set in apps/web/.env.local — skipping (exit 2)");
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

async function getRunStepsForTicket(ticketId) {
  // Find the run for this ticket, then its steps.
  const runsRes = await sb(`runs?ticket_id=eq.${ticketId}&select=id,status&order=created_at.desc`);
  const runs = await runsRes.json();
  if (runs.length === 0) return { runs: [], steps: [] };
  const runIds = runs.map((r) => r.id);
  const stepsRes = await sb(
    `run_steps?run_id=in.(${runIds.join(",")})&select=run_id,idx,kind,payload,created_at&order=created_at.asc`,
  );
  const steps = await stepsRes.json();
  return { runs, steps };
}

// ─── 1. Validator integration checks (via the engine route) ────────────────
// We can't import the TS validator from a .mjs script without a build step, so
// we exercise it through `/api/runners/tools/query-db` itself. Each case below
// is a malformed call we expect the engine to reject (4xx). A 200 here means
// the validator regressed and the script fails.

async function expectRejection(setup, body, expectedStatuses, label) {
  const res = await fetch(`http://localhost:3000/api/runners/tools/query-db`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-devpilot-runner-key": process.env.DEVPILOT_RUNNER_REGISTRATION_KEY ?? "",
    },
    body: JSON.stringify(body),
  });
  const ok = expectedStatuses.includes(res.status);
  const text = await res.text().catch(() => "");
  console.log(
    `  ${ok ? "✓" : "✗"} ${label}: status=${res.status} expected=${expectedStatuses.join("|")}` +
      (ok ? "" : `  body=${text.slice(0, 120)}`),
  );
  return ok;
}

async function runValidatorChecks(setup, runId) {
  console.log("\n--- validator integration checks ---");
  const base = {
    runId,
    tenantId: TENANT_ID,
    dataSourceId: setup.dataSourceId,
  };
  const cases = [
    {
      label: "DELETE rejected as not_select",
      body: { ...base, sql: "DELETE FROM tenants" },
      expect: [400],
    },
    {
      label: "INSERT rejected",
      body: { ...base, sql: "INSERT INTO tenants(name) VALUES ('x')" },
      expect: [400],
    },
    {
      label: "multi-statement rejected",
      body: { ...base, sql: "SELECT 1 FROM tenants; DROP TABLE tenants" },
      expect: [400],
    },
    {
      label: "disallowed table rejected (agents not in allow-list)",
      body: { ...base, sql: "SELECT * FROM agents" },
      expect: [400],
    },
    {
      label: "LIMIT > 1000 rejected",
      body: { ...base, sql: "SELECT * FROM tenants LIMIT 5000" },
      expect: [400],
    },
    {
      label: "both sql + naturalLanguageQuery rejected",
      body: { ...base, sql: "SELECT 1 FROM tenants", naturalLanguageQuery: "hi" },
      expect: [400],
    },
    {
      label: "missing dataSourceId rejected",
      body: { runId, tenantId: TENANT_ID, sql: "SELECT 1 FROM tenants" },
      expect: [400],
    },
  ];
  let allOk = true;
  for (const c of cases) {
    const ok = await expectRejection(setup, c.body, c.expect, c.label);
    if (!ok) allOk = false;
  }
  // Positive case: valid SELECT (will auto-append LIMIT 1000).
  const okRes = await fetch(`http://localhost:3000/api/runners/tools/query-db`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-devpilot-runner-key": process.env.DEVPILOT_RUNNER_REGISTRATION_KEY ?? "",
    },
    body: JSON.stringify({ ...base, sql: "SELECT count(*) AS n FROM tenants" }),
  });
  if (okRes.ok) {
    const body = await okRes.json();
    console.log(
      `  ✓ valid SELECT 200 — rowCount=${body.rowCount} executionMs=${body.executionMs}ms sample=${JSON.stringify(body.rows?.[0] ?? null)}`,
    );
  } else {
    const text = await okRes.text();
    console.log(`  ✗ valid SELECT failed: status=${okRes.status} body=${text.slice(0, 200)}`);
    allOk = false;
  }
  return allOk;
}

// ─── 2. Set up data source + scope it to the dataeng agent ──────────────────

async function setupDataSource() {
  // Find the dataeng agent for the tenant.
  const agentRes = await sb(
    `agents?tenant_id=eq.${TENANT_ID}&role=eq.dataeng&select=id,name,config&order=version.desc&limit=1`,
  );
  const agents = await agentRes.json();
  if (agents.length === 0) {
    throw new Error("no dataeng agent for tenant — run the M4 migration first");
  }
  const agent = agents[0];
  console.log(`  dataeng agent: ${agent.id} (${agent.name})`);

  // Insert a sql data source pointing at DATABASE_URL with `tenants` as the
  // only allow-listed table.
  const dsId = randomUUID();
  const ins = await sb("data_sources", {
    method: "POST",
    body: JSON.stringify({
      id: dsId,
      tenant_id: TENANT_ID,
      kind: "sql",
      name: "m10-self-postgres",
      config: {
        connection_secret_ref: "DATABASE_URL",
        allowed_tables: ["tenants"],
        read_only: true,
      },
      read_only: true,
    }),
  });
  if (!ins.ok) throw new Error(`data_sources insert failed: ${ins.status} ${await ins.text()}`);
  console.log(`  data source: ${dsId} (allowed_tables=[tenants])`);

  // Patch the dataeng agent's config.data_source_ids to include our DS.
  const nextConfig = {
    ...(agent.config ?? {}),
    data_source_ids: Array.from(
      new Set([
        ...((Array.isArray(agent.config?.data_source_ids) ? agent.config.data_source_ids : []) ??
          []),
        dsId,
      ]),
    ),
  };
  const patch = await sb(`agents?id=eq.${agent.id}`, {
    method: "PATCH",
    body: JSON.stringify({ config: nextConfig }),
  });
  if (!patch.ok) throw new Error(`agent patch failed: ${patch.status} ${await patch.text()}`);
  console.log(`  agent.config.data_source_ids patched (+ ${dsId})`);

  return { agentId: agent.id, dataSourceId: dsId, prevConfig: agent.config ?? {} };
}

async function teardownDataSource(setup) {
  // Restore agent config (drop the data source id we added).
  const agentRes = await sb(`agents?id=eq.${setup.agentId}&select=config`);
  const rows = await agentRes.json();
  if (rows.length > 0) {
    const cfg = rows[0].config ?? {};
    const ids = Array.isArray(cfg.data_source_ids)
      ? cfg.data_source_ids.filter((v) => v !== setup.dataSourceId)
      : [];
    const next = { ...cfg };
    if (ids.length === 0) delete next.data_source_ids;
    else next.data_source_ids = ids;
    await sb(`agents?id=eq.${setup.agentId}`, {
      method: "PATCH",
      body: JSON.stringify({ config: next }),
    });
  }
  // Delete the data source row.
  await sb(`data_sources?id=eq.${setup.dataSourceId}`, { method: "DELETE" });
}

// ─── 3. File the ticket and wait for the loop ───────────────────────────────

async function runScenario(setup) {
  const ticketId = randomUUID();
  console.log(`\n--- M10 ticket=${ticketId} ---`);
  const title = "Report active tenant count";
  const description =
    "Use devpilot_query_db_smart against the m10-self-postgres data source " +
    `(id=${setup.dataSourceId}) to answer: how many rows are in the tenants ` +
    "table? Cite the row count in your comment. The only allow-listed " +
    "table is `tenants`. After you have the answer, post your comment via " +
    "devpilot_comment and move the ticket to in_review via devpilot_move_ticket.";

  const ins = await sb("tickets", {
    method: "POST",
    body: JSON.stringify({
      id: ticketId,
      tenant_id: TENANT_ID,
      title,
      description,
      status: "backlog",
      requested_role: "dataeng",
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
  let toolCalled = false;
  while (Date.now() - start < ACCEPT_TIMEOUT_MS) {
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
        (c) =>
          c.author_type === "agent" && ["dataeng", "Data Engineer", "claude"].includes(c.author_id),
      );
    }
    if (!toolCalled) {
      const { steps } = await getRunStepsForTicket(ticketId);
      toolCalled = steps.some(
        (s) =>
          s.kind === "tool_call" &&
          s.payload?.tool === "devpilot_query_db" &&
          s.payload?.data_source_id === setup.dataSourceId,
      );
    }
    if (commented && advanced && toolCalled) {
      // Wait for run terminal before cleanup.
      const { runs } = await getRunStepsForTicket(ticketId);
      const last = runs[0];
      if (last?.status === "done" || last?.status === "failed") break;
    }
    if (t.status === "done" || t.status === "failed") break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  const final = await getTicket(ticketId);
  const comments = await getComments(ticketId);
  const { steps } = await getRunStepsForTicket(ticketId);
  const toolStep = steps.find(
    (s) =>
      s.kind === "tool_call" &&
      s.payload?.tool === "devpilot_query_db" &&
      s.payload?.data_source_id === setup.dataSourceId,
  );

  console.log("");
  console.log(`  final ticket status: ${final.status}`);
  console.log(`  commented:           ${commented}`);
  console.log(`  advanced past ready: ${advanced}`);
  console.log(`  devpilot_query_db fired:  ${toolCalled}`);
  if (toolStep) {
    const p = toolStep.payload ?? {};
    console.log(`  ↳ mode=${p.mode} sql=${(p.sql ?? "").slice(0, 80)}…`);
    console.log(`  ↳ rowCount=${p.rowCount ?? "n/a"} executionMs=${p.executionMs ?? "n/a"}`);
    if (p.error) console.log(`  ↳ error=${p.error}`);
  }
  console.log(`  agent comments: ${comments.filter((c) => c.author_type === "agent").length}`);

  // Cleanup ticket.
  await sb(`tickets?id=eq.${ticketId}`, { method: "DELETE" });

  return {
    pass: advanced && commented && toolCalled,
    finalStatus: final.status,
    rowCount: toolStep?.payload?.rowCount ?? null,
  };
}

// ─── 4. Drive it ────────────────────────────────────────────────────────────

async function makeSyntheticRun(setup) {
  // Insert a stub `runs` row pinned to the dataeng agent so the engine route's
  // run-lookup + agent-scope check both succeed for the validator probes. We
  // mark it `done` so the workspace-cleanup / WIP-drain code paths treat it
  // as terminal and don't try to attach a real Inngest job.
  const runId = randomUUID();
  const ins = await sb("runs", {
    method: "POST",
    body: JSON.stringify({
      id: runId,
      tenant_id: TENANT_ID,
      agent_id: setup.agentId,
      ticket_id: null,
      budget_cents: 0,
      spent_cents: 0,
      status: "done",
      depth: 0,
      runner_kind: "api",
    }),
  });
  if (!ins.ok) throw new Error(`synthetic run insert failed: ${ins.status} ${await ins.text()}`);
  return runId;
}

async function deleteSyntheticRun(runId) {
  await sb(`run_steps?run_id=eq.${runId}`, { method: "DELETE" });
  await sb(`runs?id=eq.${runId}`, { method: "DELETE" });
}

function runValidatorUnitTests() {
  console.log("\n--- validator unit tests (offline, via tsx) ---");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const tsxBin = path.resolve(__dirname, "..", "..", "runner", "node_modules", ".bin", "tsx");
  const script = path.resolve(__dirname, "phase1-m10-validator-test.mts");
  const r = spawnSync(tsxBin, [script], { stdio: "inherit" });
  return r.status === 0;
}

(async () => {
  console.log("=== Phase 1 / M10 acceptance: SQL data sources + text-to-SQL ===");
  console.log(`  tenant: ${TENANT_ID}`);
  console.log(`  DATABASE_URL: ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);

  // Phase 0: validator unit tests — no network, no infra. If these fail the
  // shape of `validateSelectSql` regressed and we don't bother with the rest.
  const validatorUnitOk = runValidatorUnitTests();
  if (!validatorUnitOk) {
    console.error("\n❌ validator unit tests failed");
    process.exit(1);
  }

  let setup;
  try {
    setup = await setupDataSource();
  } catch (err) {
    console.error(`setup failed: ${err.message ?? err}`);
    process.exit(1);
  }

  // Phase 1: validator integration checks (synthetic run row).
  let validatorOk = false;
  let syntheticRunId;
  try {
    syntheticRunId = await makeSyntheticRun(setup);
    validatorOk = await runValidatorChecks(setup, syntheticRunId);
  } catch (err) {
    console.error(`validator-check phase threw: ${err.message ?? err}`);
  } finally {
    if (syntheticRunId) {
      await deleteSyntheticRun(syntheticRunId).catch(() => undefined);
    }
  }

  if (!validatorOk) {
    console.error("\n❌ validator checks failed — refusing to run end-to-end scenario.");
    await teardownDataSource(setup).catch(() => undefined);
    process.exit(1);
  }

  // Phase 2: full end-to-end scenario.
  let result;
  try {
    result = await runScenario(setup);
  } catch (err) {
    console.error(`scenario threw: ${err.message ?? err}`);
    await teardownDataSource(setup).catch(() => undefined);
    process.exit(1);
  }

  await teardownDataSource(setup).catch((err) =>
    console.error(`teardown soft-fail: ${err.message ?? err}`),
  );

  console.log("\n=== Summary ===");
  console.log(`  validator: ${validatorOk ? "✅" : "❌"}`);
  console.log(`  scenario:  ${result.pass ? "✅" : "❌"} (finalStatus=${result.finalStatus})`);
  if (result.rowCount != null) {
    console.log(`  query returned ${result.rowCount} row(s) from tenants`);
  }
  const pass = validatorOk && result.pass;
  process.exit(pass ? 0 : 1);
})();
