// Phase 1 / M10 — SQL data sources + query-as-tool. The validator + executor
// for `query_db(dataSourceId, sql, params?)`.
//
// Defense-in-depth posture (CLAUDE.md §6 untrusted content + §3 hard ceilings):
//   1. SELECT-only. Reject every non-SELECT statement on the first whitespace-
//      stripped token. No CTE prefix exception — Postgres accepts `WITH ...`
//      before INSERT/UPDATE/DELETE, so we walk the keywords ourselves and
//      refuse anything that isn't strictly read-only.
//   2. Single statement. Reject any `;` inside the SQL after the first
//      non-trailing position. We strip exactly one trailing `;` and reject any
//      others — multi-statement is how injection payloads sneak DDL past
//      naive validators.
//   3. Allow-listed tables. Every identifier we can extract from FROM / JOIN
//      clauses must appear in `config.allowed_tables`. The extractor is
//      conservative — when it can't be sure, it refuses.
//   4. Mandatory LIMIT ≤ 1000. If the SQL has no LIMIT, we append `LIMIT 1000`.
//      If it has one ≤ 1000, we accept. > 1000 is refused.
//   5. Parameterised values only. The caller passes `params` as a positional
//      array bound to `$1`, `$2`, … . We NEVER string-interpolate.
//   6. 30s statement_timeout on every query (server-side, per pg session).
//   7. Read-only connection role. The operator must point the data source's
//      connection string at a Postgres user with only `SELECT` on the allowed
//      tables. This is a documented setup requirement, not enforced in code.
//
// All output of this module is UNTRUSTED CONTENT — the rows returned to the
// caller are data and must never be interpolated into prompts as instructions.
// The Data Engineer role's system prompt documents this contract; downstream
// callers must respect it.

import { Pool, type QueryResult } from "pg";
import { supabaseService } from "@/lib/db/server";

// ---- Configuration --------------------------------------------------------

const MAX_ROWS = 1000;
const STATEMENT_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * Per-data-source connection string lookup. The operator stores a secret REFERENCE
 * (the env var name) on the data source row; the actual connection string lives
 * in the process environment. Convention: `DEVPILOT_DATA_SOURCE_<UPPER_UUID>_URL`,
 * underscores instead of dashes. As a fallback, the literal string `DATABASE_URL`
 * may be used as the secret ref to point at the platform's own Supabase pooler
 * URL — handy for demos and self-served data (the M10 acceptance does this).
 *
 * If neither resolves to a non-empty string, queryDb refuses with a clear error.
 */
function resolveConnectionString(secretRef: string): string | null {
  const v = process.env[secretRef];
  if (v && v.length > 0) return v;
  return null;
}

export function defaultSecretRefForDataSource(dataSourceId: string): string {
  return `DEVPILOT_DATA_SOURCE_${dataSourceId.replace(/-/g, "_").toUpperCase()}_URL`;
}

// ---- Lazy pool registry ---------------------------------------------------

type PoolEntry = { pool: Pool; lastUsedAt: number };
const POOLS = new Map<string, PoolEntry>();

function getOrCreatePool(key: string, connectionString: string): Pool {
  let entry = POOLS.get(key);
  if (entry) {
    entry.lastUsedAt = Date.now();
    return entry.pool;
  }
  const pool = new Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: 10_000,
    // Enforce read-only semantics at session level on top of the operator's
    // role-level grants — belt + suspenders.
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  entry = { pool, lastUsedAt: Date.now() };
  POOLS.set(key, entry);
  return pool;
}

/**
 * Close pools that have been idle for ≥ IDLE_TIMEOUT_MS. Safe to call from a
 * cron / on-demand; the next queryDb will re-create the pool on demand.
 */
export async function reapIdlePools(): Promise<number> {
  const now = Date.now();
  let closed = 0;
  for (const [key, entry] of POOLS.entries()) {
    if (now - entry.lastUsedAt < IDLE_TIMEOUT_MS) continue;
    try {
      await entry.pool.end();
    } catch {
      // ignore — pool will be GC'd
    }
    POOLS.delete(key);
    closed++;
  }
  return closed;
}

/** Test-only — drop all pools without waiting for idle timeout. */
export async function _resetPoolsForTests(): Promise<void> {
  for (const [, entry] of POOLS.entries()) {
    try {
      await entry.pool.end();
    } catch {
      // ignore
    }
  }
  POOLS.clear();
}

// ---- SQL validator --------------------------------------------------------

export class SqlValidationError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "not_select"
      | "multi_statement"
      | "disallowed_table"
      | "limit_too_large"
      | "parse_ambiguity"
      | "empty",
  ) {
    super(message);
    this.name = "SqlValidationError";
  }
}

// Postgres write/DDL/DCL keywords we refuse outright. Listed even where the
// SELECT-only check already covers them, because we also walk the body for
// suspicious tokens (e.g. `SELECT ... INTO foo`, `CREATE VIEW ...`).
const FORBIDDEN_TOKENS: ReadonlySet<string> = new Set([
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "comment",
  "vacuum",
  "analyze",
  "reindex",
  "merge",
  "lock",
  "copy",
  "call",
  "do",
  "set", // SET statements can change session config (search_path, role, etc.)
  "reset",
  "discard",
  "listen",
  "notify",
  "unlisten",
  "checkpoint",
  "explain", // EXPLAIN ANALYZE actually executes — refuse.
]);

// SELECT ... INTO is read-implies-write; refuse.
const SELECT_INTO_RE = /\bselect\b[\s\S]*?\binto\b/i;

// Strip line + block comments before validation so an attacker can't hide a
// keyword inside a comment.
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

function normalize(sql: string): string {
  return sql.trim().replace(/\s+/g, " ");
}

function firstKeyword(sql: string): string {
  const m = sql.trimStart().match(/^[a-zA-Z_]+/);
  return (m?.[0] ?? "").toLowerCase();
}

// Extract identifiers after FROM / JOIN. Handles `schema.table`, quoted idents,
// optional aliases, and comma-separated FROM lists. Refuses on parse
// ambiguity (e.g. a `(` immediately after FROM — likely a subquery, which we
// do NOT walk into for the table allow-list; subqueries with derived tables
// are rejected for M10 because we can't be sure all referenced tables are
// allow-listed).
function extractReferencedTables(sql: string):
  | {
      ok: true;
      tables: string[];
    }
  | {
      ok: false;
      reason: string;
    } {
  const tables = new Set<string>();
  // Match FROM or JOIN followed by either:
  //   - an identifier (optionally schema-qualified, optionally quoted), then
  //     an optional alias.
  //   - a `(` — subquery — which we refuse for M10.
  const fromJoinRe = /\b(from|join)\b\s+([("a-zA-Z_][\w".]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = fromJoinRe.exec(sql)) !== null) {
    const first = m[2] ?? "";
    const verb = (m[1] ?? "").toLowerCase();
    if (first.startsWith("(")) {
      return { ok: false, reason: "subquery in FROM/JOIN — refused for M10" };
    }
    // Comma-separated FROM list: `from a, b, c` — pull each item by scanning
    // forward until the next clause keyword.
    if (verb === "from") {
      const tail = sql.slice(m.index + m[0].length);
      // Reconstruct full from-list: first identifier + any `, identifier`s
      // until the next clause keyword. Allow an optional alias (one bare
      // identifier or `AS <ident>`) between the table and the comma.
      const items: string[] = [first];
      // Match: optional " AS"? optional alias-ident, then comma, then table.
      const listRe = /\s*(?:as\s+)?(?:[a-zA-Z_]\w*)?\s*,\s*([("a-zA-Z_][\w".]*)/giy;
      listRe.lastIndex = 0;
      let consumed = 0;
      let mm: RegExpExecArray | null;
      while ((mm = listRe.exec(tail)) !== null) {
        const item = mm[1] ?? "";
        if (item.startsWith("(")) {
          return { ok: false, reason: "subquery in FROM list — refused for M10" };
        }
        items.push(item);
        consumed = listRe.lastIndex;
        // Stop at next clause keyword
        const next = tail.slice(consumed).trimStart().toLowerCase();
        if (
          next.startsWith("where") ||
          next.startsWith("group") ||
          next.startsWith("order") ||
          next.startsWith("limit") ||
          next.startsWith("having") ||
          next.startsWith("join") ||
          next.startsWith("left") ||
          next.startsWith("right") ||
          next.startsWith("inner") ||
          next.startsWith("outer") ||
          next.startsWith("full") ||
          next.startsWith("cross") ||
          next.startsWith(";") ||
          next.length === 0
        ) {
          break;
        }
      }
      for (const it of items) {
        const t = unqualifyTable(it);
        if (!t.ok) return t;
        tables.add(t.name);
      }
      continue;
    }
    const t = unqualifyTable(first);
    if (!t.ok) return t;
    tables.add(t.name);
  }
  return { ok: true, tables: Array.from(tables) };
}

function unqualifyTable(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  // Strip schema prefix and quotes. `public."tbl"` → `tbl`. `"public"."tbl"` → `tbl`.
  const parts = raw.split(".");
  const last = parts[parts.length - 1] ?? "";
  const unquoted = last.replace(/^"|"$/g, "");
  if (!/^[a-zA-Z_][\w]*$/.test(unquoted)) {
    return { ok: false, reason: `unparseable table identifier: ${raw}` };
  }
  return { ok: true, name: unquoted };
}

function findLimit(
  sql: string,
): { has: false } | { has: true; value: number } | { has: true; value: "unknown" } {
  const re = /\blimit\b\s+(\d+|\$\d+)/i;
  const m = re.exec(sql);
  if (!m) return { has: false };
  const tok = m[1] ?? "";
  if (tok.startsWith("$")) return { has: true, value: "unknown" };
  return { has: true, value: Number(tok) };
}

export type ValidationResult = {
  /** The possibly-LIMIT-appended SQL. Use this in the actual query. */
  sql: string;
  /** Tables matched against the allow-list. */
  tables: string[];
};

export function validateSelectSql(
  rawSql: string,
  allowedTables: ReadonlyArray<string>,
): ValidationResult {
  const stripped = stripComments(rawSql);
  const sql = normalize(stripped);

  if (sql.length === 0) {
    throw new SqlValidationError("empty SQL", "empty");
  }

  // Strip exactly one trailing `;` and reject any remaining (multi-statement).
  const body = sql.endsWith(";") ? sql.slice(0, -1) : sql;
  if (body.includes(";")) {
    throw new SqlValidationError("multi-statement SQL not allowed", "multi_statement");
  }

  // 1. First keyword must be SELECT (we don't accept WITH/CTE prefix in M10 —
  //    too many shapes hide writes behind CTEs; future M can re-enable with a
  //    deeper parser).
  const kw = firstKeyword(body);
  if (kw !== "select") {
    throw new SqlValidationError(`only SELECT statements allowed; got "${kw}"`, "not_select");
  }

  // 2. SELECT ... INTO is a write; refuse.
  if (SELECT_INTO_RE.test(body)) {
    throw new SqlValidationError("SELECT ... INTO is a write; refused", "not_select");
  }

  // 3. Walk every word; refuse on any forbidden token appearing as a bare
  //    identifier (not as part of an allow-listed table or column name). This
  //    is conservative — false positives are fine, the LLM/operator should
  //    rewrite the query.
  const tokens = body.toLowerCase().match(/\b[a-z_][a-z_0-9]*\b/g) ?? [];
  for (const t of tokens) {
    if (FORBIDDEN_TOKENS.has(t)) {
      throw new SqlValidationError(`forbidden keyword "${t}" in SQL`, "not_select");
    }
  }

  // 4. Table allow-list.
  const extract = extractReferencedTables(body);
  if (!extract.ok) {
    throw new SqlValidationError(extract.reason, "parse_ambiguity");
  }
  if (extract.tables.length === 0) {
    throw new SqlValidationError(
      "no FROM/JOIN clause found — refuse to run a tableless SELECT",
      "parse_ambiguity",
    );
  }
  const allowed = new Set(allowedTables.map((t) => t.toLowerCase()));
  for (const t of extract.tables) {
    if (!allowed.has(t.toLowerCase())) {
      throw new SqlValidationError(
        `table "${t}" not in allow-list [${allowedTables.join(", ")}]`,
        "disallowed_table",
      );
    }
  }

  // 5. LIMIT.
  const lim = findLimit(body);
  let finalSql = body;
  if (!lim.has) {
    finalSql = `${body} LIMIT ${MAX_ROWS}`;
  } else if (lim.value === "unknown") {
    // Parameterised limit — we can't verify ≤ MAX_ROWS at validation time;
    // refuse. Callers can hardcode a literal or skip the clause to let us add
    // our default.
    throw new SqlValidationError(
      "parameterised LIMIT not supported — omit LIMIT or use a literal ≤ 1000",
      "limit_too_large",
    );
  } else if (lim.value > MAX_ROWS) {
    throw new SqlValidationError(`LIMIT ${lim.value} exceeds max ${MAX_ROWS}`, "limit_too_large");
  }

  return { sql: finalSql, tables: extract.tables };
}

// ---- Data source row + queryDb -------------------------------------------

export type DataSourceConfig = {
  connection_secret_ref: string;
  allowed_tables: string[];
  read_only: boolean;
};

export type DataSourceRow = {
  id: string;
  tenant_id: string;
  kind: string;
  name: string;
  config: DataSourceConfig;
  read_only: boolean;
};

export async function loadDataSource(dataSourceId: string): Promise<DataSourceRow | null> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("data_sources")
    .select("id, tenant_id, kind, name, config, read_only")
    .eq("id", dataSourceId)
    .maybeSingle();
  if (error || !data) return null;
  return data as DataSourceRow;
}

export type QueryDbResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
  columns: string[];
  executionMs: number;
  sql: string;
};

export class DataSourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataSourceConfigError";
  }
}

/**
 * Run a validated SELECT against the named data source. Returns up to 1000
 * rows. Throws `SqlValidationError` on contract violations, `DataSourceConfigError`
 * on operator misconfiguration, and a generic `Error` on pg transport failures.
 */
export async function queryDb(
  dataSourceId: string,
  sql: string,
  params?: ReadonlyArray<unknown>,
): Promise<QueryDbResult> {
  const ds = await loadDataSource(dataSourceId);
  if (!ds) {
    throw new DataSourceConfigError(`data source ${dataSourceId} not found`);
  }
  if (ds.kind !== "sql") {
    throw new DataSourceConfigError(`data source ${dataSourceId} kind=${ds.kind} is not "sql"`);
  }
  const cfg = ds.config ?? ({} as DataSourceConfig);
  if (!cfg.read_only) {
    throw new DataSourceConfigError(
      `data source ${dataSourceId} is not marked read_only — refusing queries`,
    );
  }
  if (!Array.isArray(cfg.allowed_tables) || cfg.allowed_tables.length === 0) {
    throw new DataSourceConfigError(`data source ${dataSourceId} has empty allowed_tables`);
  }
  if (!cfg.connection_secret_ref || typeof cfg.connection_secret_ref !== "string") {
    throw new DataSourceConfigError(`data source ${dataSourceId} missing connection_secret_ref`);
  }

  // Validate SQL FIRST — cheaper than dialing pg, and surfaces a clear
  // SqlValidationError before any DB connection attempt. This also means
  // the validator integration tests in the M10 acceptance script catch
  // contract violations even when the data source's connection secret is
  // intentionally unset (e.g. CI without DATABASE_URL).
  const { sql: finalSql } = validateSelectSql(sql, cfg.allowed_tables);

  const connectionString = resolveConnectionString(cfg.connection_secret_ref);
  if (!connectionString) {
    throw new DataSourceConfigError(
      `connection secret "${cfg.connection_secret_ref}" not set in env`,
    );
  }

  const pool = getOrCreatePool(dataSourceId, connectionString);
  const start = Date.now();
  let result: QueryResult;
  const client = await pool.connect();
  try {
    // Belt + suspenders — session-level read-only + statement timeout. Even
    // though pg's `statement_timeout` pool option is set, also enforcing at
    // session level survives a future pool-option drift.
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET default_transaction_read_only = on`);
    result = await client.query(finalSql, params ? Array.from(params) : undefined);
  } finally {
    client.release();
  }
  const executionMs = Date.now() - start;
  const columns = result.fields?.map((f) => f.name) ?? [];
  return {
    rows: result.rows as Record<string, unknown>[],
    rowCount: result.rowCount ?? result.rows.length,
    columns,
    executionMs,
    sql: finalSql,
  };
}
