# Runbook: Add a database migration

**When to use:** You need a schema change (new table, column, index, or RLS policy).
Migrations are **forward-only** SQL files in `supabase/migrations/`; there is no down-migration.

## Prerequisites

- Supabase CLI installed and the local stack running for testing (`supabase start`); see
  README.md → Quick start.
- Know the tenancy of any new table: tenant-scoped tables need Row-Level Security policies
  (this repo secures per-tenant / per-agent data with RLS - see README.md and
  `docs/DEVPILOT_TDD.md` §4).

## Steps

1. **Create the file** `supabase/migrations/<YYYYMMDDHHMMSS>_<short_description>.sql`.
   Use a UTC timestamp prefix greater than the latest existing file (they apply in filename
   order). `supabase migration new <short_description>` generates a correctly-named empty file.
2. **Write idempotent, forward-only SQL.** Match the house style in recent migrations
   (e.g. `supabase/migrations/20260622000000_runs_tmux_session_name.sql`): a header comment
   explaining _why_, then `add column if not exists` / `create table if not exists` /
   `create index if not exists`. For policies and constraints use `drop policy if exists` /
   `drop constraint if exists` before re-creating, so a re-run or a partially-applied history
   never wedges the push.
3. **RLS for tenant-scoped tables:** `enable row level security` on the table and add the
   tenant-scoping policies. Copy the pattern from an existing policy migration such as
   `supabase/migrations/20260610000000_schedule_activity.sql`.
4. **Apply it.** Locally, `supabase db reset` re-runs all migrations against the local stack
   from scratch (cleanest verification), or `supabase db push` applies pending ones to the
   linked DB.

## Verify

- `supabase db reset` completes with no error (proves the file is idempotent and ordered
  correctly against the full history).
- Query `information_schema` / Supabase Studio (http://localhost:54323) to confirm the object
  exists, and confirm RLS is enabled on any new tenant table.
- `pnpm --filter @devpilot/web typecheck` if you also touched code that reads the new column.

## Gotchas

- **Never hand-edit the prod schema** or an already-applied migration file - add a new forward
  migration (README.md).
- Non-idempotent SQL is the #1 cause of drift here: a file that ran once but was never recorded
  in `supabase_migrations.schema_migrations` will fail a later `db push` unless it is safe to
  re-run. Always guard with `if (not) exists` / `drop … if exists`.
- A tenant-scoped table without RLS is a data-isolation bug, not a style nit - do not skip step 3.
