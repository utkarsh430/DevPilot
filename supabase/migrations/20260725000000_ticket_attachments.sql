-- =============================================================================
-- Migration : 20260725000000_ticket_attachments.sql
-- Purpose   : Ticket image attachments (Phase 1-2) — capture + store + display.
--             Adds the private `ticket-attachments` Storage bucket, its
--             tenant-scoped RLS on storage.objects, the `ticket_attachments`
--             metadata table, and a cascade cleanup of stored objects when a
--             ticket (and thus its attachment rows) is deleted.
--
-- Why
-- ───
-- A person filing a ticket from the New-ticket dialog can paste / drag a
-- screenshot; the image is uploaded straight to this bucket from the browser
-- (the RLS-bound client) under the tenant's folder, and a `ticket_attachments`
-- row ties the stored object to the ticket. The image is shown read-only on the
-- ticket drawer via a short-lived signed URL. Delivering the image to the
-- WORKING AGENT is a separate later phase (Phase 3) — not built here.
--
-- Security posture (AGENTS.md — tenant isolation is the boundary)
-- ────────────────────────────────────────────────────────────────
-- Every object path is `"<tenant_id>/<ticketId-or-draft>/<uuid>.<ext>"`. The
-- bucket RLS below keys on that FIRST path segment, so an authenticated user can
-- only read/write objects inside their own tenant's folder — a bucket path is
-- never reachable cross-tenant. The metadata table's RLS mirrors project_handoffs:
-- tenant members SELECT their own rows; INSERT/UPDATE/DELETE are denied to JWT
-- roles and done by the service role (the create server action). The MIME
-- allowlist and size cap are enforced by the bucket config (the boundary) AND
-- re-checked client-side (UX) and at row-write time.
--
-- config.toml note
-- ────────────────
-- The `[storage.buckets.ticket-attachments]` block in supabase/config.toml only
-- affects LOCAL Supabase. THIS migration is what creates the bucket + RLS on the
-- hosted project — firstmate applies it to prod.
--
-- Execution notes
-- ───────────────
-- One-shot transactional migration. The bucket insert is idempotent
-- (`on conflict do nothing`) and every policy is `create policy` guarded by a
-- prior `drop policy if exists` so a re-run is clean.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. The private bucket. 10 MiB per file; image allowlist matches
--    lib/board/attachments.ts and the config.toml block.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ticket-attachments',
  'ticket-attachments',
  false,
  10485760, -- 10 MiB
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Storage RLS — scope every object to its tenant's top-level folder.
--    The first path segment (`storage.foldername(name))[1]`) MUST be a tenant
--    the caller belongs to. Compared as text against current_user_tenants()::text
--    so a malformed (non-uuid) first segment simply fails to match rather than
--    raising a cast error. service_role bypasses RLS and is unaffected.
-- ---------------------------------------------------------------------------
drop policy if exists ticket_attachments_obj_read on storage.objects;
create policy ticket_attachments_obj_read
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'ticket-attachments'
    and (storage.foldername(name))[1] in (
      select t::text from public.current_user_tenants() as t
    )
  );

drop policy if exists ticket_attachments_obj_insert on storage.objects;
create policy ticket_attachments_obj_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'ticket-attachments'
    and (storage.foldername(name))[1] in (
      select t::text from public.current_user_tenants() as t
    )
  );

drop policy if exists ticket_attachments_obj_update on storage.objects;
create policy ticket_attachments_obj_update
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'ticket-attachments'
    and (storage.foldername(name))[1] in (
      select t::text from public.current_user_tenants() as t
    )
  )
  with check (
    bucket_id = 'ticket-attachments'
    and (storage.foldername(name))[1] in (
      select t::text from public.current_user_tenants() as t
    )
  );

drop policy if exists ticket_attachments_obj_delete on storage.objects;
create policy ticket_attachments_obj_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'ticket-attachments'
    and (storage.foldername(name))[1] in (
      select t::text from public.current_user_tenants() as t
    )
  );

-- ---------------------------------------------------------------------------
-- 3. The metadata table. One row per stored object.
-- ---------------------------------------------------------------------------
create table if not exists public.ticket_attachments (
  id          uuid        not null default gen_random_uuid()
                primary key,

  -- Cascade: deleting the ticket drops its attachment rows (and the AFTER
  -- DELETE trigger below reaps the stored objects).
  ticket_id   uuid        not null
                references public.tickets(id) on delete cascade,

  -- Tenant isolation (cascade with the tenant). The storage_key's first path
  -- segment equals this id — the write path enforces it (isKeyUnderTenant).
  tenant_id   uuid        not null
                references public.tenants(id) on delete cascade,

  -- The object path inside the `ticket-attachments` bucket:
  --   "<tenant_id>/<ticketId-or-draft>/<uuid>.<ext>"
  storage_key text        not null
                constraint chk_ticket_attachments_key_nonempty
                  check (length(btrim(storage_key)) > 0),

  -- Allowlisted image MIME (image/png|jpeg|webp|gif). Enforced app-side and by
  -- the bucket; a CHECK here keeps stray rows out.
  mime        text        not null
                constraint chk_ticket_attachments_mime
                  check (mime in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),

  -- Byte size as reported at upload (display metadata).
  bytes       bigint      not null
                constraint chk_ticket_attachments_bytes
                  check (bytes > 0),

  created_at  timestamptz not null default now(),

  -- One row per stored object.
  constraint uq_ticket_attachments_key unique (storage_key)
);

comment on table public.ticket_attachments is
  'Image attachments on a ticket (screenshots pasted/dragged into the New-ticket '
  'dialog). storage_key points at the private ticket-attachments bucket, scoped '
  'to "<tenant_id>/…". Phase 1-2 is capture+store+display only; delivering the '
  'image to a working agent (Phase 3) must fence it as untrusted data.';

-- ---------------------------------------------------------------------------
-- 4. RLS — mirrors project_handoffs (member SELECT; JWT writes denied; the
--    service role, used by the create server action, is the sole writer).
-- ---------------------------------------------------------------------------
alter table public.ticket_attachments enable row level security;

drop policy if exists ticket_attachments_member_read on public.ticket_attachments;
create policy ticket_attachments_member_read
  on public.ticket_attachments
  for select
  using (tenant_id in (select public.current_user_tenants()));

drop policy if exists ticket_attachments_insert_deny on public.ticket_attachments;
create policy ticket_attachments_insert_deny
  on public.ticket_attachments
  for insert
  with check (false);

drop policy if exists ticket_attachments_update_deny on public.ticket_attachments;
create policy ticket_attachments_update_deny
  on public.ticket_attachments
  for update
  using (false);

drop policy if exists ticket_attachments_delete_deny on public.ticket_attachments;
create policy ticket_attachments_delete_deny
  on public.ticket_attachments
  for delete
  using (false);

-- ---------------------------------------------------------------------------
-- 5. Indexes — the drawer read path ("this ticket's attachments").
-- ---------------------------------------------------------------------------
create index if not exists idx_ticket_attachments_ticket
  on public.ticket_attachments (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- 6. Cascade cleanup of stored objects.
--    When a ticket_attachments row goes away (directly, or via the ticket /
--    tenant FK cascade), delete the matching object from the bucket so a
--    deleted ticket doesn't leave its screenshots reachable. SECURITY DEFINER
--    so the reap works regardless of which role fired the delete.
--
--    Caveat (documented follow-up): this removes the storage.objects ROW, which
--    unlinks the object (it becomes unreachable — the security-relevant part).
--    The physical blob in the storage backend may be orphaned; a periodic
--    storage lifecycle GC is a later concern, not a tenant-isolation gap.
-- ---------------------------------------------------------------------------
create or replace function public.reap_ticket_attachment_object()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  delete from storage.objects
   where bucket_id = 'ticket-attachments'
     and name = old.storage_key;
  return old;
end;
$$;

drop trigger if exists trg_reap_ticket_attachment_object on public.ticket_attachments;
create trigger trg_reap_ticket_attachment_object
  after delete on public.ticket_attachments
  for each row
  execute function public.reap_ticket_attachment_object();

commit;
