-- Settle the `pending_pushes` row of a ticket whose branch was PROVABLY pushed
-- to `origin` but which never landed anything.
--
-- The full argument — including why the justification is DELIVERY rather than
-- emptiness, and why re-running the live `closeNothingToLand` path cannot work
-- for this row — lives in `apps/web/lib/integration/nothing-to-land-settle.ts`,
-- whose `decideNothingToLandSettle` is the same rule in TypeScript. A drift
-- test binds the two, so this file and that module cannot disagree about scope.
-- The short version follows.
--
-- ─── the row ──────────────────────────────────────────────────────────────
--
-- PR #156's repair (`20260749000000`) settles on "the work is on the
-- integration branch, so nothing is owed to any remote", read off
-- `tickets.landed_sha`. One row is left over, and it keeps the /changes badge
-- at 1: DevPilot-7, an end-to-end QA pass, `status = done`, `landed_sha = NULL`.
-- Nothing ever landed for it because it was review-only and wrote no code.
-- #156's rule is correct and is NOT loosened here — that predicate is what
-- keeps a genuinely-unpushed branch out of scope, and `pushed_at` non-null
-- releases the data-loss reap guard (`decideWorkspaceReap`).
--
-- ─── the justification, which is not "there are no commits" ───────────────
--
-- "The branch is level with dev" is true and unusable: SQL cannot resolve a git
-- ref. This row's own `unpushed_count` is 8 — `getUnpushedCommits` falls back
-- to every commit reachable from HEAD when `origin/<branch>` is absent — so
-- emptiness is precisely the fact the database cannot establish.
--
-- The justification used instead is that THE BRANCH REACHED `origin`, which is
-- exactly what `pushed_at` records. It is the stronger claim: even if those 8
-- commits are real, they are on the remote, so releasing the reap guard
-- destroys nothing. Safety here comes from DELIVERY, not from ABSENCE.
--
-- The proof is the land worker's ordering. `rebaseAndPush` runs BEFORE any
-- pull-request call; a conflict returns early, and any push failure throws,
-- with the message written verbatim to `last_error`. Its one other route to
-- success — "workspace unusable but already on the remote" — is gated on
-- `pushedAt` being NON-null, so it is unreachable for a row with
-- `pushed_at IS NULL`. Therefore a failure raised at the PULL-REQUEST step
-- proves `git push` ran and succeeded. `pushed_at` stayed NULL only because
-- the settle lived on the `stampLanded` paths and this row never reached one.
--
-- `20260745000000` already established the failure was raised there: it moved
-- rows to `cancelled` with a `nothing to land: ` prefix ONLY when they carried
-- `last_error LIKE 'GitHub 422 on /repos/%/pulls: Validation Failed'` with
-- `pr_number IS NULL` and `merge_sha IS NULL`. That string shape is written by
-- `throwFromResponse` for a `POST /repos/…/pulls`, i.e. it is a positional
-- witness. No live code path writes that prefix: `land-policy` cancels with
-- "ticket has no branch with work to land", and the live nothing-to-land path
-- stamps a `landed_sha` and moves the queue row to `landed` — both excluded
-- below. The one 422 shape that would have been dangerous ("Field 'head' is
-- invalid", the branch never reached the remote) is unreachable by the same
-- ordering argument: that branch throws at the push and never reaches the
-- pull-request call.
--
-- ─── scope: nine clauses, all required, all conjunctive ───────────────────
--
--   1. p.pushed_at IS NULL          only an unsettled row is in scope.
--   2. p.ticket_id IS NOT NULL      a ticket-less row has no adjudicating
--                                   queue row. Left alone.
--   3. p.tenant_id = t.tenant_id
--      p.tenant_id = q.tenant_id    the justification for settling OUR row
--                                   must come from OUR ticket and OUR queue
--                                   row. This is a service-role repair with
--                                   RLS off, so these are the whole boundary.
--   4. t.status = 'done'
--   5. t.landed_sha IS NULL         THE non-overlap clause. Exact complement of
--                                   `20260749000000`'s clause 3, so the two
--                                   repairs can never both act on one row. It
--                                   also excludes the `'backfill'` sentinel
--                                   rows — those record a GUESS an earlier
--                                   process made, which the operator has not
--                                   adjudicated and which is out of scope.
--   6. q.status = 'cancelled'
--      q.last_error LIKE 'nothing to land: %'
--                                   the recorded verdict, and its provenance.
--   7. q.pr_number IS NULL
--      q.merge_sha IS NULL          the facts that verdict was derived from,
--                                   re-asserted rather than trusted. They cost
--                                   nothing and they are what make the 422 a
--                                   pull-request failure and not something
--                                   else.
--   8. exactly one unsettled push   the verdict names a TICKET; the settle
--      row for the ticket            names a ROW. With two, there is no way to
--                                   tell which branch the worker resolved, so
--                                   both stay visible.
--   9. no in-flight queue row       a land still running will settle the row
--                                   itself through `stampLanded`, with its own
--                                   evidence. No reason to race it.
--
-- ─── what this deliberately does NOT touch ────────────────────────────────
--
-- The four rows carrying `landed_sha = 'backfill'`, and every row on a ticket
-- that is not `done`. Those may hold real commits that reached no remote.
-- Settling one drops it off the badge AND releases its reap guard, which is
-- how the only copy of a commit gets deleted. A row that survives this stays
-- visible, which is the correct failure direction.
--
-- `pushed_at` is stamped with the queue row's own `updated_at` — the moment
-- the outcome was adjudicated — rather than `now()`, which would date a push
-- that happened in 2026-07 to whenever this migration is applied.
--
-- ─── live dry-run, before applying ────────────────────────────────────────
--
-- Run against production on 2026-07-19, the predicate below selected exactly
-- 1 row: `db4dacaf-7c92-4b27-bc7e-678f48e10f35`, DevPilot-7. All six other
-- unsettled rows were correctly out of scope (four `backfill`, two
-- `input_required`). The notices below report what actually moved, so that can
-- be compared against this expectation when applied.

do $$
declare
  moved     integer;
  untouched integer;
begin
  with repaired as (
    update public.pending_pushes p
       set pushed_at  = coalesce(q.updated_at, now()),
           updated_at = now()
      from public.tickets t,
           public.integration_queue q
     where p.ticket_id  = t.id
       and p.tenant_id  = t.tenant_id
       and q.ticket_id  = p.ticket_id
       and q.tenant_id  = p.tenant_id
       and p.pushed_at  is null
       and p.ticket_id  is not null
       and t.status     = 'done'
       and t.landed_sha is null
       and q.status     = 'cancelled'
       and q.pr_number  is null
       and q.merge_sha  is null
       and q.last_error like 'nothing to land: %'
       and not exists (
             select 1
               from public.pending_pushes p2
              where p2.ticket_id = p.ticket_id
                and p2.tenant_id = p.tenant_id
                and p2.pushed_at is null
                and p2.id       <> p.id)
       and not exists (
             select 1
               from public.integration_queue q2
              where q2.ticket_id = p.ticket_id
                and q2.tenant_id = p.tenant_id
                and q2.status in ('pending', 'landing', 'awaiting_merge_resolution'))
    returning p.id
  )
  select count(*) into moved from repaired;

  select count(*) into untouched
    from public.pending_pushes p
   where p.pushed_at is null;

  raise notice 'settle_nothing_to_land_pending_pushes: settled % row(s); % unsettled row(s) remain (unproven, deliberately left visible)',
    moved, untouched;
end
$$;
