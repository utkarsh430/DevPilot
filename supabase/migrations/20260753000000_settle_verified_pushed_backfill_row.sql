-- Settle the ONE `landed_sha = 'backfill'` push row whose branch was VERIFIED,
-- against the live remote, to be on `origin` at exactly the sha the workspace
-- holds. The other three sentinel rows are deliberately left visible; §4 says
-- why, individually.
--
-- ─── the sentinel justifies nothing, and this migration is the proof ──────
--
-- `20260715000000` §6 wrote `landed_sha = 'backfill'` to EVERY `done` ticket
-- with a null sha, in one statement, so that flipping `auto_land_enabled` on
-- would not make the whole backlog read as unlanded. Its own header states the
-- position plainly: "The sha is unknowable retroactively (the work was landed
-- by hand, through PRs we have no record of), so we stamp the sentinel
-- `backfill` rather than invent one."
--
-- So the sentinel ASSUMED; it did not verify. It read no branch, contacted no
-- remote, and - decisively for this question - never looked at `pending_pushes`
-- at all. It is a statement about what the operator probably did before
-- auto-land existed, applied blanket. `20260749000000` (#156) and
-- `20260750000000` (#157) both excluded it on exactly that reasoning, and both
-- were right.
--
-- The four surviving rows demonstrate the point better than any argument. All
-- four carry the identical sentinel and - because §6 stamped them in one
-- statement - an `integrated_at` identical to the MILLISECOND
-- (2026-07-13 01:54:35.108). Yet checked individually they are in four
-- materially different states, from "fully on the remote" to "holds three
-- commits that exist nowhere else on earth". The sentinel has no discriminating
-- power whatsoever. It can never justify settling a push row, and nothing built
-- later should try to make it.
--
-- What CAN justify one is evidence gathered where the evidence actually lives.
--
-- ─── 1. what `pushed_at` means, and therefore what must be proven ─────────
--
-- Settling a row sets `pushed_at`, which asserts THE BRANCH REACHED `origin`
-- and - via `decideWorkspaceReap` - releases the engine-side guard that stops
-- the workspace being deleted. A wrongly-settled row is a route to deleting the
-- only copy of a commit, so the bar is "prove it", and the failure direction is
-- "leave it visible".
--
-- ─── 2. the evidence, and how to re-check it ──────────────────────────────
--
-- SQL cannot resolve a git ref - the wall `20260745000000` hit, and the reason
-- #157 had to find a positional witness instead. But the question is checkable
-- OUT OF BAND, and for this row it was, on 2026-07-19, two independent ways:
--
--   FROM THE REMOTE (GitHub API, `repos/utkarsh430/cert-radar`):
--     • branch `ace/scan-trigger-on-demand-api-route-cron-scheduler-per-domain`
--       EXISTS on origin, tip = 50b7452f39b992fc7937f1c23fc89141b7040ad6.
--     • the workspace's HEAD is that SAME sha, exactly.
--     • the workspace's only other local branch, `main` = 11658aa63081eed82
--       79a789bb34562aaf8f5ba2a, is likewise exactly the live `origin/main` tip.
--       Both branches were checked; neither is inferred from the other.
--
--   FROM THE WORKSPACE (`~/.ace/workspaces/ecb95dcf-…`, still present on this
--   host): `git log --branches --not --remotes` returns EMPTY - the exact
--   predicate the runner's own `cleanupWorkspace` reap guard uses. The tree is
--   clean and there are no stashes.
--
-- The two agree, and they fail differently: the local predicate could be fooled
-- by a stale remote-tracking ref, which is precisely why every branch tip was
-- also confirmed against the live remote rather than against `refs/remotes`.
--
-- Note this ticket's work is NOT on `dev` (the tip is 3 commits AHEAD of it).
-- That is a genuine, separate fact about LANDING, which `deriveLandingState`
-- renders on the card. It is not what `pushed_at` is about and must not be
-- conflated: the branch reached origin, which is the whole claim made here.
--
-- ─── 3. why the timestamp is the tip commit's date ────────────────────────
--
-- `now()` would date a 2026-07 push to whenever this migration is applied - the
-- error #157 called out. There is no queue row to read an adjudication time
-- from (none of these four tickets has one; they predate auto-land entirely).
-- The tip commit's committer date, 2026-07-07T07:44:39Z, is the tightest
-- anchor the evidence actually supports: the push necessarily happened at or
-- AFTER the commit it carried came into being. It therefore UNDER-states, which
-- is the safe direction and invents nothing. The row's own `updated_at`
-- (07:32:04) is 12 minutes EARLIER than that commit, so it cannot be the push
-- time and is not used.
--
-- ─── 4. the three rows this deliberately does NOT settle ──────────────────
--
-- Each was checked individually. None is excluded for want of effort.
--
--   ai-kids-meal-plan DevPilot-18 (push 72c425db…, workspace 5b7b5e15…):
--     REFUSED ON POSITIVE EVIDENCE OF LOSS. The workspace is present and holds
--     THREE commits - including "7-day LLM meal plan generation" and
--     "age-adaptation engine" - none of which exist on GitHub at all (each sha
--     queried individually; a known-good sha and a fabricated one were run as
--     controls, so the absence is real and not an API artefact). Its branch is
--     not on origin either. This row is the badge doing its job. Settling it
--     would release the reap guard over the only copy of real feature work.
--
--   ai-kids-meal-plan DevPilot-7 (push 9f54c88e…): its branch DOES exist on
--     origin, but the workspace has been deleted - so there is no HEAD left to
--     compare against that branch tip. "A branch of this name reached origin"
--     is not the same claim as "the commits this row represents reached
--     origin", and the row cannot be settled on the weaker one. Unknowable, so
--     left.
--
--   ai-kids-meal-plan DevPilot-10 (push a946ead0…): branch
--     `ace/app-shell-navigation-and-auth-guarded-layout` is NOT on origin, and
--     the workspace is gone. This is the worst case, and it is worth saying out
--     loud rather than tidying away: whatever that ticket produced is most
--     likely already lost. Settling it would stamp `pushed_at` - a claim that
--     is affirmatively FALSE - purely to clear a badge entry. The row stays,
--     because the badge is the only remaining trace.
--
-- ─── 5. scope: pinned to one row, and every corroborating fact re-asserted ─
--
-- The evidence is external to the database, so the predicate cannot re-derive
-- it and does not pretend to. It names the row and then re-asserts every fact
-- that was true when the evidence was taken - branch, workspace path, ticket
-- status, the sentinel, tenant agreement. If ANY of them has since changed, the
-- row is no longer the row that was verified, the predicate matches nothing,
-- and the badge entry survives. Idempotent for the same reason: once
-- `pushed_at` is set, clause 3 excludes it forever.
--
-- The tenant is pinned TWICE, and the two clauses do different jobs. This is a
-- service-role repair with RLS off, so they are the whole boundary.
--
--   • `p.tenant_id = t.tenant_id` is the AGREEMENT clause: our row's
--     justification has to come from our ticket. It is the clause #156 and #157
--     both carry - and on its own it is NOT sufficient here, which the accept
--     script caught: a push and a ticket BOTH belonging to some other tenant
--     agree with each other perfectly well, and settled. It is also the one
--     clause with no control behind it, because it is unfalsifiable by
--     construction: `assert_tenant_matches_parent` refuses to WRITE a
--     mismatched pair at all (verified directly against a live Postgres -
--     "cross-tenant write refused: pending_pushes.ticket_id … belongs to tenant
--     …"). Kept as defence in depth, since that trigger is the thing being
--     relied on and a clause costs nothing; recorded as unfalsifiable rather
--     than presented as tested.
--
--   • the literal `p.tenant_id = 'b9aacf58-…'` is what actually scopes this. A
--     row id is a uuid and in practice unique, but "in practice unique" is not
--     the property to rest a reap-guard release on - a restored or shared
--     database is exactly the scenario that produced the foreign-`workspace_path`
--     incident.
--
-- Every other clause has a control that falsifies it; all seven were
-- mutation-verified by neutralising each to a tautology and confirming the
-- accept script turns red.
--
-- ─── 6. live dry-run, before applying ─────────────────────────────────────
--
-- Run against PRODUCTION on 2026-07-19 inside a rolled-back transaction, this
-- predicate selected exactly 1 row and left 5 unsettled (the three above, plus
-- the two `input_required` rows #157 also correctly declined). Stated because
-- #156 claimed four rows from a fixture and settled zero in production.

begin;

do $$
declare
  moved     integer;
  remaining integer;
begin
  with repaired as (
    update public.pending_pushes p
       set pushed_at  = timestamptz '2026-07-07T07:44:39Z',
           updated_at = now()
      from public.tickets t
     where p.id             = 'c5f766c0-482d-4c06-b422-7cea376bbc0a'
       and t.id             = p.ticket_id
       and p.tenant_id      = 'b9aacf58-fd32-418a-96d3-f85bbcc2e991'
       and p.tenant_id      = t.tenant_id
       and p.pushed_at     is null
       and p.branch         = 'ace/scan-trigger-on-demand-api-route-cron-scheduler-per-domain'
       and p.workspace_path = '/Users/utkarsh430/.ace/workspaces/ecb95dcf-533a-4770-9499-c3bcc8630828'
       and t.status         = 'done'
       and t.landed_sha     = 'backfill'
    returning p.id
  )
  select count(*) into moved from repaired;

  select count(*) into remaining from public.pending_pushes where pushed_at is null;

  raise notice 'settled % row(s); % unsettled row(s) remain', moved, remaining;
end;
$$;

commit;
