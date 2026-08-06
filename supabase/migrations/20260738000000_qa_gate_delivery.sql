-- =============================================================================
-- Migration : 20260738000000_qa_gate_delivery.sql
--
-- L1 QA hand-off gate, B2: close the EMPTY-DELIVERY hole and bound the gate's
-- own retry loop.
--
-- Two independent additions, one migration because they ship as one behaviour.
--
-- 1. run_verifications.commits_ahead
--    ------------------------------
--    The gate could already answer "did THIS run commit" (base_sha vs
--    head_sha). It could NOT answer "does the delivered work exist at all",
--    and eight prod QA rejects were exactly that: "branch is empty vs
--    origin/main (no code, no package.json)", "claimed commit 2628522 does not
--    exist", "workspace branch has zero commits", "No implementation
--    delivered". The run-scoped pair cannot answer it, because on a QA-reject
--    retry the run-start base ALREADY contains the previous run's commits — so
--    a retry that commits nothing looks identical to a branch that never had
--    anything on it.
--
--    `commits_ahead` is `git rev-list --count origin/<baseBranch>..HEAD`,
--    recorded by the runner. NULLABLE and nullable-by-default on purpose:
--    every pre-B2 row, every runner that cannot determine it (missing tracking
--    ref, unborn HEAD, git error), and every job dispatched without a base
--    branch leaves it null, and the gate reads null as "could not determine →
--    fail open". Only a stored `0` is a positive assertion of empty delivery.
--
-- 2. tickets.gate_retry_count
--    ------------------------
--    The gate's live-agent refusal is a 422 the agent retries in-session, and
--    nothing counted those retries — a producer that cannot make its own check
--    pass could bounce off the gate forever on the tenant's subscription. This
--    is that ceiling's counter.
--
--    It is DELIBERATELY NOT `tickets.retry_count`. That column is the
--    engineer<->QA reject-loop counter with three live consumers (the
--    dispatcher's re-dispatch on `retry_count > 0`, the F2 loop-guard's G5
--    stand-down, and `enforceQaRetryCeiling`'s park at DEVPILOT_QA_MAX_RETRIES).
--    A second writer would fake QA rejects that never happened and spend the
--    QA loop's budget on tickets QA has never seen; and the human-reset of
--    `retry_count` would silently refill the gate's budget too. Separate
--    concerns, separate columns, separate env ceilings. See
--    `apps/web/lib/board/gate-retry.ts`.
--
--    NOT NULL DEFAULT 0 matches `retry_count` — every existing ticket starts
--    with a full budget, which is the correct reading of "has never been
--    refused by a gate that did not exist".
-- =============================================================================

alter table public.run_verifications
  add column if not exists commits_ahead int;

comment on column public.run_verifications.commits_ahead is
  'Commits on HEAD not on origin/<base branch>. 0 = empty delivery (a positive assertion). NULL = could not determine; the gate fails open.';

alter table public.tickets
  add column if not exists gate_retry_count int not null default 0;

comment on column public.tickets.gate_retry_count is
  'QA hand-off GATE refusals for this ticket since the last human touch. Distinct from retry_count (the engineer<->QA reject loop) and never written by it. Reset by a human moving the ticket out of blocked.';

-- Re-create the upsert with the new field. `create or replace function` cannot
-- change a signature, and adding a parameter would create an OVERLOAD that
-- PostgREST then cannot disambiguate — so drop the old signature explicitly
-- first. Everything else about the function is unchanged, including the
-- base_sha preserve-first / rest-overwrite split.
drop function if exists public.upsert_run_verification(
  uuid, uuid, uuid, text, int, text, text, boolean, text, timestamptz
);

create or replace function public.upsert_run_verification(
  p_tenant_id     uuid,
  p_run_id        uuid,
  p_ticket_id     uuid,
  p_command       text,
  p_exit_code     int,
  p_head_sha      text,
  p_base_sha      text,
  p_pushed        boolean,
  p_output_tail   text,
  p_ran_at        timestamptz,
  p_commits_ahead int default null
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.run_verifications
    (tenant_id, run_id, ticket_id, command, exit_code, head_sha, base_sha,
     pushed, output_tail, ran_at, commits_ahead)
  values
    (p_tenant_id, p_run_id, p_ticket_id, p_command, p_exit_code, p_head_sha,
     p_base_sha, p_pushed, p_output_tail, p_ran_at, p_commits_ahead)
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
    ran_at      = excluded.ran_at,
    -- OVERWRITE, unlike base_sha: this is a property of the branch as it stands
    -- now, so the latest reading is the correct one. A later iteration that
    -- cannot determine it (null) must NOT erase a known earlier count, or a
    -- transient git failure would read as "still empty" on a branch that has
    -- since delivered.
    commits_ahead = coalesce(excluded.commits_ahead, public.run_verifications.commits_ahead);
$$;
