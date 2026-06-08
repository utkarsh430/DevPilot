-- =============================================================================
-- Migration : 20260714000000_project_handoffs.sql
-- Purpose   : Add project_handoffs — the append-only, project-scoped artifact
--             agents write ("here is what I built / decided / assumed / what
--             interface I exposed") and that later, dependent tickets read at
--             dispatch time.
--
-- Why
-- ───
-- A dispatched agent's prompt (lib/roles/context.ts) carries only its OWN
-- ticket text plus its own comments. Under the parallel backlog drain (up to
-- `drain_parallelism` tickets in flight) siblings share nothing, so a ticket
-- that `builds_on` another has no idea what its ancestor actually produced
-- until that work lands on dev — which may be long after both were dispatched.
-- These rows are the interim, DB-backed carrier for that context. (Committed
-- `.devpilot/handoff` fragments are a later phase; deliberately out of scope.)
--
-- Design notes
-- ────────────
-- • APPEND-ONLY. There is no update path in the app: every write is a plain
--   INSERT, so two concurrent agents can never clobber each other's entry
--   (a read-modify-write "one row per ticket" doc would). Staleness across a
--   ticket's retries is resolved at READ time (latest-per (ticket, kind)),
--   not by mutating history. Hence no `updated_at` and no touch trigger.
-- • `kind` is a closed CHECK set rather than free text: the reader renders it
--   into the agent prompt, and a stable vocabulary keeps that block scannable.
-- • Entries are UNTRUSTED agent-authored content. The read path fences them
--   (fenceUntrustedOutput) and labels them "claimed, not yet landed on dev".
--   The per-entry length cap is enforced by the write route (400 on overflow).
-- • RLS mirrors dispatch_queue exactly: member SELECT via
--   public.current_user_tenants(); INSERT/UPDATE/DELETE denied for JWT roles.
--   service_role (the runner-tools route, Inngest) bypasses RLS and is the
--   sole writer.
--
-- Execution notes
-- ───────────────
-- One-shot transactional migration. Indexes are plain CREATE INDEX (not
-- CONCURRENTLY, which is forbidden inside a transaction block): the table is
-- brand new and has zero rows, so there is nothing to lock-contend against.
-- =============================================================================
begin;

create table if not exists public.project_handoffs (
  -- Identity
  id          uuid        not null default gen_random_uuid()
                primary key,

  -- Tenant isolation (cascade: deleting a tenant reaps its handoffs).
  tenant_id   uuid        not null
                references public.tenants(id) on delete cascade,

  -- Scope. Handoffs are read per PROJECT (the board the siblings share), so
  -- project_id is NOT NULL — a ticket with no project has no siblings to
  -- inform, and the write route refuses it rather than storing an orphan.
  project_id  uuid        not null
                references public.projects(id) on delete cascade,

  -- The ticket the entry is ABOUT (the author's own ticket). Dependents find
  -- an entry by walking their blocking-relation ancestors to this column.
  ticket_id   uuid        not null
                references public.tickets(id) on delete cascade,

  -- The run that authored it. Nullable: a smoke test / future non-run writer
  -- has none, and losing the run must not lose the note (set null, not cascade).
  run_id      uuid        null
                references public.runs(id) on delete set null,

  -- Author role slug (engineer / qa / architect / …). Free text, mirroring
  -- comments.author_id — custom JD-synthesized roles are legal slugs too.
  role        text        not null,

  -- Closed vocabulary; see design notes.
  --   built     — what actually got implemented (files, endpoints, behaviour)
  --   decision  — a choice made that constrains dependents
  --   assumption— something taken as given that a dependent should re-check
  --   interface — the concrete contract exposed (signature, route, schema)
  kind        text        not null
                constraint chk_project_handoffs_kind
                  check (kind in ('built', 'decision', 'assumption', 'interface')),

  body        text        not null
                constraint chk_project_handoffs_body_nonempty
                  check (length(btrim(body)) > 0),

  created_at  timestamptz not null default now()
);

comment on table public.project_handoffs is
  'Append-only, project-scoped handoff notes written by agents (ace_handoff) '
  'and injected into the prompt of dependent tickets at dispatch. Content is '
  'UNTRUSTED agent output: readers fence it and label it as claimed, not yet '
  'landed on the integration branch. Never updated in place — staleness is '
  'resolved at read time by taking the latest entry per (ticket, kind).';

-- ---------------------------------------------------------------------------
-- Row-Level Security — mirrors public.dispatch_queue.
-- ---------------------------------------------------------------------------
alter table public.project_handoffs enable row level security;

-- SELECT: tenant members see only their own rows.
create policy project_handoffs_member_read
  on public.project_handoffs
  for select
  using (tenant_id in (select public.current_user_tenants()));

-- INSERT / UPDATE / DELETE: denied for JWT-authenticated roles. service_role
-- (the runner-tools route, migrations) bypasses RLS entirely in Supabase.
create policy project_handoffs_insert_deny
  on public.project_handoffs
  for insert
  with check (false);

create policy project_handoffs_update_deny
  on public.project_handoffs
  for update
  using (false);

create policy project_handoffs_delete_deny
  on public.project_handoffs
  for delete
  using (false);

-- ---------------------------------------------------------------------------
-- Indexes
--
-- Index A: the project timeline — "the newest handoffs on this board".
create index if not exists idx_project_handoffs_project_created
  on public.project_handoffs (project_id, created_at desc);

-- Index B: the dispatch read path — "every handoff written about these
-- ancestor tickets, in this tenant".
create index if not exists idx_project_handoffs_tenant_ticket
  on public.project_handoffs (tenant_id, ticket_id);

commit;
