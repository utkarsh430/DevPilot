// `DevPilot-<N>` ticket number acceptance (migration 20260713000000).
//
// What this proves
// ────────────────
// 1. A ticket inserted into a project is numbered by the DB trigger, starting
//    at 1 for a fresh project and continuing max+1 thereafter — no matter which
//    insert path wrote it (the trigger fires on every insert).
// 2. Two projects number INDEPENDENTLY: each board counts from 1.
// 3. A bulk insert (the shape commitPlanAction uses — one statement, an array
//    of rows) numbers every row in the batch, contiguously.
// 4. Concurrent creates in the SAME project never collide: the trigger's
//    `update projects … returning` row-lock serialises two overlapping
//    transactions, which an app-side max()+1 could not.
// 5. `ticket_number` is STABLE across a column move — the very property the old
//    per-column `column_position` badge lacked. Moving a ticket (status +
//    column_position rewritten) leaves the key untouched.
// 6. A ticket with `project_id IS NULL` stays unnumbered (the board falls back
//    to the short hex id).
// 7. The unique index rejects a duplicate (project_id, ticket_number).
// 8. The migration's BACKFILL numbers pre-existing tickets in CREATION order —
//    not insert order — and the counter reseed continues from the high-water
//    mark rather than colliding with a backfilled row.
//
// Pre-reqs: Postgres reachable via DATABASE_URL, with all migrations applied.
// Run: node --env-file=apps/web/.env.local apps/web/scripts/ticket-number-accept.mjs

import { randomUUID } from "node:crypto";
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is missing — pass via --env-file=apps/web/.env.local");
  process.exit(2);
}

const isLocal = url.includes("127.0.0.1") || url.includes("localhost");
const clientConfig = { connectionString: url, ssl: isLocal ? false : true };
const client = new Client(clientConfig);

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

function assertEq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

async function insertTicket(tenantId, projectId, title, extra = {}) {
  const id = randomUUID();
  const createdAt = extra.createdAt ?? null;
  const r = await client.query(
    `insert into public.tickets (id, tenant_id, project_id, title, status, created_at)
     values ($1, $2, $3, $4, 'backlog', coalesce($5::timestamptz, now()))
     returning ticket_number`,
    [id, tenantId, projectId, title, createdAt],
  );
  return { id, ticketNumber: r.rows[0].ticket_number };
}

let exitCode = 0;
try {
  await client.connect();

  const tenantRes = await client.query("select id from public.tenants limit 1");
  let tenantId;
  if (tenantRes.rowCount === 0) {
    // Fresh DB (e.g. a scratch replay database) — mint a tenant to hang the
    // fixtures off. The real local DB always has one.
    tenantId = randomUUID();
    await client.query(
      `insert into public.tenants (id, name) values ($1, '__accept_ticketnum__')`,
      [tenantId],
    );
    track(`delete from public.tenants where id=$1`, [tenantId]);
  } else {
    tenantId = tenantRes.rows[0].id;
  }

  const projectA = randomUUID();
  const projectB = randomUUID();
  for (const [id, name] of [
    [projectA, `__accept_ticketnum_a_${Date.now()}__`],
    [projectB, `__accept_ticketnum_b_${Date.now()}__`],
  ]) {
    await client.query(
      `insert into public.projects (id, tenant_id, name, default_branch) values ($1, $2, $3, 'main')`,
      [id, tenantId, name],
    );
    track(`delete from public.tickets where project_id=$1`, [id]);
    track(`delete from public.projects where id=$1`, [id]);
  }

  // ─── 1. Fresh project counts from 1, then max+1 ────────────────────────
  await step("a fresh project's first ticket is DevPilot-1, then max+1", async () => {
    const t1 = await insertTicket(tenantId, projectA, "A one");
    const t2 = await insertTicket(tenantId, projectA, "A two");
    const t3 = await insertTicket(tenantId, projectA, "A three");
    assertEq([t1.ticketNumber, t2.ticketNumber, t3.ticketNumber], [1, 2, 3], "project A numbering");
  });

  // ─── 2. Projects number independently ──────────────────────────────────
  await step("a second project numbers independently, also from 1", async () => {
    const b1 = await insertTicket(tenantId, projectB, "B one");
    const b2 = await insertTicket(tenantId, projectB, "B two");
    assertEq([b1.ticketNumber, b2.ticketNumber], [1, 2], "project B numbering");
  });

  // ─── 3. Bulk insert (the commitPlanAction shape) ───────────────────────
  await step("a bulk multi-row insert numbers every row contiguously", async () => {
    const rows = [4, 5, 6].map(() => randomUUID());
    const r = await client.query(
      `insert into public.tickets (id, tenant_id, project_id, title, status)
       select unnest($1::uuid[]), $2, $3, unnest($4::text[]), 'backlog'
       returning ticket_number`,
      [rows, tenantId, projectA, ["A bulk 1", "A bulk 2", "A bulk 3"]],
    );
    const nums = r.rows.map((x) => x.ticket_number).sort((a, b) => a - b);
    assertEq(nums, [4, 5, 6], "bulk insert numbering");
  });

  // ─── 4. Concurrent creates in one project never collide ────────────────
  await step("two concurrent creates get distinct numbers (row-lock serialises)", async () => {
    const other = new Client(clientConfig);
    await other.connect();
    try {
      await client.query("begin");
      await other.query("begin");

      const idA = randomUUID();
      const first = await client.query(
        `insert into public.tickets (id, tenant_id, project_id, title, status)
         values ($1, $2, $3, 'Race A', 'backlog') returning ticket_number`,
        [idA, tenantId, projectA],
      );

      // The second transaction's insert blocks on the first's project row lock
      // until it commits — that block is exactly what makes the number safe.
      const idB = randomUUID();
      const secondPromise = other.query(
        `insert into public.tickets (id, tenant_id, project_id, title, status)
         values ($1, $2, $3, 'Race B', 'backlog') returning ticket_number`,
        [idB, tenantId, projectA],
      );

      await client.query("commit");
      const second = await secondPromise;
      await other.query("commit");

      const a = first.rows[0].ticket_number;
      const b = second.rows[0].ticket_number;
      if (a === b) throw new Error(`concurrent inserts collided on ${a}`);
      assertEq(
        [a, b].sort((x, y) => x - y),
        [7, 8],
        "race numbering",
      );
    } finally {
      await other.end().catch(() => {});
    }
  });

  // ─── 5. Stable across a column move ────────────────────────────────────
  await step("ticket_number is unchanged by a column move", async () => {
    const t = await insertTicket(tenantId, projectA, "A mover");
    const before = t.ticketNumber;
    await client.query(
      `update public.tickets
          set status = 'in_progress', column_position = 4096, updated_at = now()
        where id = $1`,
      [t.id],
    );
    const r = await client.query(`select ticket_number from public.tickets where id=$1`, [t.id]);
    assertEq(r.rows[0].ticket_number, before, "ticket_number after move");
  });

  // ─── 6. Project-less tickets stay unnumbered ───────────────────────────
  await step("a ticket with no project stays unnumbered (null)", async () => {
    const id = randomUUID();
    const r = await client.query(
      `insert into public.tickets (id, tenant_id, project_id, title, status)
       values ($1, $2, null, 'Orphan', 'backlog') returning ticket_number`,
      [id, tenantId],
    );
    track(`delete from public.tickets where id=$1`, [id]);
    assertEq(r.rows[0].ticket_number, null, "project-less ticket_number");
  });

  // ─── 7. Unique per project ─────────────────────────────────────────────
  await step("the unique index rejects a duplicate (project_id, ticket_number)", async () => {
    const id = randomUUID();
    let rejected = false;
    try {
      await client.query(
        `insert into public.tickets (id, tenant_id, project_id, title, status, ticket_number)
         values ($1, $2, $3, 'Dup', 'backlog', 1)`,
        [id, tenantId, projectA],
      );
    } catch (err) {
      rejected = err.code === "23505";
      if (!rejected) throw err;
    }
    if (!rejected) throw new Error("duplicate ticket_number was accepted");
  });

  // ─── 8. Backfill replays in creation order ─────────────────────────────
  await step("the migration's backfill numbers pre-existing tickets by created_at", async () => {
    // Insert three tickets whose created_at deliberately DISAGREES with their
    // insert order, then clear their numbers + the counter to reproduce the
    // pre-migration state, and replay the migration's backfill statements
    // verbatim. Correct output = numbered by created_at, not insert order.
    const projectC = randomUUID();
    await client.query(
      `insert into public.projects (id, tenant_id, name, default_branch) values ($1, $2, $3, 'main')`,
      [projectC, tenantId, `__accept_ticketnum_c_${Date.now()}__`],
    );
    track(`delete from public.tickets where project_id=$1`, [projectC]);
    track(`delete from public.projects where id=$1`, [projectC]);

    const oldest = await insertTicket(tenantId, projectC, "C oldest", {
      createdAt: "2026-01-01T00:00:00Z",
    });
    const newest = await insertTicket(tenantId, projectC, "C newest", {
      createdAt: "2026-03-01T00:00:00Z",
    });
    const middle = await insertTicket(tenantId, projectC, "C middle", {
      createdAt: "2026-02-01T00:00:00Z",
    });

    await client.query(`update public.tickets set ticket_number = null where project_id = $1`, [
      projectC,
    ]);
    await client.query(`update public.projects set ticket_seq = 0 where id = $1`, [projectC]);

    // ── the migration's backfill, verbatim ──
    await client.query(`
      with ordered as (
        select id, row_number() over (partition by project_id order by created_at, id) as n
          from public.tickets
         where project_id is not null
      )
      update public.tickets t
         set ticket_number = ordered.n
        from ordered
       where t.id = ordered.id
         and t.ticket_number is null
    `);
    await client.query(`
      update public.projects p
         set ticket_seq = coalesce(
           (select max(t.ticket_number) from public.tickets t where t.project_id = p.id), 0)
    `);

    const r = await client.query(
      `select id, ticket_number from public.tickets where project_id = $1`,
      [projectC],
    );
    const byId = new Map(r.rows.map((row) => [row.id, row.ticket_number]));
    assertEq(
      [byId.get(oldest.id), byId.get(middle.id), byId.get(newest.id)],
      [1, 2, 3],
      "backfill order (oldest→newest)",
    );

    // …and the reseeded counter continues from the high-water mark rather than
    // handing out a number the backfill already used.
    const next = await insertTicket(tenantId, projectC, "C post-backfill");
    assertEq(next.ticketNumber, 4, "next number after reseed");
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
