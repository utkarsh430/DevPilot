-- Phase 2.5+ / Slice IB-C — extend ticket_dependencies.relation_type to
-- include 'builds_on'. Semantics: when ticket A `builds_on` ticket B,
-- A's `ace/<slug-A>` branch is cut from B's `ace/<slug-B>` branch (rather
-- than from the integration branch). When B lands on the integration tip,
-- A is auto-rebased onto the new integration tip via the cascade-rebase
-- Inngest function (`branch/parent-landed`).
--
-- A `builds_on` row carries the same semantics direction as `blocked_by`:
-- `ticket_id` is the dependent (the one that builds on top of), and
-- `blocks_ticket_id` is the dependency (the parent).
--
-- The check constraint must be re-created in place; Postgres has no
-- "alter check" idiom.

alter table public.ticket_dependencies
  drop constraint if exists ticket_dependencies_relation_type_check;

alter table public.ticket_dependencies
  add constraint ticket_dependencies_relation_type_check
  check (relation_type in ('blocked_by','related','duplicate','builds_on'));

comment on column public.ticket_dependencies.relation_type is
  'blocked_by | related | duplicate | builds_on. The builds_on variant '
  'tells the runner to root ace/<slug-A> at ace/<slug-B> instead of at '
  'the integration branch, enabling stacked feature work.';
