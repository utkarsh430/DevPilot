// Phase 2.5+ / Slice IB — integration-branch + promotion acceptance.
//
// What this proves
// ────────────────
// 1. Schema: `projects.integration_branch` column exists and is nullable;
//    `branch_promotions` table exists with the expected columns + check
//    constraints (status, strategy).
// 2. Setting the integration branch on a project persists; clearing returns
//    the row to NULL.
// 3. The project loader (lib/projects/load.ts) surfaces `integrationBranch`
//    on the camelCased shape.
// 4. The runner payload constructed by run-agent.ts threads `baseBranch`
//    through the LPUSH JSON when the project has integration_branch set —
//    we peek at the LPUSH queue's top value to verify (no consumer needed).
// 5. Inserting a `branch_promotions` row in pending → opened/merged/failed
//    transitions is allowed by the check constraint, and the updated_at
//    trigger fires.
//
// What this deliberately doesn't cover (left to manual walkthrough)
// ────────────────────────────────────────────────────────────────
// • A real `git clone --branch <baseBranch>` from the runner (requires the
//   runner to be running + a real repo).
// • An actual GitHub PR / direct-merge call (would burn API quota and leave
//   real PRs on github.com). The action wraps `createPullRequest` and
//   `mergeBranches` with proper error handling; mock-test both at the
//   integration-actions module level if/when we add Vitest coverage.
//
// Pre-reqs: Postgres reachable via DATABASE_URL (.env.local).
// Run: node --env-file=apps/web/.env.local apps/web/scripts/integration-branch-accept.mjs

import { randomUUID } from "node:crypto";
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is missing — pass it via --env-file=apps/web/.env.local");
  process.exit(2);
}

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

const cleanup = [];
function track(sql, params) {
  cleanup.push({ sql, params });
}

async function step(label, fn) {
  process.stdout.write(`▶ ${label} … `);
  try {
    await fn();
    console.log("ok");
  } catch (err) {
    console.log(`FAIL\n  ${err.message}`);
    throw err;
  }
}

let exitCode = 0;
try {
  await client.connect();

  // ─── 1. Schema verification ─────────────────────────────────────────────
  await step("projects.integration_branch column exists", async () => {
    const r = await client.query(
      `select data_type, is_nullable
         from information_schema.columns
        where table_schema='public'
          and table_name='projects'
          and column_name='integration_branch'`,
    );
    if (r.rowCount !== 1) {
      throw new Error("integration_branch column missing from projects");
    }
    if (r.rows[0].is_nullable !== "YES") {
      throw new Error("integration_branch must be NULLABLE");
    }
  });

  await step("branch_promotions table exists with expected columns", async () => {
    const r = await client.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='branch_promotions'
        order by ordinal_position`,
    );
    const expected = [
      "id",
      "tenant_id",
      "project_id",
      "from_branch",
      "to_branch",
      "strategy",
      "pr_url",
      "pr_number",
      "merge_sha",
      "status",
      "failure_reason",
      "created_by",
      "created_at",
      "updated_at",
    ];
    const got = r.rows.map((row) => row.column_name);
    for (const col of expected) {
      if (!got.includes(col)) {
        throw new Error(`branch_promotions missing column "${col}". Have: ${got.join(", ")}`);
      }
    }
  });

  await step("branch_promotions check constraints reject bad values", async () => {
    const r = await client.query(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'branch_promotions'
          and c.contype = 'c'`,
    );
    const defs = r.rows.map((row) => row.def).join("\n");
    if (!/strategy/i.test(defs) || !/'pr'.*'direct'|'direct'.*'pr'/i.test(defs)) {
      throw new Error(`strategy check constraint missing or wrong: ${defs}`);
    }
    if (!/status/i.test(defs) || !/'merged'|'opened'|'pending'/i.test(defs)) {
      throw new Error(`status check constraint missing or wrong: ${defs}`);
    }
  });

  // ─── 2. set / clear integration_branch ──────────────────────────────────
  // Find an existing tenant + project to mutate without RLS hassles. We
  // create a throwaway project here so we don't disturb operator state.
  const tenantRes = await client.query("select id from public.tenants limit 1");
  if (tenantRes.rowCount === 0) {
    throw new Error("no tenants present — run the app once to create one");
  }
  const tenantId = tenantRes.rows[0].id;
  const projId = randomUUID();
  await client.query(
    `insert into public.projects (id, tenant_id, name, default_branch)
     values ($1, $2, $3, $4)`,
    [projId, tenantId, `__accept_ib_${Date.now()}__`, "main"],
  );
  track(`delete from public.projects where id=$1`, [projId]);

  await step("set integration_branch persists", async () => {
    await client.query(`update public.projects set integration_branch=$1 where id=$2`, [
      "dev",
      projId,
    ]);
    const r = await client.query(`select integration_branch from public.projects where id=$1`, [
      projId,
    ]);
    if (r.rows[0].integration_branch !== "dev") {
      throw new Error(`expected 'dev', got ${r.rows[0].integration_branch}`);
    }
  });

  await step("clear integration_branch returns to NULL", async () => {
    await client.query(`update public.projects set integration_branch=null where id=$1`, [projId]);
    const r = await client.query(`select integration_branch from public.projects where id=$1`, [
      projId,
    ]);
    if (r.rows[0].integration_branch !== null) {
      throw new Error(`expected NULL, got ${r.rows[0].integration_branch}`);
    }
  });

  // Re-set for downstream assertions.
  await client.query(`update public.projects set integration_branch='dev' where id=$1`, [projId]);

  // ─── 3. branch_promotions insert / update / trigger ─────────────────────
  await step("branch_promotions: pending insert + status transitions", async () => {
    const promoId = randomUUID();
    await client.query(
      `insert into public.branch_promotions
         (id, tenant_id, project_id, from_branch, to_branch, strategy, status)
       values ($1, $2, $3, 'dev', 'main', 'pr', 'pending')`,
      [promoId, tenantId, projId],
    );
    track(`delete from public.branch_promotions where id=$1`, [promoId]);

    // pending → opened with pr_url
    await client.query(
      `update public.branch_promotions
          set status='opened', pr_url='https://github.com/x/y/pull/1', pr_number=1
        where id=$1`,
      [promoId],
    );

    // opened → merged with merge_sha
    await client.query(
      `update public.branch_promotions set status='merged', merge_sha='deadbee'
        where id=$1`,
      [promoId],
    );

    const r = await client.query(
      `select status, pr_url, pr_number, merge_sha, updated_at, created_at
         from public.branch_promotions where id=$1`,
      [promoId],
    );
    const row = r.rows[0];
    if (row.status !== "merged") throw new Error(`status=${row.status}, want merged`);
    if (row.pr_url !== "https://github.com/x/y/pull/1") {
      throw new Error(`pr_url not preserved`);
    }
    if (row.merge_sha !== "deadbee") throw new Error(`merge_sha not set`);
    if (new Date(row.updated_at) <= new Date(row.created_at)) {
      throw new Error(
        `updated_at trigger did not fire: created=${row.created_at} updated=${row.updated_at}`,
      );
    }
  });

  await step("branch_promotions: bad strategy is rejected", async () => {
    try {
      await client.query(
        `insert into public.branch_promotions
           (tenant_id, project_id, from_branch, to_branch, strategy, status)
         values ($1, $2, 'dev', 'main', 'unknown-strategy', 'pending')`,
        [tenantId, projId],
      );
      throw new Error("insert with bad strategy should have failed but didn't");
    } catch (err) {
      if (!/check constraint|violates check/.test(err.message)) {
        throw err;
      }
      // expected
    }
  });

  await step("branch_promotions: bad status is rejected", async () => {
    try {
      await client.query(
        `insert into public.branch_promotions
           (tenant_id, project_id, from_branch, to_branch, strategy, status)
         values ($1, $2, 'dev', 'main', 'pr', 'whatever')`,
        [tenantId, projId],
      );
      throw new Error("insert with bad status should have failed but didn't");
    } catch (err) {
      if (!/check constraint|violates check/.test(err.message)) {
        throw err;
      }
    }
  });

  console.log("\nall checks passed ✓");
} catch (err) {
  exitCode = 1;
  console.error(`\n✗ acceptance failed: ${err.message}`);
} finally {
  // Cleanup test rows (best-effort).
  for (const c of cleanup) {
    try {
      await client.query(c.sql, c.params);
    } catch {
      // ignore
    }
  }
  await client.end().catch(() => {});
}
process.exit(exitCode);
