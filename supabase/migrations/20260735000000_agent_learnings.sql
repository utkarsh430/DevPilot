-- =============================================================================
-- Migration : 20260735000000_agent_learnings.sql
-- Purpose   : Add agent_learnings — the candidate/active LESSON + standing
--             PREFERENCE store. One row per lesson the system has extracted
--             from a mistake (or that an operator will later author): a short
--             imperative directive ("When X, do Y first"), a scope, and a
--             category, moving through a candidate → active/rejected/archived
--             lifecycle.
--
-- What this is (and is NOT)
-- ─────────────────────────
-- This is PR 2 of the "Agent Learning + Scoreboard" system: the lessons TABLE
-- plus the LLM lesson EXTRACTOR that turns an `agent_mistakes` row + its
-- correction context into a `status='candidate'` row here. It deliberately does
-- NOT include the review/approval UI (PR 3), the prompt injection / feed-forward
-- that makes agents apply active lessons (PR 4), the preferences page, or the
-- scoreboard. Full plan: ~/.claude/plans/jaunty-meandering-liskov.md.
--
-- Where rows come from
-- ────────────────────
-- `lib/learning/extract.server.ts` reads an `agent_mistakes` row (PR 1), feeds
-- its REDACTED evidence + correction context to the LLM (via
-- lib/llm/generate.server.ts — the same auth-mode/provider-aware seam every other
-- one-shot feature uses), and inserts a candidate lesson here with
-- `source_mistake_id` set. Extraction runs go-forward off `agent/run.completed`
-- (extended onto PR 1's harvest hook) and as a one-time backfill over the already
-- recorded mistakes. Both paths are idempotent: at most one candidate per source
-- mistake (a read-check on `source_mistake_id`), and a body-similarity dedupe
-- against existing active + candidate lessons for the same (tenant, scope, role)
-- so the queue never fills with restatements of the same lesson.
--
-- scope / role_slug
-- ─────────────────
-- `scope` is a closed CHECK set:
--   global — applies to every agent (a cross-cutting engineering rule).
--   role   — specific to the offending role; `role_slug` names it (the CHECK
--            below requires a slug for this scope, NULL otherwise).
--   user   — a standing OPERATOR preference / "what the captain actually wanted"
--            (a human_correction mistake leans here). This scope doubles as the
--            durable preferences store that does not exist today.
-- `role_slug` is free text like agent_mistakes.role / project_handoffs.role —
-- custom JD-synthesized roles are legal slugs too.
--
-- category
-- ────────
-- A coarse tag ("testing", "requirements", "security", "preference", …). It is
-- free `text` rather than a DB enum, and the app is the vocabulary: the extractor
-- re-derives every returned category through a closed list in
-- lib/learning/extract.ts (the same app-layer grounding project_stack_tags uses
-- for its capability/service keys, deliberately not an enum so the taxonomy can
-- evolve without a migration). The DB only enforces non-empty.
--
-- status lifecycle
-- ────────────────
--   candidate — freshly extracted, awaiting review (PR 3). The only status the
--               extractor writes.
--   active    — approved (PR 3 / auto-approve); the status PR 4's selector reads.
--   rejected  — declined in review; feeds dedupe so it is not re-proposed.
--   archived  — retired / superseded.
--
-- Security
-- ────────
-- Tenant-scoped with the identical RLS shape as agent_mistakes / project_handoffs:
-- members SELECT their own rows; INSERT/UPDATE/DELETE denied to JWT roles.
-- Writes are ENGINE-AUTHORED via the service role (which bypasses RLS): the
-- extractor inserts candidates, and PR 3's review actions will flip status
-- through a SERVER ACTION running the service client with the tenant validated
-- first — NOT a member-UPDATE RLS policy. A member-writable status column would
-- let a compromised browser promote an arbitrary (or adversarial) lesson to
-- `active` and have it fed into every future run, bypassing the human-review
-- gate that is the whole safety story for untrusted lesson bodies. Keeping writes
-- service-only means every promotion goes through validated server code. This
-- mirrors PR 1's deny-writes decision exactly.
--
-- Lesson bodies are UNTRUSTED (agent/user-authored, principle 6). The extractor
-- redacts secrets/paths (lib/learning/redact.ts) and treats the mistake evidence
-- as DATA (fenced, never instructions) before a body lands here; PR 4 will fence
-- the body again on injection. Bodies are plain text — never directives.
--
-- source_mistake_id → agent_mistakes is same-tenant, so it gets an
-- assert_tenant_matches_parent trigger below (the 20260732000000 convention).
-- The tenant-scope-scan test re-derives this pair from this migration and would
-- fail if the trigger were missing; the audit SQL is regenerated to cover it.
--
-- Execution notes
-- ───────────────
-- One-shot transactional migration; the table is brand new with zero rows, so
-- indexes are plain CREATE INDEX (CONCURRENTLY is illegal inside a transaction).
-- =============================================================================
begin;

create table if not exists public.agent_learnings (
  -- Identity
  id          uuid        not null default gen_random_uuid()
                primary key,

  -- Tenant isolation (cascade: deleting a tenant reaps its lessons).
  tenant_id   uuid        not null
                references public.tenants(id) on delete cascade,

  -- Who the lesson applies to. Closed vocabulary; see the header.
  --   global — every agent
  --   role   — one role (role_slug names it)
  --   user   — a standing operator preference
  scope       text        not null
                constraint chk_agent_learnings_scope
                  check (scope in ('global', 'role', 'user')),

  -- The role a `role`-scoped lesson targets. Free text (custom slugs are legal).
  -- Required for scope='role', NULL for global/user — see the CHECK below.
  role_slug   text        null,

  -- Coarse category tag, grounded by the app (lib/learning/extract.ts), not a DB
  -- enum. Non-empty only.
  category    text        not null
                constraint chk_agent_learnings_category_nonempty
                  check (length(btrim(category)) > 0),

  -- The lesson itself: a short imperative directive. UNTRUSTED, redacted before
  -- insert, plain text — never executed as instructions.
  body        text        not null
                constraint chk_agent_learnings_body_nonempty
                  check (length(btrim(body)) > 0),

  -- Lifecycle. Closed vocabulary; the extractor only ever writes 'candidate'.
  status      text        not null default 'candidate'
                constraint chk_agent_learnings_status
                  check (status in ('candidate', 'active', 'rejected', 'archived')),

  -- The mistake this lesson was extracted from. Nullable + set null: an operator
  -- may author a preference directly (PR 3) with no source mistake, and losing
  -- the mistake record must not lose the lesson.
  source_mistake_id uuid  null
                references public.agent_mistakes(id) on delete set null,

  -- Provenance. `created_by` is the author literal ('lesson_extractor' for the
  -- LLM path, an operator id for a hand-authored preference). `approved_by` is
  -- set by the review flow (PR 3) when a candidate is promoted to active.
  created_by  text        not null default 'lesson_extractor',
  approved_by text        null,

  created_at  timestamptz not null default now(),

  -- A role-scoped lesson MUST name a role; global/user lessons MUST NOT.
  constraint chk_agent_learnings_role_slug_scope
    check (
      (scope = 'role' and role_slug is not null)
      or (scope <> 'role' and role_slug is null)
    )
);

comment on table public.agent_learnings is
  'Candidate/active lesson + standing preference store. One row per extracted '
  'lesson: a short imperative body, a scope (global|role|user), a category, and a '
  'candidate→active/rejected/archived status. Rows are extracted by '
  'lib/learning/extract.server.ts from agent_mistakes (source_mistake_id) via the '
  'LLM, or hand-authored by an operator (PR 3). Bodies are UNTRUSTED and redacted '
  'before insert. Engine-authored: writes denied to JWT roles, service_role only '
  '(PR 3 review actions flip status through validated server code). PR 4 reads '
  'status=active to feed lessons forward into runs.';

-- ---------------------------------------------------------------------------
-- Row-Level Security — mirrors public.agent_mistakes / public.project_handoffs.
-- ---------------------------------------------------------------------------
alter table public.agent_learnings enable row level security;

-- SELECT: tenant members see only their own rows.
create policy agent_learnings_member_read
  on public.agent_learnings
  for select
  using (tenant_id in (select public.current_user_tenants()));

-- INSERT / UPDATE / DELETE: denied for JWT-authenticated roles. service_role
-- (the extractor, the backfill, PR 3's validated server actions) bypasses RLS.
create policy agent_learnings_insert_deny
  on public.agent_learnings
  for insert
  with check (false);

create policy agent_learnings_update_deny
  on public.agent_learnings
  for update
  using (false);

create policy agent_learnings_delete_deny
  on public.agent_learnings
  for delete
  using (false);

-- ---------------------------------------------------------------------------
-- Indexes
--
-- Index A: PR 4's selector read path — "the active lessons for this run":
-- filter by (tenant, status='active', scope, role_slug). Also serves PR 3's
-- candidate queue ("tenant's candidates").
create index if not exists idx_agent_learnings_tenant_status_scope_role
  on public.agent_learnings (tenant_id, status, scope, role_slug);

-- Index B: the extractor's per-mistake idempotency check — "does a lesson
-- already exist for this source mistake?".
create index if not exists idx_agent_learnings_source_mistake
  on public.agent_learnings (tenant_id, source_mistake_id);

-- ---------------------------------------------------------------------------
-- Tenant-matches-parent trigger (the 20260732000000 convention).
--
-- agent_learnings has ONE FK pointer to a tenant-scoped parent
-- (source_mistake_id → agent_mistakes), same-tenant. The tenant-scope-scan test
-- re-derives this pair from this migration and fails if the trigger is missing;
-- the audit SQL (regenerated by scripts/generate-tenant-parent-audit.ts) covers
-- it too.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_agent_learnings_source_mistake_id_tenant on public.agent_learnings;
create trigger trg_agent_learnings_source_mistake_id_tenant
  before insert or update of tenant_id, source_mistake_id on public.agent_learnings
  for each row execute function public.assert_tenant_matches_parent('source_mistake_id', 'agent_mistakes');

commit;
