-- =============================================================================
-- Migration : 20260727000000_ticket_plan_hold.sql
-- Phase     : 2.5++ - the plan-informed scaffolder's HOLD marker.
--
-- Why a column and not `status = 'backlog'`
-- ─────────────────────────────────────────
-- The first cut of the plan-informed scaffolder treated "held" as "this row is
-- a project_scaffolder sitting in backlog". That predicate is not identity - it
-- is a SHAPE, and three different tickets can wear it:
--
--   1. The genuinely-held row, waiting for its plan commit.
--   2. That same row AFTER it was released and later reset to backlog (a
--      "Discard & restart from dev", a human reset). The sleeping TTL fallback
--      would match it again and release-and-dispatch a second time - a re-run
--      nobody asked for, on a ticket the operator had just deliberately reset.
--   3. A second scaffolder ticket a human deliberately filed from the board.
--
-- `plan_hold` is the identity: TRUE only for the one row the create action
-- parked for a plan, and cleared FOREVER by whichever path releases it. Once
-- false, no release path can ever pick the row up again - which is exactly the
-- "release it once, and only the instance we held" property the whole design
-- rests on.
--
-- It also gives the release its atomic claim. `plan_hold = true` in the
-- UPDATE's WHERE is what makes the plan-commit / TTL-fallback / manual-promote
-- race resolve to exactly one dispatch: the loser matches no row.
--
-- And it is what the `→ ready` gate keys on (lib/board/transitions.ts), so a
-- held scaffolder cannot be promoted out from under its own plan by a board
-- drag OR by the backlog drain - both of which reach `ready` through that one
-- seam, and neither of which knows anything about plans.
--
-- Default FALSE is the meaningful value for every existing row and for every
-- no-plan create: nothing is held, so nothing behaves differently.
--
-- Deliberately NOT here: a `unique (project_id) where requested_role =
-- 'project_scaffolder'` index. See the PR discussion - a human may legitimately
-- file a re-scaffold ticket from the board today (the New-ticket dialog exposes
-- the full role catalog), so that index would forbid an existing operator
-- action, and it would fail to APPLY on any database that already carries two
-- scaffolder rows for one project. The invariant that actually needed enforcing
-- is "no AUTOMATED path creates a second scaffolder", which is closed in the
-- plan flow itself (roles are re-clamped at commit and on proposed-ticket edit).
-- =============================================================================

begin;

alter table public.tickets
  add column if not exists plan_hold boolean not null default false;

comment on column public.tickets.plan_hold is
  'TRUE only while this ticket is the project_scaffolder row parked for a pending plan commit. Set at insert by createProjectWithNewRepoAction (plan mode only); cleared permanently by the ONE release seam (releaseScaffolder), which claims on it. While true, `→ ready` is refused for every actor - the release is the only authorized promoter.';

-- The release/fallback lookup is "this project's held row". Partial: the column
-- is false for every row but the one in flight, so the index stays tiny.
create index if not exists tickets_plan_hold_idx
  on public.tickets(project_id)
  where plan_hold;

commit;
