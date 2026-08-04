-- =============================================================================
-- Migration : 20260737000000_agent_project_models.sql
-- Purpose   : Add agent_project_models — the PER-AGENT, PER-PROJECT LLM model
--             override. One row says "on this project, this role runs this
--             provider's model", and it is the highest rung of the model
--             precedence chain: agent+project » project » tenant » instance »
--             env.
--
-- Why this table exists (the no-op it replaces)
-- ────────────────────────────────────────────
-- `agents.config.role_config.modelTier` already exists, is written by the JD
-- synthesizer and the visual builder, and is RENDERED as a per-agent model badge
-- on /agents. It has been a documented NO-OP on the local-cc path since it
-- shipped (lib/llm/provider.ts) — i.e. on every normal ticket run. So the
-- operator has had a per-agent model control all along that silently did
-- nothing. This table is the durable value that actually reaches `claude -p
-- --model`, and shipping a SECOND silent no-op is the one unacceptable outcome:
-- a value that can be set must either take effect or be shown as not in effect
-- (see `describeEffectiveModel`'s `shadowed` outcome in
-- lib/llm/claude-model-ladder.ts).
--
-- Keyed on the ROLE SLUG, not agents.id
-- ────────────────────────────────────
-- Dispatch attributes work by `COALESCE(runs.fan_out_role, agents.role)`, and a
-- FAN-OUT SIBLING carries no `agent_id` at all — it is emitted straight from the
-- cohort plan. An override keyed on `agents.id` would therefore silently miss
-- every fan-out run, which is exactly the class of half-reaching value this
-- feature exists to end. The slug is the identity that exists on every run, and
-- it is the thing an operator can actually edit (a role config), so it is the
-- key. Free text like agent_mistakes.role / agent_learnings.role_slug — custom
-- JD-synthesized roles are legal slugs too, and are deliberately not constrained
-- to a catalog the DB cannot know.
--
-- provider is stored from day one
-- ──────────────────────────────
-- A row is *(this role, on this project, runs THIS PROVIDER's model)*. Only
-- `anthropic` is writable today (the action refuses anything else), but storing
-- the provider is what makes a later Ollama / openai_compatible rung a pure
-- app-layer change with no migration — and, more immediately, it is what the
-- COMPATIBILITY RULE reads:
--
--   The provider is decided FIRST and atomically (`selectProvider`, whole-layer,
--   never field-merged). A role model applies ONLY if its provider matches the
--   winning one. A Claude model on an `openai_compatible` project is IGNORED and
--   logged, and the run continues on the project's own model — never forwarded.
--   Without that rule the value flows into `resolveApiModelId` verbatim with no
--   allowlist check and the endpoint 404s mid-run, which is strictly worse than
--   today's no-op.
--
-- The model string is NOT constrained here beyond non-empty. The DB cannot know
-- the CLI's allowlist, and it moves with the vendor; the gate is
-- `ALLOWED_CLAUDE_MODELS` + the offered ladder, enforced by the server action
-- before the write and again by `resolveClaudeModelArg` before the value reaches
-- a `claude -p` argv. A stored value that later falls out of the allowlist
-- degrades to the account default, never to a run failure.
--
-- Security
-- ────────
-- Tenant-scoped with the same RLS shape as agent_learnings / agent_mistakes:
-- members SELECT their own rows; INSERT/UPDATE/DELETE denied to JWT roles.
-- Writes go through the service role from ONE validated server action
-- (`setAgentProjectModelAction`), which derives the tenant from the session,
-- validates the model against the ladder AND the CLI allowlist, refuses an
-- `openai_compatible` project, and carries a co-located `.eq("tenant_id", …)`.
-- A member-writable table here would let a browser repoint another tenant's
-- agents at an arbitrary model.
--
-- `project_id → projects` is same-tenant, so it gets an
-- assert_tenant_matches_parent trigger below (the 20260732000000 convention).
-- That list is DERIVED from a parse of these migrations and
-- lib/security/__tests__/tenant-scope-scan.test.ts re-derives it and FAILS on a
-- gap, so the trigger is not optional book-keeping. The audit SQL
-- (scripts/generate-tenant-parent-audit.ts) is regenerated to cover it.
-- (`tenant_id → tenants` is not in the class: `tenants` carries no tenant_id of
-- its own, so there is no parent tenant to disagree with.)
--
-- Nothing lands on `projects`, so the PROJECT_COLUMNS / shell_bootstrap() sync
-- trap does not apply — deliberately kept that way.
--
-- Execution notes
-- ───────────────
-- One-shot transactional migration; the table is brand new with zero rows, so
-- indexes are plain CREATE INDEX (CONCURRENTLY is illegal inside a transaction).
-- =============================================================================
begin;

create table if not exists public.agent_project_models (
  -- Identity
  id          uuid        not null default gen_random_uuid()
                primary key,

  -- Tenant isolation (cascade: deleting a tenant reaps its overrides).
  tenant_id   uuid        not null
                references public.tenants(id) on delete cascade,

  -- The project this override applies to. Cascade: an override for a deleted
  -- project names nothing.
  project_id  uuid        not null
                references public.projects(id) on delete cascade,

  -- The ROLE this override applies to — see the header on why not agents.id.
  role_slug   text        not null
                constraint chk_agent_project_models_role_slug_nonempty
                  check (length(btrim(role_slug)) > 0),

  -- Which provider's model `model` names. Closed set, mirrors the app's
  -- LlmProvider union. Only 'anthropic' is writable today.
  provider    text        not null
                constraint chk_agent_project_models_provider
                  check (provider in ('anthropic', 'openai_compatible')),

  -- The model id or alias ('opus' / 'sonnet' / 'haiku' / a pinned id). Non-empty
  -- only — the real gate is the app-layer allowlist (see the header). Clearing
  -- an override DELETES the row rather than writing an empty model, so "no row"
  -- is the single representation of "inherit".
  model       text        not null
                constraint chk_agent_project_models_model_nonempty
                  check (length(btrim(model)) > 0),

  created_by  uuid        null
                references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- ONE override per (tenant, project, role). The upsert conflict target.
  constraint uq_agent_project_models_scope
    unique (tenant_id, project_id, role_slug)
);

comment on table public.agent_project_models is
  'Per-agent, per-project LLM model override — the top rung of agent+project » '
  'project » tenant » instance » env. Keyed on the ROLE SLUG (not agents.id) '
  'because fan-out siblings carry no agent_id and dispatch attributes work by '
  'COALESCE(runs.fan_out_role, agents.role). Provider-qualified so a later '
  'Ollama rung needs no migration; a row whose provider does not match the '
  'project''s winning provider is IGNORED and logged, never forwarded. '
  'Engine-read (lib/llm/provider-config.server.ts), written only by the '
  'validated setAgentProjectModelAction service-role path.';

-- ---------------------------------------------------------------------------
-- Row-Level Security — mirrors public.agent_learnings / public.agent_mistakes.
-- ---------------------------------------------------------------------------
alter table public.agent_project_models enable row level security;

-- SELECT: tenant members see only their own rows (the pickers read through the
-- RLS-bound client).
create policy agent_project_models_member_read
  on public.agent_project_models
  for select
  using (tenant_id in (select public.current_user_tenants()));

-- INSERT / UPDATE / DELETE: denied for JWT-authenticated roles. service_role
-- (the one validated server action) bypasses RLS.
create policy agent_project_models_insert_deny
  on public.agent_project_models
  for insert
  with check (false);

create policy agent_project_models_update_deny
  on public.agent_project_models
  for update
  using (false);

create policy agent_project_models_delete_deny
  on public.agent_project_models
  for delete
  using (false);

-- ---------------------------------------------------------------------------
-- Indexes
--
-- Index A: the ENGINE's read path — "does this (project, role) have an
-- override?", resolved once per run inside `resolve-provider`. The unique
-- constraint already indexes (tenant_id, project_id, role_slug) and serves it;
-- no second index is needed for that shape.
--
-- Index B: the UI's read path — "every override in this tenant", so /agents and
-- /scoreboard can render the resolved model per role without an N+1.
create index if not exists idx_agent_project_models_tenant
  on public.agent_project_models (tenant_id, role_slug);

-- ---------------------------------------------------------------------------
-- Tenant-matches-parent trigger (the 20260732000000 convention). See header.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_agent_project_models_project_id_tenant on public.agent_project_models;
create trigger trg_agent_project_models_project_id_tenant
  before insert or update of tenant_id, project_id on public.agent_project_models
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

commit;
