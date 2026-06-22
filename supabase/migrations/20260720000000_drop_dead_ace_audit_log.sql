-- Drop the dead `ace_audit_log` table (ACE → DevPilot rename, batch 2a).
--
-- WHY DROP RATHER THAN RENAME: the table has never had a single reader or
-- writer. It was created by `20260603160000_phase2_token_encryption_and_audit.sql`,
-- whose comment claims "Application code inserts rows via the server actions" —
-- it does not, and never did. There is no `.from("ace_audit_log")` anywhere in
-- the tree (`rg ace_audit_log apps/ tests/ infra/` → zero), no trigger writes to
-- it, and it is not in any realtime publication. Renaming it to
-- `devpilot_audit_log` would just relocate dead schema; if an audit log is wanted
-- later, it should be designed against real requirements rather than inherited
-- from a stub that shipped empty.
--
-- Every statement is guarded, so this is safe to re-run and safe on an instance
-- where the table was never created.
--
-- Not a data-loss risk: with zero writers the table is empty by construction.
-- `drop table` fails loudly (rather than silently cascading) if anything ever
-- did come to depend on it — deliberately no `cascade`.

begin;

-- The policy and index are dropped explicitly, though `drop table` would remove
-- both implicitly — stated separately so the intent is legible.
--
-- The `to_regclass` guard is load-bearing, not decoration: `drop policy IF EXISTS
-- … ON <table>` only tolerates a missing POLICY. If the TABLE is already gone it
-- still raises `relation "public.ace_audit_log" does not exist`, which would make
-- this migration fail on any re-run and on a fresh database. `drop index if
-- exists` and `drop table if exists` need no such guard (neither depends on a
-- relation that must pre-exist).
do $$
begin
  if to_regclass('public.ace_audit_log') is not null then
    drop policy if exists ace_audit_log_member_read on public.ace_audit_log;
  end if;
end
$$;

drop index if exists public.ace_audit_log_tenant_created_idx;

drop table if exists public.ace_audit_log;

commit;
