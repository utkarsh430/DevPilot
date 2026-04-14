// Apply 20260610000000_schedule_activity.sql and verify the table landed.
// Run: node --env-file=apps/web/.env.local apps/web/scripts/apply-schedule-activity-migration.mjs

import { readFileSync } from "node:fs";
import { Client } from "pg";

const file = "supabase/migrations/20260610000000_schedule_activity.sql";
const sql = readFileSync(file, "utf8");

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query(sql);

  const verify = await client.query(`
    select column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'schedule_activity'
     order by ordinal_position;
  `);
  console.log("schedule_activity columns:");
  for (const row of verify.rows) console.log(`  ${row.column_name}`);

  const policies = await client.query(`
    select polname
      from pg_policy
     where polrelid = 'public.schedule_activity'::regclass;
  `);
  console.log("policies:");
  for (const row of policies.rows) console.log(`  ${row.polname}`);

  if (verify.rowCount < 10) {
    console.error(`expected ≥10 columns, got ${verify.rowCount}`);
    process.exit(1);
  }
  console.log("ok");
} catch (err) {
  console.error("migration failed:", err.message);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
