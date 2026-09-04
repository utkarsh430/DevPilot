-- Settle `pending_pushes` rows whose work has provably already landed.
--
-- ─── what happened ────────────────────────────────────────────────────────
--
-- `stampLanded` (`lib/integration/queue.server.ts`) is the only function that
-- writes `tickets.landed_sha` — i.e. it is the single choke point for the fact
-- "this ticket's work is now on the integration branch". The companion write
-- that fact implies — clearing the ticket's `pending_pushes` row — was
-- duplicated INLINE at two of its four call sites and simply absent at the
-- other two:
--
--   land-worker `stamp-landed`          (the ordinary land)      settled
--   land-worker `close-nothing-to-land` (review-only, PR #152)   settled
--   land-worker `close-already-landed`  (duplicate enqueue)      LEAKED
--   land-worker reaper `stamp_landed`   (dead worker reconciled) LEAKED
--
-- Both leaking paths do the FULL post-land fan-out — `branch/parent-landed`,
-- `promoteUnblockedDependents`, `ticket-drain/requested` — so every downstream
-- consumer was told the ticket landed and only the push row was left behind,
-- reading `pushed_at IS NULL` forever. Visible consequences: the /changes badge
-- counts work that shipped, and the unpushed-work reap guard
-- (`decideWorkspaceReap`) pins a workspace nothing will ever revisit.
--
-- The code fix moves the settle INSIDE `stampLanded` and makes `tenantId` and
-- `pendingPushId` REQUIRED arguments, so no new landing path can be written
-- without deciding what happens to the push row. This migration settles the
-- rows already leaked before it.
--
-- ─── the scope, which is the part to get right ────────────────────────────
--
-- `pushed_at` is not cosmetic. Non-null releases the data-loss reap guard, so a
-- row settled here that still holds the ONLY copy of a commit is a route to
-- losing it. The predicate is therefore built from what can be PROVEN, not from
-- what looks stale. Five clauses, all required, all conjunctive:
--
--   1. p.pushed_at is null        — only an unsettled row is in scope.
--   2. p.ticket_id is not null    — a ticket-less row proves nothing about
--                                   where its commits are. Left alone.
--   3. t.landed_sha is not null   — THE justification. The ticket's branch is on
--                                   the integration branch, which means it
--                                   reached the remote: nothing is owed.
--   4. t.landed_sha <> 'backfill' — the `LANDED_SHA_BACKFILL_SENTINEL`. That
--                                   value means an earlier migration recorded
--                                   "presumed landed" without resolving a sha —
--                                   a guess, not evidence, and `enqueueForLanding`
--                                   still treats such a ticket as landable. A
--                                   guess must not settle a push row.
--   5. t.status = 'done'          — matches the evidence exactly and costs
--                                   nothing. A landed ticket in any other state
--                                   is unusual enough to deserve a human look.
--
-- Plus `p.tenant_id = t.tenant_id`: the justification for settling OUR row must
-- come from OUR ticket. `assert_tenant_matches_parent` should already make a
-- mismatched pair unwritable, but a repair that leans on a cross-tenant join
-- for its evidence is not one to write on trust.
--
-- ─── what this deliberately does NOT touch ────────────────────────────────
--
-- Rows on tickets that are `input_required`, `in_progress`, `blocked` — or that
-- carry no ticket at all — are OUT of scope even when they look old. Those may
-- be genuinely pending: real commits, on a real branch, that have not reached
-- any remote. Settling one would drop it off the badge AND release its reap
-- guard, which is precisely how the only copy of a commit gets deleted. A stale
-- row that survives this migration stays visible, which is the correct failure
-- direction; the write-path fix means no new one joins it.
--
-- `pushed_at` is stamped with the ticket's own `integrated_at` where available,
-- not `now()`: the push became moot at the moment the work landed, and that is
-- the truthful timestamp. `now()` is the fallback for a landed ticket with no
-- recorded integration time.
--
-- The notices below report exactly what moved, and what was left behind and
-- why, so the counts can be compared against expectation when this is applied.

do $$
declare
  moved     integer;
  untouched integer;
begin
  with repaired as (
    update public.pending_pushes p
       set pushed_at  = coalesce(t.integrated_at, now()),
           updated_at = now()
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
    left join public.tickets t
      on t.id = p.ticket_id and t.tenant_id = p.tenant_id
   where p.pushed_at is null;

  raise notice 'settle_landed_pending_pushes: settled % row(s); % unsettled row(s) remain (unproven, deliberately left visible)',
    moved, untouched;
end
$$;
