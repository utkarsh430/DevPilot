// Apply 20260609020000_automation_pause.sql and verify columns landed.
// Run: node --env-file=apps/web/.env.local apps/web/scripts/apply-automation-pause-migration.mjs

import { readFileSync } from "node:fs";
import { Client } from "pg";

const file = "supabase/migrations/20260609020000_automation_pause.sql";
const sql = readFileSync(file, "utf8");

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query(sql);

  const verify = await client.query(`
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name in ('tenants', 'projects')
       and column_name in (
         'automation_state',
         'automation_paused_at',
         'automation_resumed_at',
         'automation_paused_by_user_id'
       )
     order by table_name, column_name;
  `);
  console.log("Columns present after migration:");
  for (const row of verify.rows) {
    console.log(`  ${row.table_name}.${row.column_name}`);
  }
  const expected = 8;
  if (verify.rowCount !== expected) {
    console.error(`expected ${expected} columns, got ${verify.rowCount}`);
    process.exit(1);
  }
  console.log("ok");
} catch (err) {
  console.error("migration failed:", err.message);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
