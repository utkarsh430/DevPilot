-- =============================================================================
-- Migration : 20260616000000_notification_kind_plan_started.sql
-- Extends the notifications.kind CHECK constraint with 'plan.started' so the
-- planner can publish a notification the first time the lead engages on a
-- session. Catalog + publish call-site live in lib/notifications/kinds.ts
-- and lib/plan/inngest.ts respectively.
-- =============================================================================

alter table public.notifications drop constraint if exists notifications_kind_check;

alter table public.notifications add constraint notifications_kind_check
  check (kind in (
    'plan.started', 'plan.finished', 'plan.failed',
    'run.completed', 'run.failed',
    'ticket.assigned_to_me', 'ticket.input_required',
    'push.merged', 'push.blocked', 'push.needs_merger'
  ));
