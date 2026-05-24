-- =============================================================================
-- Migration : 20260710000000_run_verifications.sql
--
-- L1 / producer→QA hand-off gate. Stores the mechanical verification result a
-- producer run's runner captured before the ticket is handed to QA: the exact
-- command it ran, that command's exit code, the HEAD sha it ran against, the
-- run-start base sha (to detect "did THIS run produce a commit"), and whether
-- that sha is on the remote branch.
--
-- Why: the ticket-speed audit found a 66.7% QA reject rate, and 75% of those
-- rejects were mechanically checkable before QA ever looked -- `pnpm test` /
-- `pnpm build` exiting non-zero. The `→ in_review` transition validated only
-- FSM legality, never the work. This table is the evidence the gate embedded in
-- `transitionTicket` (`lib/board/transitions.ts`, keyed on the `actor`
-- discriminator) reads before it lets a producer hand off to QA.
--
-- Written by:  POST /api/runs/{id}/verification  (runner-key auth)
-- Read by:     the ENGINEER_QA_GATE_ENABLED gate inside transitionTicket
--              (strictly WHERE run_id = <the transitioning run>)
--
-- One row per run (`unique (run_id)`), upserted with a deliberate split:
--   • base_sha is PRESERVED from the first write (COALESCE in the route) so a
--     multi-iteration run keeps its RUN-START base even as later iterations
--     overwrite head_sha/exit_code. Without this, an iteration whose base
--     already includes this run's earlier commits would make base_sha ==
--     head_sha and wrongly no-op the gate for a run that did commit.
--   • head_sha, exit_code, pushed, output_tail, ran_at are OVERWRITTEN so the
--     gate reads the run's LATEST attempt -- which is what makes fix-and-retry
--     work (fix, re-verify, move again).
--
-- `ticket_id` is denormalised off the run so a verification survives (as an
-- orphan record of what was checked) if the ticket row is later deleted --
-- hence `on delete set null`, matching `runs.ticket_id`.
--
-- `ran_at` is server-stamped on write and never accepted from the runner: a
-- client-supplied clock is not trustworthy as a freshness signal.
-- =============================================================================

create table if not exists public.run_verifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  run_id      uuid not null references public.runs(id)    on delete cascade,
  ticket_id   uuid references public.tickets(id)          on delete set null,

  -- The command as executed, e.g. 'pnpm test'. Recorded verbatim so a refusal
  -- message can tell the agent exactly what to re-run.
  command     text not null,

  -- Process exit status. `> 0` = a real failure (blocks the QA hand-off).
  -- `0` = pass. `< 0` = could-not-determine (timeout / spawn failure /
  -- unrunnable command) -- the gate treats `< 0` as fail-open (allow).
  exit_code   int  not null,

  -- The commit the command ran against.
  head_sha    text not null,

  -- The workspace HEAD at run START (before the agent worked this run). When it
  -- equals head_sha the run produced no commit -> nothing to verify -> the gate
  -- no-ops (protects the ~48 non-code producer roles). Nullable: runners that
  -- predate this column, and unborn-HEAD workspaces, simply omit it.
  base_sha    text,

  -- Whether head_sha is on the remote branch. RECORDED for the deferred O2
  -- follow-up (block on unpushed); the v1 gate does NOT read it.
  pushed      boolean not null,

  -- Tail of the command's combined output, truncated by the ingest route.
  -- Surfaced (fenced/neutralised) back to the agent in the refusal.
  output_tail text not null default '',

  ran_at      timestamptz not null default now(),
  created_at  timestamptz not null default now(),

  constraint run_verifications_run_uniq unique (run_id)
);

-- Idempotent add for a re-run against a DB where the table already exists from
-- a partial history (the enforce-branch sibling had this table without base_sha).
alter table public.run_verifications
  add column if not exists base_sha text;

-- The gate reads by run_id (the unique constraint already covers that lookup).
-- This index covers the ticket-scoped orphan-audit read a future "why blocked?"
-- panel would make.
create index if not exists run_verifications_ticket_idx
  on public.run_verifications(ticket_id, ran_at desc);

-- Tenant-scoped table: RLS is mandatory (AGENTS.md -> Conventions). The ingest
-- route and the gate both go through the service client, which bypasses RLS;
-- these policies exist so an authenticated member reading the row from the UI
-- (a future "why was this blocked?" panel) sees only their own tenant's rows.
alter table public.run_verifications enable row level security;

drop policy if exists run_verifications_member_read on public.run_verifications;
create policy run_verifications_member_read on public.run_verifications
  for select using (tenant_id in (select public.current_user_tenants()));

drop policy if exists run_verifications_member_write on public.run_verifications;
create policy run_verifications_member_write on public.run_verifications
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- Atomic upsert with the base_sha preserve-first / rest-overwrite split. A
-- plain client-side upsert can't express `base_sha = COALESCE(existing,
-- excluded)`, and a read-then-write would race the two runner hooks that POST
-- for the same run. SECURITY DEFINER so the runner-key ingest route (service
-- client, RLS bypassed) can call it; it derives tenant/ticket from the passed
-- run row (the route looks them up), never trusts the client for scope.
create or replace function public.upsert_run_verification(
  p_tenant_id   uuid,
  p_run_id      uuid,
  p_ticket_id   uuid,
  p_command     text,
  p_exit_code   int,
  p_head_sha    text,
  p_base_sha    text,
  p_pushed      boolean,
  p_output_tail text,
  p_ran_at      timestamptz
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.run_verifications
    (tenant_id, run_id, ticket_id, command, exit_code, head_sha, base_sha,
     pushed, output_tail, ran_at)
  values
    (p_tenant_id, p_run_id, p_ticket_id, p_command, p_exit_code, p_head_sha,
     p_base_sha, p_pushed, p_output_tail, p_ran_at)
  on conflict (run_id) do update set
    ticket_id   = excluded.ticket_id,
    command     = excluded.command,
    exit_code   = excluded.exit_code,
    head_sha    = excluded.head_sha,
    -- PRESERVE the first run-start base; later iterations drift (their base
    -- includes this run's earlier commits) and must not overwrite it.
    base_sha    = coalesce(public.run_verifications.base_sha, excluded.base_sha),
    pushed      = excluded.pushed,
    output_tail = excluded.output_tail,
    ran_at      = excluded.ran_at;
$$;
