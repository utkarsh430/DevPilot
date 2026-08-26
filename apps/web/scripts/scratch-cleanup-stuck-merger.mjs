// One-off cleanup for the stuck merger that was spawned by Phase B's
// pre-fix rebase code on pending_push d3e0ecf4-a18f-45b8-9332-bdb3697287e6.
// Scratch script — safe to delete after the cleanup runs.
//
// Run: node --env-file=apps/web/.env.local apps/web/scripts/scratch-cleanup-stuck-merger.mjs

import { Client } from "pg";

const PENDING_PUSH_ID = "d3e0ecf4-a18f-45b8-9332-bdb3697287e6";
const MERGER_TICKET_ID = "81349496-b587-412c-b28e-bbffdc4d1cb7";

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

try {
  await client.query("BEGIN");

  const evDel = await client.query(
    "delete from public.merge_conflict_events where pending_push_id = $1",
    [PENDING_PUSH_ID],
  );
  console.log(`merge_conflict_events deleted: ${evDel.rowCount}`);

  const depDel = await client.query(
    `delete from public.ticket_dependencies
       where blocks_ticket_id = $1
         and relation_type = 'blocked_by'`,
    [MERGER_TICKET_ID],
  );
  console.log(`ticket_dependencies(blocked_by, merger) deleted: ${depDel.rowCount}`);

  const ppUpd = await client.query(
    `update public.pending_pushes
        set conflict_state = null,
            conflict_detail = null,
            rebased_onto_sha = null,
            merger_ticket_id = null,
            updated_at = now()
      where id = $1`,
    [PENDING_PUSH_ID],
  );
  console.log(`pending_pushes reset: ${ppUpd.rowCount}`);

  const tDel = await client.query("delete from public.tickets where id = $1", [MERGER_TICKET_ID]);
  console.log(`merger ticket deleted: ${tDel.rowCount}`);

  await client.query("COMMIT");
  console.log("cleanup committed");
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("cleanup failed; transaction rolled back:", err.message);
  process.exit(1);
} finally {
  await client.end();
}
