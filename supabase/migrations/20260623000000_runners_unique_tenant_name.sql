-- =============================================================================
-- Migration : 20260623000000_runners_unique_tenant_name.sql
--
-- Make runner registration idempotent. POST /api/runners/register is the
-- worker→engine boot handshake, and the runner wraps it in a transient-connect
-- retry (boot-race resilience on a cold `pnpm dev`). Some retryable failures
-- fire AFTER the request bytes are sent (ECONNRESET/ETIMEDOUT), so the engine
-- may have already created the runner row before the connection dropped. A plain
-- INSERT would then register a SECOND runner on retry — two idle workers pulling
-- jobs, breaching the subscription concurrency cap the platform treats as a hard
-- boundary.
--
-- The fix is an UPSERT on (tenant_id, name) in the route, which needs a matching
-- unique constraint here. A runner's (tenant_id, name) identity is stable across
-- boots, so re-registration re-resolves to the same row instead of duplicating.
--
-- Guard against pre-existing duplicates first: keep the most recently created
-- row per (tenant_id, name) and delete the rest, so the constraint can be added
-- cleanly. `runs.runner_id` is `on delete set null`, so orphaning a stale
-- duplicate's runs is harmless — they get re-dispatched.
-- =============================================================================

delete from public.runners r
using public.runners keep
where r.tenant_id = keep.tenant_id
  and r.name = keep.name
  and (keep.created_at, keep.id) > (r.created_at, r.id);

alter table public.runners
  add constraint runners_tenant_name_key unique (tenant_id, name);
