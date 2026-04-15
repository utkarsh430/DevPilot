// Phase 1 / M10 — text-to-SQL wrapper around queryDb.
//
// Translation contract: natural-language question → ONE Postgres SELECT against
// only the allow-listed tables, single LIMIT ≤ 1000, no narration. The LLM is
// NOT trusted to obey this contract on its own — every generated SQL passes
// through the same `validateSelectSql` gate as `queryDb` directly. The LLM is
// one of two trust principals; the operator's allow-list is the other. Both
// must agree before execution.

import { generateText } from "ai";
import { getLlmAuthMode } from "@/lib/llm/auth-mode.server";
import { requireDirectApiModel } from "@/lib/llm/generate.server";
import { featureNeedsApiKeyModeError, routeForAuthMode } from "@/lib/llm/routing";
import {
  loadDataSource,
  queryDb,
  type DataSourceConfig,
  type QueryDbResult,
  DataSourceConfigError,
} from "@/lib/data/sql";
import { Pool } from "pg";

// ---- Schema discovery -----------------------------------------------------
//
// For each allow-listed table, ask information_schema for the column list.
// This is the smallest amount of schema the LLM needs to write a correct
// query and the largest amount we're willing to give it — no row samples,
// no value distributions (those leak data; the operator hasn't sanctioned
// us reading them just because the table is allow-listed).

type TableSchema = {
  table: string;
  columns: { name: string; type: string; nullable: boolean }[];
};

async function loadAllowedTableSchemas(
  connectionString: string,
  allowedTables: ReadonlyArray<string>,
): Promise<TableSchema[]> {
  // One-off pool just for schema discovery — short-lived, intentionally not
  // pooled per-data-source (this runs once per text-to-SQL invocation; reuse
  // via the global Pool would conflate read-only vs schema-read intent).
  const pool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  try {
    const client = await pool.connect();
    try {
      await client.query(`SET default_transaction_read_only = on`);
      const res = await client.query(
        `select table_schema, table_name, column_name, data_type, is_nullable
         from information_schema.columns
         where table_name = any($1::text[])
         order by table_name, ordinal_position`,
        [allowedTables],
      );
      const byTable = new Map<string, TableSchema>();
      for (const row of res.rows as Array<{
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>) {
        // Only honor public-schema tables in M10. Cross-schema is a future
        // operator opt-in.
        if (row.table_schema !== "public") continue;
        let entry = byTable.get(row.table_name);
        if (!entry) {
          entry = { table: row.table_name, columns: [] };
          byTable.set(row.table_name, entry);
        }
        entry.columns.push({
          name: row.column_name,
          type: row.data_type,
          nullable: row.is_nullable === "YES",
        });
      }
      return Array.from(byTable.values());
    } finally {
      client.release();
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// ---- Prompt construction --------------------------------------------------

const SYSTEM_PROMPT = [
  "You translate a natural-language question into ONE Postgres SELECT statement.",
  "Output rules — non-negotiable, the consumer parses your reply with a regex:",
  "  1. Reply with EXACTLY ONE SQL statement. No prose. No code fences. No comments.",
  "  2. The statement MUST begin with the word SELECT (uppercase).",
  "  3. Only reference tables in the provided schema. Do not invent tables.",
  "  4. Include exactly ONE `LIMIT N` clause where N <= 1000. If the question",
  "     implies a small answer (aggregates), pick a small LIMIT (e.g. 100).",
  "  5. Use parameterised placeholders ($1, $2, ...) only if explicitly needed.",
  "     For a one-shot natural-language query, inline literals are fine.",
  "  6. No CTEs, no subqueries, no SET commands, no JOINs to tables outside the",
  "     provided schema.",
  "  7. Do NOT include a trailing semicolon.",
].join("\n");

function schemaPrompt(schemas: TableSchema[]): string {
  if (schemas.length === 0) {
    return "(No schema available — the allow-listed tables don't exist in the target database.)";
  }
  const lines: string[] = ["SCHEMA:"];
  for (const t of schemas) {
    lines.push(`  ${t.table}(`);
    for (const c of t.columns) {
      lines.push(`    ${c.name} ${c.type}${c.nullable ? "" : " NOT NULL"}`);
    }
    lines.push("  )");
  }
  return lines.join("\n");
}

// Extract the SELECT statement from the LLM's reply. Strips markdown fences
// if the LLM disregarded rule 1 — defense against the "drift on long
// schemas" failure mode.
function extractSelect(text: string): string {
  let t = text.trim();
  // Strip ```sql ... ``` or ``` ... ```
  const fence = t.match(/^```(?:sql)?\s*([\s\S]*?)\s*```$/i);
  if (fence && fence[1] != null) t = fence[1].trim();
  // Take everything up to the first ; or end-of-string
  const semi = t.indexOf(";");
  if (semi >= 0) t = t.slice(0, semi).trim();
  return t;
}

// ---- Public API -----------------------------------------------------------

export type QueryDbSmartResult = QueryDbResult & {
  /** The natural-language input. */
  naturalLanguageQuery: string;
  /** The SQL the LLM produced (post-validator, post-LIMIT-append). */
  sql: string;
};

/**
 * Translate `naturalLanguageQuery` to one Postgres SELECT against the named
 * data source's allow-listed tables, run it through `queryDb`'s validator,
 * and execute. Throws on any contract violation — the LLM's SQL is treated
 * as untrusted user input.
 */
export async function queryDbSmart(
  naturalLanguageQuery: string,
  dataSourceId: string,
  tenantId: string,
): Promise<QueryDbSmartResult> {
  // Auth-mode gate. This runs INSIDE an in-flight runner job (the agent's
  // query_db tool call), so in claude_code mode it cannot be routed back
  // through the runner — a nested one-shot job would compete for (and at
  // CONCURRENCY=1 deadlock on) the same subscription slots. The direct API
  // with the tenant-resolved key is the only viable path; when the tenant
  // hasn't opted into api_key mode, fail with actionable copy (the agent can
  // still fall back to writing SQL itself via the direct query mode).
  const mode = await getLlmAuthMode(tenantId);
  if (routeForAuthMode(mode) !== "direct_api") {
    throw new DataSourceConfigError(
      featureNeedsApiKeyModeError("Natural-language querying (smart mode)") +
        " Alternatively, write the SELECT yourself and use the direct `sql` mode.",
    );
  }
  const modelRes = await requireDirectApiModel(
    tenantId,
    "default",
    "Natural-language querying (smart mode)",
  );
  if (!modelRes.ok) {
    throw new DataSourceConfigError(modelRes.error);
  }

  const ds = await loadDataSource(dataSourceId);
  if (!ds) {
    throw new DataSourceConfigError(`data source ${dataSourceId} not found`);
  }
  if (ds.kind !== "sql") {
    throw new DataSourceConfigError(`data source ${dataSourceId} kind=${ds.kind} is not "sql"`);
  }
  const cfg = ds.config as DataSourceConfig;
  const connectionString = process.env[cfg.connection_secret_ref];
  if (!connectionString || connectionString.length === 0) {
    throw new DataSourceConfigError(
      `connection secret "${cfg.connection_secret_ref}" not set in env`,
    );
  }

  // 1. Pull schema for the allow-listed tables.
  const schemas = await loadAllowedTableSchemas(connectionString, cfg.allowed_tables);

  // 2. Ask Sonnet for a single SELECT.
  const prompt =
    `${schemaPrompt(schemas)}\n\n` + `QUESTION: ${naturalLanguageQuery}\n\n` + `Write the SQL now:`;
  const gen = await generateText({
    model: modelRes.model,
    system: SYSTEM_PROMPT,
    prompt,
  });
  const sql = extractSelect(gen.text);

  // 3. Run through the validator + executor. Throws if the LLM disobeyed
  //    the contract — caller (the Data Engineer's tool path) surfaces the
  //    error to the run as a failed tool_call.
  const result = await queryDb(dataSourceId, sql);

  return {
    ...result,
    naturalLanguageQuery,
    sql: result.sql,
  };
}
