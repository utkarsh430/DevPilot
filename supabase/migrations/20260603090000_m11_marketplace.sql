-- =============================================================================
-- Migration : 20260603060000_m11_marketplace.sql
-- Phase 1 / M11 — Skill marketplace + tool marketplace (read-only verified
-- first-party bundles only; no user-submission flow in Phase 1).
--
-- Purpose
-- ────────
-- 1. Extend the existing `skills` table with `installed_from_skill_id` so we
--    can trace clones back to their public source. Add `targets` for the
--    runtime relevance pass (which roles this skill is meant for) and
--    `triggers` for keyword-style hints.
-- 2. Create `tool_packages` — mirror of `skills` for MCP-style tool bundles.
--    Phase 1 ships the storage + RLS only; runtime wiring is M12+.
-- 3. Tighten RLS on public rows (tenant_id IS NULL): readable by everyone,
--    writable ONLY by service_role. The locked Phase 1 marketplace governance
--    decision (docs/ACE_PHASE1_PLAN.md "Locked decisions") forbids user
--    submissions, so the existing `for all using (tenant_id in ...)` policy
--    is replaced with one that explicitly excludes public rows from member
--    writes.
-- 4. Seed 12 first-party verified skills — one or two per built-in role,
--    drawn from the examples in the M11 spec.
--
-- Idempotency
-- ───────────
-- Forward-only. The `add column if not exists` guards make re-running safe.
-- The seed `insert ... on conflict (tenant_id, name, version) do nothing`
-- relies on the existing unique constraint and is idempotent per row.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Skills table extensions
-- ---------------------------------------------------------------------------

alter table public.skills
  add column if not exists installed_from_skill_id uuid
    references public.skills(id) on delete set null;

-- `targets` is the role allow-list for the runtime relevance pass. Empty
-- array = "applies to any role"; non-empty = "only consider this skill for
-- agents whose role slug is in the list". Stored as jsonb so we can later
-- evolve to richer matching criteria (model tier, runner policy, etc.)
-- without another migration.
alter table public.skills
  add column if not exists targets jsonb not null default '[]'::jsonb;

-- `triggers` is a keyword list the Haiku relevance pass uses as a cheap
-- pre-filter before paying for the LLM call. Optional; empty array means
-- "rely on the body + role only".
alter table public.skills
  add column if not exists triggers jsonb not null default '[]'::jsonb;

create index if not exists skills_installed_from_idx
  on public.skills(installed_from_skill_id);

-- Public-skill lookup index (the marketplace listing query).
create index if not exists skills_public_idx
  on public.skills(name) where tenant_id is null;

-- ---------------------------------------------------------------------------
-- 2. tool_packages — mirrors skills shape for MCP-style tool bundles.
-- ---------------------------------------------------------------------------

create table if not exists public.tool_packages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade, -- null = public/marketplace
  name        text not null,
  version     text not null,
  manifest    jsonb not null,                 -- declared MCP server URL, auth ref, tool list
  body        text not null default '',       -- optional README/usage notes
  installed_from_tool_package_id uuid
    references public.tool_packages(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (tenant_id, name, version)
);

create index if not exists tool_packages_tenant_idx
  on public.tool_packages(tenant_id);
create index if not exists tool_packages_installed_from_idx
  on public.tool_packages(installed_from_tool_package_id);
create index if not exists tool_packages_public_idx
  on public.tool_packages(name) where tenant_id is null;

alter table public.tool_packages enable row level security;

-- ---------------------------------------------------------------------------
-- 3. RLS — public rows are READ-ONLY for everyone but service_role.
-- ---------------------------------------------------------------------------
-- Existing core.sql policies:
--   skills_read           — select where tenant_id is null OR tenant member
--   skills_member_write   — for all on tenant_id in current_user_tenants()
-- The second policy already excludes public rows (NULL tenant_id is not in
-- the current_user_tenants() set), so authenticated users can't UPDATE or
-- DELETE public rows. We make this guarantee explicit with separate INSERT /
-- UPDATE / DELETE policies that re-state the rule, and drop the catch-all
-- `for all` policy.

drop policy if exists skills_member_write on public.skills;

create policy skills_member_insert on public.skills
  for insert
  with check (
    tenant_id is not null
    and tenant_id in (select public.current_user_tenants())
  );

create policy skills_member_update on public.skills
  for update
  using (
    tenant_id is not null
    and tenant_id in (select public.current_user_tenants())
  )
  with check (
    tenant_id is not null
    and tenant_id in (select public.current_user_tenants())
  );

create policy skills_member_delete on public.skills
  for delete
  using (
    tenant_id is not null
    and tenant_id in (select public.current_user_tenants())
  );

-- tool_packages — same shape.
create policy tool_packages_read on public.tool_packages
  for select using (
    tenant_id is null or tenant_id in (select public.current_user_tenants())
  );

create policy tool_packages_member_insert on public.tool_packages
  for insert
  with check (
    tenant_id is not null
    and tenant_id in (select public.current_user_tenants())
  );

create policy tool_packages_member_update on public.tool_packages
  for update
  using (
    tenant_id is not null
    and tenant_id in (select public.current_user_tenants())
  )
  with check (
    tenant_id is not null
    and tenant_id in (select public.current_user_tenants())
  );

create policy tool_packages_member_delete on public.tool_packages
  for delete
  using (
    tenant_id is not null
    and tenant_id in (select public.current_user_tenants())
  );

-- ---------------------------------------------------------------------------
-- 4. Seed 12 first-party verified skills (tenant_id = NULL).
-- ---------------------------------------------------------------------------
-- Each skill body is a short, well-scoped prompt fragment that gets merged
-- into a role's systemPrompt at dispatch time. Bodies are deliberately
-- compact (<800 chars) so the relevance pass can keep its budget low.

insert into public.skills (tenant_id, name, version, manifest, targets, triggers, body)
values
  (
    null,
    'RFC writer',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Drafts a one-page RFC for a proposed change.',
      'author', 'ACE first-party',
      'verified', true
    ),
    '["engineer","techwriter","pm"]'::jsonb,
    '["rfc","design doc","proposal","spec","architecture"]'::jsonb,
    'SKILL — RFC writer:'
    || E'\nWhen the ticket calls for a design proposal, structure your output as a one-page RFC with these headings:'
    || E'\n  1. Summary (2-3 sentences)'
    || E'\n  2. Motivation (the problem + why now)'
    || E'\n  3. Proposal (the actual change, concrete enough to implement)'
    || E'\n  4. Alternatives considered (at least two, with one-line trade-offs)'
    || E'\n  5. Rollout (migration / flag / observability plan)'
    || E'\n  6. Open questions (anything that needs a human decision)'
    || E'\nKeep the whole RFC under ~600 words. Prefer concrete examples over abstract claims.'
  ),
  (
    null,
    'OWASP Top 10 checklist',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Quick OWASP Top 10 (2021) review pass for code changes.',
      'author', 'ACE first-party',
      'verified', true
    ),
    '["security","engineer"]'::jsonb,
    '["security","auth","sql","xss","csrf","injection","secret"]'::jsonb,
    'SKILL — OWASP Top 10 checklist (2021):'
    || E'\nFor each change, walk this list and call out any hit:'
    || E'\n  A01 Broken access control — does any new endpoint skip tenant/role checks?'
    || E'\n  A02 Cryptographic failures — secrets in code/logs? weak hashing?'
    || E'\n  A03 Injection — string-concat SQL, shell, or template paths?'
    || E'\n  A04 Insecure design — missing rate limits, no abuse model?'
    || E'\n  A05 Security misconfiguration — debug flags, permissive CORS?'
    || E'\n  A06 Vulnerable components — new deps with known CVEs?'
    || E'\n  A07 Auth failures — predictable tokens, no lockout?'
    || E'\n  A08 Integrity failures — unsigned downloads, deserialisation?'
    || E'\n  A09 Logging failures — does the failure path actually log?'
    || E'\n  A10 SSRF — any URL fetched from user input without an allow-list?'
    || E'\nReport hits as `[Axx] <one-line finding>` lines; absence is fine to state as "no findings".'
  ),
  (
    null,
    'PostgreSQL index advisor',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Suggests indexes for slow Postgres queries.',
      'author', 'ACE first-party',
      'verified', true
    ),
    '["dataeng","engineer"]'::jsonb,
    '["postgres","index","slow query","explain","seq scan"]'::jsonb,
    'SKILL — PostgreSQL index advisor:'
    || E'\nWhen analysing a slow query:'
    || E'\n  1. Reproduce against EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT).'
    || E'\n  2. Identify the dominant cost node (Seq Scan on large table, Nested Loop with high rows, Sort spilling to disk).'
    || E'\n  3. Propose ONE index per finding, naming columns in selectivity order (most selective first).'
    || E'\n  4. Prefer partial indexes when the predicate is constant (e.g. `where status = ''ready''`).'
    || E'\n  5. State the expected cost reduction (rows × cost factor) and the write-amplification trade-off.'
    || E'\n  6. Never suggest dropping an index you didn''t introduce in this ticket.'
  ),
  (
    null,
    'WCAG 2.1 AA quick audit',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Fast accessibility audit pass against WCAG 2.1 AA.',
      'author', 'ACE first-party',
      'verified', true
    ),
    '["designer","engineer"]'::jsonb,
    '["accessibility","a11y","wcag","aria","contrast","keyboard"]'::jsonb,
    'SKILL — WCAG 2.1 AA quick audit:'
    || E'\nWalk the change against these checkpoints and flag failures:'
    || E'\n  • 1.4.3 Contrast — text ≥ 4.5:1, large text ≥ 3:1.'
    || E'\n  • 1.4.11 Non-text contrast — UI components ≥ 3:1 against background.'
    || E'\n  • 2.1.1 Keyboard — every interactive control reachable + operable via keyboard.'
    || E'\n  • 2.4.7 Focus visible — focus ring distinguishable from hover.'
    || E'\n  • 3.3.2 Labels or instructions — every input has a programmatic label.'
    || E'\n  • 4.1.2 Name, role, value — custom widgets carry correct ARIA.'
    || E'\nFor each failure: state the checkpoint, the offending selector/component, and the smallest fix.'
  ),
  (
    null,
    'K8s rollback runbook',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Safe rollback procedure for a Kubernetes Deployment.',
      'author', 'ACE first-party',
      'verified', true
    ),
    '["devops"]'::jsonb,
    '["k8s","kubernetes","rollback","deployment","incident"]'::jsonb,
    'SKILL — K8s rollback runbook:'
    || E'\nWhen the ticket calls for rolling back a Deployment:'
    || E'\n  1. Confirm the impact window (which Deployment, which revision was bad, blast radius).'
    || E'\n  2. Capture state: `kubectl rollout history deployment/<name>` and `kubectl get pods -l app=<name> -o wide`.'
    || E'\n  3. Roll back: `kubectl rollout undo deployment/<name> --to-revision=<good>`.'
    || E'\n  4. Watch: `kubectl rollout status deployment/<name> --timeout=300s`.'
    || E'\n  5. Verify SLI: error rate < 1% over the next 5 min on the relevant dashboard.'
    || E'\n  6. Postmortem: file a follow-up ticket describing what was rolled back, why, and what gates would have prevented it.'
    || E'\nNever roll back without first capturing the bad revision''s logs (`kubectl logs --previous`).'
  ),
  (
    null,
    'Conventional commits',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Enforces conventional commit message format.',
      'author', 'ACE first-party',
      'verified', true
    ),
    '["engineer"]'::jsonb,
    '["commit","git","changelog"]'::jsonb,
    'SKILL — Conventional commits:'
    || E'\nEvery commit message MUST follow `<type>(<scope>): <subject>` where type is one of'
    || E'\n  feat | fix | refactor | docs | test | chore | perf | ci'
    || E'\nSubject: imperative, lower-case, ≤72 chars, no trailing period.'
    || E'\nBody (optional): wrap at 72 chars; explain the WHY, not the WHAT.'
    || E'\nBreaking change: append `BREAKING CHANGE: <description>` in the footer.'
  ),
  (
    null,
    'Test pyramid reviewer',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Pushes back when tests skew too integration-heavy or too unit-heavy.',
      'author', 'ACE first-party',
      'verified', true
    ),
    '["qa","engineer"]'::jsonb,
    '["test","coverage","unit","integration","e2e"]'::jsonb,
    'SKILL — Test pyramid reviewer:'
    || E'\nWhen reviewing test additions, classify each new test:'
    || E'\n  • Unit (pure, <50ms, no I/O)'
    || E'\n  • Integration (DB or HTTP, <500ms each)'
    || E'\n  • E2E (full stack, browser or full process)'
    || E'\nFlag the change if:'
    || E'\n  - >50% of new tests are E2E (they will rot fastest)'
    || E'\n  - <30% are unit tests (too slow a feedback loop)'
    || E'\n  - Any new behavior has zero unit coverage and only an E2E test.'
    || E'\nFor each flag, suggest the smaller-scope test that would cover the same behavior.'
  ),
  (
    null,
    'API docs from handler',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Generates OpenAPI-flavored docs for a route handler.',
      'author', 'ACE first-party',
      'verified', true
    ),
    '["techwriter","engineer"]'::jsonb,
    '["api","openapi","docs","endpoint","route"]'::jsonb,
    'SKILL — API docs from handler:'
    || E'\nFor each new or changed route, produce a section:'
    || E'\n  ## <METHOD> <path>'
    || E'\n  <one-sentence purpose>'
    || E'\n'
    || E'\n  **Auth:** <bearer | session | public>'
    || E'\n  **Request body:** <schema or "none">'
    || E'\n  **Response 2xx:** <schema>'
    || E'\n  **Errors:** <list of (status, condition) pairs>'
    || E'\n  **Example:** <one curl + one response snippet>'
    || E'\nDerive every field from the actual handler source — do not invent fields.'
  ),
  (
    null,
    'PM ticket refiner',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Refines a vague ticket into clear description + acceptance criteria.',
      'author', 'ACE first-party',
      'verified', true
    ),
    '["pm"]'::jsonb,
    '["refine","acceptance criteria","grooming","unclear","vague"]'::jsonb,
    'SKILL — PM ticket refiner:'
    || E'\nWhen a ticket is vague, refine it into:'
    || E'\n  Description: 1-2 paragraphs in active voice, user-perspective ("As an operator, I want…").'
    || E'\n  Acceptance criteria: 3-6 bullets, each testable, each starting with a verb ("returns…", "renders…", "fails when…").'
    || E'\n  Out-of-scope: explicit list of adjacent things this ticket DOES NOT cover.'
    || E'\nIf a critical fact is missing (target user, success metric, environment), move the ticket to `input_required` and ask exactly the missing question — never invent the answer.'
  ),
  (
    null,
    'SQL safety checks',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Pre-flight checks before running a generated SQL query.',
      'author', 'ACE first-party',
      'verified', true
    ),
    '["dataeng"]'::jsonb,
    '["sql","query","read-only","delete","update"]'::jsonb,
    'SKILL — SQL safety checks:'
    || E'\nBefore executing any SQL via ace_query_db:'
    || E'\n  1. Confirm the statement begins with SELECT (or WITH … SELECT). Refuse DDL/DML.'
    || E'\n  2. Confirm every referenced table is in the data source allow-list.'
    || E'\n  3. Confirm a LIMIT clause exists. If not, add `LIMIT 1000`.'
    || E'\n  4. Reject any query with subqueries that lack a LIMIT and could fan out (e.g. `… IN (SELECT id FROM huge_table)`).'
    || E'\nState the safety verdict in the comment before showing results.'
  ),
  (
    null,
    'QA acceptance verifier',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Maps each acceptance criterion to a concrete observable.',
      'author', 'ACE first-party',
      'verified', true
    ),
    '["qa"]'::jsonb,
    '["qa","acceptance","verify","review"]'::jsonb,
    'SKILL — QA acceptance verifier:'
    || E'\nFor each acceptance criterion on the ticket:'
    || E'\n  1. State the criterion verbatim.'
    || E'\n  2. State the OBSERVABLE you used to verify it (file path + line, test name + result, command output, screenshot).'
    || E'\n  3. State PASS / FAIL.'
    || E'\nIf any FAIL: reject the ticket with a one-line reason per failing criterion.'
    || E'\nIf any criterion lacks an observable: also reject — "no test, no pass".'
  ),
  (
    null,
    'Designer empty-state checklist',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Ensures every new screen handles empty/loading/error states.',
      'author', 'ACE first-party',
      'verified', true
    ),
    '["designer","engineer"]'::jsonb,
    '["empty state","loading","error","ux","skeleton"]'::jsonb,
    'SKILL — Designer empty-state checklist:'
    || E'\nEvery new screen / list view must define:'
    || E'\n  • Empty: what the user sees on zero records, and the one suggested next action.'
    || E'\n  • Loading: skeleton or shimmer that matches the populated layout shape.'
    || E'\n  • Error: short message + retry affordance + link to support context.'
    || E'\n  • First-success: micro-celebration (toast or inline animation) on first happy-path completion.'
    || E'\nFlag any screen that ships with only the populated state.'
  )
on conflict (tenant_id, name, version) do nothing;

commit;
