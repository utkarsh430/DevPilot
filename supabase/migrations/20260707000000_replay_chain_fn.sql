-- Replay-chain lookup for the Run Inspector (/runs/[id]).
--
-- Why: `loadReplayChain` used to climb `runs.replay_of_run_id` one row at a
-- time (up to 8 sequential round trips) to find the chain's original, then
-- issue two more reads for original + replays. On cloud latency (~80ms/hop)
-- that alone could cost ~800ms of TTFB. This function does the whole walk in
-- ONE round trip: a recursive CTE climbs to the original, then returns the
-- original plus every direct replay of it, in display order.
--
-- Semantics mirror the TS walk it replaces:
--   • The climb is bounded at 8 hops — a malformed-data guard; by policy
--     chains can't exceed ACE_MAX_REPLAYS_PER_RUN (default 5).
--   • Output = original first, then its direct replays in created_at order.
--
-- SECURITY INVOKER on purpose: the web app calls this through the RLS-bound
-- client, so the caller's row-level policies on `runs` apply inside the
-- function — a user can only walk chains within their own tenant.

create or replace function public.replay_chain(p_run_id uuid)
returns table (
  id uuid,
  status text,
  replay_of_run_id uuid,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with recursive climb as (
    select r.id, r.replay_of_run_id, 0 as depth
    from public.runs r
    where r.id = p_run_id
    union all
    select parent.id, parent.replay_of_run_id, climb.depth + 1
    from public.runs parent
    join climb on parent.id = climb.replay_of_run_id
    where climb.depth < 8
  ),
  original as (
    select climb.id from climb order by climb.depth desc limit 1
  )
  select r.id, r.status, r.replay_of_run_id, r.created_at
  from public.runs r
  where r.id = (select original.id from original)
     or r.replay_of_run_id = (select original.id from original)
  order by (r.replay_of_run_id is null) desc, r.created_at asc
$$;

revoke all on function public.replay_chain(uuid) from public;
grant execute on function public.replay_chain(uuid) to authenticated, service_role;
