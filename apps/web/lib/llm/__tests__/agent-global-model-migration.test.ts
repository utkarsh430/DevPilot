// The uniqueness of the AGENT-WIDE default is a SCHEMA property, so it is
// asserted against the migration source.
//
// ── Why this test has to exist ─────────────────────────────────────────────
// `uq_agent_project_models_scope` is `unique (tenant_id, project_id, role_slug)`
// and it reads as though it already covers the global rows. It does not:
// Postgres treats NULLs as DISTINCT in a unique index, so two rows with the same
// (tenant, role) and a NULL `project_id` do not conflict and the constraint would
// happily hold a dozen agent-wide defaults for one role. Whichever one the read
// happened to return would then be the effective model — a settable value doing
// something other than what it says, which is the exact failure this family of
// work exists to end.
//
// `create unique index … where project_id is null` is what makes exactly one
// global representable, and it is also why the write path is delete-then-insert
// (PostgREST's `on_conflict` names columns and cannot express a partial index's
// predicate). A reviewer deleting the index "because the unique constraint
// already covers it" is the realistic regression; this test is what stops it.
//
// It is a source-level assertion, not a live-DB one: the suite runs under
// Vitest with no database, and the repo's convention for schema invariants that
// tests cannot execute is exactly this (lib/security/tenant-scope-scan.ts parses
// these same migration files).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = path.resolve(process.cwd(), "../../supabase/migrations");

function migrationNamed(fragment: string): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(fragment));
  if (!file) throw new Error(`no migration matching "${fragment}"`);
  return readFileSync(path.join(MIGRATIONS, file), "utf8").toLowerCase();
}

describe("agent_project_models — the agent-wide default", () => {
  const sql = migrationNamed("agent_global_model");

  it("makes project_id nullable, so NULL can mean 'every project'", () => {
    expect(sql).toMatch(/alter\s+column\s+project_id\s+drop\s+not\s+null/);
  });

  it("adds a PARTIAL unique index — the only thing preventing a second global", () => {
    // Column list AND predicate. Without the `where project_id is null` clause
    // the index would forbid a role from having any per-project rows at all,
    // which is the opposite failure and just as bad.
    const index = sql.match(/create\s+unique\s+index[^;]*uq_agent_project_models_global[^;]*;/s);
    expect(index, "uq_agent_project_models_global must exist").toBeTruthy();
    const body = index![0].replace(/\s+/g, " ");
    expect(body).toContain("(tenant_id, role_slug)");
    expect(body).toMatch(/where\s+project_id\s+is\s+null/);
  });

  it("does not drop the per-project unique constraint the project rows rely on", () => {
    expect(sql).not.toMatch(/drop\s+constraint\s+uq_agent_project_models_scope/);
  });

  it("keeps the tenant-matches-parent trigger, which already tolerates a NULL pointer", () => {
    // The guard short-circuits on a null pointer ("a null pointer names no
    // parent"), so a global row is writable and every row that DOES name a
    // project is still guarded. Dropping the trigger here would silently open
    // the cross-tenant hole the 20260732000000 convention closed.
    expect(sql).not.toMatch(/drop\s+trigger[^;]*agent_project_models_project_id_tenant/);
  });

  it("the tenant-matches-parent function returns early on a NULL pointer", () => {
    const guard = migrationNamed("20260732000000");
    expect(guard).toMatch(/if\s+v_ptr\s+is\s+null\s+then\s+return\s+new;/);
  });
});
