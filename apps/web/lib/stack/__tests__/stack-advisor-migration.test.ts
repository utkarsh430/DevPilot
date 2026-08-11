// Stack advisor — the constraint model `project_stack_tags` must have.
//
// HONEST SCOPE: these are STATIC assertions over the migration SQL text. This
// suite does not run Postgres, so it proves the migration *says* the right
// thing, NOT that Postgres accepts the insert. It exists because the bug it
// guards is invisible to every pure test we have: WI-15 created the table with
// an inline `unique (project_id, service_key)` — correct when a row WAS a
// service — and the capability model makes a row a (service, capability) PAIR,
// so a multi-capability service (supabase → 4 rows, all `service_key`
// 'supabase') violates it and `persistStackSelection`'s batched INSERT is
// rejected WHOLESALE. It returns false best-effort, create still succeeds, and
// zero capability rows persist. Nothing in a pure suite notices.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MIGRATION = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../../supabase/migrations/20260722000000_stack_advisor.sql",
  ),
  "utf8",
);

describe("20260722000000 reconciles the base unique with the capability model", () => {
  it("drops the whole-table unique on (project_id, service_key)", () => {
    // By LOOKUP, not by a guessed name — a `drop constraint if exists` on the
    // wrong name silently no-ops and leaves the bug in place.
    expect(MIGRATION).toContain("con.contype = 'u'");
    expect(MIGRATION).toContain("array['project_id', 'service_key']");
    expect(MIGRATION).toMatch(/alter table public\.project_stack_tags drop constraint %I/);
  });

  it("keeps extras deduped with a capability-NULL partial unique", () => {
    expect(MIGRATION).toContain("project_stack_tags_project_service_extra_uidx");
    expect(MIGRATION).toMatch(
      /on public\.project_stack_tags\(project_id, service_key\)\s*\n\s*where capability is null;/,
    );
  });

  it("keeps D6: one service per capability", () => {
    expect(MIGRATION).toContain("project_stack_tags_project_capability_uidx");
    expect(MIGRATION).toMatch(
      /on public\.project_stack_tags\(project_id, capability\)\s*\n\s*where capability is not null;/,
    );
  });

  it("does all of it inside the migration's existing transaction", () => {
    expect(MIGRATION.trimStart().startsWith("--") || MIGRATION.includes("begin;")).toBe(true);
    expect(MIGRATION.indexOf("begin;")).toBeLessThan(
      MIGRATION.indexOf("project_stack_tags_project_service_extra_uidx"),
    );
    expect(MIGRATION.lastIndexOf("commit;")).toBeGreaterThan(
      MIGRATION.indexOf("project_stack_tags_project_service_extra_uidx"),
    );
  });
});
