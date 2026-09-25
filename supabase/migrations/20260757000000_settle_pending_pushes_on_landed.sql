-- Make "a landing settles its push row" a property of the DATABASE, not of
-- whoever happens to write `tickets.landed_sha`.
--
-- ─── what happened, and why the last fix did not hold ─────────────────────
--
-- PR #156 (`20260749000000` + `lib/integration/landed-push.ts`) moved the
-- settle INSIDE `stampLanded` and made `tenantId` / `pendingPushId` REQUIRED
-- arguments, so that "a fifth landing path is a compile error until it decides
-- what happens to the push row". That worked exactly as far as it reaches: the
-- paths that go THROUGH `stampLanded`.
--
-- It binds nothing else. A required parameter is a property of one function,
-- and `landed_sha` has since acquired a second writer and a third route:
--
--   lib/integration/queue.server.ts   stampLanded            settles     ✔
--   lib/integration/merger-outcome-store.ts  closeMergerOutcome (#191)   ✗
--   a hand-written UPDATE (a rescue PR merged by hand, then recorded)    ✗
--
-- Measured on 2026-08-04, project `scoursh`: 12 rows with `pushed_at IS NULL`,
-- of which ELEVEN belong to tickets that have landed — every one of them still
-- sitting in the operator's Changes queue awaiting a review of work that
-- shipped. (The twelfth, DevPilot-97, is `paused` with no `landed_sha`: it is
-- genuinely unlanded and is deliberately left alone.) Instance-wide the same
-- scan shows four further unsettled rows, all correctly out of scope — three
-- carrying the `'backfill'` sentinel and two on `input_required` tickets.
--
-- ─── why a trigger, and NOT a sweeper ─────────────────────────────────────
--
-- `landed-push.ts` rejects a reaper over `pending_pushes` outright, and that
-- reasoning is untouched here: a sweep would have HIDDEN this defect, because
-- the stale rows were the only visible evidence that the write path was still
-- incomplete. A reaper that hides a write-path bug is worse than a stale badge.
--
-- A trigger is the opposite of a sweeper. It does not periodically look for
-- rows that got left behind; it makes the leak unrepresentable, in the same
-- statement as the fact that causes it. `landed_sha` moving NULL -> non-NULL IS
-- "this ticket's work reached the integration branch". The companion write that
-- fact implies now happens as part of it, for every writer alike — the two in
-- the codebase today, whatever the fifth path turns out to be, and a hand-typed
-- UPDATE in a SQL console. Convention bound the first; nothing bound the rest.
--
-- The application-side settle in `stampLanded` is deliberately NOT removed. It
-- stays as the narrow, row-identified write (see SCOPE below) and the trigger
-- stands behind it; a caller that already settled its row leaves the trigger
-- with nothing to do, because the CAS below matches no row.
--
-- ─── scope, which is the part to get right ────────────────────────────────
--
-- `pushed_at` is not cosmetic. Non-null releases the unpushed-work reap guard
-- (`decideWorkspaceReap`), so a row settled without proof is a route to
-- deleting the only copy of a commit. Three clauses, all required:
--
--   1. `ticket_id = new.id`      — this ticket's own rows, and no others. The
--                                  evidence is a fact about a TICKET, so the
--                                  widest scope it can honestly justify is that
--                                  ticket's rows; another ticket's push is
--                                  someone else's business.
--   2. `tenant_id = new.tenant_id` — matching every trigger convention in this
--                                  schema. `assert_tenant_matches_parent`
--                                  already makes a mismatched pair unwritable,
--                                  but a write that leans on that for its
--                                  scoping is not one to take on trust.
--   3. `pushed_at is null`       — the CAS. An earlier, genuine push timestamp
--                                  is never overwritten, so a re-land, a
--                                  replay, or a reopen-and-land cycle cannot
--                                  rewrite history.
--
-- WHERE THIS IS WIDER THAN `settleLandedPush`, AND WHY THAT IS THE HONEST
-- ANSWER. The application settle resolves ONE row — the ticket's newest push,
-- via `resolveTicketPush` — and its header says a ticket carrying a second push
-- on another branch keeps it. That is the right scope THERE, because that
-- caller knows which row the landing resolved. A trigger does not: the fact it
-- fires on carries a ticket id and a sha, and no row identity at all. Settling
-- an arbitrary one of two would be a guess; settling none would leave the
-- defect open for exactly the tickets that have the most going on. So it
-- settles the ticket's own rows, which is what `20260749000000` already
-- concluded for this same evidence and shipped — and it is what produces the
-- eleven measured above (two of those tickets, DevPilot-77 and DevPilot-87, carry
-- two unsettled rows each).
--
-- That widening does not weaken the data-loss invariant, and this is the load-
-- bearing reason rather than a hope: the engine-side `decideWorkspaceReap` is
-- only the FIRST of two guards, and the second — the runner's
-- `checkWorkspaceReapSafety`, which refuses in front of the `rm` whenever
-- `git log --branches --not --remotes` is non-empty — reads the workspace
-- itself and knows nothing about `pending_pushes`. A workspace that genuinely
-- holds a commit no remote has is still not deletable. Neither guard is
-- modified here.
--
-- ─── the `'backfill'` sentinel is not evidence ────────────────────────────
--
-- `20260715000000` §6 stamped `landed_sha = 'backfill'` onto every `done`
-- ticket with a null sha, in ONE statement, having contacted no remote and read
-- no `pending_pushes` row. Its own header concedes the position: "the sha is
-- unknowable retroactively … so we stamp the sentinel rather than invent one".
-- It is an ASSUMPTION, not a landing, and `20260749000000` and `20260753000000`
-- both excluded it for that reason. A transition INTO it therefore settles
-- nothing, and the exclusion sits in the trigger's WHEN clause so it is visible
-- in `\d public.tickets` rather than buried in a function body.
--
-- The reverse direction ('backfill' -> a real sha) does not fire either, since
-- the WHEN clause requires `old.landed_sha IS NULL`. That is correct and not a
-- gap: `landTicketNowAction`'s force path clears the sentinel to NULL first
-- (`queue.server.ts`, `decideLandedShaGate`) and `stampLanded`'s own CAS is on
-- `landed_sha IS NULL`, so a real landing always arrives from NULL.
--
-- ─── two clauses deliberately NOT in the trigger ──────────────────────────
--
-- `status = 'done'` is in the repair below but NOT in the trigger, and the
-- asymmetry is intentional. In the repair it is conservatism about historical
-- rows nobody watched land ("a landed ticket in any other state is unusual
-- enough to deserve a human look" — `20260749000000`). In the trigger it would
-- buy no safety and add a silent-miss mode: the workspace reaper only ever
-- touches tickets that are already terminal, so a non-`done` ticket's workspace
-- is not reapable whatever its push rows say — while a landing that happened to
-- fire a moment before the ticket settled would leak forever, which is the
-- defect this closes.
--
-- `security definer` is likewise absent. Every real writer of `landed_sha`
-- bypasses RLS already (the engine's service role; a superuser in a SQL
-- console), and a member-role writer's own `pending_pushes_member_write` policy
-- permits precisely the same-tenant write this performs — so a definer would
-- buy nothing while adding a definer-privileged writer of `pending_pushes` to
-- the schema. `set search_path = ''` is required regardless (the Supabase
-- linter's `function_search_path_mutable`, and a caller-controlled search_path
-- in a trigger is a privilege-escalation surface), so every object below is
-- schema-qualified.
--
-- ─── what the proof CANNOT see ────────────────────────────────────────────
--
-- `scripts/settle-landed-trigger-accept.mjs` reproduces the leak first, then
-- proves every clause below by deleting it and watching the run go red. Three
-- do NOT go red on their own, and saying so is the point — a reviewer must not
-- read them as tested guards:
--
--   • `new.landed_sha is not null` / `t.landed_sha is not null` are redundant
--     while the `<> 'backfill'` clause stands, because `NULL <> 'backfill'` is
--     NULL rather than true. Deleting EITHER is invisible; deleting BOTH is
--     caught (a NULL -> NULL write would otherwise settle rows and stamp
--     `coalesce(NULL, now())`, inventing a push that never happened — and
--     `discardAndRestartFromDevAction` performs exactly that write). They are
--     kept as the pair that makes the dangerous case unreachable from either
--     side, not as belt-and-braces.
--   • `p.ticket_id is not null` is implied by the join (`NULL = t.id` is never
--     true). Carried because `20260749000000` carries it and the two predicates
--     are meant to read as the same rule.
--   • `after update OF landed_sha` is a cost and precision choice, not a guard:
--     the WHEN clause already rejects everything it excludes. Widening it to
--     every ticket UPDATE changes no outcome — it just evaluates the WHEN
--     clause on every write to the busiest table in the schema.
--
-- ─── deploy safety ────────────────────────────────────────────────────────
--
--   • `after update of landed_sha` — an UPDATE that does not mention the column
--     never fires, so ordinary ticket writes are untouched.
--   • The WHEN clause is evaluated before the function body, so the common case
--     (any other ticket UPDATE) costs one comparison.
--   • No recursion: it writes `pending_pushes`, which has no trigger reaching
--     back to `tickets`.
--   • `pending_pushes` is in the `supabase_realtime` publication, so a settle
--     reaches the /changes page live, exactly as the application write does.
-- =============================================================================
begin;

create or replace function public.settle_pending_pushes_on_landed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- `chk_tickets_landed_pair` makes `integrated_at` non-null whenever
  -- `landed_sha` is, so the coalesce is defence and not a routine fallback.
  -- The push became moot at the moment the work landed; `now()` would date it
  -- to whenever this trigger happened to run.
  update public.pending_pushes
     set pushed_at = coalesce(new.integrated_at, now())
   where ticket_id = new.id
     and tenant_id = new.tenant_id
     and pushed_at is null;

  return null; -- AFTER trigger: the return value is ignored.
end;
$$;

comment on function public.settle_pending_pushes_on_landed() is
  'Settles a ticket''s unsettled pending_pushes rows when its landed_sha goes '
  'NULL -> non-NULL. Makes the settle unconditional across every writer of '
  'landed_sha rather than a convention each one has to remember. See '
  'supabase/migrations/20260757000000_settle_pending_pushes_on_landed.sql.';

drop trigger if exists tickets_settle_pending_pushes_on_landed on public.tickets;
create trigger tickets_settle_pending_pushes_on_landed
  after update of landed_sha on public.tickets
  for each row
  when (
    old.landed_sha is null
    and new.landed_sha is not null
    and new.landed_sha <> 'backfill'
  )
  execute function public.settle_pending_pushes_on_landed();

-- ---------------------------------------------------------------------------
-- Repair: the rows that leaked before the trigger existed.
--
-- The predicate is `20260749000000`'s, unchanged and deliberately not widened.
-- That migration's rule was correct; what was missing was anything to keep it
-- true afterwards, which is what the trigger above now supplies. Re-running the
-- same statement therefore settles exactly the rows that accumulated since —
-- and, being conjunctive on facts that only get MORE true, it is idempotent
-- both against itself and against the earlier migration.
--
--   1. p.pushed_at is null        — only an unsettled row is in scope.
--   2. p.ticket_id is not null    — a ticket-less row proves nothing about
--                                   where its commits are. Left alone.
--   3. t.landed_sha is not null   — THE justification: the ticket's work is on
--                                   the integration branch, so it reached the
--                                   remote and nothing is owed.
--   4. t.landed_sha <> 'backfill' — a guess, not evidence. See above.
--   5. t.status = 'done'          — matches the evidence exactly and costs
--                                   nothing on a historical sweep.
--   6. p.tenant_id = t.tenant_id  — our row's justification must come from our
--                                   ticket.
--
-- Out of scope, on purpose: DevPilot-97 (`paused`, no `landed_sha` — genuinely
-- unlanded), the two `input_required` rows, and the three `'backfill'` rows.
-- Those stay visible, which is the correct failure direction.
-- ---------------------------------------------------------------------------
do $$
declare
  moved     integer;
  untouched integer;
begin
  with repaired as (
    update public.pending_pushes p
       set pushed_at = coalesce(t.integrated_at, now())
      from public.tickets t
     where p.ticket_id  = t.id
       and p.tenant_id  = t.tenant_id
       and p.pushed_at  is null
       and p.ticket_id  is not null
       and t.status     = 'done'
       and t.landed_sha is not null
       and t.landed_sha <> 'backfill'
    returning p.id
  )
  select count(*) into moved from repaired;

  select count(*) into untouched
    from public.pending_pushes p
   where p.pushed_at is null;

  raise notice 'settle_pending_pushes_on_landed: settled % row(s); % unsettled row(s) remain (unproven, deliberately left visible)',
    moved, untouched;
end
$$;

commit;
