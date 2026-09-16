-- 20260752000000_storage_reap_guard.sql
--
-- A ticket carrying an attachment could not be deleted. At all.
--
-- Supabase ships `storage.protect_delete`, a BEFORE DELETE **STATEMENT**
-- trigger on `storage.objects` that raises 42501 ("Direct deletion from
-- storage tables is not allowed") unless the transaction-local GUC
-- `storage.allow_delete_query` is set to 'true'. Statement-level is the part
-- that makes this unavoidable: it fires on the delete STATEMENT, so a reap
-- that matches zero objects is refused exactly like one that matches many.
--
-- Two of our three reap triggers issued that statement bare. And because a
-- reap is an AFTER DELETE trigger, the 42501 does not merely fail to clean
-- up — it propagates out and ABORTS THE DELETE THAT FIRED IT. Reproduced
-- against a live local Postgres (see the accept script named below):
--
--   * `trg_reap_ticket_attachment_object` (20260725000000) — deleting a
--     ticket that has an attachment fails. The operator sees the toast
--     "Couldn't delete ticket — Direct deletion from storage tables is not
--     allowed. Use the Storage API instead.", which names nothing they did
--     and offers no way forward: that ticket is simply undeletable. Bulk
--     delete is one statement, so a single attachment-bearing ticket in the
--     selection takes the whole batch down with it.
--
--   * `trg_reap_export_object` (20260728000000) — same shape, reached by
--     deleting a PROJECT that has ever produced a project-scope PDF export
--     (`exports.project_id` cascades). Also reproduced.
--
--   * `trg_reap_run_artifact_object` (20260748000000) — already correct;
--     PR #155 hit this while building it and guarded it there. It is the
--     shape the other two are brought up to here.
--
-- Tenant deletion cascades into all three, so it inherited every one.
--
-- ---------------------------------------------------------------------------
-- ONE HELPER, NOT THREE COPIES — and why the ordering objection does not bite
-- ---------------------------------------------------------------------------
-- The obvious alternative is to paste the guard into each of the two broken
-- functions. It was rejected. Three hand-maintained copies of one rule is
-- precisely how the codebase got here: #155 wrote the correct shape and the
-- two older siblings kept the wrong one, invisibly, because nothing tied them
-- together. The next person to add a storage-backed table copies whichever
-- reap they happen to open first — which, today, is a coin flip.
--
-- The stated worry is that a migration must not depend on a helper a later
-- migration might alter. It does not apply to how this is written: this ONE
-- migration creates the helper and rewrites all three functions to call it,
-- inside a single transaction, so there is no window in which a function
-- references a helper that does not exist. The residual risk — someone edits
-- the helper and moves three triggers at once — is the same trade the repo
-- already makes for `checkPromptGuardPatterns` (called, never copied), and it
-- cuts the right way: one guarded implementation gets read carefully, three
-- copies get skimmed.
--
-- `run_artifacts` is rewritten too even though it was not broken. Leaving it
-- on its own private copy would preserve exactly the drift this exists to end.
--
-- ---------------------------------------------------------------------------
-- THREE PROPERTIES OF THE HELPER, all load-bearing
-- ---------------------------------------------------------------------------
-- (1) THE EXCEPTION HANDLER IS THE ACTUAL FIX, not the set_config.
--     Setting the GUC handles the failure mode we know about. The handler
--     handles the ones we do not: Supabase owns `storage.protect_delete` and
--     has changed its shape before, and any future refusal — a renamed GUC, a
--     new policy, a permission change — would otherwise resurrect an
--     undeletable ticket. An orphaned object is a bounded, invisible cost. A
--     row that cannot be deleted is a trap the operator cannot work around.
--     Degrade to a warning, always.
--
-- (2) THE PRIOR GUC VALUE IS RESTORED.
--     `set_config(..., is_local => true)` is transaction-scoped, not
--     statement-scoped. Leaving it armed means one reaped attachment disarms
--     `protect_delete` for every subsequent statement in that transaction —
--     including application statements that have nothing to do with reaping.
--     Restoring narrows the hole to the one delete that needs it. (The
--     exception path gets it for free: plpgsql rolls a caught block's GUC
--     changes back with it. The explicit restore there is belt-and-braces.)
--
-- (3) EXECUTE IS REVOKED FROM PUBLIC.
--     This is a SECURITY DEFINER function that deletes an arbitrary object
--     from an arbitrary bucket. Postgres grants EXECUTE to PUBLIC by default,
--     which would hand `anon` and `authenticated` a cross-tenant storage
--     deleter reachable over PostgREST's RPC surface — a straight privilege
--     escalation, and a strictly worse bug than the one being fixed. The
--     three callers are themselves SECURITY DEFINER and owned by the same
--     role, so the inner call is permission-checked as that definer and is
--     unaffected by the revoke.
--
-- Verification: `pnpm --filter @devpilot/web accept:storage-reap` seeds a
-- ticket-with-attachment and a project-with-export against a real Postgres,
-- asserts BOTH deletes fail before this migration and succeed after, asserts
-- the objects are actually gone, and asserts an unreapable object degrades to
-- a warning instead of blocking the delete. Everything rolls back.
--
-- No app-layer change. No agent-facing surface.

begin;

-- ---------------------------------------------------------------------------
-- The one guarded storage delete.
-- ---------------------------------------------------------------------------
create or replace function public.storage_reap_object(p_bucket text, p_key text)
returns void
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  prior text;
begin
  if p_key is null or p_bucket is null then
    return;
  end if;

  -- Remember what the caller had, so the arming below cannot outlive this
  -- one statement (property 2 above).
  prior := coalesce(current_setting('storage.allow_delete_query', true), 'false');

  begin
    perform set_config('storage.allow_delete_query', 'true', true);

    delete from storage.objects
     where bucket_id = p_bucket
       and name = p_key;

    perform set_config('storage.allow_delete_query', prior, true);
  exception when others then
    -- An orphaned object is acceptable. A row that cannot be deleted is not.
    perform set_config('storage.allow_delete_query', prior, true);
    raise warning 'storage reap: could not remove %/% (%)', p_bucket, p_key, sqlerrm;
  end;
end;
$$;

comment on function public.storage_reap_object(text, text) is
  'Delete one object from a storage bucket on behalf of an AFTER DELETE reap '
  'trigger. Arms storage.allow_delete_query for the single statement and '
  'restores it, and degrades any failure to a warning so a reap can never '
  'abort the delete that fired it. EXECUTE is revoked from PUBLIC — callers '
  'must be SECURITY DEFINER trigger functions owned by the same role.';

revoke all on function public.storage_reap_object(text, text) from public;

-- ---------------------------------------------------------------------------
-- The three reaps, now sharing that one implementation.
-- ---------------------------------------------------------------------------

-- Was broken: deleting a ticket with an attachment raised 42501.
create or replace function public.reap_ticket_attachment_object()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  perform public.storage_reap_object('ticket-attachments', old.storage_key);
  return old;
end;
$$;

-- Was broken: deleting a project with a completed export raised 42501.
create or replace function public.reap_export_object()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  perform public.storage_reap_object('exports', old.storage_key);
  return old;
end;
$$;

-- Was already correct (#155). Rewritten only so one rule has one home.
create or replace function public.reap_run_artifact_object()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  perform public.storage_reap_object('run-artifacts', old.storage_key);
  return old;
end;
$$;

commit;
