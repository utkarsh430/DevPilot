-- =============================================================================
-- Migration : 20260758000000_supervisor_console_messages.sql
-- Phase     : the supervisor console's conversation - durable, per project, and
--             the missing half of the `supervisor_actions` audit trail.
--
-- Why
-- ───
-- The console shipped with no persistence at all: no table, no thread, no
-- history module. Every reload started empty. Two costs, and the second is the
-- one that matters.
--
--  1. The operator loses the thread. They ask "why is nothing moving", read the
--     answer, go and look at a ticket, come back - and the console has
--     forgotten both the question and the answer.
--
--  2. THE AUDIT TRAIL IS HALF A TRAIL. `supervisor_actions` records every
--     commanded fix with its cause, precisely because an operator hand-swept
--     one board about six times in a day and every sweep hid a WIP-slot leak
--     (see 20260756000000 §2). But the console's whole design is that the
--     TARGET of a command comes from the operator's own words - the server
--     re-parses their message to derive which ticket they named - and those
--     words were held only in browser memory. So the ledger could say "ticket
--     47 was recovered by operator X" and nothing anywhere could say what they
--     had asked, or what the console had told them, when they decided to.
--
-- What this adds
-- ──────────────
--  1. public.supervisor_console_messages - the transcript. Tenant- AND
--     project-scoped, append-only in practice.
--  2. supervisor_actions.console_message_id - the link from a commanded fix to
--     the operator message that caused it.
--
-- No `projects` column, so `shell_bootstrap()` is deliberately NOT rewritten
-- here - the PROJECT_COLUMNS sync obligation (20260756000000 §4) does not apply.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. supervisor_console_messages - one row per turn.
--
--    SCOPED TO A PROJECT, not to a tenant or to a user. The console reads ONE
--    board and every answer it gives is about that board, so a thread that
--    spanned projects would replay an explanation of a different board into the
--    model's context as though it were history. Not per-user either: the
--    console is an operations surface and "what did we already ask about this
--    board" is a question the next operator on shift needs answered too - the
--    same reasoning that makes `supervisor_actions` tenant-scoped rather than
--    private to whoever ran the fix.
--
--    APPEND-ONLY IN PRACTICE. Nothing in the app updates a row; a turn is a
--    record of what was said, and editing one would make the ledger link below
--    a link to text that has since changed. RLS denies every JWT write, so the
--    only writer is the service role via the console's own server actions.
-- ---------------------------------------------------------------------------
create table if not exists public.supervisor_console_messages (
  id          uuid        primary key default gen_random_uuid(),

  tenant_id   uuid        not null references public.tenants(id)  on delete cascade,
  project_id  uuid        not null references public.projects(id) on delete cascade,

  -- Who said it. Two values only: the human, and the console. Text with a
  -- CHECK rather than an enum, matching `supervisor_actions.cause` and
  -- `tickets.paused_reason` - a third speaker would be a code change.
  role        text        not null
                constraint chk_console_messages_role
                  check (role in ('operator', 'console')),

  -- WHAT KIND of turn, for the audit half rather than for rendering.
  --
  --   ask            - the operator's own message
  --   answer         - a grounded model reply
  --   model_failure  - the model was unreachable, or answered unusably
  --   notice         - something the console said without the model (e.g. "that
  --                    is not a ticket on this board")
  --   action_result  - the outcome of a command or recovery action
  --
  -- Load-bearing for reading the trail back: "the operator commanded a recovery
  -- immediately after the model failed" and "…after the console recommended it"
  -- are different stories, and `role` alone cannot tell them apart.
  kind        text        not null
                constraint chk_console_messages_kind
                  check (kind in ('ask', 'answer', 'model_failure', 'notice', 'action_result')),

  -- The text, as it was shown. Bounded by the application before it arrives
  -- here; the CHECK only refuses an empty turn, which would be a bug rather
  -- than a message.
  body        text        not null
                constraint chk_console_messages_body
                  check (length(btrim(body)) > 0),

  -- Who typed it, for an operator turn. NULL for a console turn - nobody typed
  -- those. `auth.users` carries no tenant_id of its own, so this FK is outside
  -- the assert_tenant_matches_parent class (same as `deployments.promoted_by`).
  author_user_id uuid     references auth.users(id) on delete set null,

  created_at  timestamptz not null default now()
);

comment on table public.supervisor_console_messages is
  'Durable transcript of the supervisor console, per project. Both halves of '
  'the conversation are DATA, never instructions: an operator turn can contain '
  'a pasted agent comment and a console turn is model output, so both are '
  'fenced and bounded wherever they re-enter a prompt (principle 6). Rows are '
  'append-only; supervisor_actions.console_message_id points back at the '
  'operator message that caused a commanded fix.';

comment on column public.supervisor_console_messages.body is
  'UNTRUSTED. Operator text may quote agent-authored content and console text '
  'IS model output. Fence and bound before replaying into any prompt.';

-- RLS mirrors `supervisor_actions` exactly: member SELECT (this is the
-- operator's own conversation and the readable half of their audit trail),
-- every JWT write denied. A browser-writable transcript would let a client
-- forge the message a commanded fix is attributed to - which is precisely the
-- provenance this table exists to establish - and, worse, DELETE the record of
-- what was asked before a sweep.
alter table public.supervisor_console_messages enable row level security;

drop policy if exists supervisor_console_messages_member_read on public.supervisor_console_messages;
create policy supervisor_console_messages_member_read
  on public.supervisor_console_messages
  for select
  using (tenant_id in (select public.current_user_tenants()));

drop policy if exists supervisor_console_messages_insert_deny on public.supervisor_console_messages;
create policy supervisor_console_messages_insert_deny
  on public.supervisor_console_messages for insert with check (false);

drop policy if exists supervisor_console_messages_update_deny on public.supervisor_console_messages;
create policy supervisor_console_messages_update_deny
  on public.supervisor_console_messages for update using (false);

drop policy if exists supervisor_console_messages_delete_deny on public.supervisor_console_messages;
create policy supervisor_console_messages_delete_deny
  on public.supervisor_console_messages for delete using (false);

-- EXPLICIT GRANTS, and they are not boilerplate - a policy without a table
-- grant is a dead policy, and this was REPRODUCED on the local dev database
-- while writing this migration: `service_role` came back holding only
-- REFERENCES/TRIGGER/TRUNCATE, so the first transcript write returned 42501.
--
-- AGENTS.md already records the class (six existing tables whose creating
-- migrations never granted explicitly and which work only because Supabase's
-- hosted setup auto-grants; a fresh or self-hosted deploy does not). Repairing
-- those six belongs in its own PR. NOT repeating the mistake on a new table
-- belongs here.
--
-- `service_role` gets the writes because every path to this table is
-- service-role (the RLS policies above deny every JWT write). `authenticated`
-- gets SELECT ONLY, which is exactly what `supervisor_console_messages_member_
-- read` permits - the grant is the outer door and the policy is the inner one,
-- and both have to be open for a member to read their own conversation.
grant select, insert, update, delete on public.supervisor_console_messages to service_role;
grant select on public.supervisor_console_messages to authenticated;

-- The only read path: "this project's thread, newest first, bounded". Both the
-- reload and the model-context replay are this query with different limits.
create index if not exists idx_console_messages_project_recent
  on public.supervisor_console_messages (tenant_id, project_id, created_at desc);

-- Tenant-matches-parent trigger (the 20260732000000 convention). `project_id`
-- points at a tenant-scoped parent and this child carries its own tenant_id, so
-- it is in the class; the derived list in
-- lib/security/__tests__/tenant-scope-scan.test.ts FAILS on a gap. Regenerate
-- scripts/audit-tenant-parent-mismatches.sql after applying.
--
-- (`tenant_id → tenants` is not in the class - `tenants` has no tenant_id of its
-- own. `author_user_id → auth.users` is not either, for the same reason.)
drop trigger if exists trg_console_messages_project_id_tenant on public.supervisor_console_messages;
create trigger trg_console_messages_project_id_tenant
  before insert or update of tenant_id, project_id on public.supervisor_console_messages
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

-- ---------------------------------------------------------------------------
-- 2. supervisor_actions.console_message_id - the link.
--
--    NULLABLE, and it will legitimately be null for most rows: the AUTONOMOUS
--    supervisor commands nothing and is caused by no message, and an operator
--    can run a recovery action from the report without having asked anything.
--    A null means "no conversation caused this", which is a true statement
--    about every autonomous fix.
--
--    `on delete set null`, not cascade: deleting a message must never delete
--    the record of a fix. The ledger is the durable artifact; the transcript is
--    context for it.
--
--    THE LINK IS ONLY WRITTEN WHEN IT CAN BE PROVEN - see
--    `decideConsoleMessageLink` in lib/supervisor/console-history.ts. The client
--    supplies a message id alongside the question the target was derived from,
--    and the link is recorded only if the STORED message says the same thing.
--    An audit trail that can be pointed at an unrelated message is worse than
--    one with a gap in it, because the gap is visible and the wrong link is not.
-- ---------------------------------------------------------------------------
alter table public.supervisor_actions
  add column if not exists console_message_id uuid
    references public.supervisor_console_messages(id) on delete set null;

comment on column public.supervisor_actions.console_message_id is
  'The operator console message that caused this fix, when one did. NULL for '
  'every autonomous remediation and for any action run outside a conversation. '
  'Written only when the stored message is provably the text the command''s '
  'target was derived from.';

create index if not exists idx_supervisor_actions_console_message
  on public.supervisor_actions (console_message_id)
  where console_message_id is not null;

-- In the tenant-matches-parent class: the parent is tenant-scoped and carries
-- its own tenant_id, so a link across tenants must be unrepresentable rather
-- than merely unwritten by today's code.
drop trigger if exists trg_supervisor_actions_console_message_id_tenant on public.supervisor_actions;
create trigger trg_supervisor_actions_console_message_id_tenant
  before insert or update of tenant_id, console_message_id on public.supervisor_actions
  for each row execute function public.assert_tenant_matches_parent(
    'console_message_id', 'supervisor_console_messages');

commit;
