-- Phase 2.5+ / Slice IB — branch_promotions ledger.
--
-- Tracks operator-initiated "promote integration_branch → default_branch"
-- actions. Two strategies:
--   • 'pr'     — open a GitHub PR; operator merges on github.com
--                (respects branch protection + CODEOWNERS).
--   • 'direct' — POST /repos/:owner/:repo/merges via the GitHub API
--                (faster; bypasses branch protection, so the project
--                must allow the operator's token to merge directly).
--
-- Status lifecycle:
--   pending  → initial insert
--   opened   → PR strategy, PR opened (pr_url is set)
--   merged   → either strategy: PR merged on github.com, or direct merge
--              succeeded (merge_sha set)
--   closed   → PR closed without merging (operator decision)
--   failed   → API call failed; failure_reason carries the GitHub message
--
-- We don't poll GitHub for PR-merge status — the operator can re-open the
-- ledger row from the project page if they want an update. Realtime is on
-- for the changes feed to pick up new rows.

create table if not exists public.branch_promotions (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references public.tenants(id) on delete cascade,
  project_id      uuid        not null references public.projects(id) on delete cascade,
  from_branch     text        not null,
  to_branch       text        not null,
  strategy        text        not null check (strategy in ('pr','direct')),
  pr_url          text,
  pr_number       int,
  merge_sha       text,
  status          text        not null default 'pending'
                              check (status in ('pending','opened','merged','closed','failed')),
  failure_reason  text,
  created_by      uuid        references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists branch_promotions_project_status_idx
  on public.branch_promotions(project_id, status, created_at desc);

create index if not exists branch_promotions_tenant_idx
  on public.branch_promotions(tenant_id, created_at desc);

alter table public.branch_promotions enable row level security;

-- Tenant-scoped read + write. Mirrors the pending_pushes policy shape.
drop policy if exists branch_promotions_member_read on public.branch_promotions;
create policy branch_promotions_member_read on public.branch_promotions
  for select using (tenant_id in (select public.current_user_tenants()));

drop policy if exists branch_promotions_member_write on public.branch_promotions;
create policy branch_promotions_member_write on public.branch_promotions
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- updated_at maintenance: touch on every UPDATE.
create or replace function public.tg_touch_branch_promotions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_branch_promotions_updated_at on public.branch_promotions;
create trigger touch_branch_promotions_updated_at
  before update on public.branch_promotions
  for each row execute function public.tg_touch_branch_promotions_updated_at();
