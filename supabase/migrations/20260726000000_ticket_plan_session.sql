-- =============================================================================
-- Migration : 20260726000000_ticket_plan_session.sql
-- Phase     : 2.5++ - the project scaffolder becomes a PLAN-INFORMED ticket.
--
-- What this adds
-- ──────────────
-- • tickets.plan_session_id - the link from a ticket to the planning session
--   whose commit released it. Set today by `commitPlanAction` on exactly one
--   row (the project's held `project_scaffolder` ticket) at the moment the
--   operator commits the plan.
--
--   Why a LINK and not a snapshot column: the enrichment it drives (the
--   confirmed stack + the lead's decisions) is rendered at DISPATCH time from
--   the live `project_stack_tags` / `planning_messages` rows through the one
--   prompt-injection seam (`lib/roles/context.ts`). A snapshot would freeze
--   catalog labels into a text blob, and catalog-owned labels are precisely
--   what keeps an attacker-influenceable repo/model string out of the top of
--   an agent's prompt (AGENTS.md - WI-15's "catalog is the ONLY vocabulary").
--
--   NULL is the meaningful default and covers every existing row plus both
--   no-plan seed paths (a plain create, and the abandonment fallback that
--   releases a never-committed scaffolder with BASE context). A ticket with no
--   link renders byte-for-byte the prompt it renders today.
--
--   `on delete set null`: a discarded/deleted planning session must never
--   cascade a ticket - the scaffold work outlives the discussion that framed
--   it. The ticket simply degrades to base context.
--
-- No RLS change: `tickets` already carries its tenant policies, and this is a
-- column on that existing table. The FK target (`planning_sessions`) is
-- tenant-scoped too, and every writer scopes its update by tenant_id.
-- =============================================================================

begin;

alter table public.tickets
  add column if not exists plan_session_id uuid
    references public.planning_sessions(id) on delete set null;

comment on column public.tickets.plan_session_id is
  'Planning session whose commit released this ticket. Set on the held project_scaffolder ticket by commitPlanAction; NULL for every other ticket (and for a scaffolder released by the abandonment fallback, which carries base context only).';

-- Partial index: the only reader looks up "is this ticket plan-informed?" by
-- id, but the release path scans a project's tickets for the held scaffolder.
-- Keep the index off the 99.9% NULL rows.
create index if not exists tickets_plan_session_idx
  on public.tickets(plan_session_id)
  where plan_session_id is not null;

commit;
