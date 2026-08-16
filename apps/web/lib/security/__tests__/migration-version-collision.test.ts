// Two migrations must never share a version prefix.
//
// THE DEFECT THIS EXISTS FOR, and why nothing else catches it. Supabase keys
// `supabase_migrations.schema_migrations` on the numeric prefix ALONE — the
// `_some_name` suffix is not part of the key. So two files numbered
// `20260745000000_a.sql` and `20260745000000_b.sql` are ONE version as far as
// the CLI is concerned: whichever applies first records the version, and the
// second is then treated as already applied and is SILENTLY NEVER RUN. On a
// production database that already recorded the number, the second migration
// never executes and nothing anywhere reports a problem.
//
// It is invisible to every gate we have:
//   - git sees two DIFFERENT paths, so a branch adding one and a main adding
//     the other merge and rebase cleanly with no add/add conflict. That is
//     exactly how this shipped into a PR: the rebase was clean and the
//     collision arrived with it.
//   - tsc sees nothing; a migration is not typed.
//   - the vitest suite sees nothing; migrations are read as text, by name, by
//     the few tests that reference one specifically.
//   - a local `supabase db reset` applies BOTH files (it replays the
//     directory), so even a full local replay reports success while the
//     production behaviour differs.
//
// Hence a source scan. It is cheap, it is total, and it turns a silent
// production no-op into a red test.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

describe("migration version prefixes", () => {
  it("are unique across every migration", () => {
    const byVersion = new Map<string, string[]>();
    for (const file of migrationFiles()) {
      const version = file.split("_")[0]!;
      byVersion.set(version, [...(byVersion.get(version) ?? []), file]);
    }
    const collisions = [...byVersion.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([version, files]) => `${version}: ${files.join(" + ")}`);
    expect(collisions).toEqual([]);
  });

  it("is non-vacuous: it really read the migrations directory", () => {
    // A wrong path would make the assertion above pass over an empty list.
    const files = migrationFiles();
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((f) => f.includes("first_party_skills_batch2"))).toBe(true);
  });

  it("every migration is named <14-digit version>_<snake_case>.sql", () => {
    // The uniqueness check keys on everything before the first underscore, so
    // a file that does not carry a version prefix in the expected shape would
    // be compared on a nonsense key and silently excluded from the guard.
    const malformed = migrationFiles().filter((f) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(f));
    expect(malformed).toEqual([]);
  });
});
