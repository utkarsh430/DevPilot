-- =============================================================================
-- Migration : 20260762000000_desktop_rls_security_definer_rpcs.sql
-- Purpose   : WP 1.3 (devpilot-desktop) — the six SECURITY DEFINER RPCs the
--             7 agent write shapes need that a bare owner/tenant RLS policy
--             cannot express: a reserved column value, an actor-type
--             distinction, an atomic cross-row cap, or a multi-step gate
--             ladder. Companion to 20260761000000 (the 3 plain-policy routes).
--
-- Provenance
-- ──────────
-- Productionised from the executed local-harness probe at
--   projects/devpilot-desktop/probes/rls/sql/05_security_definer_rpcs.sql
--   projects/devpilot-desktop/probes/rls/tests/1{1,2,3,5,6,9}_*.sql
--   projects/devpilot-desktop/docs/probes/04-rls-agent-writes.md
-- ("Definitive RPC list for WP 1.3" table). The RPC PATTERN — SECURITY
-- DEFINER, set search_path = public, EXECUTE granted to authenticated, every
-- function independently re-deriving tenant from a server-trusted FK chain
-- and re-checking membership before touching anything — is unchanged from the
-- probe; this file adapts the candidate bodies to devpilot's REAL schema and
-- fixes the drift the probe's own finding doc flagged as needing verification
-- against the live schema. What changed and why, table by table:
--
--   • devpilot_move_ticket now enforces the REAL FSM (lib/board/state.ts's
--     ALLOWED_TRANSITIONS, all 10 states / 33 edges) and the REAL human-only
--     gate sets (lib/board/reopen-policy.ts's HUMAN_ONLY_BACKLOG_RESET_SOURCES
--     = {done, in_progress, input_required, blocked} for `→ backlog`;
--     lib/board/safety-gate.ts's `to=done AND safety_critical AND actor≠human`
--     for the safety gate) — not the probe's smaller "representative subset,
--     enough to exercise every gate this probe tests". Using the toy subset in
--     a PRODUCTION migration would forbid legal transitions the app performs
--     today and admit illegal ones it doesn't; the real table is not a design
--     change, it's existing, deployed, tested business logic. DELIBERATELY
--     NOT implemented (matches the probe finding doc's own explicit scoping,
--     "additive to the same RPC body ... WP 1.3 needs to actually write it"):
--     the QA-verification-required gate (reads run_verifications), the
--     gate_retry_count ceiling park, and cascading promoteUnblockedDependents.
--     A ticket this RPC moves to `ready` does NOT re-check open blockers.
--
--   • devpilot_create_ticket claims its atomic per-run cap with its OWN
--     `update runs ... where id=p_run_id and tenant_id=v_tenant_id and
--     tickets_created_count < v_max ...` rather than calling the EXISTING
--     runs_claim_ticket_slot(run_id, max) (20260717000000) — the finding doc
--     says so explicitly: "WP 1.3 should just build the wrapping RPC directly
--     rather than layering a new function on the old service_role-only one."
--     There is a real reason beyond that recommendation, too:
--     runs_claim_ticket_slot's WHERE has no tenant_id clause (it never needed
--     one — its only caller was the trusted service-role engine), so calling
--     it here would let a caller pass an ARBITRARY run id and race/exhaust a
--     DIFFERENT tenant's fan-out counter. Baking tenant_id into this
--     function's own atomic UPDATE closes that in the same statement that
--     claims the slot — no separate check, no window between them.
--     agent_ticket_max_per_run defaults to 3 when the project has not set an
--     override — devpilot's real default-resolution chain is
--     project » DEVPILOT_MAX_TICKETS_PER_RUN env » 3
--     (lib/board/agent-ticket.ts's resolveMaxTicketsPerRun); a Postgres
--     function has no access to the app's env var, so this RPC only has the
--     first and third rungs. Also newly matches the real app: places the new
--     ticket's column_position via the SAME max(+1024)-after-blockers rule
--     lib/board/topo.ts's computePlacementAfterBlockers uses (the probe's
--     synthetic schema had no column_position at all — leaving it at its
--     table DEFAULT of 0 is the exact "ties every other 0-row and gets shoved
--     to the top by the updated_at tiebreak" bug this codebase has already
--     been bitten by once; see AGENTS.md's `column_position` note).
--     DELIBERATELY NOT implemented (matches the probe's explicit scope,
--     "dedupe ... and the cycle-guard BFS ... stay app-layer"): duplicate-
--     title dedupe, alias-uniqueness-within-run checking, and the
--     dependency-cycle guard. A caller may create a ticket whose depends_on
--     entry creates a cycle, or whose title duplicates an open ticket.
--
--   • devpilot_spawn_run does NOT set the child run's agent_id — the REAL
--     spawn route (apps/web/app/api/runners/tools/spawn/route.ts) never
--     inherits the parent's agent_id onto the child either (a spawned
--     supervisor child resolves its OWN role/agent at dispatch time); the
--     probe's candidate SQL set `agent_id = v_parent.agent_id`, which was
--     drift from the real route, not an intentional design choice.
--     DELIBERATELY NOT implemented (out of RLS-feasibility scope, per the
--     probe's own framing — role resolution and event emission are pure
--     application logic with no RLS analog): this RPC only seeds the `runs`
--     row under cap; it does not resolve a role config, compose a system
--     prompt, or emit `agent/run.requested`. A desktop-side caller is
--     expected to do that next, exactly as the real spawn route does after
--     its own `runs` insert.
--
--   • devpilot_set_project_secret DELEGATES to the real, already-encryption-
--     aware `set_project_secret(project_id, secret_key, value, user_id)`
--     (20260606000000) rather than re-implementing the INSERT — this
--     preserves the pgp_sym_encrypt/app.token_vault_key transition-fallback
--     behaviour verbatim instead of drifting a second copy of it. This works
--     because a SECURITY DEFINER function executes with the PRIVILEGES OF ITS
--     OWNER, and an owner always retains implicit EXECUTE on its own objects
--     regardless of `revoke ... from public` — so this function (owned by
--     whichever role applies migrations, same as set_project_secret) can call
--     it directly even though `authenticated` itself has no grant on it.
--
-- Every function independently re-derives tenant_id from a server-trusted FK
-- chain (never from a client-supplied tenant_id parameter — none of these
-- functions ACCEPT one) and calls require_tenant_member() before touching
-- anything, exactly as the probe's finding doc requires: "none trust the
-- caller's own claims about tenant/project/run identity, only server-derived
-- lookups."
--
-- The NULL-vs-false trap (documented at length in the finding doc — a
-- zero-row `UPDATE ... RETURNING x INTO v` leaves `v` NULL, not false, so a
-- bare `if not v_claimed` is silently skipped, not entered) bit the probe's
-- OWN first draft twice (create-ticket's cap claim, spawn's fan-out claim).
-- Every atomic claim below is guarded with `coalesce(v_claimed, false)`, and
-- the finding doc's own instruction is followed for any future one: "Any RPC
-- written for WP 1.3 that does an atomic `UPDATE ... WHERE <cap> RETURNING
-- <sentinel> INTO <var>` must guard with COALESCE(..., false), not a bare NOT."
--
-- REVOKE BEFORE GRANT, from BOTH public AND anon. Postgres grants EXECUTE on
-- a newly created function to PUBLIC by default, so every function below is
-- reachable by an unauthenticated caller until that default is explicitly
-- revoked — `require_tenant_member()` still refuses such a caller (auth.uid()
-- reads NULL from an unset JWT claim, and no tenant_members row has a NULL
-- user_id), so this is defence in depth, not the primary boundary. `anon`
-- gets its own explicit revoke alongside `public` because a Supabase project
-- may ALSO hand `anon` a separate, direct EXECUTE grant via its own default-
-- privilege bootstrap (the function-level twin of the table-level gap fixed
-- for `tickets`/`project_secrets` in 20260761000000) — revoking only from
-- PUBLIC would not touch that second, independent grant. Found by the
-- devpilot-desktop companion harness (WP 1.4, PR #8) driving this exact RPC
-- set against a real local Supabase stack.
--
-- Idempotent: CREATE OR REPLACE FUNCTION throughout.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 0. require_tenant_member — shared re-derivation guard every RPC below opens
--    with. STABLE (read-only), SECURITY DEFINER so it can see tenant_members
--    regardless of the caller's own RLS, pinned search_path.
-- ---------------------------------------------------------------------------
create or replace function public.require_tenant_member(p_tenant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.tenant_members
    where tenant_id = p_tenant_id and user_id = auth.uid()
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.require_tenant_member(uuid) from public, anon;
grant execute on function public.require_tenant_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. devpilot_system_comment — reserves author_type='system' + a whitelisted
--    devpilot_* author_id. Replaces the system-comment route.
-- ---------------------------------------------------------------------------
create or replace function public.devpilot_system_comment(
  p_ticket_id uuid,
  p_author_id text,
  p_body text,
  p_metadata jsonb default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_id uuid;
begin
  select tenant_id into v_tenant_id from public.tickets where id = p_ticket_id;
  if v_tenant_id is null then
    raise exception 'ticket % not found', p_ticket_id;
  end if;
  perform public.require_tenant_member(v_tenant_id);

  if p_author_id !~ '^devpilot_[a-z_]+$' then
    raise exception 'author_id % is not a reserved devpilot_* system identity', p_author_id
      using errcode = '42501';
  end if;

  insert into public.comments (tenant_id, ticket_id, author_type, author_id, body, metadata)
  values (v_tenant_id, p_ticket_id, 'system', p_author_id, p_body, p_metadata)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.devpilot_system_comment(uuid, text, text, jsonb) from public, anon;
grant execute on function public.devpilot_system_comment(uuid, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. devpilot_move_ticket — the FSM edge check, the human-only reopen gate, and
--    the human-only safety-critical-completion gate. Replaces the move-ticket
--    route AND the transition half of request-human/request-secret (both are
--    one FSM edge, `* -> input_required`, gated by the same actor problem).
--
--    p_to_status is typed as the real public.ticket_status ENUM (not text),
--    so an unrecognised status is refused by Postgres's own enum-input check
--    before this function body even runs — a stronger, earlier refusal than
--    any string comparison this function could write itself.
-- ---------------------------------------------------------------------------
create or replace function public.devpilot_move_ticket(
  p_ticket_id uuid,
  p_to_status public.ticket_status,
  p_actor text,
  p_reason text default null,
  p_run_id uuid default null
) returns public.tickets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.tickets;
  v_allowed boolean;
begin
  select * into v_ticket from public.tickets where id = p_ticket_id;
  if v_ticket.id is null then
    raise exception 'ticket % not found', p_ticket_id;
  end if;
  perform public.require_tenant_member(v_ticket.tenant_id);

  if p_actor not in ('agent', 'human', 'system') then
    raise exception 'unknown actor %', p_actor using errcode = '22023';
  end if;

  -- FSM edge table, verbatim from lib/board/state.ts's ALLOWED_TRANSITIONS
  -- (10 statuses, 33 edges). Keep this in sync with that file — it is the
  -- single source of truth for the ticket state machine. Compared as text
  -- (rather than relying on enum-literal type inference inside a row-IN
  -- list) so this can never depend on a Postgres version's inference
  -- behavior for unknown-type literals against a composite row comparison.
  select (v_ticket.status::text, p_to_status::text) in (
    ('backlog', 'ready'), ('backlog', 'failed'),
    ('ready', 'assigned'), ('ready', 'in_progress'), ('ready', 'backlog'), ('ready', 'failed'),
    ('assigned', 'in_progress'), ('assigned', 'ready'), ('assigned', 'paused'), ('assigned', 'failed'),
    ('in_progress', 'ready'), ('in_progress', 'in_review'), ('in_progress', 'input_required'),
      ('in_progress', 'blocked'), ('in_progress', 'paused'), ('in_progress', 'backlog'),
      ('in_progress', 'done'), ('in_progress', 'failed'),
    ('input_required', 'in_progress'), ('input_required', 'paused'), ('input_required', 'backlog'),
      ('input_required', 'failed'),
    ('blocked', 'in_progress'), ('blocked', 'paused'), ('blocked', 'backlog'), ('blocked', 'done'),
      ('blocked', 'failed'),
    ('in_review', 'in_progress'), ('in_review', 'blocked'), ('in_review', 'paused'),
      ('in_review', 'done'), ('in_review', 'failed'),
    ('paused', 'in_progress'), ('paused', 'backlog'), ('paused', 'failed'),
    ('done', 'backlog')
    -- 'failed' is terminal — no outbound edges.
  ) into v_allowed;

  if not v_allowed then
    raise exception 'illegal transition % -> % for ticket %', v_ticket.status, p_to_status, p_ticket_id
      using errcode = '22023';
  end if;

  -- Reopen gate (lib/board/reopen-policy.ts's decideReopenGate /
  -- HUMAN_ONLY_BACKLOG_RESET_SOURCES): only a human may reset a ticket to
  -- backlog from done / in_progress / input_required / blocked. `paused` is
  -- deliberately absent from this set — `paused -> backlog` predates the gate
  -- and is reachable by any actor.
  if p_to_status = 'backlog'
     and v_ticket.status in ('done', 'in_progress', 'input_required', 'blocked')
     and p_actor <> 'human'
  then
    raise exception 'actor % may not reset % ticket % to backlog (human-only)',
      p_actor, v_ticket.status, p_ticket_id
      using errcode = '42501';
  end if;

  -- Safety gate (lib/board/safety-gate.ts's decideSafetyGate): a
  -- safety_critical ticket may only be completed to `done` by a human.
  if p_to_status = 'done' and v_ticket.safety_critical and p_actor <> 'human' then
    raise exception 'actor % may not complete safety_critical ticket % (human-only)', p_actor, p_ticket_id
      using errcode = '42501';
  end if;

  update public.tickets
     set status = p_to_status
   where id = p_ticket_id and tenant_id = v_ticket.tenant_id
  returning * into v_ticket;

  insert into public.comments (tenant_id, ticket_id, author_type, author_id, body, metadata)
  values (
    v_ticket.tenant_id, p_ticket_id, 'system', 'devpilot_move_ticket',
    coalesce(p_reason, format('%s -> %s', v_ticket.status, p_to_status)),
    jsonb_build_object('actor', p_actor, 'run_id', p_run_id)
  );

  return v_ticket;
end;
$$;

revoke all on function public.devpilot_move_ticket(uuid, public.ticket_status, text, text, uuid) from public, anon;
grant execute on function public.devpilot_move_ticket(uuid, public.ticket_status, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. devpilot_create_ticket — per-project opt-in flag + atomic per-run
--    fan-out cap (its OWN tenant-scoped atomic claim, see the file header) +
--    forced status/requested_role + column_position placement + dependency
--    edges + provenance comment. Replaces the create-ticket route.
-- ---------------------------------------------------------------------------
create or replace function public.devpilot_create_ticket(
  p_spawning_ticket_id uuid,
  p_run_id uuid,
  p_title text,
  p_agent_alias text default null,
  p_depends_on uuid[] default '{}'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_project_id uuid;
  v_agent_ticket_creation boolean;
  v_max_per_run int;
  v_claimed boolean;
  v_column_position int;
  v_new_id uuid;
  v_dep uuid;
begin
  select tenant_id, project_id into v_tenant_id, v_project_id
    from public.tickets where id = p_spawning_ticket_id;
  if v_tenant_id is null then
    raise exception 'spawning ticket % not found', p_spawning_ticket_id;
  end if;
  perform public.require_tenant_member(v_tenant_id);

  if v_project_id is null then
    raise exception 'spawning ticket % has no project — nothing to file into', p_spawning_ticket_id
      using errcode = '42501';
  end if;

  select agent_ticket_creation, agent_ticket_max_per_run
    into v_agent_ticket_creation, v_max_per_run
    from public.projects where id = v_project_id;
  if not coalesce(v_agent_ticket_creation, false) then
    raise exception 'project % has not opted into agent ticket creation', v_project_id
      using errcode = '42501';
  end if;

  -- project » 3. (The real app's third rung, DEVPILOT_MAX_TICKETS_PER_RUN, is
  -- an env var this Postgres function has no access to — see file header.)
  v_max_per_run := coalesce(v_max_per_run, 3);

  -- Atomic per-run cap claim, tenant-scoped IN THE SAME STATEMENT — see the
  -- file header for why this is NOT a call to the existing
  -- runs_claim_ticket_slot(). A zero-row UPDATE leaves v_claimed NULL, not
  -- false; `coalesce(v_claimed, false)` is load-bearing (see file header).
  update public.runs
     set tickets_created_count = tickets_created_count + 1
   where id = p_run_id
     and tenant_id = v_tenant_id
     and tickets_created_count < v_max_per_run
  returning true into v_claimed;

  if not coalesce(v_claimed, false) then
    -- Disambiguate an unknown/cross-tenant run from a genuine cap refusal —
    -- the two must not be confused by the caller (same reasoning as
    -- runs_claim_ticket_slot's own header).
    if not exists (select 1 from public.runs where id = p_run_id and tenant_id = v_tenant_id) then
      raise exception 'run % not found in tenant %', p_run_id, v_tenant_id;
    end if;
    raise exception 'run % has reached its per-run ticket creation cap (%)', p_run_id, v_max_per_run
      using errcode = '42501';
  end if;

  -- column_position: max(+1024) after the highest-positioned blocker, or at
  -- the end of the project's backlog when there are none — mirrors
  -- lib/board/topo.ts's computePlacementAfterBlockers exactly.
  if p_depends_on is null or array_length(p_depends_on, 1) is null then
    select coalesce(max(column_position), 0) + 1024 into v_column_position
      from public.tickets
     where project_id = v_project_id and tenant_id = v_tenant_id and status = 'backlog';
  else
    select coalesce(max(column_position), 0) + 1024 into v_column_position
      from public.tickets
     where id = any(p_depends_on) and tenant_id = v_tenant_id;
  end if;

  -- Forced columns: status='backlog', requested_role=NULL. Nothing dispatches
  -- from backlog, and no parameter of this function can set either to
  -- anything else — the omission is structural, not a runtime check.
  insert into public.tickets (
    tenant_id, project_id, title, status, requested_role,
    source_run_id, agent_alias, column_position
  )
  values (
    v_tenant_id, v_project_id, p_title, 'backlog', null,
    p_run_id, p_agent_alias, v_column_position
  )
  returning id into v_new_id;

  -- Dependency edges (blocked_by only — see AGENTS.md's WI-14 note on why
  -- builds_on is never used for declared agent dependencies). Every entry is
  -- re-verified against THIS tenant; `is distinct from` (rather than `<>`)
  -- so a NONEXISTENT dependency ticket is refused with a clear message
  -- instead of silently passing the NULL-vs-false trap and failing later on
  -- the bare FK constraint.
  foreach v_dep in array coalesce(p_depends_on, '{}') loop
    if (select tenant_id from public.tickets where id = v_dep) is distinct from v_tenant_id then
      raise exception 'dependency ticket % is not in tenant % (or does not exist)', v_dep, v_tenant_id
        using errcode = '42501';
    end if;
    insert into public.ticket_dependencies (ticket_id, blocks_ticket_id, relation_type)
    values (v_new_id, v_dep, 'blocked_by');
  end loop;

  insert into public.comments (tenant_id, ticket_id, author_type, author_id, body, metadata)
  values (
    v_tenant_id, p_spawning_ticket_id, 'system', 'devpilot_agent_ticket',
    format('filed a new backlog ticket for out-of-scope work found while working this one (%s/%s allowed from this run): %s',
      (select tickets_created_count from public.runs where id = p_run_id), v_max_per_run, v_new_id),
    jsonb_build_object('kind', 'agent_ticket_created', 'ticketId', v_new_id, 'runId', p_run_id,
      'dependsOn', p_depends_on)
  );

  return v_new_id;
end;
$$;

revoke all on function public.devpilot_create_ticket(uuid, uuid, text, text, uuid[]) from public, anon;
grant execute on function public.devpilot_create_ticket(uuid, uuid, text, text, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. devpilot_spawn_run — depth / fan-out / global-active / budget-inheritance
--    caps, all atomic. Replaces the spawn route's `runs` row seed (role
--    resolution + agent/run.requested emission stay caller-side — see file
--    header).
-- ---------------------------------------------------------------------------
create or replace function public.devpilot_spawn_run(
  p_parent_run_id uuid,
  p_budget_cents int,
  p_runner_kind text default 'local-cc'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent public.runs;
  v_active_count int;
  v_claimed boolean;
  v_new_id uuid;
  v_max_depth constant int := 3;
  v_max_fan_out constant int := 4;
  v_max_total_agents constant int := 20;
begin
  if p_budget_cents is null or p_budget_cents <= 0 then
    raise exception 'budgetCents required (must be > 0)' using errcode = '22023';
  end if;

  select * into v_parent from public.runs where id = p_parent_run_id;
  if v_parent.id is null then
    raise exception 'parent run % not found', p_parent_run_id;
  end if;
  perform public.require_tenant_member(v_parent.tenant_id);

  if v_parent.depth + 1 > v_max_depth then
    raise exception 'spawn refused: depth cap (%) exceeded', v_max_depth using errcode = '42501';
  end if;

  if p_budget_cents > (v_parent.budget_cents - v_parent.spent_cents) then
    raise exception 'spawn refused: budget_cents % exceeds parent remaining budget %',
      p_budget_cents, v_parent.budget_cents - v_parent.spent_cents using errcode = '42501';
  end if;

  select count(*) into v_active_count from public.runs
    where tenant_id = v_parent.tenant_id and status in ('running', 'awaiting_human');
  if v_active_count >= v_max_total_agents then
    raise exception 'spawn refused: tenant % active-run cap (%) reached', v_parent.tenant_id, v_max_total_agents
      using errcode = '42501';
  end if;

  -- Atomic fan-out claim: a zero-row UPDATE leaves v_claimed NULL, not false —
  -- coalesce is load-bearing (see file header). Deliberately NOT
  -- runs_increment_children(): that function increments UNCONDITIONALLY (no
  -- cap in its WHERE clause; the app-side caller compares the returned count
  -- against MAX_FAN_OUT itself), so reusing it here would let two concurrent
  -- spawns off the same parent both increment past the cap.
  update public.runs
     set children_count = children_count + 1
   where id = p_parent_run_id and children_count < v_max_fan_out
  returning true into v_claimed;

  if not coalesce(v_claimed, false) then
    raise exception 'spawn refused: parent % fan-out cap (%) reached', p_parent_run_id, v_max_fan_out
      using errcode = '42501';
  end if;

  insert into public.runs (tenant_id, parent_run_id, runner_kind, depth, status, budget_cents, spent_cents)
  values (v_parent.tenant_id, p_parent_run_id, p_runner_kind, v_parent.depth + 1, 'running', p_budget_cents, 0)
  returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke all on function public.devpilot_spawn_run(uuid, int, text) from public, anon;
grant execute on function public.devpilot_spawn_run(uuid, int, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5/6. Secret values — project_secrets carries NO RLS policy and NO grant to
--    authenticated at all (values are never RLS-readable, by design since
--    20260606000000); these two RPCs are the only sanctioned access path.
--    devpilot_set_project_secret DELEGATES to the real set_project_secret (see
--    file header for why); devpilot_get_project_secret_names reads names
--    directly (no encryption concern — it never touches value_plain /
--    value_encrypted).
--
--    Both add the membership check the real set_project_secret /
--    get_project_secrets_json currently lack — those were safe only because
--    the only caller was ever service_role. Not widening THEIR grants here;
--    they stay service_role-only, reached only via delegation from a
--    definer-owner context.
-- ---------------------------------------------------------------------------
create or replace function public.devpilot_set_project_secret(
  p_project_id uuid,
  p_secret_key text,
  p_value text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  select tenant_id into v_tenant_id from public.projects where id = p_project_id;
  if v_tenant_id is null then
    raise exception 'project % not found', p_project_id;
  end if;
  perform public.require_tenant_member(v_tenant_id);

  perform public.set_project_secret(p_project_id, p_secret_key, p_value, auth.uid());
end;
$$;

revoke all on function public.devpilot_set_project_secret(uuid, text, text) from public, anon;
grant execute on function public.devpilot_set_project_secret(uuid, text, text) to authenticated;

create or replace function public.devpilot_get_project_secret_names(p_project_id uuid)
returns setof text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  select tenant_id into v_tenant_id from public.projects where id = p_project_id;
  if v_tenant_id is null then
    raise exception 'project % not found', p_project_id;
  end if;
  perform public.require_tenant_member(v_tenant_id);

  return query select secret_key from public.project_secrets where project_id = p_project_id;
end;
$$;

revoke all on function public.devpilot_get_project_secret_names(uuid) from public, anon;
grant execute on function public.devpilot_get_project_secret_names(uuid) to authenticated;

commit;
