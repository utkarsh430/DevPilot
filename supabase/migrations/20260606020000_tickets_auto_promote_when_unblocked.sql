-- Bulk Move-to-Ready: per-ticket "auto-promote when blockers clear" flag.
--
-- When the operator bulk-promotes a batch of backlog tickets to Ready and some
-- still have open dependencies, those tickets stay in Backlog with this flag
-- set to true. The transition hook (transitions.ts) watches for any ticket
-- entering 'done' and scans its dependents: any flagged dependent whose
-- blockers are now all done gets transitioned to 'ready'.
--
-- The flag is also cleared whenever the ticket itself transitions out of
-- 'backlog' so a manual move + later auto-promote can't double-fire.

alter table public.tickets
  add column if not exists auto_promote_when_unblocked boolean not null default false;
