-- =============================================================================
-- Migration : 20260730000000_tickets_project_tenant_write.sql
-- Purpose   : Stop a tenant from writing a ticket that claims ANOTHER tenant's
--             project. Defence in depth behind the app-side tenant filters in
--             `lib/metrics/project.ts` and `lib/export/*`.
--
-- The hole
-- ────────
-- `tickets_member_write` (20260601000000_core.sql) gates only the row's OWN
-- tenant:
--
--   for all using  (tenant_id in (select public.current_user_tenants()))
--       with check (tenant_id in (select public.current_user_tenants()))
--
-- `project_id` was unconstrained. So a member of tenant B could insert
-- `{tenant_id: B, project_id: <tenant A's project>}` and the policy passed. The
-- row is invisible to tenant A through RLS (it belongs to B), but it is not
-- invisible to a SERVICE-ROLE scan of `tickets WHERE project_id = <A's project>`
-- — which is exactly what the per-project rollups do. B's ticket, and its runs,
-- landed in A's Total spend / Tickets / Runs / Retries tiles and in A's by-role
-- bars, on the project page and in the audit PDF.
--
-- Nothing secret crossed: those reads aggregate counts and cents rather than
-- rendering titles or narration. But an audit document's numbers being quietly
-- wrong is its own kind of failure — the whole point of the artifact is that the
-- figures can be relied on.
--
-- `parent_ticket_id` gets the same treatment, and for the same reason: it is the
-- other attacker-settable cross-tenant pointer on this table (it fed the
-- export's sub-issue read).
--
-- Why BOTH this and the app-side filters
-- ──────────────────────────────────────
-- The app-side `.eq("tenant_id", …)` is the real control, because it holds for
-- every row ALREADY in the table — this policy cannot retroactively unmake rows
-- written before it. This migration stops NEW ones and means the next person to
-- write a `WHERE project_id = …` scan does not have to rediscover the hazard.
--
-- We do NOT delete or re-home existing cross-tenant rows: a destructive cleanup
-- of tickets, inside a policy migration, is not something to do silently. They
-- are already inert — every reader is now tenant-scoped.
--
-- Execution notes
-- ───────────────
-- One-shot, transactional, idempotent (`drop policy if exists` then create).
-- The USING clause is unchanged, so reads and deletes behave exactly as before;
-- only WITH CHECK (INSERT/UPDATE) gains the two pointer constraints. NULL
-- project_id / parent_ticket_id stay legal — `x is null or …` — because a
-- project-less ticket is a normal, supported state (legacy rows, and the
-- ticket_number counter's whole null branch).
-- =============================================================================
begin;

drop policy if exists tickets_member_write on public.tickets;
create policy tickets_member_write on public.tickets
  for all
  using (tenant_id in (select public.current_user_tenants()))
  with check (
    tenant_id in (select public.current_user_tenants())
    -- NEW: a ticket may only claim a project in one of my tenants.
    and (
      project_id is null
      or project_id in (
        select id from public.projects where tenant_id in (select public.current_user_tenants())
      )
    )
    -- NEW: and may only parent onto a ticket in one of my tenants.
    and (
      parent_ticket_id is null
      or parent_ticket_id in (
        select id from public.tickets where tenant_id in (select public.current_user_tenants())
      )
    )
  );

comment on column public.tickets.project_id is
  'The project this ticket belongs to. Constrained to the writer''s tenants by '
  'tickets_member_write — a ticket cannot claim another tenant''s project. Readers '
  'that run with the service role (RLS off) must STILL filter by tenant_id '
  'explicitly; see lib/metrics/project.ts.';

commit;
