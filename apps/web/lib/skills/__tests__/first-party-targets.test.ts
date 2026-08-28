// Guards for the first-party skill `targets` realignment.
//
// The defect these exist to prevent is not a crash — it is SILENCE. A skill
// targeting a role slug that does not exist resolves to nothing, forever, with
// no error anywhere. That is how the original eight-role target lists survived
// ~43 role additions unnoticed. Each test below turns one part of that silence
// into a red test.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROLES } from "@/lib/roles";
import {
  BATCH2_SKILL_TARGETS,
  DELIBERATELY_NOT_WIDENED,
  DELIBERATELY_UNCOVERED,
  FIRST_PARTY_SKILL_TARGETS,
  REALIGNMENT_TARGET_ROLES,
  allFirstPartySkillTargets,
  firstPartySkillsForRole,
  knownRoleSlugs,
} from "@/lib/skills/first-party-targets";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const MIGRATION = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260744000000_skill_targets_realignment.sql",
);
const SEED_MIGRATION = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260603090000_m11_marketplace.sql",
);
const BATCH2_MIGRATION = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260746000000_first_party_skills_batch2.sql",
);
const SELECT_SOURCE = join(__dirname, "..", "select.ts");

/**
 * name -> targets, parsed out of the batch-2 seed migration.
 *
 * Anchored on indent-4 columns so it reads the row's own `name`, `version` and
 * `targets` and never the indent-6 contents of `jsonb_build_object` (whose
 * summary strings contain both quotes and brackets).
 */
function parseBatch2Migration(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /^\s{4}'([^']+)',\n\s{4}'\d+\.\d+\.\d+',[\s\S]*?\n\s{4}'(\[[^\]]*\])'::jsonb,/gm;
  for (const m of sql.matchAll(re)) {
    const [, name, json] = m;
    if (!name || !json) continue;
    out.set(name, JSON.parse(json) as string[]);
  }
  return out;
}

describe("first-party skill targets — no phantom roles", () => {
  // THE DRIFT GUARD. This is the test the original bug needed and did not have.
  // Scoped to ALL first-party skills, both batches: a new skill that skipped
  // the module would sit outside the only guard against this class.
  it("targets no role slug that does not exist", () => {
    const known = knownRoleSlugs();
    const phantom: string[] = [];
    for (const [name, targets] of Object.entries(allFirstPartySkillTargets())) {
      for (const slug of targets) {
        if (!known.has(slug)) phantom.push(`${name} -> ${slug}`);
      }
    }
    expect(phantom).toEqual([]);
  });

  it("is non-vacuous: the batch-2 targets are actually being walked", () => {
    // A regression that emptied BATCH2_SKILL_TARGETS would make the assertion
    // above pass while guarding nothing.
    const batch2Slugs = Object.values(BATCH2_SKILL_TARGETS).flat();
    expect(Object.keys(BATCH2_SKILL_TARGETS).length).toBe(40);
    expect(batch2Slugs.length).toBeGreaterThan(100);
    expect(new Set(batch2Slugs).size).toBeGreaterThan(40);
  });

  it("no two first-party skills share a name", () => {
    // `skills.name` is the install key and the drift key. Worse, at runtime
    // `selectSkillsForDispatch` has NO notion of "latest" — it loads every
    // installed row and keyword-filters, so two same-named rows are two
    // independent candidates and `renderSkillsBlock` merges BOTH bodies into
    // one prompt. A collision is not a cosmetic clash; it is contradictory
    // standing instructions in the same system prompt.
    const a = Object.keys(FIRST_PARTY_SKILL_TARGETS);
    const b = Object.keys(BATCH2_SKILL_TARGETS);
    const collisions = b.filter((n) => a.includes(n));
    expect(collisions).toEqual([]);
    // ...and the combined map must not have lost a key to a silent overwrite.
    expect(Object.keys(allFirstPartySkillTargets()).length).toBe(a.length + b.length);
  });

  it("no two SEEDED skills share a name — checked against the migrations, not the module", () => {
    // The module is documentation; the migrations are what create rows. A
    // duplicate could exist in SQL while the module looked clean, because a
    // JS object literal silently de-duplicates its own keys.
    const seeded = [
      ...[
        ...readFileSync(SEED_MIGRATION, "utf8").matchAll(
          /^\s{4}'([^']+)',\n\s{4}'\d+\.\d+\.\d+',$/gm,
        ),
      ].map((m) => m[1]!),
      ...parseBatch2Migration(readFileSync(BATCH2_MIGRATION, "utf8")).keys(),
    ];
    expect(seeded.length).toBe(52);
    expect(new Set(seeded).size).toBe(seeded.length);
  });

  it("is non-vacuous: a made-up slug would be caught", () => {
    // Proves the assertion above has teeth rather than passing on an empty set.
    expect(knownRoleSlugs().has("frontend_engineer")).toBe(true);
    expect(knownRoleSlugs().has("frontend_enginer")).toBe(false);
  });

  it("covers every skill seeded by the marketplace migration", () => {
    // A skill added to the seed but omitted here would silently keep its
    // original eight-role targeting — the exact drift being repaired.
    const seed = readFileSync(SEED_MIGRATION, "utf8");
    const seededNames = [...seed.matchAll(/^\s{4}'([^']+)',\n\s{4}'\d+\.\d+\.\d+',$/gm)].map(
      (m) => m[1],
    );
    expect(seededNames.length).toBe(12);
    for (const name of seededNames) {
      expect(Object.keys(FIRST_PARTY_SKILL_TARGETS)).toContain(name);
    }
  });
});

describe("first-party skill targets — the realignment actually lands", () => {
  it.each(REALIGNMENT_TARGET_ROLES)(
    "%s resolves to a skill, or is explicitly and deliberately uncovered",
    (role) => {
      const resolved = firstPartySkillsForRole(role);
      if (resolved.length > 0) {
        expect(DELIBERATELY_UNCOVERED[role]).toBeUndefined();
        return;
      }
      // Zero coverage is permitted only WITH a stated reason, so a future
      // reader can tell a decision from the drift this change repaired.
      const reason = DELIBERATELY_UNCOVERED[role];
      expect(reason, `${role} resolves to no skill and has no stated reason`).toBeTruthy();
      expect(reason!.length).toBeGreaterThan(80);
    },
  );

  it("every role named in the audit is accounted for", () => {
    // Guards against quietly shortening the list to make the suite pass.
    for (const role of REALIGNMENT_TARGET_ROLES) {
      expect(Object.keys(ROLES)).toContain(role);
    }
    expect(REALIGNMENT_TARGET_ROLES.length).toBe(15);
  });

  it("every role the audit named as having zero skills now has some", () => {
    // 20260744000000 got 12 of the 15 and recorded the other three as
    // DELIBERATELY_UNCOVERED "because the skill that would fit does not exist
    // yet". The batch-2 seed is those skills, so the exception list is empty
    // for this set.
    const uncovered = REALIGNMENT_TARGET_ROLES.filter(
      (r) => firstPartySkillsForRole(r).length === 0,
    );
    expect(uncovered).toEqual([]);
    for (const role of ["sre", "release_engineer", "platform_engineer"]) {
      expect(DELIBERATELY_UNCOVERED[role]).toBeUndefined();
    }
  });

  it("DELIBERATELY_UNCOVERED is not stale — every entry really resolves to nothing", () => {
    // The staleness assertion runs in BOTH directions on purpose. An entry
    // naming a role that now receives a skill is a comment describing a state
    // that no longer holds, which is exactly the silent drift this module
    // exists to catch — so it fails here rather than rotting in prose.
    const stale = Object.keys(DELIBERATELY_UNCOVERED).filter(
      (role) => firstPartySkillsForRole(role).length > 0,
    );
    expect(stale).toEqual([]);
    for (const [role, reason] of Object.entries(DELIBERATELY_UNCOVERED)) {
      expect(Object.keys(ROLES), `${role} is not a real role slug`).toContain(role);
      expect(reason.length).toBeGreaterThan(80);
    }
    // Non-vacuity: the list must not have been emptied to make this pass.
    expect(Object.keys(DELIBERATELY_UNCOVERED).length).toBeGreaterThan(0);
  });

  it("the headline misses are fixed", () => {
    // frontend_engineer writes the markup; it must reach the a11y skill.
    expect(firstPartySkillsForRole("frontend_engineer")).toContain("WCAG 2.1 AA quick audit");
    // appsec_engineer's prompt names OWASP as its hunting ground.
    expect(firstPartySkillsForRole("appsec_engineer")).toContain("OWASP Top 10 checklist");
    // dba owns index strategy and EXPLAIN discipline.
    expect(firstPartySkillsForRole("dba")).toContain("PostgreSQL index advisor");
  });
});

describe("first-party skill targets — deliberate non-widenings hold", () => {
  it.each(Object.keys(DELIBERATELY_NOT_WIDENED))("%s keeps its original targets", (name) => {
    // These three carry bodies that are wrong (dead tool name, off-stack infra,
    // pure duplication). Widening them would spread the wrongness. If someone
    // widens one later, they must remove it from DELIBERATELY_NOT_WIDENED and
    // justify it — this test makes that a deliberate act, not an oversight.
    const original: Record<string, string[]> = {
      "K8s rollback runbook": ["devops"],
      "SQL safety checks": ["dataeng"],
      "Conventional commits": ["engineer"],
    };
    expect(FIRST_PARTY_SKILL_TARGETS[name]).toEqual(original[name]);
    const reason = DELIBERATELY_NOT_WIDENED[name];
    expect(reason).toBeTruthy();
    expect(reason?.length ?? 0).toBeGreaterThan(80);
  });

  it("no role gained coverage ONLY from a deliberately-not-widened skill", () => {
    // Belt and braces: if the three untouched skills were the sole source of a
    // role's coverage, that role's "covered" status would be an illusion.
    const notWidened = new Set(Object.keys(DELIBERATELY_NOT_WIDENED));
    for (const role of REALIGNMENT_TARGET_ROLES) {
      const resolved = firstPartySkillsForRole(role);
      if (resolved.length === 0) continue;
      expect(resolved.some((n) => !notWidened.has(n))).toBe(true);
    }
  });
});

describe("first-party skill targets — the migration matches the module", () => {
  // The module is documentation and the migration is what actually runs. If
  // they disagree, the comments describe a routing that does not exist.
  it("the migration sets exactly the targets this module declares", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const inSql = new Map<string, string[]>();
    for (const m of sql.matchAll(/^\s{4}'([^']+)',\n\s{6}'(\[[^\]]*\])'::jsonb/gm)) {
      const [, name, json] = m;
      if (!name || !json) continue;
      inSql.set(name, JSON.parse(json) as string[]);
    }
    // Guard the parse itself: a regex that silently matched nothing would make
    // every assertion below vacuously true.
    expect(inSql.size).toBe(9);

    // Every skill the migration touches must match the module exactly.
    for (const [name, targets] of inSql) {
      expect(FIRST_PARTY_SKILL_TARGETS[name], `${name} missing from module`).toEqual(targets);
    }
    // ...and the migration must touch every skill that is NOT a deliberate
    // non-widening. A skill silently dropped from the migration would keep its
    // stale targets in the database while this module claimed otherwise.
    const expected = Object.keys(FIRST_PARTY_SKILL_TARGETS).filter(
      (n) => !(n in DELIBERATELY_NOT_WIDENED),
    );
    expect([...inSql.keys()].sort()).toEqual(expected.sort());
  });

  it("the migration never rewrites an operator-authored skill", () => {
    // The scoping predicate is the safety property of this migration: an
    // operator may author their own skill named "RFC writer" (tenant_id set,
    // installed_from_skill_id NULL) and it must never be retargeted.
    const sql = readFileSync(MIGRATION, "utf8");
    const updates = [...sql.matchAll(/update public\.skills[\s\S]*?;/g)];
    expect(updates.length).toBeGreaterThan(0);
    for (const [stmt] of updates) {
      expect(stmt).toContain("tenant_id is null or installed_from_skill_id is not null");
    }
  });

  it("the migration modifies targets only — never a body", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    // `set` clauses must name `targets` and nothing else. Bodies are prompt
    // text an operator consented to at install; a targets change must not
    // smuggle one in.
    const setClauses = [...sql.matchAll(/\n\s*set\s+(\w+)\s*=/g)].map((m) => m[1]);
    expect(setClauses.length).toBeGreaterThan(0);
    expect([...new Set(setClauses)]).toEqual(["targets"]);
    expect(sql).not.toMatch(/\binsert\s+into\b/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
  });
});

describe("first-party skills — the batch-2 seed matches the module", () => {
  it("seeds exactly the skills the module declares, with exactly those targets", () => {
    const inSql = parseBatch2Migration(readFileSync(BATCH2_MIGRATION, "utf8"));
    // Guard the parse itself: a regex that silently matched nothing would make
    // every assertion below vacuously true.
    expect(inSql.size).toBe(40);
    expect([...inSql.keys()].sort()).toEqual(Object.keys(BATCH2_SKILL_TARGETS).sort());
    for (const [name, targets] of inSql) {
      expect(BATCH2_SKILL_TARGETS[name], `${name} targets disagree`).toEqual(targets);
    }
  });

  it("seeds no target naming a role that does not exist", () => {
    // Asserted against the SQL as well as the module, because the SQL is what
    // creates the rows and a module-only check would pass on a typo the
    // migration carried.
    const known = knownRoleSlugs();
    const inSql = parseBatch2Migration(readFileSync(BATCH2_MIGRATION, "utf8"));
    const phantom: string[] = [];
    for (const [name, targets] of inSql) {
      for (const slug of targets) if (!known.has(slug)) phantom.push(`${name} -> ${slug}`);
    }
    expect(phantom).toEqual([]);
  });

  it("only inserts — it never updates or deletes an existing skill", () => {
    // A body is prompt text an operator consented to at install. A seed
    // migration that also rewrote one would smuggle new standing instructions
    // into an already-installed skill; that needs a version bump and the
    // 20260744000000 scoping predicate, not an insert migration.
    const sql = readFileSync(BATCH2_MIGRATION, "utf8");
    const statements = sql.replace(/^\s*--.*$/gm, "");
    expect(statements).not.toMatch(/\bupdate\s+public\.skills\b/i);
    expect(statements).not.toMatch(/\bdelete\s+from\b/i);
    expect(statements).toMatch(/\binsert\s+into\s+public\.skills\b/i);
  });

  it("is idempotent by an explicit predicate, not by a constraint that cannot fire", () => {
    // `skills` carries `unique (tenant_id, name, version)`, which reads as
    // though it makes a public row unique and does NOT: Postgres treats NULLs
    // as DISTINCT, and every public seed row has `tenant_id IS NULL`. So an
    // `on conflict` clause here would be decoration. The guard has to be an
    // explicit existence check, and it has to test `tenant_id is null` — a
    // check that ignored tenant would skip seeding a public row merely
    // because some tenant authored a same-named skill of their own.
    const sql = readFileSync(BATCH2_MIGRATION, "utf8");
    const statements = sql.replace(/^\s*--.*$/gm, "");
    expect(statements).not.toMatch(/\bon\s+conflict\b/i);
    expect(statements).toMatch(/where\s+not\s+exists/i);
    expect(statements).toMatch(/e\.tenant_id\s+is\s+null/i);
  });

  it("seeds every row as public, and none as a tenant's", () => {
    // A seed row written with a tenant id would be invisible in the
    // marketplace and installed by nobody, while looking seeded.
    const sql = readFileSync(BATCH2_MIGRATION, "utf8");
    expect((sql.match(/^\s{4}null(::uuid)?,$/gm) ?? []).length).toBe(40);
  });
});

describe("first-party skill targets — the resolution predicate cannot drift", () => {
  it("select.ts still matches on exact slug membership with empty = any", () => {
    // firstPartySkillsForRole re-states select.ts's predicate. If selection
    // ever changes (prefix matching, role families, a default), this test
    // fails and forces the re-statement to be revisited rather than quietly
    // becoming wrong.
    const src = readFileSync(SELECT_SOURCE, "utf8");
    expect(src).toContain("targets.length === 0 || targets.includes(role)");
  });
});
