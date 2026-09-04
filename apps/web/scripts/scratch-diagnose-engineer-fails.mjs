// One-off: why did engineer runs 7686fbb6 and 403c55d1 (ticket F712B9BF) fail?
// Run: node --env-file=apps/web/.env.local apps/web/scripts/scratch-diagnose-engineer-fails.mjs

import { Client } from "pg";

const RUN_PREFIXES = ["7686fbb6", "403c55d1"];
const TICKET_PREFIX = "f712b9bf";

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

// --- Ticket context -------------------------------------------------------
const t = await client.query(
  `select id, title, status, paused_at, paused_reason, retry_count, updated_at
   from public.tickets
   where id::text like $1 || '%'`,
  [TICKET_PREFIX],
);
console.log("TICKET:");
console.log(" ", t.rows[0] ?? "(not found)");
console.log();

// --- One block per run ----------------------------------------------------
for (const prefix of RUN_PREFIXES) {
  console.log("=".repeat(78));
  console.log(`RUN ${prefix}`);
  console.log("=".repeat(78));

  const r = await client.query(
    `select id, status, status_reason, runner_id, runner_kind, replay_of_run_id,
            replay_reason, parent_run_id, attempt_index, supervision_strategy,
            spent_cents, budget_cents, created_at, last_event_at
     from public.runs
     where id::text like $1 || '%'`,
    [prefix],
  );
  if (r.rowCount === 0) {
    console.log("  (run not found)\n");
    continue;
  }
  const run = r.rows[0];
  console.log("HEADER:");
  console.log(`  id            ${run.id}`);
  console.log(`  status        ${run.status}`);
  console.log(`  status_reason ${run.status_reason ?? "—"}`);
  console.log(
    `  runner        kind=${run.runner_kind ?? "—"} id=${run.runner_id?.slice(0, 8) ?? "—"}`,
  );
  console.log(`  budget        spent=${run.spent_cents}¢ / cap=${run.budget_cents}¢`);
  console.log(
    `  lineage       parent=${run.parent_run_id?.slice(0, 8) ?? "—"} replay_of=${run.replay_of_run_id?.slice(0, 8) ?? "—"} reason=${run.replay_reason ?? "—"} attempt=${run.attempt_index ?? 0}`,
  );
  console.log(
    `  timing        created=${run.created_at.toISOString()} last_event=${run.last_event_at?.toISOString?.() ?? run.last_event_at ?? "—"}`,
  );

  // --- System (audit) steps: failed_reason lives here ---------------------
  const sys = await client.query(
    `select idx, payload, created_at
     from public.run_steps
     where run_id = $1 and kind = 'system'
     order by idx asc`,
    [run.id],
  );
  console.log(`\nSYSTEM STEPS (${sys.rowCount}):`);
  for (const s of sys.rows) {
    const p = s.payload ?? {};
    const reason = p.failed_reason ?? p.reason ?? null;
    console.log(`  idx=${s.idx} keys=${Object.keys(p).join(",")} ${s.created_at.toISOString()}`);
    if (reason) {
      console.log(`    failed_reason:`);
      for (const line of String(reason).split("\n")) console.log(`      ${line}`);
    } else {
      // No failed_reason — show the raw payload so we can spot whatever was logged.
      const raw = JSON.stringify(p, null, 2).split("\n").slice(0, 40).join("\n");
      console.log(`    payload (first 40 lines):`);
      for (const line of raw.split("\n")) console.log(`      ${line}`);
    }
  }

  // --- Productive step trail (last 8) -------------------------------------
  const prod = await client.query(
    `select idx, kind, payload, created_at
     from public.run_steps
     where run_id = $1 and kind in ('think','tool_call','tool_result','human_wait')
     order by idx desc
     limit 8`,
    [run.id],
  );
  console.log(`\nLAST ${prod.rowCount} PRODUCTIVE STEPS (newest first):`);
  for (const s of prod.rows.reverse()) {
    const p = s.payload ?? {};
    let summary = "";
    if (s.kind === "tool_call") {
      summary = `tool=${p.tool ?? p.name ?? "?"} args=${JSON.stringify(p.args ?? p.arguments ?? {}).slice(0, 160)}`;
    } else if (s.kind === "tool_result") {
      const ok = p.ok ?? p.success ?? "?";
      const err = p.error ?? p.err ?? null;
      summary = `ok=${ok}${err ? ` error=${String(err).slice(0, 160)}` : ` result=${JSON.stringify(p.result ?? p.output ?? "").slice(0, 160)}`}`;
    } else if (s.kind === "think") {
      summary = `role=${p.role ?? "—"} content=${String(p.content ?? p.text ?? "").slice(0, 160)}`;
    } else {
      summary = JSON.stringify(p).slice(0, 200);
    }
    console.log(
      `  idx=${String(s.idx).padStart(4)} ${s.kind.padEnd(11)} ${s.created_at.toISOString()}  ${summary}`,
    );
  }

  console.log();
}

await client.end();
