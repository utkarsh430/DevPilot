// One-off: what happened to ticket 5029ADEC?
// Run: node --env-file=apps/web/.env.local apps/web/scripts/scratch-diagnose-5029adec.mjs

import { Client } from "pg";

const TICKET_PREFIX = "5029adec";

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const t = await client.query(
  `select id, title, status, paused_at, paused_reason, retry_count, updated_at
   from public.tickets
   where id::text like $1 || '%'`,
  [TICKET_PREFIX],
);
console.log("TICKET:", t.rows[0]);
const ticketId = t.rows[0].id;

const runs = await client.query(
  `select id, status, status_reason, runner_id, runner_kind, replay_of_run_id,
          replay_reason, parent_run_id, attempt_index, supervision_strategy,
          spent_cents, created_at, last_event_at
   from public.runs
   where ticket_id = $1
   order by created_at asc`,
  [ticketId],
);
console.log(`\nRUNS: ${runs.rowCount}`);
for (const r of runs.rows) {
  console.log(
    `  ${r.created_at.toISOString()} ${r.id.slice(0, 8)} status=${r.status} reason=${r.status_reason ?? "—"} runner=${r.runner_id?.slice(0, 8) ?? "—"} parent=${r.parent_run_id?.slice(0, 8) ?? "—"} replay_of=${r.replay_of_run_id?.slice(0, 8) ?? "—"} replay_reason=${r.replay_reason ?? "—"} attempt=${r.attempt_index ?? 0} sup=${r.supervision_strategy ?? "—"} spent=${r.spent_cents}¢`,
  );
}

const comments = await client.query(
  `select author_type, author_id, body, created_at
   from public.comments
   where ticket_id = $1
   order by created_at desc
   limit 10`,
  [ticketId],
);
console.log(`\nRECENT COMMENTS (newest first):`);
for (const c of comments.rows) {
  console.log(
    `  ${c.created_at.toISOString()} [${c.author_type}:${c.author_id}] ${c.body.slice(0, 150).replace(/\n/g, " ")}`,
  );
}

const queue = await client.query(
  `select id, status, agent_id, enqueued_at, claimed_at, cancelled_at
   from public.dispatch_queue
   where ticket_id = $1
   order by enqueued_at desc
   limit 10`,
  [ticketId],
);
console.log(`\nDISPATCH QUEUE: ${queue.rowCount}`);
for (const q of queue.rows) console.log(" ", q);

await client.end();
