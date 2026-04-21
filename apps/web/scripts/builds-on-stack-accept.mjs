// Phase 2.5+ / Slice IB-C — stacked tickets (builds_on) acceptance.
//
// What this proves
// ────────────────
// 1. relation_type CHECK accepts 'builds_on' alongside the existing values.
// 2. Inserting a builds_on row between two tickets in the same tenant works
//    and is read-stable.
// 3. The (ticket_id, blocks_ticket_id, relation_type) primary key permits
//    multiple relation types between the same pair (blocked_by + builds_on
//    can coexist).
// 4. Cascade delete: removing the parent ticket also wipes the builds_on
//    dependency rows that referenced it (because ON DELETE CASCADE).
// 5. The git_branch_name on the parent is the slug that loadBuildsOnBase
//    will surface to the runner (verifies the data shape; the actual TS
//    function is not exercised here — that needs the Next.js runtime).
//
// What this deliberately doesn't cover (left to manual walkthrough)
// ────────────────────────────────────────────────────────────────
// • The runner actually doing `git clone --branch devpilot/<parent-slug>`
//   (needs the runner running + a real repo + a parent ticket with a
//   pushed-to-origin branch).
// • The builds-on-cascade notifier writing a system comment when the
//   parent's push lands (needs Inngest dev + the push pipeline).
// • The NewTicketDialog picker UI (browser-only).
//
// Pre-reqs: Postgres reachable via DATABASE_URL (.env.local).
// Run: node --env-file=apps/web/.env.local apps/web/scripts/builds-on-stack-accept.mjs

import { randomUUID } from "node:crypto";
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is missing — pass via --env-file=apps/web/.env.local");
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

  // ─── 1. Constraint shape ───────────────────────────────────────────────
  await step("relation_type CHECK enumerates four values", async () => {
    const r = await client.query(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'ticket_dependencies'
          and c.contype = 'c'
          and c.conname like '%relation_type%'`,
    );
    const defs = r.rows.map((row) => row.def).join("\n");
    for (const v of ["blocked_by", "related", "duplicate", "builds_on"]) {
      if (!defs.includes(`'${v}'`)) {
        throw new Error(`relation_type CHECK missing '${v}'. Got: ${defs}`);
      }
    }
  });

  // ─── 2. Set up two tickets in a project ────────────────────────────────
  const tenantRes = await client.query("select id from public.tenants limit 1");
  if (tenantRes.rowCount === 0) {
    throw new Error("no tenants present — run the app once to create one");
  }
  const tenantId = tenantRes.rows[0].id;

  const projectId = randomUUID();
  await client.query(
    `insert into public.projects (id, tenant_id, name, default_branch)
     values ($1, $2, $3, 'main')`,
    [projectId, tenantId, `__accept_buildson_${Date.now()}__`],
  );
  track(`delete from public.projects where id=$1`, [projectId]);

  // Parent ticket: simulate a ticket that's already in flight on its
  // devpilot/<slug> branch.
  const parentId = randomUUID();
  await client.query(
    `insert into public.tickets
       (id, tenant_id, project_id, title, status, git_branch_name)
     values ($1, $2, $3, 'Parent stack ticket', 'in_progress', $4)`,
    [parentId, tenantId, projectId, "parent-stack-ticket"],
  );

  // Child ticket: builds_on the parent.
  const childId = randomUUID();
  await client.query(
    `insert into public.tickets
       (id, tenant_id, project_id, title, status, git_branch_name)
     values ($1, $2, $3, 'Child stack ticket', 'ready', $4)`,
    [childId, tenantId, projectId, "child-stack-ticket"],
  );

  // ─── 3. Insert builds_on relation ──────────────────────────────────────
  await step("insert builds_on relation persists", async () => {
    await client.query(
      `insert into public.ticket_dependencies
         (ticket_id, blocks_ticket_id, relation_type)
       values ($1, $2, 'builds_on')`,
      [childId, parentId],
    );
    const r = await client.query(
      `select count(*)::int as n from public.ticket_dependencies
        where ticket_id=$1 and blocks_ticket_id=$2 and relation_type='builds_on'`,
      [childId, parentId],
    );
    if (r.rows[0].n !== 1) throw new Error("builds_on row not stored");
  });

  await step("blocked_by + builds_on coexist between the same pair", async () => {
    await client.query(
      `insert into public.ticket_dependencies
         (ticket_id, blocks_ticket_id, relation_type)
       values ($1, $2, 'blocked_by')`,
      [childId, parentId],
    );
    const r = await client.query(
      `select relation_type from public.ticket_dependencies
        where ticket_id=$1 and blocks_ticket_id=$2
        order by relation_type asc`,
      [childId, parentId],
    );
    const types = r.rows.map((row) => row.relation_type).sort();
    if (JSON.stringify(types) !== JSON.stringify(["blocked_by", "builds_on"])) {
      throw new Error(`expected ['blocked_by','builds_on'], got ${JSON.stringify(types)}`);
    }
  });

  await step("bad relation_type still rejected", async () => {
    try {
      await client.query(
        `insert into public.ticket_dependencies
           (ticket_id, blocks_ticket_id, relation_type)
         values ($1, $2, 'duplicate-of-a-fake-kind')`,
        [childId, parentId],
      );
      throw new Error("insert with bogus relation_type should have failed");
    } catch (err) {
      if (!/check constraint|violates check/.test(err.message)) throw err;
    }
  });

  // ─── 4. Parent slug shape (what loadBuildsOnBase will surface) ─────────
  await step("parent git_branch_name is the slug runner uses for devpilot/<slug>", async () => {
    const r = await client.query(`select git_branch_name from public.tickets where id=$1`, [
      parentId,
    ]);
    if (r.rows[0].git_branch_name !== "parent-stack-ticket") {
      throw new Error(`expected 'parent-stack-ticket', got ${r.rows[0].git_branch_name}`);
    }
  });

  // ─── 5. Cascade delete from parent ─────────────────────────────────────
  await step("deleting the parent cascades the builds_on rows", async () => {
    await client.query(`delete from public.tickets where id=$1`, [parentId]);
    const r = await client.query(
      `select count(*)::int as n from public.ticket_dependencies
        where ticket_id=$1 and blocks_ticket_id=$2`,
      [childId, parentId],
    );
    if (r.rows[0].n !== 0) {
      throw new Error(`expected 0 rows post-cascade, got ${r.rows[0].n}`);
    }
  });

  console.log("\nall checks passed ✓");
} catch (err) {
  exitCode = 1;
  console.error(`\n✗ acceptance failed: ${err.message}`);
} finally {
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
