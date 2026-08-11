-- =============================================================================
-- Migration : 20260739000000_agent_global_model.sql
-- Purpose   : Let ONE row of agent_project_models mean "this agent runs this
--             model on EVERY project" — the agent-wide default — by making
--             `project_id` nullable and treating NULL as "all projects".
--
-- Why no second table
-- ───────────────────
-- The agent-wide default answers the same question as a per-project row ("which
-- model does this role run") at a coarser scope. A second table would duplicate
-- the provider column, the model CHECK, the RLS shape, the tenant trigger and
-- the read path, and would then have to be joined back together at resolution
-- time anyway. One table with a nullable pointer keeps a single read, a single
-- write path, and a single set of rules.
--
-- Precedence after this migration (MODEL only — the PROVIDER chain is untouched
-- and stays whole-layer/atomic in `selectProvider`):
--
--     agent+project  »  agent-global  »  project  »  tenant  »  instance  »  env
--
-- More specific always wins, so a per-project row keeps beating the global. That
-- is deliberate and is SURFACED in the UI ("N projects override this") rather
-- than resolved by silently deleting the operator's per-project choices.
--
-- ── The partial unique index is REQUIRED, not belt-and-braces ──────────────
-- `uq_agent_project_models_scope` is `unique (tenant_id, project_id, role_slug)`
-- and it does NOT constrain the global rows at all: Postgres treats NULLs as
-- DISTINCT in a unique index (SQL-standard `UNIQUE NULLS DISTINCT`), so two rows
-- with the same (tenant, role) and a NULL project_id do not conflict — the
-- constraint would happily hold a dozen globals for one role. Whichever the read
-- happened to return would then be the effective model, which is precisely the
-- "a settable value silently does something other than what it says" failure
-- this whole family of work exists to end.
--
-- `create unique index … where project_id is null` is what makes exactly one
-- global per (tenant, role) representable. It is also why the global write path
-- is delete-then-insert rather than an upsert: PostgREST's `on_conflict` names
-- columns and cannot express a partial index's predicate, so there is no
-- conflict target to infer. The index remains the backstop — a concurrent double
-- insert fails loudly instead of duplicating.
--
-- ── The tenant trigger already tolerates NULL ──────────────────────────────
-- `assert_tenant_matches_parent` (20260732000000) short-circuits on a NULL
-- pointer ("a null pointer names no parent, so there is no tenant to
-- contradict") — the same allowance `assert_tenant_matches_ticket` makes for
-- ticket-less runs. So the existing
-- `trg_agent_project_models_project_id_tenant` trigger needs no change and keeps
-- guarding every row that DOES name a project. Nothing is dropped here, so
-- lib/security/__tests__/tenant-scope-scan.test.ts (which re-derives the pair
-- list from these migrations) still sees the pair and stays green.
--
-- Security is otherwise unchanged: RLS still denies every JWT write, the global
-- row is written only by the validated service-role server action
-- (`setAgentGlobalModelAction`), which derives the tenant from the session and
-- carries a co-located tenant predicate.
--
-- A global row is NOT refused for an `openai_compatible` project the way a
-- per-project write is — it names no project, so at write time there is nothing
-- to check. The COMPATIBILITY RULE handles it at resolution: a Claude model on a
-- project that resolves to `openai_compatible` is IGNORED and logged, never
-- forwarded (forwarding it would 404 that endpoint mid-run), and the UI renders
-- that project's row as `shadowed` / not in effect.
--
-- Execution notes
-- ───────────────
-- Dropping NOT NULL is a catalog-only change (no rewrite). The new index covers
-- the zero existing global rows, so a plain CREATE INDEX inside the transaction
-- is fine.
-- =============================================================================
begin;

-- NULL project_id ⇒ this override applies to EVERY project in the tenant.
alter table public.agent_project_models
  alter column project_id drop not null;

-- Exactly one agent-wide default per (tenant, role). See the header for why the
-- existing unique constraint cannot do this.
create unique index if not exists uq_agent_project_models_global
  on public.agent_project_models (tenant_id, role_slug)
  where project_id is null;

comment on column public.agent_project_models.project_id is
  'The project this override applies to, or NULL for the AGENT-WIDE default '
  '(every project, including ones created later). A per-project row wins over '
  'the global — precedence is agent+project » agent-global » project » tenant » '
  'instance » env. Uniqueness of the global is enforced by the partial index '
  'uq_agent_project_models_global, NOT by uq_agent_project_models_scope, which '
  'treats NULLs as distinct and so does not constrain globals at all.';

comment on table public.agent_project_models is
  'Per-agent LLM model override — the top rungs of agent+project » agent-global '
  '» project » tenant » instance » env. A row with project_id NULL is the '
  'agent-wide default; a row naming a project overrides it for that project. '
  'Keyed on the ROLE SLUG (not agents.id) because fan-out siblings carry no '
  'agent_id and dispatch attributes work by COALESCE(runs.fan_out_role, '
  'agents.role). Provider-qualified so a later Ollama rung needs no migration; a '
  'row whose provider does not match the project''s winning provider is IGNORED '
  'and logged, never forwarded. Engine-read '
  '(lib/llm/provider-config.server.ts), written only by the validated '
  'service-role actions in lib/metrics/model-actions.ts.';

commit;
