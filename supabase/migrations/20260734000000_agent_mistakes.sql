-- =============================================================================
-- Migration : 20260734000000_agent_mistakes.sql
-- Purpose   : Add agent_mistakes — one row per discrete, harvested MISTAKE
--             event an agent made (a failed test/build, a QA reject, a run
--             failure, a gate/ceiling park, or a human corrective redirect).
--
-- What this is (and is NOT)
-- ─────────────────────────
-- This is PR 1 of the "Agent Learning + Scoreboard" system: the mistake RECORD
-- only. It is the raw material the later PRs consume — the lesson extractor
-- reads these rows, and the scoreboard counts them. It deliberately does NOT
-- include the lessons table (`agent_learnings`), the review UI, prompt
-- injection, the preferences page, or the leaderboard. Full plan:
-- ~/.claude/plans/jaunty-meandering-liskov.md.
--
-- Rows are DERIVED, not authored: `lib/learning/harvest.server.ts` reconstructs
-- them deterministically from DevPilot's existing signals (`runs.status='failed'`,
-- `run_verifications.exit_code>0`, the QA reject-loop `tickets.retry_count`, and
-- gate/human comments). Harvest runs go-forward on `agent/run.completed` and as a
-- one-time backfill; both paths derive the SAME rows from the SAME stored data,
-- so they converge.
--
-- Dedupe key (the "don't double-count the same event twice" invariant)
-- ────────────────────────────────────────────────────────────────────
-- `dedupe_key` is a deterministic identity for the underlying signal, and
-- `unique (tenant_id, dedupe_key)` is what makes harvest idempotent across
-- retries, replays, the go-forward hook re-firing, and the backfill overlapping
-- the go-forward path. The scheme is `<type>:<source-signal-id>`:
--   • run_failed        → run_failed:<run_id>          (one per failed run)
--   • verification_fail → verification_fail:<run_id>   (run_verifications is
--                         UNIQUE per run_id, so one per failing check)
--   • gate_refusal      → gate_refusal:<comment_id>    (the gate/ceiling comment)
--   • qa_reject         → qa_reject:<producer_run_id>  (the rejected producer run)
--   • human_correction  → human_correction:<comment_id>(the corrective comment)
-- It is a `text` column rather than the suggested `(tenant_id, run_id, type)`
-- index because two of the five types (gate_refusal, human_correction) key on a
-- COMMENT, of which a single run can produce several — `run_id + type` would
-- collapse distinct events. Anchoring each row on the id of its source signal
-- row is exact and re-derivable.
--
-- Attribution (`agent_id` / `role` / `run_id`)
-- ────────────────────────────────────────────
-- The mistake belongs to the PRODUCER whose work failed/was rejected, not the
-- reviewer who caught it — resolved COALESCE(runs.fan_out_role, agents.role)
-- exactly like lib/metrics/project.ts. `agent_id`/`run_id` are nullable because
-- fan-out siblings carry no agent_id and a comment-derived signal is correlated
-- to its producing run by phase/timestamp (comments have no run FK), which can
-- miss. `role` (free text, like project_handoffs.role) is the durable attribution
-- and is always set.
--
-- counts_against_score
-- ────────────────────
-- Only OBJECTIVE failures count toward an agent's future score (verification_fail,
-- qa_reject, run_failed, gate_refusal). A `human_correction` is a preference/
-- lesson signal — the captain changing direction or supplying new information —
-- and is stored with counts_against_score = FALSE so it NEVER lowers a score.
--
-- Security
-- ────────
-- Tenant-scoped with the identical RLS shape as project_handoffs: members SELECT
-- their own rows; INSERT/UPDATE/DELETE denied to JWT roles (engine-authored via
-- the service role, which bypasses RLS). Evidence bodies (`output_tail`, reject
-- reasons, human comments) are UNTRUSTED and are secret/PII-redacted by the
-- harvester (lib/learning/redact.ts) BEFORE they reach this table.
--
-- The three FK pairs (agent_id→agents, ticket_id→tickets, run_id→runs) are all
-- same-tenant, so each gets an assert_tenant_matches_parent trigger below (the
-- 20260732000000 convention). None is cross-tenant, so nothing is added to
-- CROSS_TENANT_BY_DESIGN; the tenant-scope-scan test re-derives these pairs from
-- this migration and would fail if a trigger were missing.
--
-- Execution notes
-- ───────────────
-- One-shot transactional migration; the table is brand new with zero rows, so
-- indexes are plain CREATE INDEX (CONCURRENTLY is illegal inside a transaction).
-- =============================================================================
begin;

create table if not exists public.agent_mistakes (
  -- Identity
  id          uuid        not null default gen_random_uuid()
                primary key,

  -- Tenant isolation (cascade: deleting a tenant reaps its mistake record).
  tenant_id   uuid        not null
                references public.tenants(id) on delete cascade,

  -- The agent config the offending run belonged to. Nullable + set null: a
  -- fan-out sibling carries no agent_id, and losing the agent config must not
  -- lose the mistake record. `role` below is the durable attribution.
  agent_id    uuid        null
                references public.agents(id) on delete set null,

  -- Resolved role slug of the producer: COALESCE(runs.fan_out_role, agents.role).
  -- Free text like comments.author_id / project_handoffs.role — custom
  -- JD-synthesized roles are legal slugs too. Always set (the attribution anchor).
  role        text        not null,

  -- The ticket the mistake happened on. NOT NULL: every mistake here is
  -- ticket-bound work (a ticket-less supervisor/replay run has no board context
  -- to attribute against and is out of scope for this record).
  ticket_id   uuid        not null
                references public.tickets(id) on delete cascade,

  -- The offending producer run. Nullable: a comment-derived signal is correlated
  -- to its run by phase/timestamp and can miss (comments have no run FK); a
  -- deleted run must not delete the mistake (set null).
  run_id      uuid        null
                references public.runs(id) on delete set null,

  -- Closed vocabulary. See the migration header for how each is derived.
  --   verification_fail — run_verifications.exit_code > 0 (failed test/build)
  --   qa_reject         — in_review → in_progress QA reject (retry_count bump)
  --   run_failed        — runs.status = 'failed'
  --   gate_refusal      — a QA/retry-ceiling/safety gate park comment
  --   human_correction  — a human corrective reply on an input_required ticket
  type        text        not null
                constraint chk_agent_mistakes_type
                  check (type in (
                    'verification_fail', 'qa_reject', 'run_failed',
                    'gate_refusal', 'human_correction'
                  )),

  -- Whether this mistake counts toward the agent's score. TRUE for objective
  -- failures; FALSE for human_correction (a redirect is not a mark against the
  -- agent). NOT NULL so the scoreboard never has to guess.
  counts_against_score boolean not null,

  -- Coarse 1..3 severity (1 low / 2 medium / 3 high). smallint per the plan.
  severity    smallint    not null default 1
                constraint chk_agent_mistakes_severity
                  check (severity between 1 and 5),

  -- What went wrong: {command, exitCode, outputTail} for a verification, the
  -- reject/gate reason, the human comment body, etc. All free-text fields are
  -- secret/PII-redacted by the harvester before landing here (principle 6).
  evidence    jsonb       not null default '{}'::jsonb,

  -- How it was fixed (best-effort, nullable): the next run on the ticket + whether
  -- the re-verification landed exit_code=0. The seed the later lesson extractor
  -- uses for the "how it was corrected" half of a lesson.
  corrected_by jsonb      null,

  -- Deterministic identity of the underlying signal — see the header. The whole
  -- dedupe/idempotency mechanism.
  dedupe_key  text        not null
                constraint chk_agent_mistakes_dedupe_nonempty
                  check (length(btrim(dedupe_key)) > 0),

  created_at  timestamptz not null default now(),

  -- One mistake row per underlying signal, per tenant.
  constraint agent_mistakes_dedupe_uniq unique (tenant_id, dedupe_key)
);

comment on table public.agent_mistakes is
  'One row per discrete harvested agent mistake (verification_fail | qa_reject | '
  'run_failed | gate_refusal | human_correction), derived deterministically from '
  'runs / run_verifications / tickets.retry_count / comments by '
  'lib/learning/harvest.server.ts. Attribution is to the PRODUCER '
  '(COALESCE(runs.fan_out_role, agents.role)). counts_against_score is FALSE for '
  'human_correction (a redirect must never lower a score). dedupe_key gives each '
  'row the identity of its source signal so harvest (go-forward + backfill) is '
  'idempotent. Evidence is UNTRUSTED, redacted before insert. Engine-authored: '
  'writes denied to JWT roles, service_role only.';

-- ---------------------------------------------------------------------------
-- Row-Level Security — mirrors public.project_handoffs.
-- ---------------------------------------------------------------------------
alter table public.agent_mistakes enable row level security;

-- SELECT: tenant members see only their own rows.
create policy agent_mistakes_member_read
  on public.agent_mistakes
  for select
  using (tenant_id in (select public.current_user_tenants()));

-- INSERT / UPDATE / DELETE: denied for JWT-authenticated roles. service_role
-- (the harvester, the backfill) bypasses RLS entirely in Supabase.
create policy agent_mistakes_insert_deny
  on public.agent_mistakes
  for insert
  with check (false);

create policy agent_mistakes_update_deny
  on public.agent_mistakes
  for update
  using (false);

create policy agent_mistakes_delete_deny
  on public.agent_mistakes
  for delete
  using (false);

-- ---------------------------------------------------------------------------
-- Indexes
--
-- Index A: the scoreboard read path — "every mistake for this agent config".
create index if not exists idx_agent_mistakes_tenant_agent
  on public.agent_mistakes (tenant_id, agent_id);

-- Index B: the per-role leaderboard read path — "every mistake for this role,
-- by type".
create index if not exists idx_agent_mistakes_tenant_role_type
  on public.agent_mistakes (tenant_id, role, type);

-- Index C: the harvest/extractor read path — "every mistake on this ticket".
create index if not exists idx_agent_mistakes_tenant_ticket
  on public.agent_mistakes (tenant_id, ticket_id);

-- ---------------------------------------------------------------------------
-- Tenant-matches-parent triggers (the 20260732000000 convention).
--
-- agent_mistakes has three FK pointers to tenant-scoped parents, all same-tenant.
-- The tenant-scope-scan test re-derives these pairs from this migration and fails
-- if any trigger is missing; the audit SQL (regenerated by
-- scripts/generate-tenant-parent-audit.ts) audits them too.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_agent_mistakes_agent_id_tenant on public.agent_mistakes;
create trigger trg_agent_mistakes_agent_id_tenant
  before insert or update of tenant_id, agent_id on public.agent_mistakes
  for each row execute function public.assert_tenant_matches_parent('agent_id', 'agents');

drop trigger if exists trg_agent_mistakes_run_id_tenant on public.agent_mistakes;
create trigger trg_agent_mistakes_run_id_tenant
  before insert or update of tenant_id, run_id on public.agent_mistakes
  for each row execute function public.assert_tenant_matches_parent('run_id', 'runs');

drop trigger if exists trg_agent_mistakes_ticket_id_tenant on public.agent_mistakes;
create trigger trg_agent_mistakes_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.agent_mistakes
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

commit;
