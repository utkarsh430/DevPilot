// Generates `audit-tenant-parent-mismatches.sql` from the schema.
//
// Why this exists
// ---------------
// The audit's header always CLAIMED it was "generated from the same enumeration
// that generates the triggers", but the generator was never committed — so the
// SQL was really a 1236-line hand-maintained artifact wearing a generated file's
// header. That gap is not cosmetic: round 6 had to remove two pointer pairs from
// the audit, and without a generator the only options were hand-surgery on four
// scattered blocks or leaving it wrong.
//
// Now the claim is true. The pair list comes from `guardedTenantPointers`, which
// is `allTenantPointers` (FK-derived ∪ curated non-FK) minus
// `CROSS_TENANT_BY_DESIGN` — the same single set the DB triggers and the static
// detector read. A pair cannot be audited but untriggered, or excluded here but
// still enforced there.
//
// Run:  pnpm --filter @devpilot/web tsx scripts/generate-tenant-parent-audit.ts
// A test asserts the committed .sql matches this generator's output byte for
// byte, so regenerating is not optional book-keeping — CI fails without it.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CROSS_TENANT_BY_DESIGN,
  guardedTenantPointers,
  type TenantPointer,
} from "../lib/security/tenant-scope-scan";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../../../supabase/migrations");
export const AUDIT_SQL_PATH = path.join(HERE, "audit-tenant-parent-mismatches.sql");

function migrationSources(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8"));
}

/** One pair's SELECT arm of the UNION ALL. */
function arm(p: TenantPointer): string {
  return `  select
    '${p.table}'::text as child_table,
    '${p.column}'::text as pointer_column,
    '${p.parent}'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.${p.table} c
  join public.${p.parent} p on p.id = c.${p.column}
  where c.${p.column} is not null
    and c.tenant_id is distinct from p.tenant_id`;
}

function exclusionNotes(): string {
  return CROSS_TENANT_BY_DESIGN.map((p) => {
    const wrapped = p.reason.replace(/(.{1,68})(\s|$)/g, "$1\n--     ").trimEnd();
    return `--   * ${p.table}.${p.column} -> ${p.parent}\n--     ${wrapped}`;
  }).join("\n");
}

export function renderAuditSql(sqlSources: readonly string[]): string {
  const pairs = guardedTenantPointers(sqlSources);
  const union = pairs.map(arm).join("\n  union all\n");

  return `-- =============================================================================
-- audit-tenant-parent-mismatches.sql
--
-- GENERATED FILE -- do not edit by hand.
-- Source: apps/web/scripts/generate-tenant-parent-audit.ts
-- Regenerate: pnpm --filter @devpilot/web tsx scripts/generate-tenant-parent-audit.ts
--
-- Reports every EXISTING row whose \`tenant_id\` disagrees with the tenant of the
-- parent its pointer names -- i.e. rows the cross-tenant class could have written
-- BEFORE the guards existed.
--
-- Why this script exists
-- ----------------------
-- \`20260732000000_tenant_matches_parent_all.sql\` makes such a row unwritable
-- from now on, and the app-layer \`.eq("tenant_id", ...)\` predicates stop reads
-- returning one. Neither can do anything about a row ALREADY written by one of
-- the round-1..4 holes: a trigger validates writes, not history, and the
-- migration deliberately does not backfill (a silent destructive sweep of
-- runs/comments is not something to do inside a migration).
--
-- So "the class is closed" is only fully true once this returns ZERO ROWS on
-- prod. Run it before trusting the close.
--
-- How to run
--   psql "$SUPABASE_DB_URL" -f apps/web/scripts/audit-tenant-parent-mismatches.sql
--
-- Read-only: pure SELECTs, no writes, safe against a live database.
--
-- Expected output
--   Zero rows, twice (detail, then summary). Anything returned is a real
--   cross-tenant row. Cleanup is deliberately NOT automated here: the right call
--   depends on what wrote the row, and deleting a customer's runs or comments on
--   the strength of a script is not a decision to take blind.
--
-- Coverage
-- --------
-- The ${pairs.length} pairs below are \`guardedTenantPointers\` -- every relationship in the
-- schema (FK-derived UNION the curated non-FK ones, so the FK-less
-- \`schedule_activity.project_id\` is covered too) MINUS the cross-tenant-by-design
-- set. The triggers and the static detector read that same set, so this audit
-- cannot check a pair the DB does not guard, or skip one it does.
--
-- Deliberately EXCLUDED (\`CROSS_TENANT_BY_DESIGN\`, lib/security/tenant-scope-scan.ts).
-- A mismatch on these is CORRECT, so auditing them would report healthy rows as
-- findings and bury the real ones:
${exclusionNotes()}
-- =============================================================================

\\timing on

-- -- 1. Detail: every mismatched row ----------------------------------------
with mismatches as (
${union}
)
select child_table, pointer_column, parent_table, child_id, child_tenant, parent_tenant
from mismatches
order by child_table, pointer_column, child_id;

-- -- 2. Summary: counts per (table, pointer). Zero rows = the close holds for
--    every guarded pair. ------------------------------------------------------
with mismatches as (
${union}
)
select child_table, pointer_column, parent_table, count(*) as mismatched_rows
from mismatches
group by child_table, pointer_column, parent_table
order by mismatched_rows desc;
`;
}

/** The generator's expected output, for the drift test and the CLI alike. */
export function expectedAuditSql(): string {
  return renderAuditSql(migrationSources());
}

// Written only when invoked directly, never on import (the test imports this).
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const sql = expectedAuditSql();
  writeFileSync(AUDIT_SQL_PATH, sql, "utf8");
  const pairs = guardedTenantPointers(migrationSources()).length;
  console.log(
    `wrote ${path.relative(process.cwd(), AUDIT_SQL_PATH)} — ${pairs} guarded pairs, ` +
      `${CROSS_TENANT_BY_DESIGN.length} excluded as cross-tenant by design`,
  );
}
