-- =============================================================================
-- Migration : 20260603150000_phase2_pending_pushes.sql
-- Phase 2 / M5c — Review-before-push UX substrate (`pending_pushes` table).
--
-- Purpose
-- ────────
-- M5a/M5b move commits from the local workspace to per-project repos, but
-- nothing pushes yet — the user's hard requirement is that every commit
-- (including the auto-scaffolder's initial seed) surfaces in `/changes` and
-- waits for an explicit Push button. This table is the substrate for that
-- review queue.
--
-- The runner writes one row per ready-to-push workspace (typically one per
-- run + branch) with:
--   • where the workspace lives on disk (`workspace_path`, for the runner to
--     re-attach when Push is clicked)
--   • what's unpushed (`unpushed_count`, `files_changed[]`, `unified_diff`)
--   • the head SHA so we can verify nothing moved between review and push
--
-- After a successful push, `pushed_at` + `pushed_pr_url` are stamped and
-- the row stays as the audit record. Unpushed rows are surfaced to /changes
-- via the partial index for cheap polling/realtime.
--
-- RLS
-- ───
-- Standard tenant-member pattern. The runner uses service_role to insert.
--
-- Idempotency
-- ───────────
-- Forward-only; `create table if not exists` + `create index if not exists`.
-- =============================================================================
begin;

create table if not exists public.pending_pushes (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  ticket_id       uuid references public.tickets(id) on delete set null,
  run_id          uuid references public.runs(id) on delete set null,
  -- Absolute path on the runner host (e.g.,
  -- `~/.ace/workspaces/<ticketId>/`). Used by the Push handler to re-attach
  -- to the existing checkout instead of re-cloning.
  workspace_path  text not null,
  -- The local branch that holds the unpushed commits, e.g. `ace/<slug>`.
  branch          text not null,
  unpushed_count  int  not null default 0,
  -- JSONB array of `{ path, status, additions, deletions }` for the
  -- /changes file-list UI; deliberately denormalized so the page doesn't
  -- have to shell back into the workspace.
  files_changed   jsonb not null default '[]'::jsonb,
  -- Pre-rendered unified diff. Nullable because very large diffs are
  -- elided server-side and re-fetched on demand.
  unified_diff    text,
  -- Head SHA at the time the row was written. The Push handler refuses
  -- to push if the workspace's HEAD has moved (defensive against an
  -- agent racing the user).
  head_sha        text,
  -- Set when the push succeeds; null = still pending review.
  pushed_at       timestamptz,
  pushed_pr_url   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists pending_pushes_tenant_project_idx
  on public.pending_pushes(tenant_id, project_id);

-- Partial index for the /changes page — only the "still pending" rows
-- matter for the queue. Cheap to maintain because pushes are rare.
create index if not exists pending_pushes_unpushed_idx
  on public.pending_pushes(tenant_id)
  where pushed_at is null;

alter table public.pending_pushes enable row level security;

drop policy if exists pending_pushes_member_read on public.pending_pushes;
create policy pending_pushes_member_read on public.pending_pushes
  for select using (tenant_id in (select public.current_user_tenants()));

drop policy if exists pending_pushes_member_write on public.pending_pushes;
create policy pending_pushes_member_write on public.pending_pushes
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- Wire into Supabase Realtime so /changes updates live when a new push
-- becomes pending or an existing one is pushed.
do $$
begin
  begin
    alter publication supabase_realtime add table public.pending_pushes;
  exception
    when duplicate_object then null;
  end;
end$$;

-- updated_at trigger using the existing helper from core.sql.
drop trigger if exists pending_pushes_updated_at on public.pending_pushes;
create trigger pending_pushes_updated_at
  before update on public.pending_pushes
  for each row execute function public.touch_updated_at();

commit;
