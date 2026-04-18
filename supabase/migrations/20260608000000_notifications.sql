-- Migration: 20260608000000_notifications.sql
--
-- Phase 2.5+ / M8 — in-app notification fan-out + per-(user, kind) prefs.
--
-- Two tables:
--   1. notifications              — durable, append-only notification feed
--                                   per user, fanned out from Inngest events.
--                                   Subscribed via Supabase Realtime so the
--                                   topbar bell + toast bridge update across
--                                   screens / tabs without polling.
--   2. notification_preferences   — (user_id, kind) → channel toggles.
--                                   `in_app` gates whether a row is written
--                                   at all; `toast` gates whether the client
--                                   pops a transient Sonner toast.
--
-- Notification rows are personal (user_id) and ALSO tenant-scoped so cascade
-- deletes work and so the topbar bell can filter by the active tenant. RLS
-- gates selects + updates to the owning user; INSERTs are server-only via the
-- service-role client (see lib/notifications/publish.ts).
--
-- Dedupe: `(user_id, dedupe_key)` is uniquely indexed where dedupe_key is
-- non-null, so Inngest step retries can safely call `publishNotification`
-- multiple times — only the first write lands.

begin;

-- ---------------------------------------------------------------------------
-- 1. notifications
-- ---------------------------------------------------------------------------

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id)  on delete cascade,
  user_id     uuid not null references auth.users(id)      on delete cascade,
  -- Domain typing. Keep as text + CHECK so adding a new kind later is a
  -- single-table migration, not a type ALTER.
  kind        text not null check (kind in (
    'plan.finished', 'plan.failed',
    'run.completed', 'run.failed',
    'ticket.assigned_to_me', 'ticket.input_required',
    'push.merged', 'push.blocked', 'push.needs_merger'
  )),
  title       text not null,
  body        text,
  -- Optional click-through URL (e.g. /projects/:id?planSessionId=:sid).
  href        text,
  -- Free-form domain metadata (sessionId, runId, ticketId, …). Read by the
  -- bell row click handler for legacy routes.
  metadata    jsonb not null default '{}',
  -- Set by the publisher to a deterministic string. Unique-per-user so
  -- retries can't double-notify. Nullable for one-off / non-idempotent
  -- emissions.
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create unique index if not exists notifications_user_dedupe_idx
  on public.notifications(user_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists notifications_user_recent_idx
  on public.notifications(user_id, created_at desc);

create index if not exists notifications_user_unread_idx
  on public.notifications(user_id)
  where read_at is null;

create index if not exists notifications_tenant_idx
  on public.notifications(tenant_id);

alter table public.notifications enable row level security;

-- Owner can read their own notifications.
drop policy if exists notifications_owner_read on public.notifications;
create policy notifications_owner_read on public.notifications
  for select using (user_id = auth.uid());

-- Owner can update their own (mark-as-read). The WITH CHECK pins user_id so
-- a malicious client can't reassign ownership during an update.
drop policy if exists notifications_owner_update on public.notifications;
create policy notifications_owner_update on public.notifications
  for update using (user_id = auth.uid())
         with check (user_id = auth.uid());

-- No INSERT/DELETE policy — those flow only through the service-role
-- publisher (lib/notifications/publish.ts).

-- Realtime publication so the bell + toaster react without polling.
do $$
begin
  begin
    alter publication supabase_realtime add table public.notifications;
  exception
    when duplicate_object then null;
  end;
end$$;

-- ---------------------------------------------------------------------------
-- 2. notification_preferences
-- ---------------------------------------------------------------------------
--
-- Per-(user, kind) channel toggles. Defaults to in_app=true + toast=true.
-- Missing rows fall through to the per-kind defaults defined in
-- lib/notifications/kinds.ts (no backfill needed for existing users).

create table if not exists public.notification_preferences (
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,
  in_app      boolean not null default true,
  toast       boolean not null default true,
  -- Reserved for future delivery channels (no UI yet, kept here to avoid
  -- a future migration when we wire them).
  email       boolean not null default false,
  desktop     boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, kind)
);

alter table public.notification_preferences enable row level security;

drop policy if exists notification_preferences_owner_all on public.notification_preferences;
create policy notification_preferences_owner_all on public.notification_preferences
  for all using (user_id = auth.uid())
         with check (user_id = auth.uid());

drop trigger if exists notification_preferences_updated_at on public.notification_preferences;
create trigger notification_preferences_updated_at
  before update on public.notification_preferences
  for each row execute function public.touch_updated_at();

commit;
