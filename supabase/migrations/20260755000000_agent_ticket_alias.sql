-- =============================================================================
-- Migration : 20260755000000_agent_ticket_alias.sql
-- Phase     : follow-up to WI-14 - let `devpilot_create_ticket` declare
--             dependencies, including on siblings filed by the same run.
--
-- Why
-- ───
-- `devpilot_create_ticket` took no dependency argument, so an agent decomposing a
-- ticket into children could only write the ordering into prose. On 2026-08-02
-- four decompositions on one board did exactly that and the graph stayed empty:
-- every child dispatched at once, three burned a run re-deriving "my dependency
-- is missing", and one set of six tickets was told to build the same shared file
-- "if absent" - a merge race by construction.
--
-- The hard part is the FORWARD REFERENCE: child 2 depends on child 1, whose uuid
-- does not exist until child 1 is created, and each tool call is a separate HTTP
-- request. So the agent labels a ticket as it files it (`alias: "engine"`) and
-- later calls reference that label. The label has to be durable across requests,
-- which is what this column is.
--
-- What this adds
-- ──────────────
-- • tickets.agent_alias - NULLABLE text, the run-local label.
--
--   On `tickets` rather than in a side table, and that is the point: the alias
--   is written in the SAME insert as the ticket, so there is never a moment when
--   a ticket exists without the label another call may be about to reference,
--   and there is nothing to clean up when a run ends. It is scoped by the
--   existing `source_run_id` (added in 20260717000000), so no second key column
--   is needed either.
--
--   NULL for every human-created ticket and for every agent ticket that does not
--   need a label, which is the overwhelming majority - the column is a handle
--   for one decomposition, not a second identity. `tickets.ticket_number`
--   (`DevPilot-<N>`) remains THE identity; an alias is deliberately refused by the
--   app if it is shaped like a ticket key or a uuid, so the two can never be
--   confused at a reference site.
--
-- • uq_tickets_agent_alias_per_run - partial unique index on
--   (source_run_id, agent_alias).
--
--   PARTIAL IS REQUIRED, and the reason is the usual NULL trap: Postgres treats
--   NULLs as DISTINCT in a unique index, so a plain `unique (source_run_id,
--   agent_alias)` would happily hold every human ticket (both columns NULL) and
--   say nothing at all about the rows that matter. The `where` clause restricts
--   it to rows that actually carry both.
--
--   What it protects: an agent re-using an alias for a second ticket would
--   SILENTLY REPOINT every later `dependsOn` that names it - the edge would be
--   written, and written to the wrong ticket, which is worse than the empty
--   graph this feature replaces. The app refuses a duplicate alias in front of
--   this index (so the agent gets a readable refusal instead of a 500 that has
--   already burnt one of the run's ticket slots); the index is the boundary that
--   holds when two concurrent tool calls from one run race it.
--
-- • check on length, mirroring the app's AGENT_ALIAS_MAX_CHARS.
--
-- Deliberately NOT added: any change to `ticket_dependencies`. The dependency
-- rows this feature writes are ordinary `blocked_by` rows in the existing table,
-- with the existing PK (ticket_id, blocks_ticket_id) doing the duplicate-edge
-- work and the existing `ticket_dependencies_no_self` check refusing a self
-- edge. A new relation flavour would have needed every readiness query in the
-- tree to learn about it; the whole design here is that an agent-declared
-- dependency is not a special kind of dependency.
-- =============================================================================

begin;

alter table public.tickets
  add column if not exists agent_alias text
    check (agent_alias is null or char_length(agent_alias) <= 40);

comment on column public.tickets.agent_alias is
  'Run-local label an agent gave this ticket when filing it via devpilot_create_ticket, '
  'so a LATER call on the same run can name it in dependsOn before its uuid is known to '
  'the model. Scoped by source_run_id; NULL for human-created tickets and for agent '
  'tickets nothing depends on. Never an identity - that is ticket_number.';

create unique index if not exists uq_tickets_agent_alias_per_run
  on public.tickets (source_run_id, agent_alias)
  where agent_alias is not null and source_run_id is not null;

commit;
