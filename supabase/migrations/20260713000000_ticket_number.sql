-- =============================================================================
-- Migration : 20260713000000_ticket_number.sql
--
-- `DevPilot-<N>` — the human-friendly, per-project ticket key.
--
-- The board has been rendering a per-COLUMN ordinal badge derived from
-- `column_position` (render index within the column). That number repeats
-- across columns (Backlog #1 and In Progress #1 are different tickets), moves
-- when a card moves, and reads backwards from creation order — it is not an
-- identity, it is a sort key. This migration introduces the identity the
-- codebase already reserved a name for (see the comment in
-- `components/board/TicketCard.tsx` and the `DevPilot-142` example in
-- `lib/roles/business_analyst.ts`): a stable, creation-order integer that is
-- assigned once, unique within its project, and never changes.
--
-- Numbering is PER PROJECT (like GitHub issue numbers): every project's board
-- counts from 1. The counter lives on `projects.ticket_seq`.
--
-- Race-safety is the crux, and it is why this is a DB trigger rather than an
-- app-side `max(ticket_number) + 1`:
--   • `update projects set ticket_seq = ticket_seq + 1 … returning` takes a ROW
--     lock on the project for the remainder of the inserting transaction, so
--     two concurrent creates in the same project serialise and can never be
--     handed the same number. A read-then-write in application code cannot make
--     that guarantee without an explicit lock.
--   • A plain sequence would be global, not per project, and would leak numbers
--     across projects.
-- A rolled-back insert still burns its number (the counter is not restored) —
-- that is the same, accepted trade GitHub issue numbers make. Contiguity is not
-- an invariant; uniqueness and stability are.
--
-- Because the assignment happens in the database on EVERY insert, all insert
-- paths — createTicketAction, commitPlanAction's bulk array insert, the
-- plan-test route, the builder spawn path, and anything added later — are
-- numbered automatically with no application change and no way to forget.
--
-- `ticket_number` is NULLABLE on purpose: tickets with `project_id IS NULL`
-- (legacy / pre-M5a rows) belong to no project, so no per-project counter can
-- number them. The board falls back to the short hex id for those.
-- =============================================================================

-- Per-project high-water mark. `not null default 0` so the trigger's
-- `ticket_seq + 1` is always defined, including for projects created before
-- this migration.
alter table public.projects
  add column if not exists ticket_seq int not null default 0;

alter table public.tickets
  add column if not exists ticket_number int;

-- Uniqueness is scoped to the project and only applies to numbered rows;
-- project-less tickets (ticket_number IS NULL) are simply not in the index.
create unique index if not exists tickets_project_number_uidx
  on public.tickets (project_id, ticket_number)
  where ticket_number is not null;

-- `set search_path = ''` is REQUIRED: the Supabase db linter flags
-- `function_search_path_mutable`, and a trigger function running with a
-- caller-controlled search_path is a privilege-escalation surface. Every object
-- below is therefore schema-qualified.
create or replace function public.assign_ticket_number()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only assign when the row belongs to a project and the caller didn't supply
  -- a number itself (the backfill below, and any future data-repair path, may).
  if new.project_id is not null and new.ticket_number is null then
    update public.projects
       set ticket_seq = ticket_seq + 1
     where id = new.project_id
    returning ticket_seq into new.ticket_number;
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_assign_number on public.tickets;
create trigger tickets_assign_number
  before insert on public.tickets
  for each row execute function public.assign_ticket_number();

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Number every existing project-scoped ticket in creation order (id as the
-- tiebreak, so the result is deterministic even for rows sharing a timestamp).
-- Guarded on `ticket_number is null` so a re-run is a no-op rather than a
-- renumbering.
with ordered as (
  select id,
         row_number() over (partition by project_id order by created_at, id) as n
    from public.tickets
   where project_id is not null
)
update public.tickets t
   set ticket_number = ordered.n
  from ordered
 where t.id = ordered.id
   and t.ticket_number is null;

-- Reseed each project's counter to its high-water mark so the first ticket
-- created after this migration continues the sequence instead of colliding
-- with a backfilled row (the unique index would reject it).
update public.projects p
   set ticket_seq = coalesce(
     (select max(t.ticket_number) from public.tickets t where t.project_id = p.id),
     0
   );
