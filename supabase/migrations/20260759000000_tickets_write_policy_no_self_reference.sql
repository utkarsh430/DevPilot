-- =============================================================================
-- Migration : 20260759000000_tickets_write_policy_no_self_reference.sql
-- Purpose   : Stop `tickets_member_write` from querying `tickets`. Creating a
--             ticket from the UI was BROKEN - every authenticated INSERT failed
--             with `42P17 infinite recursion detected in policy for relation
--             "tickets"`.
--
-- The defect
-- ──────────
-- `20260730000000` added two pointer clauses to the WITH CHECK. One of them
-- SELECTS FROM THE VERY TABLE THE POLICY GUARDS:
--
--   and (parent_ticket_id is null
--        or parent_ticket_id in (select id from public.tickets where …))
--
-- Postgres expands RLS policies recursively and refuses to re-enter a relation
-- whose policies it is already expanding, so an INSERT into `tickets` evaluates
-- WITH CHECK, which needs the SELECT policies of `tickets`, which is `tickets`
-- again. It raises 42P17 and nothing is written.
--
-- Two things about this are worth pinning down, because both are counter-
-- intuitive and both shaped the fix.
--
--   • IT FIRES EVEN FOR `parent_ticket_id IS NULL`. The `x is null or …`
--     short-circuit is a RUNTIME property; the recursion is detected while the
--     policy expression is being PLANNED. So this is not "sub-issue creation is
--     broken", it is "ticket creation is broken". Measured against a real local
--     Postgres as an `authenticated` role: all three of {null parent,
--     same-tenant parent, foreign parent} returned 42P17.
--
--   • ONLY THE RLS PATH IS AFFECTED, which is why it hid. The service role
--     bypasses RLS, so every engine and agent write - `createTicketCore` via
--     `supabaseService()`, `commitPlanAction`, the drain, the MCP
--     create-ticket route - kept working. The one caller that runs RLS-bound is
--     the human New-ticket form, so the board looked healthy while the operator
--     could not file anything.
--
-- Why the clause can simply GO, rather than being rewritten
-- ────────────────────────────────────────────────────────
-- Do NOT read this as dropping a cross-tenant check. `20260732000000` installed
-- `assert_tenant_matches_parent`, one parameterised BEFORE trigger over every
-- (tenant_id + FK-to-tenant-scoped-parent) pair, and `tickets.parent_ticket_id`
-- is one of them:
--
--   trg_tickets_parent_ticket_id_tenant
--     before insert or update of tenant_id, parent_ticket_id on public.tickets
--     execute function assert_tenant_matches_parent('parent_ticket_id','tickets')
--
-- Verified present on the live schema, not assumed from the migration text.
--
-- THE TRIGGER IS STRICTLY STRONGER THAN THE CLAUSE IT REPLACES. The clause said
-- "the parent must live in ONE OF MY tenants"; the trigger says "the parent's
-- tenant must EQUAL this row's tenant". Combined with the policy's surviving
-- `tenant_id in (select current_user_tenants())`, we get
--
--     parent.tenant_id = new.tenant_id  ∧  new.tenant_id ∈ my tenants
--   ⟹ parent.tenant_id ∈ my tenants
--
-- i.e. everything the removed clause asserted, and more (it additionally forbids
-- parenting across two tenants the same person happens to belong to). So this is
-- a NARROWING of what is writable, not a widening.
--
-- The trigger also cannot recurse, structurally: it is `security definer` with
-- `set search_path = public` and performs a direct PK lookup, so it never enters
-- RLS policy expansion at all. And it fires for the SERVICE ROLE too, which the
-- policy never did - the trigger covers engine bugs, the policy only covered
-- hostile members.
--
-- Why the `project_id` clause STAYS
-- ─────────────────────────────────
-- It reads `projects`, not `tickets`, so it does not recurse and it is not the
-- defect. It is left exactly as `20260730000000` wrote it. It is nonetheless now
-- belt-and-braces behind `trg_tickets_project_id_tenant` - with one narrow case
-- where it still does real work: that trigger is scoped `update of tenant_id,
-- project_id`, so an UPDATE touching neither column (a title edit, a status
-- move) does not fire it, while WITH CHECK still evaluates the whole new row.
-- For a row written BEFORE the trigger existed and already pointing at a foreign
-- project, the clause is what keeps refusing. Removing it was not necessary to
-- fix this bug, so it is not removed.
--
-- Execution notes
-- ───────────────
-- One-shot, transactional, idempotent (`drop policy if exists` then create). The
-- USING clause is byte-identical to `20260730000000`'s, so reads and deletes are
-- unchanged. No data is touched: this migration writes no row.
--
-- Proof: `pnpm --filter @devpilot/web accept:tickets-write-policy` reproduces the
-- 42P17 against the pre-fix policy FIRST - without that half the whole script
-- would pass against a database where the defect never existed - then applies
-- this file and asserts the three outcomes that matter, the third being the one
-- that separates this fix from simply deleting a safety check:
--
--     parent NULL           → inserted
--     same-tenant parent    → inserted
--     FOREIGN-tenant parent → STILL REFUSED  ← the control
-- =============================================================================
begin;

drop policy if exists tickets_member_write on public.tickets;
create policy tickets_member_write on public.tickets
  for all
  using (tenant_id in (select public.current_user_tenants()))
  with check (
    tenant_id in (select public.current_user_tenants())
    -- A ticket may only claim a project in one of my tenants. Reads `projects`,
    -- so it does not recurse; retained verbatim from 20260730000000.
    and (
      project_id is null
      or project_id in (
        select id from public.projects where tenant_id in (select public.current_user_tenants())
      )
    )
    -- NO parent_ticket_id clause here, deliberately. Selecting from `tickets`
    -- inside a `tickets` policy is 42P17 by construction. The invariant is held
    -- - more tightly - by trg_tickets_parent_ticket_id_tenant
    -- (20260732000000), which is security definer, does a direct PK lookup, and
    -- fires for the service role as well. See the header.
  );

comment on column public.tickets.parent_ticket_id is
  'Parent ticket for sub-issue nesting. Constrained to the SAME tenant as this '
  'row by trg_tickets_parent_ticket_id_tenant (20260732000000) - deliberately '
  'NOT by tickets_member_write, because a policy on `tickets` that selects from '
  '`tickets` raises 42P17 and breaks every RLS-bound insert (20260759000000). '
  'Readers that run with the service role (RLS off) must STILL filter by '
  'tenant_id explicitly; see lib/export/ticket-audit.ts.';

commit;
