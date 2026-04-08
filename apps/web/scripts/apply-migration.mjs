// One-shot migration runner used to apply the auto_promote_when_unblocked
// column without requiring `psql` or the supabase CLI on the host. Run with:
//   node --env-file=.env.local scripts/apply-migration.mjs <path-to.sql>
import { readFileSync } from "node:fs";
import { Client } from "pg";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/apply-migration.mjs <path-to.sql>");
  process.exit(2);
}
const sql = readFileSync(file, "utf8");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is missing — pass it via --env-file=.env.local");
  process.exit(2);
}

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  await client.query(sql);
  const verify = await client.query(
    "select column_name from information_schema.columns where table_schema='public' and table_name='tickets' and column_name='auto_promote_when_unblocked'",
  );
  if (verify.rowCount === 1) {
    console.log("ok: auto_promote_when_unblocked column is present");
  } else {
    console.error("applied without error, but column not found in information_schema");
    process.exit(1);
  }
} catch (err) {
  console.error("migration failed:", err.message);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
