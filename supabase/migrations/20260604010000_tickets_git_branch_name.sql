-- Phase 2.5++ / C4 — Human-readable git branch names.
--
-- `tickets.git_branch_name` stores the slug assigned the first time the
-- engine prepares a workspace for the ticket. Once set, every subsequent
-- run on the ticket reuses it — so renaming the ticket via the inline
-- TicketDrawer editor (C3) never forks the engineer's branch mid-flight.
--
-- Nullable + lazily populated. Tickets that pre-date C4 stay on whatever
-- branch their on-disk workspace already has (the runner's re-entry path
-- detects `ace/<…>` branches and writes them back here verbatim instead of
-- forcing a fresh slug). New tickets get `ace/<slugify(title, maxLen=60)>`.

alter table public.tickets
  add column if not exists git_branch_name text;

comment on column public.tickets.git_branch_name is
  'Stable git branch slug assigned at first run. Survives title edits so branch identity does not fork. Lazily populated by lib/engine/run-agent.ts and apps/runner/src/workspace.ts.';
