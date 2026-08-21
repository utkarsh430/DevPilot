-- =============================================================================
-- Migration : 20260742000000_vercel_deployment_records.sql
-- Purpose   : PR 4 of the Vercel deployment feature — the fields a deployment
--             record needs once DevPilot actually triggers, polls and records
--             deployments, plus the fields PR 5 (rollback) will read.
--             Plan: data/devpilot-vercel-deploy-plan-v1/report.md §10 (PR 4/PR 5)
--             and data/devpilot-vercel-rollback-check-r2/report.md §8.
--
-- ── Why this migration exists at all ──────────────────────────────────────
-- `project_deployments` shipped in 20260740000000 with the columns PR 2 could
-- justify: which deployment, which target, what state, which URL, which commit,
-- and the audit pair. Writing the first row (this PR) and promoting a previous
-- row (PR 5) each need more than that, and the brief for this PR is explicit
-- that PR 5 must not have to migrate again. So both sets land here.
--
-- ── The PR-4 columns: making a FAILED deploy actionable ───────────────────
-- A build failure that renders as "Deploy failed" with no route to the log is a
-- dead end — the operator has to go find the deployment in Vercel's dashboard by
-- hand, which is exactly the diagnosis-failure the whole feature exists to end.
-- `inspector_url` is Vercel's own deep link to the build log for THIS
-- deployment, returned in the create response, so the failure surface is one
-- click from the cause. `error_message` carries Vercel's reason (bounded and
-- scrubbed app-side) so the card can say WHY without a second API call.
--
-- `branch` is stored because a deployment's ref is not recoverable from
-- `commit_sha` alone once the branch moves on, and "which branch went live" is
-- the first question asked about a surprise production deploy.
--
-- `polled_at` / `ready_at` separate "when did DevPilot last look" from "when did
-- the build finish". Without the first, a poller that dies mid-flight leaves a
-- row stuck at BUILDING that is indistinguishable from a build genuinely still
-- running an hour later.
--
-- ── The PR-5 columns: the promotion inventory ─────────────────────────────
-- PR 5 promotes a previous deployment back to production. The rollback scout
-- (devpilot-vercel-rollback-check-r2 §6c) established that **Vercel refuses to
-- promote a deployment that has already been promoted** — it steers you to
-- rollback instead. So "has this one already been promoted?" is not a nicety: it
-- is the difference between offering a control that works and one that returns a
-- 409 the operator cannot interpret.
--
--   became_production_at — when this deployment started serving production. PR 5
--     orders the eligible list by it, and it is the only way to answer "what was
--     live before the current one" from DevPilot's own records rather than a
--     Vercel round trip.
--   promoted_at / promoted_by — whether it has been promoted, and by whom.
--     Nullable and NULL for every row this PR writes: a deployment that became
--     production by being BUILT for production was never *promoted*, and
--     conflating the two would make PR 5 hide a perfectly eligible target.
--
-- These are DevPilot's own record, deliberately NOT a mirror of Vercel's
-- eligibility. PR 5 must still ask Vercel for the eligible set
-- (`GET /v7/deployments?rollbackCandidate=true`) rather than recompute it here —
-- Vercel owns that rule and a stale local mirror of it would offer targets that
-- fail. What these columns give PR 5 is the DEVPILOT-side history: who deployed
-- what, when it went live, and whether we have already promoted it.
--
-- ── What this migration deliberately does NOT touch ───────────────────────
-- No `projects` column is added, so `PROJECT_COLUMNS` (lib/projects/load.ts) and
-- `shell_bootstrap()`'s projects select list stay in sync with no rewrite —
-- 20260740000000 already added `vercel_production_url`, which is the only
-- projects column PR 4 writes. (That sync trap is real; it is simply not
-- triggered here. Adding a projects column in a later PR means rewriting the
-- function again, in that PR's own migration.)
--
-- No new tenant-parent FK pair either: `promoted_by` points at `auth.users`,
-- which carries no `tenant_id` and is therefore outside the
-- `assert_tenant_matches_parent` class — exactly like the existing
-- `triggered_by`. The two in-class pointers (`project_id`, `ticket_id`) already
-- have their triggers from 20260740000000, so
-- lib/security/__tests__/tenant-scope-scan.test.ts and
-- audit-tenant-parent-mismatches.sql need no regeneration.
--
-- Execution notes: additive and idempotent (`add column if not exists`); the
-- table is small and young, so a plain transactional migration is fine.
-- =============================================================================
begin;

alter table public.project_deployments
  -- The git ref that was deployed. Not derivable from commit_sha after the fact.
  add column if not exists branch text,

  -- Vercel's deep link to THIS deployment's build log. The whole of "surface
  -- failure usefully" hangs off this column.
  add column if not exists inspector_url text,

  -- Vercel's failure reason, bounded and scrubbed before it is written.
  add column if not exists error_message text,

  -- When the build reached a terminal state, per Vercel.
  add column if not exists ready_at timestamptz,

  -- When DevPilot last read this deployment's state. Distinguishes "still
  -- building" from "the poller died and nobody has looked since".
  add column if not exists polled_at timestamptz,

  -- ---- PR 5's inventory ----------------------------------------------------

  -- When this deployment began serving production. NULL for a preview, and for a
  -- production build that never reached READY.
  add column if not exists became_production_at timestamptz,

  -- Whether this deployment has been PROMOTED (as opposed to having been built
  -- for production in the first place). Vercel refuses to promote an
  -- already-promoted deployment, so PR 5 reads this to avoid offering a target
  -- that will 409. NULL for every row PR 4 writes.
  add column if not exists promoted_at timestamptz,
  add column if not exists promoted_by uuid references auth.users(id) on delete set null;

comment on column public.project_deployments.inspector_url is
  'Vercel''s build-log deep link for this deployment. A failed deploy with no '
  'route to the log is a dead end for the operator, so this is load-bearing '
  'rather than decorative.';
comment on column public.project_deployments.became_production_at is
  'When this deployment started serving production. PR 5 orders rollback '
  'targets by it. NULL for previews and for production builds that never '
  'reached READY.';
comment on column public.project_deployments.promoted_at is
  'Set when DevPilot PROMOTED this deployment back to production (PR 5). NULL '
  'means it was never promoted — including for a deployment that became '
  'production by being built for it. Vercel refuses to promote an '
  'already-promoted deployment, so this distinguishes an offerable rollback '
  'target from one that would 409.';

-- PR 5's target query: the production deployments for a project, newest-live
-- first. Partial on `target = 'production'` because previews are never rollback
-- candidates and are the bulk of the rows.
create index if not exists idx_project_deployments_production_history
  on public.project_deployments (tenant_id, project_id, became_production_at desc)
  where target = 'production';

commit;
