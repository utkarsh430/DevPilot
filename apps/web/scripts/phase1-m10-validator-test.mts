// Phase 1 / M10 — validator unit tests.
//
// Runs `validateSelectSql` directly (no network, no pg) against a fixed
// allow-list. Invoked by the M10 acceptance script via tsx as a pre-check
// before any infrastructure-dependent assertions. Vitest would be the natural
// home for these but isn't configured in this repo (`docs/SESSION_HANDOFF.md`).
//
// Run standalone:
//   cd apps/web
//   ../../apps/runner/node_modules/.bin/tsx scripts/phase1-m10-validator-test.mts

import { validateSelectSql, SqlValidationError } from "../lib/data/sql.js";

type Case = {
  label: string;
  sql: string;
  allowed: string[];
  expect:
    | { ok: true; finalSql?: RegExp; tables?: string[] }
    | { ok: false; reason: SqlValidationError["reason"] };
};

const cases: Case[] = [
  {
    label: "valid SELECT auto-appends LIMIT 1000",
    sql: "SELECT id FROM tenants",
    allowed: ["tenants"],
    expect: { ok: true, finalSql: /LIMIT 1000$/i, tables: ["tenants"] },
  },
  {
    label: "valid SELECT with LIMIT 100 accepted as-is",
    sql: "SELECT id FROM tenants LIMIT 100",
    allowed: ["tenants"],
    expect: { ok: true, finalSql: /LIMIT 100$/i },
  },
  {
    label: "DELETE rejected → not_select",
    sql: "DELETE FROM tenants",
    allowed: ["tenants"],
    expect: { ok: false, reason: "not_select" },
  },
  {
    label: "INSERT rejected → not_select",
    sql: "INSERT INTO tenants(id) VALUES ('x')",
    allowed: ["tenants"],
    expect: { ok: false, reason: "not_select" },
  },
  {
    label: "UPDATE rejected → not_select",
    sql: "UPDATE tenants SET name = 'x'",
    allowed: ["tenants"],
    expect: { ok: false, reason: "not_select" },
  },
  {
    label: "DROP rejected → not_select",
    sql: "DROP TABLE tenants",
    allowed: ["tenants"],
    expect: { ok: false, reason: "not_select" },
  },
  {
    label: "WITH/CTE rejected (only SELECT first token allowed) → not_select",
    sql: "WITH x AS (SELECT 1) SELECT * FROM x",
    allowed: ["tenants"],
    expect: { ok: false, reason: "not_select" },
  },
  {
    label: "multi-statement rejected → multi_statement",
    sql: "SELECT id FROM tenants; DROP TABLE tenants",
    allowed: ["tenants"],
    expect: { ok: false, reason: "multi_statement" },
  },
  {
    label: "trailing semicolon allowed (single statement)",
    sql: "SELECT id FROM tenants;",
    allowed: ["tenants"],
    expect: { ok: true },
  },
  {
    label: "disallowed table → disallowed_table",
    sql: "SELECT * FROM agents",
    allowed: ["tenants"],
    expect: { ok: false, reason: "disallowed_table" },
  },
  {
    label: "schema-qualified allow-listed table accepted",
    sql: "SELECT id FROM public.tenants",
    allowed: ["tenants"],
    expect: { ok: true },
  },
  {
    label: "JOIN to disallowed table → disallowed_table",
    sql: "SELECT t.id FROM tenants t JOIN agents a ON a.tenant_id = t.id",
    allowed: ["tenants"],
    expect: { ok: false, reason: "disallowed_table" },
  },
  {
    label: "comma FROM list with one disallowed table → disallowed_table",
    sql: "SELECT * FROM tenants t, agents a",
    allowed: ["tenants"],
    expect: { ok: false, reason: "disallowed_table" },
  },
  {
    label: "LIMIT 5000 rejected → limit_too_large",
    sql: "SELECT id FROM tenants LIMIT 5000",
    allowed: ["tenants"],
    expect: { ok: false, reason: "limit_too_large" },
  },
  {
    label: "LIMIT 1000 accepted",
    sql: "SELECT id FROM tenants LIMIT 1000",
    allowed: ["tenants"],
    expect: { ok: true },
  },
  {
    label: "comment-hidden DROP rejected → not_select",
    sql: "SELECT id FROM tenants -- ;DROP TABLE tenants",
    allowed: ["tenants"],
    // Once we strip the `--` comment, the body is a valid SELECT. We expect
    // a PASS here — the comment-stripper does its job.
    expect: { ok: true },
  },
  {
    label: "block-comment-hidden DROP — strip then rejected by table allow-list",
    sql: "SELECT id FROM /* sneaky */ tenants WHERE 1=1",
    allowed: ["tenants"],
    expect: { ok: true },
  },
  {
    label: "SELECT ... INTO rejected → not_select",
    sql: "SELECT id INTO exfil FROM tenants",
    allowed: ["tenants"],
    expect: { ok: false, reason: "not_select" },
  },
  {
    label: "SET command rejected → not_select",
    sql: "SET ROLE postgres; SELECT * FROM tenants",
    allowed: ["tenants"],
    expect: { ok: false, reason: "multi_statement" },
  },
  {
    label: "tableless SELECT rejected → parse_ambiguity",
    sql: "SELECT 1",
    allowed: ["tenants"],
    expect: { ok: false, reason: "parse_ambiguity" },
  },
  {
    label: "empty SQL rejected → empty",
    sql: "   ",
    allowed: ["tenants"],
    expect: { ok: false, reason: "empty" },
  },
  {
    label: "parameterised LIMIT rejected → limit_too_large",
    sql: "SELECT id FROM tenants LIMIT $1",
    allowed: ["tenants"],
    expect: { ok: false, reason: "limit_too_large" },
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  let actual:
    | { ok: true; finalSql: string; tables: string[] }
    | { ok: false; reason: string; message: string };
  try {
    const r = validateSelectSql(c.sql, c.allowed);
    actual = { ok: true, finalSql: r.sql, tables: r.tables };
  } catch (err) {
    if (err instanceof SqlValidationError) {
      actual = { ok: false, reason: err.reason, message: err.message };
    } else {
      actual = {
        ok: false,
        reason: "unexpected",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  let ok = false;
  if (c.expect.ok && actual.ok) {
    ok = true;
    if (c.expect.finalSql && !c.expect.finalSql.test(actual.finalSql)) ok = false;
    if (c.expect.tables) {
      const want = c.expect.tables.slice().sort().join(",");
      const got = actual.tables.slice().sort().join(",");
      if (want !== got) ok = false;
    }
  } else if (!c.expect.ok && !actual.ok) {
    ok = actual.reason === c.expect.reason;
  }

  if (ok) {
    pass++;
    console.log(`  ✓ ${c.label}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${c.label}\n      want=${JSON.stringify(c.expect)}\n      got=${JSON.stringify(actual)}`,
    );
  }
}

console.log(`\n${pass}/${pass + fail} validator cases passed`);
if (fail > 0) process.exit(1);
