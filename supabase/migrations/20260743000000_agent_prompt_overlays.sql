-- =============================================================================
-- Migration : 20260743000000_agent_prompt_overlays.sql
-- Purpose   : Store the operator's OWN instructions for a role — an appended,
--             fenced, subordinate block beneath the role's shipped prompt.
--
-- ── The one rule this table exists to preserve ─────────────────────────────
-- The shipped prompt STAYS IN CODE and is NEVER copied here. This table holds
-- only the operator's additions. Nothing in this schema can hold a base prompt,
-- a base snapshot, or a "base at time of edit" — there is no column for one, and
-- that absence is the design.
--
-- The moment a copy of a shipped prompt exists in the database, so does the
-- drift problem: shipping v2 of a role prompt pins every tenant that ever
-- touched it to v1, "reset to default" becomes "throw away everything you
-- wrote", and every MCP tool rename becomes a data migration over operator text
-- (the 20260721000000 backfill, which rewrote `agents.config.role_config`
-- systemPrompts and `skills.body` for exactly that reason, is what that looks
-- like). Under the overlay design none of that exists: the base is resolved from
-- code at dispatch time, so a new version reaches every tenant on deploy with
-- the overlay riding intact on top, and "clear the overlay" is a complete and
-- always-correct reset because the default IS the code.
--
-- Same mechanism the codebase already uses for installed skills
-- (`apps/web/lib/skills/merge.ts`): operator-controlled, DB-stored text merged
-- into the system prompt at dispatch behind a fence whose header tells the model
-- in prose that it does not change the ticket state machine and does not
-- override the role's MCP-tool contract. This is that, with a different source
-- and a per-role scope.
--
-- ── Keyed on the ROLE SLUG, never `agents.id` ──────────────────────────────
-- Same constraint, and the same reason, as the per-agent model override
-- (20260737000000): a built-in role's materialized `agents` row carries no
-- `role_config` at all, and a fan-out sibling carries no `agent_id`
-- (`runs.fan_out_role`). The slug is the only identity every dispatch path
-- shares, so an id-keyed overlay would silently miss whole classes of run —
-- which is the "a settable value does not reach the thing it names" failure this
-- family of work exists to end.
--
-- ── `project_id` ships NULLABLE and global-only ────────────────────────────
-- Phase 2 writes ONLY the global rung (`project_id IS NULL` = this overlay
-- applies to every project in the tenant). The column exists from day one so the
-- per-project rung planned for Phase 4 needs no second migration and no widening
-- of a NOT NULL column later.
--
-- The partial unique index is REQUIRED and `uq_agent_prompt_overlays_scope`
-- is NOT a substitute for it: Postgres treats NULLs as DISTINCT in a unique
-- index (SQL-standard `UNIQUE NULLS DISTINCT`), so that constraint does not
-- constrain the global rows at all and would happily hold a dozen overlays for
-- one role — whichever the read happened to return would then be the effective
-- overlay. `create unique index … where project_id is null` is what makes
-- exactly one global per (tenant, role) representable. It is also why the global
-- write path is delete-then-insert rather than an upsert: PostgREST's
-- `on_conflict` names COLUMNS and cannot express a partial index's predicate, so
-- there is no conflict target to infer. Verbatim the 20260739000000 finding.
--
-- ── RLS ────────────────────────────────────────────────────────────────────
-- Members READ (the inspector page renders through the RLS-bound client); every
-- JWT write is DENIED. Writing an overlay is a human action performed through
-- one validated server action on the service client, which carries the
-- co-located `.eq("tenant_id", …)` that is then the entire write-side boundary.
-- A browser-writable overlay would let a compromised client inject standing
-- instructions into every future run of a role — the same reason
-- `agent_learnings` (20260735000000) denies JWT writes.
--
-- There is deliberately NO agent-facing surface: no MCP tool, nothing in
-- `DEVPILOT_BOARD_TOOLS`, no runner change. An agent cannot write its own
-- standing instructions.
-- =============================================================================

begin;

create table if not exists public.agent_prompt_overlays (
  -- Identity
  id          uuid        not null default gen_random_uuid()
                primary key,

  -- Tenant isolation (cascade: deleting a tenant reaps its overlays).
  tenant_id   uuid        not null
                references public.tenants(id) on delete cascade,

  -- NULL ⇒ this overlay applies to EVERY project in the tenant. Phase 2 writes
  -- only NULL; the per-project rung is Phase 4. Cascade: an overlay naming a
  -- deleted project names nothing.
  project_id  uuid        null
                references public.projects(id) on delete cascade,

  -- The ROLE this overlay applies to — see the header on why not agents.id.
  role_slug   text        not null
                constraint chk_agent_prompt_overlays_role_slug_nonempty
                  check (length(btrim(role_slug)) > 0),

  -- The operator's own instructions. NEVER a copy of the shipped prompt.
  -- Bounded here as well as in the app: a runaway overlay costs tokens on every
  -- run of that role forever. 4000 matches OVERLAY_MAX_CHARS in
  -- `apps/web/lib/roles/overlay.ts`; the app REFUSES an over-cap body rather
  -- than truncating it, so this CHECK is the backstop, not the message.
  body        text        not null
                constraint chk_agent_prompt_overlays_body_nonempty
                  check (length(btrim(body)) > 0)
                constraint chk_agent_prompt_overlays_body_bounded
                  check (length(body) <= 4000),

  updated_by  uuid        null
                references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- ONE overlay per (tenant, project, role) for the PROJECT-scoped rows. Does
  -- NOT constrain the global rows — see the header, and the partial index below.
  constraint uq_agent_prompt_overlays_scope
    unique (tenant_id, project_id, role_slug)
);

comment on table public.agent_prompt_overlays is
  'Operator-authored instructions appended beneath a role''s SHIPPED prompt at '
  'dispatch, inside a fence that subordinates them to the role contract. The '
  'shipped prompt stays in code and is NEVER stored here — there is no column '
  'for one. Clearing a row is therefore a complete and always-correct reset.';

comment on column public.agent_prompt_overlays.project_id is
  'The project this overlay applies to, or NULL for the tenant-wide overlay. '
  'Phase 2 writes only NULL; the per-project rung is Phase 4.';

comment on column public.agent_prompt_overlays.body is
  'The operator''s own instructions ONLY. Redaction-scrubbed and length-bounded '
  'before write; rendered inside a fence that tells the model these refine HOW '
  'the agent works and never change the ticket state machine, the MCP-tool '
  'contract, or any safety rule.';

-- Exactly one tenant-wide overlay per (tenant, role). See the header for why
-- `uq_agent_prompt_overlays_scope` cannot do this.
create unique index if not exists uq_agent_prompt_overlays_global
  on public.agent_prompt_overlays (tenant_id, role_slug)
  where project_id is null;

-- ---------------------------------------------------------------------------
-- Row-Level Security — mirrors public.agent_project_models / agent_learnings.
-- ---------------------------------------------------------------------------
alter table public.agent_prompt_overlays enable row level security;

drop policy if exists agent_prompt_overlays_member_read on public.agent_prompt_overlays;
create policy agent_prompt_overlays_member_read
  on public.agent_prompt_overlays
  for select
  using (tenant_id in (select public.current_user_tenants()));

drop policy if exists agent_prompt_overlays_insert_deny on public.agent_prompt_overlays;
create policy agent_prompt_overlays_insert_deny
  on public.agent_prompt_overlays
  for insert
  with check (false);

drop policy if exists agent_prompt_overlays_update_deny on public.agent_prompt_overlays;
create policy agent_prompt_overlays_update_deny
  on public.agent_prompt_overlays
  for update
  using (false);

drop policy if exists agent_prompt_overlays_delete_deny on public.agent_prompt_overlays;
create policy agent_prompt_overlays_delete_deny
  on public.agent_prompt_overlays
  for delete
  using (false);

-- The dispatch read: "the overlay for this role in this tenant", on every
-- compose. Covered by uq_agent_prompt_overlays_global for the global rung; this
-- index serves the tenant-wide listing the inspector and Phase 4 will want.
create index if not exists idx_agent_prompt_overlays_tenant
  on public.agent_prompt_overlays (tenant_id, role_slug);

-- ---------------------------------------------------------------------------
-- Tenant-matches-parent trigger (the 20260732000000 convention).
--
-- `tenant_id → tenants` is outside the class (tenants carries no tenant_id of
-- its own) and `updated_by → auth.users` likewise (no tenant_id column there) —
-- same as the existing created_by/triggered_by/promoted_by pointers. Only
-- project_id needs guarding, and the function short-circuits on a NULL pointer,
-- so the Phase-2 global rows pass through it untouched while every row that
-- DOES name a project is checked.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_agent_prompt_overlays_project_id_tenant on public.agent_prompt_overlays;
create trigger trg_agent_prompt_overlays_project_id_tenant
  before insert or update of tenant_id, project_id on public.agent_prompt_overlays
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

commit;
