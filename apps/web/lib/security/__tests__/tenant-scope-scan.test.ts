// The repo-wide guard for the cross-tenant read class, and the proof that the
// guard is SOUND.
//
// The previous version of this detector was unsound and missed two live holes in
// files it was scanning (`run_verifications`, `planning_sessions`). A detector
// that cannot catch its own evasions is worse than none: it ends the search. So
// the first suite below attacks the detector itself, and only then is it pointed
// at the app.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allTenantPointers,
  attackerPointersFromSchema,
  CROSS_TENANT_BY_DESIGN,
  filteredPointers,
  guardedTenantPointers,
  hasTenantPredicate,
  NON_FK_TENANT_POINTERS,
  parseFromChains,
  platformInternalPointerColumns,
  scanForUnscopedReads,
  tenantPointersFromMigrations,
  tenantScopedTablesFromMigrations,
} from "@/lib/security/tenant-scope-scan";
import { KNOWN_UNSCOPED_READS } from "@/lib/security/known-unscoped-reads";

const WEB_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../../../../../supabase/migrations", import.meta.url));

function migrationSources(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8"));
}

function sourceFiles(): Array<{ file: string; src: string }> {
  const out: Array<{ file: string; src: string }> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next" || e.name === "__tests__") continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        out.push({ file: path.relative(WEB_ROOT, p), src: readFileSync(p, "utf8") });
      }
    }
  };
  walk(path.join(WEB_ROOT, "app"));
  walk(path.join(WEB_ROOT, "lib"));
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Is the detector sound? Attack it with the shapes that defeated the last one.
// ───────────────────────────────────────────────────────────────────────────

describe("detector soundness", () => {
  it("EVASION (a): finds a .from nested in a Promise.all array", () => {
    // The exact shape that hid `run_verifications`. The old regex chunked from
    // the first `.from(` to the next `;`, swallowing the siblings — and since the
    // first table was exempt, the whole block was skipped.
    const src = `
      const [a, b, c] = await Promise.all([
        supabase.from("run_steps").select("run_id").in("run_id", runIds),
        supabase.from("agents").select("id").in("id", agentIds),
        supabase.from("run_verifications").select("command").in("run_id", runIds),
      ]);`;
    const chains = parseFromChains(src);
    expect(chains.map((c) => c.table)).toEqual(["run_steps", "agents", "run_verifications"]);
    // …and each chain contains ONLY its own calls — the sibling's `.from` must
    // not have been swallowed into the first chain.
    expect(chains[0]!.chain).not.toContain("run_verifications");
    expect(chains[0]!.chain).not.toContain("agents");
  });

  it("EVASION (a): flags the hidden sibling as a violation", () => {
    const src = `
      await Promise.all([
        supabase.from("run_steps").select("run_id").in("run_id", ids),
        supabase.from("run_verifications").select("command").in("run_id", ids),
      ]);`;
    const found = scanForUnscopedReads(
      [{ file: "f.ts", src }],
      // run_steps has no tenant_id; run_verifications does.
      new Set(["run_verifications"]),
      ["run_id"],
    );
    expect(found.map((f) => f.table)).toEqual(["run_verifications"]);
  });

  it("EVASION (b): a SELECTED tenant_id column is not a predicate", () => {
    // The exact shape that hid `planning_sessions`: it selects tenant_id and
    // filters only on project_id, so a substring test read it as scoped.
    const chain = `.select("id, tenant_id, goal_summary").eq("project_id", projectId).limit(8)`;
    expect(hasTenantPredicate(chain)).toBe(false);
  });

  it("EVASION (b): flags a read that selects but does not filter tenant_id", () => {
    const src = `
      const { data } = await supabase
        .from("planning_sessions")
        .select("id, tenant_id, project_id, goal_summary")
        .eq("project_id", projectId)
        .limit(8);`;
    const found = scanForUnscopedReads([{ file: "f.ts", src }], new Set(["planning_sessions"]), [
      "project_id",
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ table: "planning_sessions", pointers: ["project_id"] });
  });

  it("EVASION (c): an apostrophe in a COMMENT does not open a phantom string", () => {
    // Blind spot (a), one level down, and found live in supervision.ts. The
    // balanced-paren scanner tracked strings but not comments, so the `'` in
    // `run's` opened a string that ran to the next quote — the chain swallowed
    // thousands of characters, including whole unrelated queries.
    const src = `
      await supabase.from("runs").insert({
        tenant_id: t,
        // Supervised restarts inherit the original run's runner kind
        parent_run_id: p,
      });
      const { data } = await supabase
        .from("run_steps")
        .select("payload")
        .eq("run_id", ctx.run.id);`;
    const chains = parseFromChains(src);
    const runsChain = chains.find((c) => c.table === "runs")!;
    // The insert's chain must END at its own closing paren.
    expect(runsChain.chain).not.toContain("run_steps");
    expect(runsChain.chain).not.toContain('.eq("run_id"');
  });

  it("EVASION (c): a swallowed chain must not INHERIT a later query's tenant predicate", () => {
    // The dangerous direction. If the comment apostrophe lets an UNSCOPED read
    // absorb a later, unrelated query, `hasTenantPredicate` finds that query's
    // `.eq("tenant_id", …)` and the real violation reads as scoped — a false
    // NEGATIVE, which is how this whole class stayed alive for three rounds.
    const src = `
      const a = await supabase
        .from("comments")
        .select("body")
        // the ticket's own thread
        .eq("ticket_id", id);
      const b = await supabase.from("runs").select("id").eq("tenant_id", t);`;
    const found = scanForUnscopedReads([{ file: "f.ts", src }], new Set(["comments", "runs"]), [
      "ticket_id",
    ]);
    expect(found.map((f) => f.table)).toEqual(["comments"]);
  });

  it("accepts every real form of a tenant predicate", () => {
    for (const chain of [
      `.select("id").eq("ticket_id", t).eq("tenant_id", x)`,
      `.select("id").eq("ticket_id", t).in("tenant_id", xs)`,
      `.select("id").eq("ticket_id", t).filter("tenant_id", "eq", x)`,
      `.select("id").eq("ticket_id", t).match({ tenant_id: x })`,
      `.select("id").eq("ticket_id", t).or("tenant_id.eq.1,tenant_id.is.null")`,
    ]) {
      expect(hasTenantPredicate(chain), chain).toBe(true);
    }
  });

  it("only counts a pointer when it is FILTERED, not merely selected", () => {
    // Selecting `ticket_id` is not an attack surface; filtering on it is.
    expect(filteredPointers(`.select("ticket_id, body").eq("id", x)`, ["ticket_id"])).toEqual([]);
    expect(filteredPointers(`.select("body").eq("ticket_id", x)`, ["ticket_id"])).toEqual([
      "ticket_id",
    ]);
  });

  it("does not flag a scoped read", () => {
    const src = `supabase.from("runs").select("id").in("ticket_id", ids).eq("tenant_id", t);`;
    expect(scanForUnscopedReads([{ file: "f.ts", src }], new Set(["runs"]), ["ticket_id"])).toEqual(
      [],
    );
  });

  it("does not flag a table with no tenant_id column", () => {
    // `run_steps` cannot carry a conflicting tenant, so its rows are scoped by
    // the run they belong to. This exemption is DERIVED from the schema, never
    // asserted by hand.
    const src = `supabase.from("run_steps").select("id").in("run_id", ids);`;
    expect(scanForUnscopedReads([{ file: "f.ts", src }], new Set(["runs"]), ["run_id"])).toEqual(
      [],
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Schema derivation — the detector's and the trigger's shared source of truth.
// ───────────────────────────────────────────────────────────────────────────

describe("schema derivation", () => {
  const sql = migrationSources();

  it("knows which tables carry a tenant_id", () => {
    const t = tenantScopedTablesFromMigrations(sql);
    for (const has of ["runs", "comments", "tickets", "run_verifications", "planning_sessions"]) {
      expect(t.has(has), `${has} should be tenant-scoped`).toBe(true);
    }
    // No tenant_id of their own — gated entirely by their parent.
    for (const hasnt of ["run_steps", "ticket_labels", "ticket_dependencies"]) {
      expect(t.has(hasnt), `${hasnt} should NOT be tenant-scoped`).toBe(false);
    }
  });

  it("enumerates pointer pairs from real columns, not from prose or across commas", () => {
    const pairs = tenantPointersFromMigrations(sql);
    const keys = pairs.map((p) => `${p.table}.${p.column}`);
    // Real FKs.
    expect(keys).toContain("runs.ticket_id");
    expect(keys).toContain("run_verifications.run_id");
    expect(keys).toContain("comments.ticket_id");
    // `fan_out_group` is a plain uuid, NOT an FK — a body-wide regex invented
    // `tickets.fan_out_group -> projects` by matching across a comma.
    expect(keys).not.toContain("tickets.fan_out_group");
    // Words from SQL comments are not columns.
    expect(keys).not.toContain("api_keys.the");
    expect(keys).not.toContain("pending_pushes.add");
    // Multi-column `alter table … add column a, add column b` parses both.
    expect(keys).toContain("pending_pushes.merger_ticket_id");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. The DB trigger covers every pointer pair. This is the structural close.
// ───────────────────────────────────────────────────────────────────────────

describe("single source of truth", () => {
  const sql = migrationSources();

  it("the detector's pointer vocabulary IS the schema-derived set", () => {
    // The drift guard. `ATTACKER_POINTERS` used to be hand-typed and omitted
    // eight real FK pointers — assignee_agent_id, committed_ticket_id, kb_id,
    // merger_ticket_id, pending_push_id, replay_of_run_id, runner_id,
    // schedule_id — so the detector was blind to real reads such as
    // `runs`-by-`replay_of_run_id` (replay). Deriving it from the same source the
    // triggers use makes that impossible by construction; this asserts the
    // derivation actually covers them.
    //
    // `runner_id` is NOT in this list, and its absence is the round-6 correction
    // rather than a regression. It was added here as a win — "the detector was
    // blind to runs-by-runner_id (runner-watchdog)" — but that blindness was
    // CORRECT: runners are shared across tenants, so the watchdog's runner-keyed
    // read must not be tenant-scoped, and flagging it demanded a filter that
    // breaks the reap. It is excluded deliberately now; see the
    // CROSS_TENANT_BY_DESIGN suite, which asserts that exclusion directly.
    const derived = attackerPointersFromSchema(sql);
    for (const previouslyMissed of [
      "assignee_agent_id",
      "committed_ticket_id",
      "kb_id",
      "merger_ticket_id",
      "pending_push_id",
      "replay_of_run_id",
      "schedule_id",
    ]) {
      expect(derived, `${previouslyMissed} must be visible to the detector`).toContain(
        previouslyMissed,
      );
    }
    // …and the obvious ones are still there.
    for (const p of ["ticket_id", "project_id", "run_id"]) expect(derived).toContain(p);
  });

  it("the non-FK curated pointers are real, and really lack an FK", () => {
    // The curated list is the one place a human asserts something the schema
    // cannot. So each entry is checked against the schema for the two facts that
    // ARE mechanical: the tables exist and are tenant-scoped, and the FK parse
    // genuinely does not already cover it (otherwise the entry is dead weight
    // pretending to add safety).
    const tenantTables = tenantScopedTablesFromMigrations(sql);
    const fk = new Set(tenantPointersFromMigrations(sql).map((p) => `${p.table}.${p.column}`));
    expect(NON_FK_TENANT_POINTERS.length).toBeGreaterThan(0);
    for (const p of NON_FK_TENANT_POINTERS) {
      expect(tenantTables.has(p.table), `${p.table} must be tenant-scoped`).toBe(true);
      expect(tenantTables.has(p.parent), `${p.parent} must be tenant-scoped`).toBe(true);
      expect(fk.has(`${p.table}.${p.column}`), `${p.table}.${p.column} has an FK — drop it`).toBe(
        false,
      );
    }
  });

  it("allTenantPointers = FK-derived ∪ curated non-FK", () => {
    const all = allTenantPointers(sql).map((p) => `${p.table}.${p.column}`);
    for (const p of tenantPointersFromMigrations(sql)) {
      expect(all).toContain(`${p.table}.${p.column}`);
    }
    for (const p of NON_FK_TENANT_POINTERS) expect(all).toContain(`${p.table}.${p.column}`);
    // The specific gap: a plain-uuid pointer with no FK.
    expect(all).toContain("schedule_activity.project_id");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3b. The exclusion set. An exclusion is exactly as load-bearing as an
//     inclusion, in the opposite direction: a WRONG one opens a hole, a MISSING
//     one wedges legitimate work. Round 6 shipped from the second kind.
// ───────────────────────────────────────────────────────────────────────────

describe("CROSS_TENANT_BY_DESIGN — the single exclusion set", () => {
  const sql = migrationSources();

  it("every entry names a real relationship the schema actually has", () => {
    // The one place a human asserts something the schema cannot. So the parts
    // that ARE mechanical get checked: the pair must exist in the raw
    // relationship set, or it is dead weight pretending to add safety.
    const all = new Set(allTenantPointers(sql).map((p) => `${p.table}.${p.column}->${p.parent}`));
    for (const p of CROSS_TENANT_BY_DESIGN) {
      expect(all, `${p.table}.${p.column} -> ${p.parent} is not a real pointer`).toContain(
        `${p.table}.${p.column}->${p.parent}`,
      );
      expect(p.reason.length, `${p.table}.${p.column} needs a real reason`).toBeGreaterThan(40);
    }
  });

  it("guarded = all − excluded, and the runner pairs are the ones removed", () => {
    const guarded = new Set(guardedTenantPointers(sql).map((p) => `${p.table}.${p.column}`));
    const all = allTenantPointers(sql);
    expect(guardedTenantPointers(sql).length).toBe(all.length - CROSS_TENANT_BY_DESIGN.length);
    for (const p of CROSS_TENANT_BY_DESIGN) {
      expect(guarded, `${p.table}.${p.column} must not be guarded`).not.toContain(
        `${p.table}.${p.column}`,
      );
    }
    // Named explicitly — this is the round-6 finding, not a generic property.
    expect(guarded).not.toContain("runs.runner_id");
    expect(guarded).not.toContain("dev_server_sessions.runner_id");
  });

  it("runner_id is NOT an attacker pointer — the detector must not ask for a filter", () => {
    // RED ON REVERT: drop the runner entries from CROSS_TENANT_BY_DESIGN (or flip
    // their `reads` to "scoped-read") and this fails.
    //
    // This is the app-layer half of the same mistake. A runner-keyed read is
    // platform-internal: the watchdog reaping a dead runner's runs must see EVERY
    // tenant's runs on that runner. If the detector flags those reads, the "fix"
    // it demands — `.eq("tenant_id", …)` — hides exactly the cross-tenant runs the
    // reap exists for, and they hang `running` behind a dead runner forever.
    expect(platformInternalPointerColumns()).toEqual(["runner_id"]);
    expect(attackerPointersFromSchema(sql)).not.toContain("runner_id");

    // …but the vocabulary is otherwise intact. Provenance columns STAY in it:
    // a provenance read has an owning tenant ("which of MY skills came from X"),
    // so it should still be scoped. Cross-tenant POINTER ≠ unscoped READ.
    for (const p of ["ticket_id", "project_id", "run_id", "replay_of_run_id", "parent_run_id"]) {
      expect(attackerPointersFromSchema(sql), `${p} must stay in the vocabulary`).toContain(p);
    }
    expect(attackerPointersFromSchema(sql)).toContain("installed_from_skill_id");
  });

  it("the runner-keyed platform reads carry NO tenant filter", () => {
    // The concrete regression this round exists to prevent, asserted against the
    // real source. Each of these was given `.eq("tenant_id", …)` in round 4 on
    // the strength of a trigger round 4 had itself just invented.
    //
    // RED ON REVERT: re-add a tenant predicate to any of them and this fails.
    const runnerKeyed = [
      "lib/engine/runner-watchdog.ts",
      "app/api/runners/[id]/heartbeat/route.ts",
      "app/api/runs/[id]/claim/route.ts",
    ];
    const tenantTables = tenantScopedTablesFromMigrations(sql);
    for (const file of runnerKeyed) {
      const src = readFileSync(path.join(WEB_ROOT, file), "utf8");
      for (const { table, chain, line } of parseFromChains(src)) {
        if (!tenantScopedTables(tenantTables, table)) continue;
        if (!/\.\s*(?:eq|is)\(\s*["'`]runner_id["'`]/.test(chain)) continue;
        expect(
          hasTenantPredicate(chain),
          `${file}:${line} — a runner-keyed read must NOT be tenant-scoped; runners are ` +
            `shared, so this hides the cross-tenant rows it exists to act on`,
        ).toBe(false);
      }
    }
  });

  function tenantScopedTables(set: ReadonlySet<string>, table: string): boolean {
    return set.has(table);
  }
});

describe("schema-wide trigger coverage", () => {
  const triggerSql = readFileSync(
    path.join(MIGRATIONS, "20260732000000_tenant_matches_parent_all.sql"),
    "utf8",
  );

  /**
   * Does a tenant-matches-parent trigger exist for `pair` in the FINAL schema —
   * i.e. after every migration has been applied in order?
   *
   * This REPLAYS create/drop across the whole migration directory rather than
   * grepping one file, and that is the whole point. Round 6 had to remove two
   * triggers that 20260732000000 creates; applied migrations are historical
   * records here, so the removal lives in a LATER migration (20260733000000).
   * A test that greps only the creating file would report those triggers as
   * present forever, and would have gone on asserting the very state the prod
   * audit had just proved wrong.
   */
  function triggerExistsInFinalSchema(pair: { table: string; column: string }): boolean {
    const createRe = new RegExp(
      `create trigger\\s+(\\S+)\\s+before insert or update of tenant_id, ${pair.column}\\s+on public\\.${pair.table}\\b`,
    );
    let present = false;
    for (const f of readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = readFileSync(path.join(MIGRATIONS, f), "utf8");
      const created = createRe.exec(sql);
      if (created) {
        present = true;
        continue;
      }
      // A `drop trigger if exists <name> on public.<table>` with no matching
      // create in the same file is a removal.
      const dropRe = new RegExp(
        `drop trigger if exists\\s+(\\S+)\\s+on public\\.${pair.table};`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = dropRe.exec(sql))) {
        if (new RegExp(`_${pair.column}_tenant$`).test(m[1]!)) present = false;
      }
    }
    return present;
  }

  it("has a trigger for EVERY guarded pair", () => {
    // Round 3's trigger list was hand-written and silently omitted
    // `run_verifications` — the very table that then leaked forged QA evidence.
    // This re-derives the set from the schema and fails on any gap, so the
    // trigger coverage cannot drift as tables are added.
    //
    // `guardedTenantPointers`, not `allTenantPointers`: the exclusions are no
    // longer re-stated here (they were, and one of them was wrong in a way this
    // test could not see — see the CROSS_TENANT_BY_DESIGN suite below).
    const pairs = guardedTenantPointers(migrationSources());
    expect(pairs.length).toBeGreaterThan(40);

    const missing = pairs.filter((p) => !triggerExistsInFinalSchema(p));
    expect(
      missing.map((p) => `${p.table}.${p.column} -> ${p.parent}`),
      "pointer pairs with no tenant-matches-parent trigger",
    ).toEqual([]);
  });

  it("covers the non-FK pointers too (the gap that falsified 'fails on any gap')", () => {
    // `schedule_activity.project_id` is a plain uuid with no FK, so the FK parse
    // could not see it: no trigger, and the coverage test above passed anyway
    // while a member of tenant B could insert `{tenant_id: B, project_id: <A's
    // project>}` and nothing rejected it. Named explicitly so the non-FK path is
    // not merely covered by accident.
    for (const p of NON_FK_TENANT_POINTERS) {
      expect(
        triggerExistsInFinalSchema(p),
        `${p.table}.${p.column} (non-FK) must have a trigger`,
      ).toBe(true);
    }
  });

  it("guards NOTHING that is cross-tenant by design — in the FINAL schema", () => {
    // Both halves of the exclusion set, checked the same way:
    //
    //  • Marketplace provenance was never guarded: installing a public skill
    //    clones it and points at the ORIGINAL, whose tenant is by design someone
    //    else's. A blanket "guard every FK" breaks every install.
    //
    //  • The two runner_id pairs WERE guarded, wrongly, by 20260732000000, and
    //    are dropped by 20260733000000. Runners are shared across tenants, so
    //    those triggers would reject a legitimate cross-tenant claim and wedge
    //    the run. This asserts the net effect, which is what the DB actually has.
    const stillGuarded = CROSS_TENANT_BY_DESIGN.filter((p) => triggerExistsInFinalSchema(p));
    expect(
      stillGuarded.map((p) => `${p.table}.${p.column} -> ${p.parent}`),
      "cross-tenant-by-design pairs must NOT be guarded — a trigger here rejects correct behaviour",
    ).toEqual([]);
  });

  it("the runner_id triggers are created by 20260732 and dropped by 20260733", () => {
    // Pins the actual mechanism, so nobody "tidies up" by deleting the drop
    // migration on the grounds that the create is right there in history — and
    // so a fresh apply and the already-remediated prod provably converge.
    expect(triggerSql).toContain("create trigger trg_runs_runner_id_tenant");
    expect(triggerSql).toContain("create trigger trg_dev_server_sessions_runner_id_tenant");

    const dropSql = readFileSync(
      path.join(MIGRATIONS, "20260733000000_drop_runner_id_tenant_triggers.sql"),
      "utf8",
    );
    expect(dropSql).toContain("drop trigger if exists trg_runs_runner_id_tenant on public.runs;");
    expect(dropSql).toContain(
      "drop trigger if exists trg_dev_server_sessions_runner_id_tenant on public.dev_server_sessions;",
    );
    // Idempotent: safe on prod (already dropped by hand) and on a fresh apply.
    expect(dropSql).not.toMatch(/drop trigger(?! if exists)/);
  });

  it("allows a NULL pointer (ticket-less runs must still be writable)", () => {
    expect(triggerSql).toContain("if v_ptr is null then");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. The repo-wide sweep.
// ───────────────────────────────────────────────────────────────────────────

describe("repo-wide sweep of apps/web", () => {
  it("has no unscoped read outside the known register", () => {
    const tenantTables = tenantScopedTablesFromMigrations(migrationSources());
    const known = new Set(KNOWN_UNSCOPED_READS.map((k) => `${k.file}::${k.table}`));
    const violations = scanForUnscopedReads(
      sourceFiles(),
      tenantTables,
      attackerPointersFromSchema(migrationSources()),
    ).filter((v) => !known.has(`${v.file}::${v.table}`));

    const detail = violations
      .map((v) => `  ${v.file}:${v.line} — from("${v.table}") filtered by ${v.pointers.join(", ")}`)
      .join("\n");
    expect(
      violations,
      violations.length === 0
        ? ""
        : "NEW cross-tenant-class read(s):\n" +
            detail +
            '\n\nAdd `.eq("tenant_id", <the authorised tenant>)`. A clean parent id does NOT ' +
            "imply a clean child row: these tables carry their own tenant_id and their write " +
            "policies do not constrain the pointer. Do NOT add it to KNOWN_UNSCOPED_READS — " +
            "that register is empty and must stay empty; it is the gate, not an escape hatch.",
    ).toEqual([]);
  });

  it("the register is EMPTY — the whole class is closed at the app layer too", () => {
    // The strongest form of the guard, and the reason the previous test's
    // `.filter(known)` can never be widened quietly. The register existed to
    // park ~41 engine-internal reads behind the trigger invariant while the
    // export surface was fixed; they have all been given real predicates.
    //
    // If you are here because you added an entry to make CI green: that is the
    // one thing this file exists to stop. Add the predicate instead.
    expect(
      KNOWN_UNSCOPED_READS,
      "KNOWN_UNSCOPED_READS must stay empty — add the tenant predicate, not a line here",
    ).toEqual([]);
  });

  it("the register is not stale — every listed site still violates", () => {
    // Stops the register from rotting into a list of lies. Fix a read, delete
    // its line; this fails until you do.
    const tenantTables = tenantScopedTablesFromMigrations(migrationSources());
    const actual = new Set(
      scanForUnscopedReads(
        sourceFiles(),
        tenantTables,
        attackerPointersFromSchema(migrationSources()),
      ).map((v) => `${v.file}::${v.table}`),
    );
    const stale = KNOWN_UNSCOPED_READS.filter((k) => !actual.has(`${k.file}::${k.table}`));
    expect(
      stale.map((k) => `${k.file} (${k.table})`),
      "listed in KNOWN_UNSCOPED_READS but no longer violating — delete these lines",
    ).toEqual([]);
  });

  it("the marketplace install is cross-tenant BY DESIGN and must NOT be scoped", () => {
    // The app-layer twin of the trigger suite's provenance exclusion, and the
    // reason "add .eq(tenant_id) everywhere" is the wrong rule stated crudely.
    //
    // Installing a public skill READS A ROW THAT IS DELIBERATELY NOT IN THE
    // CALLER'S TENANT: public rows are `tenant_id IS NULL`. A blanket
    // `.eq("tenant_id", tenantId)` here would match nothing and break every
    // install. Its safety comes from a DIFFERENT control, asserted below: the
    // source is fetched by PRIMARY KEY (not attacker-aimable) and then required
    // to be public before anything is cloned.
    //
    // The detector already leaves it alone — it only counts reads filtered by a
    // POINTER, and `id` is not one — but that is a property worth pinning, not
    // relying on.
    const src = readFileSync(path.join(WEB_ROOT, "app/(app)/marketplace/actions.ts"), "utf8");
    expect(src).toContain("if (src.tenant_id !== null) {");
    expect(src).toContain("can only install public (tenant_id null) skills");

    const tenantTables = tenantScopedTablesFromMigrations(migrationSources());
    const marketplace = sourceFiles().filter((f) => f.file.startsWith("app/(app)/marketplace/"));
    expect(marketplace.length).toBeGreaterThan(0);
    expect(
      scanForUnscopedReads(
        marketplace,
        tenantTables,
        attackerPointersFromSchema(migrationSources()),
      ),
      "the marketplace public-row reads are keyed on a primary key, not a pointer",
    ).toEqual([]);
  });

  it("project_secrets is RLS-enabled with NO policies — and is scoped anyway", () => {
    // `project_secrets` was carried in the register under a different
    // justification from everything else: it is arguably NOT in the class at
    // all. It has RLS enabled and ZERO policies, so there is no member read or
    // write path to it whatsoever — every write goes through the service role
    // and derives `tenant_id` from `projects`. `project_id = P` therefore
    // structurally implies P's tenant, and the detector cannot see that
    // reasoning.
    //
    // We asserted the reasoning AND added the predicate anyway. The argument
    // rests on "no policy exists", which is a fact about a file someone could
    // change in one line — and the value on the other side is the tenant's
    // decrypted API keys. This test pins the fact; the predicate means the read
    // is still correct on the day the fact stops being true.
    const sql = readFileSync(
      path.join(MIGRATIONS, "20260606000000_phase2_5_project_secrets.sql"),
      "utf8",
    );
    expect(sql).toContain("alter table public.project_secrets enable row level security");
    const allPolicies = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .flatMap((f) => readFileSync(path.join(MIGRATIONS, f), "utf8").split(/\n/))
      .filter((line) => /create\s+policy/i.test(line) && /project_secrets/i.test(line));
    expect(allPolicies, "project_secrets must have no RLS policies").toEqual([]);

    // …and the reads carry the predicate regardless.
    const secrets = readFileSync(path.join(WEB_ROOT, "lib/projects/secrets.ts"), "utf8");
    const scoped = secrets.match(/\.eq\("tenant_id", (?:tenantId|input\.tenantId)\)/g) ?? [];
    expect(scoped.length, "every project_secrets query is tenant-scoped").toBeGreaterThanOrEqual(5);
  });

  it("the export surface this PR owns has ZERO unscoped reads", () => {
    // Now true of the whole app, not just here — but kept as a named, narrower
    // guard on the surface this branch owns, so a future widening of the
    // repo-wide sweep can never quietly stop covering it.
    const tenantTables = tenantScopedTablesFromMigrations(migrationSources());
    const exportSurface = sourceFiles().filter(
      (f) =>
        f.file.startsWith("lib/export/") ||
        f.file.startsWith("lib/metrics/") ||
        f.file.includes("projects/[projectId]/page.tsx"),
    );
    expect(exportSurface.length).toBeGreaterThan(3);
    expect(
      scanForUnscopedReads(
        exportSurface,
        tenantTables,
        attackerPointersFromSchema(migrationSources()),
      ),
    ).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. The prod audit. It is what turns "the class is closed" from a claim into a
//    measurement, so it has to cover exactly the guarded set — no more, no less.
// ───────────────────────────────────────────────────────────────────────────

describe("prod mismatch audit", () => {
  const auditSql = readFileSync(
    path.join(WEB_ROOT, "scripts/audit-tenant-parent-mismatches.sql"),
    "utf8",
  );

  it("is byte-identical to its generator's output", async () => {
    // The audit's header CLAIMED it was generated long before a generator
    // existed; it was really a 1236-line hand-maintained file wearing a
    // generated header. That is why round 6 could not simply re-derive it. Now
    // the claim is enforced: regenerate or CI fails.
    const { expectedAuditSql } = await import("@/scripts/generate-tenant-parent-audit");
    expect(
      auditSql,
      "audit SQL is stale — run: pnpm --filter @devpilot/web tsx scripts/generate-tenant-parent-audit.ts",
    ).toBe(expectedAuditSql());
  });

  it("audits EVERY guarded pair", () => {
    for (const p of guardedTenantPointers(migrationSources())) {
      expect(
        auditSql.includes(`join public.${p.parent} p on p.id = c.${p.column}`) &&
          auditSql.includes(`'${p.table}'::text as child_table`),
        `${p.table}.${p.column} -> ${p.parent} is guarded but not audited`,
      ).toBe(true);
    }
  });

  it("audits NOTHING that is cross-tenant by design — or it can never return zero", () => {
    // RED ON REVERT: drop the runner entries from CROSS_TENANT_BY_DESIGN and
    // regenerate — the runner arms come back and this fails.
    //
    // This is not tidiness. A mismatch on these pairs is CORRECT (prod has 8
    // legitimate cross-tenant runs on a shared runner), so auditing them means
    // the audit reports healthy rows forever. firstmate gates the merge on this
    // returning ZERO, so an audit that cannot return zero is not a slightly noisy
    // report — it is a broken gate that either blocks the merge or trains its
    // reader to ignore it.
    //
    // Checked against the SQL BODY, not the file: the header names each excluded
    // pair on purpose, and matching those would pass while the query still ran.
    const body = auditSql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    for (const p of CROSS_TENANT_BY_DESIGN) {
      expect(
        body.includes(`join public.${p.parent} p on p.id = c.${p.column}`),
        `${p.table}.${p.column} is cross-tenant by design and must NOT be audited`,
      ).toBe(false);
    }
    // The specific finding, named.
    expect(body).not.toContain("public.runners");
  });
});
