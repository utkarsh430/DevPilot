-- =============================================================================
-- Migration : 20260729000000_ticket_dependencies_cross_tenant_write.sql
-- Purpose   : Stop a tenant from pointing a `ticket_dependencies` edge at
--             ANOTHER tenant's ticket. Defence in depth behind the audit
--             export's explicit tenant scoping.
--
-- The hole
-- ────────
-- `ticket_dependencies_member_write` (20260601000000_core.sql) gates only the
-- `ticket_id` endpoint:
--
--   with check (
--     ticket_id in (select id from public.tickets
--                    where tenant_id in (select public.current_user_tenants()))
--   )
--
-- `blocks_ticket_id` — the OTHER endpoint — was unconstrained. So a member of
-- tenant A could insert `(ticket_id = <their own ticket>, blocks_ticket_id =
-- <a known tenant-B ticket uuid>)` and the write passed. The row is invisible to
-- tenant B (the read policy gates on `ticket_id`), but it sits on tenant A's own
-- ticket, so any code that resolves the referenced id renders tenant B's data.
--
-- That is exactly what the audit export's relation reads did on the background
-- project job, where the service client has RLS switched off entirely: a foreign
-- ticket's title / number / status / land-state rendered into a downloadable PDF.
--
-- Why BOTH this and the app-side filter
-- ─────────────────────────────────────
-- The real boundary for the export is the explicit `.eq("tenant_id", …)` in
-- `lib/export/ticket-audit.ts`, because it holds for every row ALREADY in the
-- table — this policy cannot retroactively unmake edges written before it. But
-- an edge whose two endpoints straddle tenants is meaningless in every reading
-- (it can never gate readiness, since the blocker query joins through the
-- tenant), so it should never have been writable in the first place. Closing it
-- means the next reader of `ticket_dependencies` does not have to rediscover the
-- hazard.
--
-- Note we do NOT delete existing cross-tenant rows: a destructive cleanup on a
-- table an operator may have legitimate-looking rows in is not something to do
-- silently inside a policy migration. They are already inert — the export filters
-- them, and `fetchBlockerRows` joins through `tickets` under RLS.
--
-- Execution notes
-- ───────────────
-- One-shot, transactional, idempotent (`drop policy if exists` then create).
-- The USING clause is unchanged; only WITH CHECK (which governs INSERT/UPDATE)
-- gains the second endpoint, so existing reads/deletes behave identically.
-- =============================================================================
begin;

drop policy if exists ticket_dependencies_member_write on public.ticket_dependencies;
create policy ticket_dependencies_member_write on public.ticket_dependencies
  for all
  using (
    ticket_id in (
      select id from public.tickets where tenant_id in (select public.current_user_tenants())
    )
  )
  with check (
    ticket_id in (
      select id from public.tickets where tenant_id in (select public.current_user_tenants())
    )
    -- NEW: the blocker endpoint must be in one of my tenants too. Without this a
    -- relation could name any ticket uuid in the database.
    and blocks_ticket_id in (
      select id from public.tickets where tenant_id in (select public.current_user_tenants())
    )
  );

comment on table public.ticket_dependencies is
  'Ticket relations (blocked_by | builds_on | related | duplicate). BOTH endpoints '
  'are constrained to the writer''s tenants by ticket_dependencies_member_write — a '
  'cross-tenant edge is not writable. Readers that run with the service role (RLS '
  'off) must STILL scope resolved ids by tenant explicitly; see lib/export/ticket-audit.ts.';

commit;
