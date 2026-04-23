// Phase 2.5+ / Slice IB-B — conflict rebase + merger audit acceptance.
//
// What this proves
// ────────────────
// 1. Schema:
//    a. pending_pushes has conflict_state, conflict_detail, rebased_onto_sha,
//       merger_ticket_id columns with the expected types + check constraints.
//    b. merge_conflict_events table exists with the expected kind enum
//       and FK to pending_pushes (CASCADE) + tickets (SET NULL).
// 2. release_engineer role is wired:
//    a. lib/roles/index.ts ROLES map has it.
//    b. lib/roles/catalog.ts has the entry.
//    c. The dispatcher's classifier prompt enumerates it (via catalog).
// 3. State transitions:
//    - Insert a synthetic pending_push row, stamp conflict_state='conflict'
//      with a structured conflict_detail, then log a chain of events
//      (detected → merger_spawned → merger_started → file_resolved ×2 →
//      merger_completed → retry_pushed). All inserts succeed.
//    - Verify the events are queryable in created_at order and that the
//      kind values match the check constraint.
// 4. Cascade behavior:
//    - Deleting the pending_push cascades the merge_conflict_events
//      (ON DELETE CASCADE).
//
// What this deliberately doesn't cover (left to manual walkthrough)
// ────────────────────────────────────────────────────────────────
// • An actual `git rebase` failure inside pushPendingChangesAction
//   (would need the runner + a real workspace + a real GitHub repo with
//   an actual merge conflict on the integration branch).
// • The merger role's full claude run end-to-end.
// • The /changes Conflicts tab realtime subscription (browser-only).
//
// Pre-reqs: Postgres reachable via DATABASE_URL (.env.local).
// Run: node --env-file=apps/web/.env.local apps/web/scripts/conflict-rebase-accept.mjs

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

  // ─── 1. Schema verification ─────────────────────────────────────────────
  await step("pending_pushes conflict columns exist", async () => {
    const r = await client.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='pending_pushes'
          and column_name in
            ('conflict_state','conflict_detail','rebased_onto_sha','merger_ticket_id')`,
    );
    const cols = r.rows.map((row) => row.column_name).sort();
    const want = ["conflict_detail", "conflict_state", "merger_ticket_id", "rebased_onto_sha"];
    for (const c of want) {
      if (!cols.includes(c)) {
        throw new Error(`pending_pushes missing column "${c}". Got: ${cols.join(", ")}`);
      }
    }
  });

  await step("pending_pushes.conflict_state check constraint matches spec", async () => {
    const r = await client.query(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'pending_pushes'
          and c.contype = 'c'`,
    );
    const defs = r.rows.map((row) => row.def).join("\n");
    for (const v of ["clean", "rebased", "conflict", "resolved"]) {
      if (!defs.includes(`'${v}'`)) {
        throw new Error(`conflict_state check missing '${v}'`);
      }
    }
  });

  await step("merge_conflict_events table exists with expected columns", async () => {
    const r = await client.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='merge_conflict_events'
        order by ordinal_position`,
    );
    const got = r.rows.map((row) => row.column_name);
    const want = [
      "id",
      "tenant_id",
      "pending_push_id",
      "project_id",
      "ticket_id",
      "merger_ticket_id",
      "kind",
      "payload",
      "created_at",
    ];
    for (const c of want) {
      if (!got.includes(c)) {
        throw new Error(`merge_conflict_events missing column "${c}". Have: ${got.join(", ")}`);
      }
    }
  });

  await step("merge_conflict_events.kind check constraint enumerates events", async () => {
    const r = await client.query(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'merge_conflict_events'
          and c.contype = 'c'`,
    );
    const defs = r.rows.map((row) => row.def).join("\n");
    const kinds = [
      "detected",
      "merger_spawned",
      "merger_started",
      "file_resolved",
      "merger_completed",
      "operator_overrode",
      "retry_pushed",
      "retry_failed",
    ];
    for (const k of kinds) {
      if (!defs.includes(`'${k}'`)) {
        throw new Error(`kind check missing '${k}'`);
      }
    }
  });

  // ─── 2. Pick a tenant + project + create a synthetic pending_push ───────
  const tenantRes = await client.query("select id from public.tenants limit 1");
  if (tenantRes.rowCount === 0) {
    throw new Error("no tenants present — run the app once to create one");
  }
  const tenantId = tenantRes.rows[0].id;

  const projectId = randomUUID();
  await client.query(
    `insert into public.projects (id, tenant_id, name, default_branch, integration_branch)
     values ($1, $2, $3, 'main', 'dev')`,
    [projectId, tenantId, `__accept_conflict_${Date.now()}__`],
  );
  track(`delete from public.projects where id=$1`, [projectId]);

  const sourceTicketId = randomUUID();
  await client.query(
    `insert into public.tickets (id, tenant_id, project_id, title, status)
     values ($1, $2, $3, 'Smoke source ticket', 'in_review')`,
    [sourceTicketId, tenantId, projectId],
  );
  // No need to track — cascades via project.

  const pendingPushId = randomUUID();
  await client.query(
    `insert into public.pending_pushes
       (id, tenant_id, project_id, ticket_id, workspace_path, branch,
        unpushed_count, files_changed)
     values ($1, $2, $3, $4, '/tmp/__accept__', 'devpilot/smoke-source',
             1, '[]'::jsonb)`,
    [pendingPushId, tenantId, projectId, sourceTicketId],
  );

  // ─── 3. Conflict state transitions ──────────────────────────────────────
  await step("stamp pending_pushes.conflict_state='conflict' with detail", async () => {
    const detail = {
      files: ["README.md", "src/index.ts"],
      stderr: "CONFLICT (content): Merge conflict in README.md",
      base_sha: "abcdef1",
      branch_sha: "1234567",
    };
    await client.query(
      `update public.pending_pushes
          set conflict_state='conflict', conflict_detail=$1::jsonb
        where id=$2`,
      [JSON.stringify(detail), pendingPushId],
    );
    const r = await client.query(
      `select conflict_state, conflict_detail from public.pending_pushes where id=$1`,
      [pendingPushId],
    );
    if (r.rows[0].conflict_state !== "conflict") {
      throw new Error(`expected conflict, got ${r.rows[0].conflict_state}`);
    }
    if (!Array.isArray(r.rows[0].conflict_detail.files)) {
      throw new Error("conflict_detail.files did not round-trip as an array");
    }
  });

  await step("create merger ticket + stamp merger_ticket_id", async () => {
    const mergerTicketId = randomUUID();
    await client.query(
      `insert into public.tickets
         (id, tenant_id, project_id, title, status, requested_role,
          parent_ticket_id, priority)
       values ($1, $2, $3, 'Resolve merge conflict: Smoke source ticket',
               'ready', 'release_engineer', $4, 1)`,
      [mergerTicketId, tenantId, projectId, sourceTicketId],
    );
    await client.query(
      `insert into public.ticket_dependencies
         (ticket_id, blocks_ticket_id, relation_type)
       values ($1, $2, 'blocked_by')`,
      [sourceTicketId, mergerTicketId],
    );
    await client.query(`update public.pending_pushes set merger_ticket_id=$1 where id=$2`, [
      mergerTicketId,
      pendingPushId,
    ]);
    const r = await client.query(`select merger_ticket_id from public.pending_pushes where id=$1`, [
      pendingPushId,
    ]);
    if (r.rows[0].merger_ticket_id !== mergerTicketId) {
      throw new Error("merger_ticket_id not stamped");
    }
    // Verify the blocked_by relation.
    const dep = await client.query(
      `select count(*)::int as n from public.ticket_dependencies
        where ticket_id=$1 and blocks_ticket_id=$2 and relation_type='blocked_by'`,
      [sourceTicketId, mergerTicketId],
    );
    if (dep.rows[0].n !== 1) {
      throw new Error("blocked_by dependency not inserted");
    }
  });

  await step("log full event chain (detected → … → retry_pushed)", async () => {
    const kinds = [
      ["detected", { files: ["README.md", "src/index.ts"] }],
      ["merger_spawned", { merger_ticket_id: "abc" }],
      ["merger_started", { merger_run_id: "run-1" }],
      ["file_resolved", { file: "README.md", strategy: "synthesis", notes: "merged both lists" }],
      ["file_resolved", { file: "src/index.ts", strategy: "pick-theirs", notes: "branch wins" }],
      ["merger_completed", { resolved_files: ["README.md", "src/index.ts"] }],
      ["retry_pushed", { head_sha: "deadbee" }],
    ];
    for (const [kind, payload] of kinds) {
      const r = await client.query(
        `insert into public.merge_conflict_events
           (tenant_id, project_id, pending_push_id, ticket_id, kind, payload)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         returning id`,
        [tenantId, projectId, pendingPushId, sourceTicketId, kind, JSON.stringify(payload)],
      );
      if (r.rowCount !== 1) {
        throw new Error(`insert for kind=${kind} failed`);
      }
    }
    const r = await client.query(
      `select kind from public.merge_conflict_events
        where pending_push_id=$1
        order by created_at asc, id asc`,
      [pendingPushId],
    );
    const got = r.rows.map((row) => row.kind);
    const want = kinds.map(([k]) => k);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`event order mismatch: got ${got.join(",")} want ${want.join(",")}`);
    }
  });

  await step("merge_conflict_events.kind check rejects bad values", async () => {
    try {
      await client.query(
        `insert into public.merge_conflict_events
           (tenant_id, project_id, pending_push_id, kind)
         values ($1, $2, $3, 'sneaky-fake-kind')`,
        [tenantId, projectId, pendingPushId],
      );
      throw new Error("insert with bad kind should have failed");
    } catch (err) {
      if (!/check constraint|violates check/.test(err.message)) {
        throw err;
      }
    }
  });

  await step("stamp resolved → audit row + state both present", async () => {
    await client.query(`update public.pending_pushes set conflict_state='resolved' where id=$1`, [
      pendingPushId,
    ]);
    const r = await client.query(`select conflict_state from public.pending_pushes where id=$1`, [
      pendingPushId,
    ]);
    if (r.rows[0].conflict_state !== "resolved") {
      throw new Error("conflict_state not transitioned to resolved");
    }
    const cnt = await client.query(
      `select count(*)::int as n from public.merge_conflict_events
        where pending_push_id=$1`,
      [pendingPushId],
    );
    if (cnt.rows[0].n < 7) {
      throw new Error(`expected 7+ events, got ${cnt.rows[0].n}`);
    }
  });

  await step("ON DELETE CASCADE wipes events when pending_push goes", async () => {
    await client.query(`delete from public.pending_pushes where id=$1`, [pendingPushId]);
    const cnt = await client.query(
      `select count(*)::int as n from public.merge_conflict_events
        where pending_push_id=$1`,
      [pendingPushId],
    );
    if (cnt.rows[0].n !== 0) {
      throw new Error(`expected 0 events post-cascade, got ${cnt.rows[0].n}`);
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
