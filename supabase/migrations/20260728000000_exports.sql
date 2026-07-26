-- =============================================================================
-- Migration : 20260728000000_exports.sql
-- Purpose   : Audit-grade PDF export — the async PROJECT scope's job table and
--             its private `exports` Storage bucket (+ tenant-scoped RLS).
--
-- Why a job at all
-- ────────────────
-- The per-ticket export renders synchronously and streams straight back to the
-- browser — one ticket is a few seconds of aggregation and a handful of pages.
-- A project export is not: it batches up to MAX_FULL_TICKETS tickets' worth of
-- runs, narration, evidence and embedded images, which comfortably exceeds a
-- serverless request's patience (and Vercel's response timeout). So the project
-- scope is a durable Inngest function that renders to a buffer, uploads the
-- object here, and marks the row `ready`; the client polls the row and then
-- fetches a short-lived signed URL.
--
-- The row is also the AUTHORISATION RECORD. A background job has no session and
-- therefore no RLS identity, so it cannot re-derive "may this caller see this
-- project?". Instead the ROUTE that creates the job asserts membership and
-- stamps `tenant_id` onto the row; the job then re-scopes its service-role reads
-- to that stamped tenant. The event payload is never trusted for tenancy — an
-- event is data on a queue, a row is a record an authorised request wrote.
--
-- Security posture (AGENTS.md — tenant isolation is the boundary)
-- ───────────────────────────────────────────────────────────────
-- Object paths are `"<tenant_id>/<export_id>.pdf"`, and the bucket RLS keys on
-- that FIRST path segment exactly like `ticket-attachments` does, so a stored
-- export is unreachable cross-tenant even with a guessed key. The table's RLS
-- mirrors `ticket_attachments`: tenant members SELECT their own rows; every JWT
-- write is denied and the service role (the route + the job) is the sole writer.
-- The bucket is PRIVATE and carries no MIME allowlist beyond application/pdf.
--
-- config.toml note
-- ────────────────
-- The `[storage.buckets.exports]` block in supabase/config.toml only affects
-- LOCAL Supabase. THIS migration creates the bucket + RLS on the hosted project —
-- firstmate applies it to prod.
--
-- Execution notes
-- ───────────────
-- One-shot transactional migration. The bucket insert is idempotent
-- (`on conflict do nothing`) and every policy is guarded by a prior
-- `drop policy if exists`, so a re-run is clean.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. The private bucket. 64 MiB ceiling: a capped project export (30 tickets
--    with embedded screenshots) lands well under this; the limit exists so a
--    pathological render cannot fill the project's storage quota.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'exports',
  'exports',
  false,
  67108864, -- 64 MiB
  array['application/pdf']
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Storage RLS — scope every object to its tenant's top-level folder.
--    Compared as text against current_user_tenants()::text so a malformed
--    (non-uuid) first segment fails to match rather than raising a cast error.
--    service_role bypasses RLS: the job writes, the download route signs.
--
--    SELECT only for JWT roles. A user never uploads an export — the engine
--    produces it — so there is deliberately no insert/update policy here at all.
--    That absence IS the control: no authenticated caller can plant an object in
--    the exports bucket and then have a download route hand it back signed.
-- ---------------------------------------------------------------------------
drop policy if exists exports_obj_read on storage.objects;
create policy exports_obj_read
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'exports'
    and (storage.foldername(name))[1] in (
      select t::text from public.current_user_tenants() as t
    )
  );

-- ---------------------------------------------------------------------------
-- 3. The job table.
-- ---------------------------------------------------------------------------
create table if not exists public.exports (
  id          uuid        not null default gen_random_uuid()
                primary key,

  -- Tenant isolation (cascade with the tenant). Stamped by the creating route
  -- from the authenticated session — this column is the job's trust root.
  tenant_id   uuid        not null
                references public.tenants(id) on delete cascade,

  -- The project being exported. Cascade: deleting a project drops its exports
  -- (and the AFTER DELETE trigger below reaps the stored objects).
  project_id  uuid        not null
                references public.projects(id) on delete cascade,

  -- pending → ready | failed. `pending` covers both "queued" and "rendering";
  -- the distinction buys the UI nothing (it polls either way) and a second
  -- state would be one more thing a crashed worker could strand a row in.
  status      text        not null default 'pending'
                constraint chk_exports_status
                  check (status in ('pending', 'ready', 'failed')),

  -- The object path inside the private `exports` bucket:
  --   "<tenant_id>/<export_id>.pdf". NULL until the render succeeds.
  storage_key text        null,

  -- Populated when status = 'failed'. Surfaced to the operator so a failed
  -- export says why instead of spinning forever.
  error       text        null,

  -- Byte size of the rendered PDF (display metadata).
  bytes       bigint      null
                constraint chk_exports_bytes
                  check (bytes is null or bytes > 0),

  -- The auth.users id that requested it. `set null` — losing the user must not
  -- lose the audit record of the export having been produced.
  created_by  uuid        null
                references auth.users(id) on delete set null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- A ready export MUST have an object; a pending/failed one MUST NOT claim to.
  -- Makes the "ready but nothing to download" state unrepresentable rather than
  -- merely unlikely (the same posture as integration_queue's landed_sha CHECK).
  constraint chk_exports_ready_has_key
    check (
      (status = 'ready' and storage_key is not null)
      or (status <> 'ready' and storage_key is null)
    )
);

comment on table public.exports is
  'Async project PDF export jobs. tenant_id is stamped by the authorising route '
  'and is the background job''s trust root — the Inngest event payload is never '
  'trusted for tenancy. storage_key points at the private exports bucket, scoped '
  'to "<tenant_id>/…".';

-- Guarded like the reap trigger below, so the header's "a re-run is clean" claim
-- is actually true (an unguarded `create trigger` errors on the second run).
drop trigger if exists exports_updated_at on public.exports;
create trigger exports_updated_at
  before update on public.exports
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. RLS — mirrors ticket_attachments (member SELECT; JWT writes denied; the
--    service role, used by the route + the durable job, is the sole writer).
-- ---------------------------------------------------------------------------
alter table public.exports enable row level security;

drop policy if exists exports_member_read on public.exports;
create policy exports_member_read
  on public.exports
  for select
  using (tenant_id in (select public.current_user_tenants()));

drop policy if exists exports_insert_deny on public.exports;
create policy exports_insert_deny
  on public.exports
  for insert
  with check (false);

drop policy if exists exports_update_deny on public.exports;
create policy exports_update_deny
  on public.exports
  for update
  using (false);

drop policy if exists exports_delete_deny on public.exports;
create policy exports_delete_deny
  on public.exports
  for delete
  using (false);

-- ---------------------------------------------------------------------------
-- 5. Indexes — the poll path ("this export's status") is the PK; this one backs
--    the project's export list, newest first.
-- ---------------------------------------------------------------------------
create index if not exists idx_exports_project_created
  on public.exports (project_id, created_at desc);

create index if not exists idx_exports_tenant_created
  on public.exports (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 6. Cascade cleanup of stored objects — same shape and same caveat as
--    reap_ticket_attachment_object: deleting the row unlinks the object (the
--    security-relevant part); the physical blob may be orphaned until a storage
--    lifecycle GC exists. SECURITY DEFINER so the reap works regardless of which
--    role fired the delete.
-- ---------------------------------------------------------------------------
create or replace function public.reap_export_object()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  if old.storage_key is not null then
    delete from storage.objects
     where bucket_id = 'exports'
       and name = old.storage_key;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_reap_export_object on public.exports;
create trigger trg_reap_export_object
  after delete on public.exports
  for each row
  execute function public.reap_export_object();

commit;
