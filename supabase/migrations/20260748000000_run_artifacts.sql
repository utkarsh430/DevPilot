-- =============================================================================
-- Migration : 20260748000000_run_artifacts.sql
-- Purpose   : Visual evidence OUT of a run — the private `run-artifacts` bucket,
--             its tenant-scoped storage RLS, and the `run_artifacts` metadata
--             table that ties a stored image to the exact agent step that
--             produced it.
--
-- The gap this closes
-- ───────────────────
-- `@playwright/mcp` is wired into every `claude -p` step with 24 browser tools,
-- including `browser_take_screenshot`. Its `--output-dir` pointed at a fixed
-- path under the OS temp dir that NOTHING read, NOTHING uploaded, and NOTHING
-- cleaned up. An agent could navigate a page, click through a flow, screenshot
-- the result — and every image died in /tmp. The agent saw the page; the
-- operator got a sentence about the page. This table is where those bytes now
-- land so the operator can look at them.
--
-- Direction note: this is the OPPOSITE path to `ticket_attachments`
-- (20260725000000), which carries operator-supplied images INTO a run. Both use
-- a private tenant-foldered bucket and the same RLS shape, deliberately — but
-- they are separate tables because the trust direction is opposite. A ticket
-- attachment is human-authored and untrusted-to-the-agent; a run artifact is
-- agent-produced and untrusted-to-the-operator's-browser (hence the byte
-- signature check at the ingest route, and PNG/JPEG only — no SVG, which is an
-- active document).
--
-- The association is PROVABLE, and that is the whole point
-- ───────────────────────────────────────────────────────
-- Evidence that misfiles itself is worse than no evidence: an operator reading a
-- screenshot under the wrong step draws a confident wrong conclusion. So
-- `step_idx` is not inferred from timestamps. The runner writes a per-step MCP
-- config whose `--output-dir` is unique to `(run_id, iteration_idx)`, and the
-- @playwright/mcp server is a stdio CHILD of exactly one `claude -p` process —
-- the one invocation the engine records as `run_steps (run_id, idx = iteration,
-- kind='think')`. A file in that directory can therefore only have been written
-- during that step. What this does NOT establish is WHICH TOOL CALL inside the
-- step wrote it, so the UI says "captured during this step" and never implies
-- per-action precision. `captured_at` (the file's mtime) is carried so the
-- operator can order images within the step.
--
-- What is kept, and why the operator is told
-- ──────────────────────────────────────────
-- A long browser flow can capture many images; uploading all of them is a
-- storage bill and a haystack. The rule is a cap, and the cap is LEGIBLE rather
-- than silent: `captured_total` records how many the step actually captured, so
-- the inspector can say "showing 4 of 9 — the 5 oldest were dropped" instead of
-- quietly showing 4. `sequence` is the kept image's 0-based position in capture
-- order, so the surviving set is orderable and its gaps are visible.
--
-- Security posture (AGENTS.md — tenant isolation is the boundary)
-- ──────────────────────────────────────────────────────────────
-- Object paths are `"<tenant_id>/<run_id>/<step_idx>/<uuid>.<ext>"`; the storage
-- RLS below keys on the FIRST path segment exactly as ticket-attachments does,
-- so a bucket path is never reachable cross-tenant. The table's RLS mirrors
-- ticket_attachments / project_handoffs: members SELECT their own rows, every
-- JWT write is denied, and the service role (the runner-authenticated ingest
-- route) is the sole writer. `run_id → runs` is a tenant-scoped parent, so it
-- carries the `assert_tenant_matches_parent` trigger of the 20260732000000
-- convention — that list is DERIVED from a parse of these migrations and
-- lib/security/__tests__/tenant-scope-scan.test.ts FAILS on a gap, so the
-- trigger is not optional book-keeping. Regenerate the audit SQL
-- (scripts/generate-tenant-parent-audit.ts) after applying.
--
-- Lifecycle
-- ─────────
-- Deleting a run cascades its artifact rows, and the AFTER DELETE trigger reaps
-- the stored objects — the same shape (and the same documented caveat about the
-- physical blob) as ticket_attachments. The per-run cap is enforced app-side at
-- the ingest route, so this bucket cannot grow without bound the way the temp
-- directory it replaces did.
--
-- config.toml note
-- ────────────────
-- The `[storage.buckets.run-artifacts]` block in supabase/config.toml only
-- affects LOCAL Supabase. THIS migration creates the bucket + RLS on the hosted
-- project.
--
-- Execution notes
-- ───────────────
-- One-shot transactional migration. The bucket insert is idempotent and every
-- policy is guarded by a prior `drop policy if exists`, so a re-run is clean.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. The private bucket. 5 MiB per file; PNG/JPEG only.
--
--    Tighter than ticket-attachments (10 MiB, 4 types) on purpose. These images
--    are machine-produced viewport captures, not arbitrary operator uploads: a
--    1280x720 PNG is well under 1 MiB, so 5 MiB is generous. GIF and WebP are
--    excluded because @playwright/mcp emits PNG or JPEG and nothing else, so
--    admitting more would widen the render surface for no capability.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'run-artifacts',
  'run-artifacts',
  false,
  5242880, -- 5 MiB
  array['image/png', 'image/jpeg']
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Storage RLS — scope every object to its tenant's top-level folder.
--    Read-only for members: nothing but the service role ever writes here (the
--    runner posts bytes to the ingest route; no browser uploads to this bucket),
--    so there is deliberately no authenticated INSERT/UPDATE/DELETE policy.
-- ---------------------------------------------------------------------------
drop policy if exists run_artifacts_obj_read on storage.objects;
create policy run_artifacts_obj_read
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'run-artifacts'
    and (storage.foldername(name))[1] in (
      select t::text from public.current_user_tenants() as t
    )
  );

-- ---------------------------------------------------------------------------
-- 3. The metadata table. One row per stored object.
-- ---------------------------------------------------------------------------
create table if not exists public.run_artifacts (
  id            uuid        not null default gen_random_uuid()
                  primary key,

  -- Cascade: deleting the run drops its artifact rows (and the AFTER DELETE
  -- trigger below reaps the stored objects).
  run_id        uuid        not null
                  references public.runs(id) on delete cascade,

  -- Tenant isolation (cascade with the tenant). The storage_key's first path
  -- segment equals this id — the ingest route enforces it (isKeyUnderTenant).
  tenant_id     uuid        not null
                  references public.tenants(id) on delete cascade,

  -- The agent step this image was captured during: equal to `run_steps.idx` of
  -- the `think` row for the same iteration. NOT a timestamp inference — see the
  -- header. Non-negative because iteration indices start at 0.
  step_idx      int         not null
                  constraint chk_run_artifacts_step_idx
                    check (step_idx >= 0),

  -- The object path inside the `run-artifacts` bucket:
  --   "<tenant_id>/<run_id>/<step_idx>/<uuid>.<ext>"
  storage_key   text        not null
                  constraint chk_run_artifacts_key_nonempty
                    check (length(btrim(storage_key)) > 0),

  -- Allowlisted image MIME. Enforced by the bucket, by the ingest route's
  -- extension check, AND by a magic-byte sniff of the uploaded body — a stored
  -- object is rendered in the operator's browser, so "it was named .png" is not
  -- evidence that it is one.
  mime          text        not null
                  constraint chk_run_artifacts_mime
                    check (mime in ('image/png', 'image/jpeg')),

  bytes         bigint      not null
                  constraint chk_run_artifacts_bytes
                    check (bytes > 0),

  -- Where the image came from. Only browser captures exist today; the column
  -- makes a later source (a CLI screenshot tool, a video frame) additive rather
  -- than a migration.
  source        text        not null default 'browser'
                  constraint chk_run_artifacts_source
                    check (source in ('browser')),

  -- 0-based position among the images this STEP captured, in capture order.
  -- Kept even when earlier images were dropped by the cap, so a gap in the
  -- sequence is visible rather than silently closed up.
  sequence      int         not null
                  constraint chk_run_artifacts_sequence
                    check (sequence >= 0),

  -- How many images the step captured in total, including the ones the cap
  -- dropped. This is what makes the retention rule legible to the operator
  -- ("showing 4 of 9") instead of a silent truncation.
  captured_total int        not null
                  constraint chk_run_artifacts_captured_total
                    check (captured_total > 0),

  -- The file's mtime on the runner host: when the browser actually wrote the
  -- image. Distinct from created_at (when it reached storage, after the step
  -- finished) — conflating the two would misdate every image by the length of
  -- the step.
  captured_at   timestamptz not null,

  created_at    timestamptz not null default now(),

  -- One row per stored object.
  constraint uq_run_artifacts_key unique (storage_key)
);

comment on table public.run_artifacts is
  'Screenshots an agent captured via the browser (@playwright/mcp) during a run, '
  'filed against the step that produced them. step_idx equals run_steps.idx for '
  'the same iteration and is provable by construction (per-step --output-dir), '
  'not inferred from timestamps. captured_total records what the per-step cap '
  'dropped so the retention rule is legible rather than silent.';

-- ---------------------------------------------------------------------------
-- 4. RLS — member SELECT; every JWT write denied; the service role (the
--    runner-authenticated ingest route) is the sole writer.
-- ---------------------------------------------------------------------------
alter table public.run_artifacts enable row level security;

drop policy if exists run_artifacts_member_read on public.run_artifacts;
create policy run_artifacts_member_read
  on public.run_artifacts
  for select
  using (tenant_id in (select public.current_user_tenants()));

drop policy if exists run_artifacts_insert_deny on public.run_artifacts;
create policy run_artifacts_insert_deny
  on public.run_artifacts
  for insert
  with check (false);

drop policy if exists run_artifacts_update_deny on public.run_artifacts;
create policy run_artifacts_update_deny
  on public.run_artifacts
  for update
  using (false);

drop policy if exists run_artifacts_delete_deny on public.run_artifacts;
create policy run_artifacts_delete_deny
  on public.run_artifacts
  for delete
  using (false);

-- ---------------------------------------------------------------------------
-- 5. Indexes — the inspector read path ("this run's artifacts, by step") and
--    the ingest route's per-run cap count.
-- ---------------------------------------------------------------------------
create index if not exists idx_run_artifacts_run
  on public.run_artifacts (run_id, step_idx, sequence);

-- ---------------------------------------------------------------------------
-- 6. Tenant-matches-parent trigger (the 20260732000000 convention). See header.
--    (`tenant_id → tenants` is not in the class: `tenants` carries no tenant_id
--    of its own, so there is no parent tenant to disagree with.)
-- ---------------------------------------------------------------------------
drop trigger if exists trg_run_artifacts_run_id_tenant on public.run_artifacts;
create trigger trg_run_artifacts_run_id_tenant
  before insert or update of tenant_id, run_id on public.run_artifacts
  for each row execute function public.assert_tenant_matches_parent('run_id', 'runs');

-- ---------------------------------------------------------------------------
-- 7. Cascade cleanup of stored objects.
--
--    TWO things here differ from trg_reap_ticket_attachment_object, and both
--    were found by actually running this migration against a local Supabase
--    rather than by reading the older one.
--
--    (a) `storage.protect_delete` — a BEFORE DELETE trigger current Supabase
--        ships on storage.objects — RAISES 42501 ("Direct deletion from storage
--        tables is not allowed") unless the transaction sets
--        `storage.allow_delete_query`. A reap that does not set it does not
--        merely fail to clean up: it aborts the DELETE that fired it, so
--        deleting a run (or a tenant) errors outright. `set_config(..., true)`
--        is transaction-LOCAL, so the permission is not left standing.
--
--    (b) The whole body is wrapped in an exception handler. Object cleanup is
--        housekeeping; the delete that triggered it is the operation the caller
--        asked for. If a future storage-side guard blocks this again, the right
--        outcome is an orphaned object (invisible, bounded by the per-run cap,
--        and already an accepted caveat for the physical blob) — never a run
--        that cannot be deleted. The warning is what makes the orphan findable.
--
--    Caveat, as with ticket_attachments: this removes the storage.objects ROW,
--    which unlinks the object — the security-relevant part. Reclaiming the
--    physical blob is a storage lifecycle concern, not a tenant-isolation gap.
-- ---------------------------------------------------------------------------
create or replace function public.reap_run_artifact_object()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  begin
    perform set_config('storage.allow_delete_query', 'true', true);
    delete from storage.objects
     where bucket_id = 'run-artifacts'
       and name = old.storage_key;
  exception when others then
    raise warning 'run_artifacts: could not reap stored object % (%)', old.storage_key, sqlerrm;
  end;
  return old;
end;
$$;

drop trigger if exists trg_reap_run_artifact_object on public.run_artifacts;
create trigger trg_reap_run_artifact_object
  after delete on public.run_artifacts
  for each row
  execute function public.reap_run_artifact_object();

commit;
