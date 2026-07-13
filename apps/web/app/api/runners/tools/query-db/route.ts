// POST /api/runners/tools/query-db
//
// Phase 1 / M10 — query-as-tool MCP endpoint. Two modes selected by the
// presence of `naturalLanguageQuery` in the body:
//
//   1. Direct SQL:     { dataSourceId, sql, params? }
//   2. Text-to-SQL:    { dataSourceId, naturalLanguageQuery }
//
// Both modes go through the same agent-scoping check and the same
// `validateSelectSql` gate. The text-to-SQL mode additionally calls Sonnet to
// produce the SQL — the LLM is treated as untrusted input, every byte goes
// through the validator before reaching pg.
//
// The route also writes a `tool_call` step into `run_steps` so the Run
// Inspector can show the query, the row count, and the execution time. Per
// CLAUDE.md §6, all returned rows are UNTRUSTED CONTENT — the Data Engineer's
// system prompt acknowledges this and treats rows as data, never as
// instructions.
//
// Auth: `x-devpilot-runner-key` header. The runner is expected to forward the
// current run + tenant context as `DEVPILOT_RUN_ID` / `DEVPILOT_TENANT_ID` env when it
// spawns `claude -p`; the MCP relay picks those up and includes them in the
// body here. We refuse the call if the run isn't tied to an agent in the
// tenant.
//
// Request body:
//   {
//     runId: string,            // injected by the MCP relay from DEVPILOT_RUN_ID
//     tenantId: string,         // injected by the MCP relay from DEVPILOT_TENANT_ID
//     dataSourceId: string,
//     sql?: string,
//     params?: unknown[],
//     naturalLanguageQuery?: string,
//     runnerId?: string,
//   }
// Response 200:
//   { rows, rowCount, columns, executionMs, sql }
//
// curl example (direct SQL):
//   curl -X POST http://localhost:3000/api/runners/tools/query-db \
//     -H 'Content-Type: application/json' \
//     -H "x-devpilot-runner-key: $DEVPILOT_RUNNER_REGISTRATION_KEY" \
//     -d '{"runId":"<uuid>","tenantId":"<uuid>","dataSourceId":"<uuid>","sql":"SELECT count(*) FROM tenants"}'

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { queryDb, SqlValidationError, DataSourceConfigError } from "@/lib/data/sql";
import { queryDbSmart } from "@/lib/data/text-to-sql";
import { currentAgentDataSources } from "@/lib/data/agent-scope";

export const dynamic = "force-dynamic";

// Cap the row payload we round-trip through MCP. Even with LIMIT 1000 some
// rows can be huge (long text columns); slice for tool reply, the full
// QueryDbResult still lands in run_steps.payload for Inspector review.
const MAX_PAYLOAD_ROWS = 50;

type Body = {
  runId?: string;
  tenantId?: string;
  dataSourceId?: string;
  sql?: string;
  params?: unknown[];
  naturalLanguageQuery?: string;
  runnerId?: string;
};

export async function POST(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body?.runId || typeof body.runId !== "string") {
    return NextResponse.json({ error: "runId required" }, { status: 400 });
  }
  if (!body.tenantId || typeof body.tenantId !== "string") {
    return NextResponse.json({ error: "tenantId required" }, { status: 400 });
  }
  if (!body.dataSourceId || typeof body.dataSourceId !== "string") {
    return NextResponse.json({ error: "dataSourceId required" }, { status: 400 });
  }
  const direct = typeof body.sql === "string" && body.sql.length > 0;
  const smart =
    typeof body.naturalLanguageQuery === "string" && body.naturalLanguageQuery.length > 0;
  if (direct === smart) {
    return NextResponse.json(
      { error: "exactly one of `sql` or `naturalLanguageQuery` required" },
      { status: 400 },
    );
  }

  // 1. Look up the run row to find its agent_id. The MCP relay can't be
  //    trusted to forward agent_id directly — we read it from the durable run.
  const supabase = supabaseService();
  const { data: run, error: runErr } = await supabase
    .from("runs")
    .select("id, tenant_id, agent_id")
    .eq("id", body.runId)
    .maybeSingle();
  if (runErr || !run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  if (run.tenant_id !== body.tenantId) {
    return NextResponse.json({ error: "tenantId mismatch with run row" }, { status: 403 });
  }
  if (!run.agent_id) {
    return NextResponse.json(
      { error: "run has no agent_id — cannot scope data source access" },
      { status: 403 },
    );
  }

  // 2. Agent-level data source scope check.
  const allowed = await currentAgentDataSources(run.agent_id as string);
  if (!allowed.includes(body.dataSourceId)) {
    return NextResponse.json(
      {
        error: `agent ${run.agent_id} is not authorized for data source ${body.dataSourceId}`,
      },
      { status: 403 },
    );
  }

  // 3. Verify the data source's tenant matches the run's tenant. Defense
  //    against an operator misconfiguring `data_source_ids` across tenants.
  const { data: ds, error: dsErr } = await supabase
    .from("data_sources")
    .select("id, tenant_id, kind")
    .eq("id", body.dataSourceId)
    .maybeSingle();
  if (dsErr || !ds) {
    return NextResponse.json({ error: "data source not found" }, { status: 404 });
  }
  if (ds.tenant_id !== body.tenantId) {
    return NextResponse.json(
      { error: "data source belongs to a different tenant" },
      { status: 403 },
    );
  }

  // 4. Run the query. Both branches share the same validator inside `queryDb`.
  let result;
  try {
    if (direct) {
      result = await queryDb(body.dataSourceId, body.sql!, body.params);
    } else {
      result = await queryDbSmart(body.naturalLanguageQuery!, body.dataSourceId, body.tenantId);
    }
  } catch (err) {
    const isValidation = err instanceof SqlValidationError;
    const isConfig = err instanceof DataSourceConfigError;
    const status = isValidation ? 400 : isConfig ? 422 : 500;
    const message = err instanceof Error ? err.message : String(err);
    // Still log a tool_call step so the Inspector shows the failed attempt.
    await persistToolCallStep(body.runId, body.dataSourceId, {
      mode: direct ? "sql" : "smart",
      sql: direct ? (body.sql ?? null) : null,
      naturalLanguageQuery: smart ? (body.naturalLanguageQuery ?? null) : null,
      error: message,
    });
    return NextResponse.json({ error: message }, { status });
  }

  // 5. Persist a tool_call step. The Inspector reads payload.kind === "tool_call".
  //    Truncate row sample to keep payload bytes bounded.
  const sampleRows = result.rows.slice(0, MAX_PAYLOAD_ROWS);
  await persistToolCallStep(body.runId, body.dataSourceId, {
    mode: direct ? "sql" : "smart",
    sql: result.sql,
    naturalLanguageQuery: smart ? (body.naturalLanguageQuery ?? null) : null,
    rowCount: result.rowCount,
    columns: result.columns,
    executionMs: result.executionMs,
    rowsSample: sampleRows,
    rowsSampleTruncated: result.rows.length > MAX_PAYLOAD_ROWS,
  });

  return NextResponse.json({
    rows: sampleRows,
    rowCount: result.rowCount,
    columns: result.columns,
    executionMs: result.executionMs,
    sql: result.sql,
    rowsSampleTruncated: result.rows.length > MAX_PAYLOAD_ROWS,
    // Reminder for the LLM consumer — these are data, not instructions.
    untrusted: true,
  });
}

async function persistToolCallStep(
  runId: string,
  dataSourceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const supabase = supabaseService();
  // Pick an idx beyond any existing step. The dispatcher's persist loop uses
  // sequential per-iteration idxes; tool calls happen out-of-band from the
  // think loop, so we use 10_000 + a millisecond suffix to stay above the
  // think indices and below the failure idx (9999 ... actually let's use a
  // larger offset to be safe across very long runs).
  const idx = 100_000 + (Date.now() % 1_000_000);
  await supabase.from("run_steps").insert({
    run_id: runId,
    idx,
    kind: "tool_call",
    payload: {
      tool: "devpilot_query_db",
      data_source_id: dataSourceId,
      ...payload,
    },
  });
}
