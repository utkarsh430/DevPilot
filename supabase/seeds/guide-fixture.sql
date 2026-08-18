-- The guide fixture: the ONLY data any shipped screenshot is allowed to show.
--
-- ── Why a fixture at all ───────────────────────────────────────────────────
--
-- The app normally runs against the cloud database holding the operator's real
-- projects, tickets and customer issues. "Forgot to switch" is the realistic
-- threat, and a screenshot leaking real content into a shipped manual is not
-- recoverable: the PDF is downloaded, the page is cached, and the discovery is
-- made by a stranger reading the guide.
--
-- `scripts/guide-capture.mjs` refuses to start unless BOTH the Supabase host
-- resolves to localhost AND the resolved tenant equals `GUIDE_FIXTURE_TENANT_ID`
-- in `apps/web/lib/guide/fixture.ts`. This file is what makes the second key
-- satisfiable. Redaction-after-capture was considered and rejected - a human
-- step whose failure is silent and permanent.
--
-- ── Every timestamp is an OFFSET FROM `now()`, deliberately ────────────────
--
-- This is the single least obvious thing in the file, and getting it wrong
-- produces figures that diff on every capture for no reason.
--
-- `relativeTime()` ("3d ago") is called during SERVER render as well as on the
-- client, and the call sites carry `suppressHydrationWarning` - so React keeps
-- the SERVER's string and never rewrites it on hydration. A frozen browser clock
-- therefore CANNOT make those strings deterministic; only the data can.
--
-- Fixed absolute instants would age: a row stamped 2026-05-04 renders as "3d
-- ago" this week and "2mo ago" next month, so the same unchanged UI yields a
-- different PNG every time anyone recaptures. Offsets from `now()` render the
-- SAME string on every run, forever.
--
-- Offsets are also chosen coarsely (`3 days 4 hours`, never `3 days`) so a
-- bucket boundary cannot be crossed between this seed running and the browser
-- painting - that race is what would turn "2m ago" into "3m ago" mid-capture.
--
-- ── Idempotent ─────────────────────────────────────────────────────────────
-- The capture script re-applies this before every run, so it deletes its own
-- rows first. It touches ONLY the fixture tenant; a stray real row is never in
-- scope of any statement here.

begin;

-- ── Identifiers are written as LITERALS, not psql `\set` variables ─────────
-- The capture script applies this file through node-postgres (`pg`), which
-- speaks the wire protocol and does not implement psql's meta-commands - a
-- `\set` here would be a syntax error at exactly the moment the script needs to
-- work. Every uuid mirrors `apps/web/lib/guide/fixture.ts`, and
-- `lib/guide/__tests__/manifest-figures.test.ts` asserts the two agree: two
-- hand-maintained copies of a uuid is precisely the drift that yields an empty
-- board and a capture failure nobody can explain.

-- ── Teardown, fixture-scoped only ──────────────────────────────────────────
--
-- ORDER MATTERS AND IS NOT ARBITRARY. Several of these tables carry no
-- `tenant_id` of their own (`run_steps`, `planning_messages`,
-- `planning_proposed_tickets`, `ticket_dependencies`) and so cannot be deleted
-- by tenant at all - they are reached through their parent, which means every
-- one of them must go BEFORE the parent whose id names it. The `tickets` delete
-- also cascades nothing here by itself, so the rows that point at a ticket are
-- removed explicitly rather than left to a foreign key we have not verified.
delete from public.planning_messages where tenant_id = '9de1de00-0000-4000-a000-000000000001';
delete from public.planning_proposed_tickets where tenant_id = '9de1de00-0000-4000-a000-000000000001';
delete from public.planning_sessions where tenant_id = '9de1de00-0000-4000-a000-000000000001';
delete from public.agent_learnings where tenant_id = '9de1de00-0000-4000-a000-000000000001';
delete from public.agent_mistakes where tenant_id = '9de1de00-0000-4000-a000-000000000001';
delete from public.integration_queue where tenant_id = '9de1de00-0000-4000-a000-000000000001';
delete from public.pending_pushes where tenant_id = '9de1de00-0000-4000-a000-000000000001';
delete from public.comments where tenant_id = '9de1de00-0000-4000-a000-000000000001';
delete from public.ticket_dependencies
 where ticket_id in (select id from public.tickets where tenant_id = '9de1de00-0000-4000-a000-000000000001')
    or blocks_ticket_id in (select id from public.tickets where tenant_id = '9de1de00-0000-4000-a000-000000000001');
delete from public.run_steps
 where run_id in (select id from public.runs where tenant_id = '9de1de00-0000-4000-a000-000000000001');
delete from public.runs     where tenant_id = '9de1de00-0000-4000-a000-000000000001';
delete from public.skills   where tenant_id = '9de1de00-0000-4000-a000-000000000001';
delete from public.tickets  where tenant_id = '9de1de00-0000-4000-a000-000000000001';
delete from public.projects where tenant_id = '9de1de00-0000-4000-a000-000000000001';
delete from public.tenant_members where tenant_id = '9de1de00-0000-4000-a000-000000000001';
delete from public.tenants  where id = '9de1de00-0000-4000-a000-000000000001';

-- ── The operator the capture script signs in as ────────────────────────────
-- Created here rather than by the script so the user id is FIXED: sign-in is
-- magic-link OTP, and GoTrue would otherwise mint a random id on first use that
-- no membership row names. `email_confirmed_at` is set so the OTP is a sign-IN
-- rather than a sign-up confirmation flow.
--
-- THE EMPTY STRINGS ARE LOAD-BEARING. `confirmation_token`, `recovery_token`,
-- `email_change`, `email_change_token_new/current`, `phone_change_token` and
-- `reauthentication_token` are all NULLABLE in the schema, so a hand-written
-- insert leaves them NULL and looks perfectly fine - but GoTrue scans them into
-- non-nullable Go strings and fails the whole lookup. The symptom is a bare
-- `500 {"msg":"Database error finding user"}` from `/auth/v1/otp` with nothing
-- wrong in the row a human would think to inspect, and no mail is ever sent.
insert into auth.users (
  id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at, encrypted_password,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
) values (
  '9de1de00-0000-4000-a000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'guide-capture@example.com', now() - interval '30 days',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Guide Capture"}'::jsonb,
  now() - interval '30 days', now() - interval '30 days',
  extensions.crypt('guide-capture-local-only', extensions.gen_salt('bf')),
  '', '', '', '', '', '', '', ''
)
on conflict (id) do update set
  email = excluded.email,
  encrypted_password = excluded.encrypted_password,
  confirmation_token = '', recovery_token = '', email_change = '',
  email_change_token_new = '', email_change_token_current = '',
  phone_change = '', phone_change_token = '', reauthentication_token = '';

-- ── Drop the personal tenant the signup trigger just created ───────────────
-- `handle_new_user` fires on every `auth.users` insert and mints a tenant named
-- after the account, plus an owner membership. Left in place it gives the
-- capture account TWO reachable tenants, which the capture script's second key
-- correctly refuses to proceed with - the fixture would be unusable.
--
-- The predicate is deliberately narrow, and the narrowness is the point: only a
-- tenant NAMED EXACTLY after the capture email is removed. A real workspace is
-- never named that, so this cannot quietly delete one - and, just as important,
-- it cannot quietly SUPPRESS the second key. If someone adds the capture account
-- to a real tenant, that tenant survives this statement and the script refuses,
-- which is exactly the outcome the key exists to produce.
delete from public.tenant_members m
 using public.tenants t
 where m.tenant_id = t.id
   and m.user_id = '9de1de00-0000-4000-a000-000000000004'
   and t.name = 'guide-capture@example.com';

delete from public.tenants t
 where t.name = 'guide-capture@example.com'
   and not exists (select 1 from public.tenant_members m where m.tenant_id = t.id);

insert into public.tenants (id, name, created_at)
values ('9de1de00-0000-4000-a000-000000000001', 'Harbour Lights Co', now() - interval '30 days');

insert into public.tenant_members (tenant_id, user_id, role)
values ('9de1de00-0000-4000-a000-000000000001', '9de1de00-0000-4000-a000-000000000004', 'owner');

insert into public.projects (
  id, tenant_id, name, description, repo_url, github_owner, github_repo,
  default_branch, integration_branch, created_by, created_at, ticket_seq,
  project_type, auto_land_enabled
) values (
  '9de1de00-0000-4000-a000-000000000002', '9de1de00-0000-4000-a000-000000000001', 'Harbour Lights',
  'A fictional tide-times app. Exists only so the guide has something to show.',
  'https://github.com/harbour-lights/harbour-lights',
  'harbour-lights', 'harbour-lights', 'main', 'dev',
  -- `auto_land_enabled` is TRUE because both create flows arm it at insert
  -- time, so that is what a project a reader just made actually looks like.
  -- Left false, the Branch routing card renders its half-configured warning -
  -- a real and documented state, but not the one a first project is in, and a
  -- figure of it would teach a new reader that their setup is broken.
  '9de1de00-0000-4000-a000-000000000004', now() - interval '21 days', 8, 'web', true
);

-- ── Tickets ────────────────────────────────────────────────────────────────
-- Spread across the lifecycle the guide's first section describes, so the
-- board figure shows the column-IS-state idea rather than a tidy empty board.
-- `column_position` follows the repo's 1024-spacing convention.
--
-- LANDING IS STAMPED IN THE INSERT, NOT BY A FOLLOW-UP UPDATE. `tickets` carries
-- a BEFORE UPDATE `touch_updated_at()` trigger, so ANY later update overwrites
-- `updated_at` with `now()` regardless of what the statement assigns - and the
-- card prints that column as "1m ago". A seed that stamps landing afterwards
-- therefore produces a Done column whose relative times depend on how long
-- elapsed between seeding and the shutter, which is exactly the non-determinism
-- the offsets above exist to remove.
insert into public.tickets (
  id, tenant_id, project_id, ticket_number, title, description,
  status, column_position, requested_role, created_at, updated_at,
  landed_sha, integrated_at
) values
  ('9de1de00-0000-4000-a000-000000000011'::uuid, '9de1de00-0000-4000-a000-000000000001', '9de1de00-0000-4000-a000-000000000002', 1,
   'Cache the tide-table fetch',
   'The station feed is refetched on every render.',
   'backlog', 1024, 'engineer',
   now() - interval '6 days 3 hours', now() - interval '5 days 2 hours',
   null, null),

  ('9de1de00-0000-4000-a000-000000000012'::uuid, '9de1de00-0000-4000-a000-000000000001', '9de1de00-0000-4000-a000-000000000002', 2,
   'Add a harbour picker to the header',
   'Readers land on the wrong harbour and have no way to switch.',
   'ready', 2048, 'frontend_engineer',
   now() - interval '5 days 5 hours', now() - interval '4 days 6 hours',
   null, null),

  ('9de1de00-0000-4000-a000-000000000013'::uuid, '9de1de00-0000-4000-a000-000000000001', '9de1de00-0000-4000-a000-000000000002', 3,
   'Sunrise and sunset alongside each tide',
   'Needs the solar calculation and a compact two-column row.',
   'in_progress', 3072, 'fullstack_engineer',
   now() - interval '4 days 7 hours', now() - interval '3 days 4 hours',
   null, null),

  ('9de1de00-0000-4000-a000-000000000014'::uuid, '9de1de00-0000-4000-a000-000000000001', '9de1de00-0000-4000-a000-000000000002', 4,
   'Which chart datum are the heights measured from?',
   'The feed does not say, and the numbers are unusable without it.',
   'input_required', 4096, 'engineer',
   now() - interval '4 days 2 hours', now() - interval '3 days 8 hours',
   null, null),

  ('9de1de00-0000-4000-a000-000000000015'::uuid, '9de1de00-0000-4000-a000-000000000001', '9de1de00-0000-4000-a000-000000000002', 5,
   'Readable at a glance in bright sun',
   'Contrast and type size for the outdoor case.',
   'in_review', 5120, 'frontend_engineer',
   now() - interval '3 days 6 hours', now() - interval '2 days 5 hours',
   null, null),

  ('9de1de00-0000-4000-a000-000000000016'::uuid, '9de1de00-0000-4000-a000-000000000001', '9de1de00-0000-4000-a000-000000000002', 6,
   'Offline: keep the last fetched table',
   'Signal at the coast is unreliable; a stale table beats a spinner.',
   'done', 6144, 'engineer',
   now() - interval '9 days 4 hours', now() - interval '7 days 3 hours',
   'c0ffee1', now() - interval '7 days 2 hours'),

  ('9de1de00-0000-4000-a000-000000000017'::uuid, '9de1de00-0000-4000-a000-000000000001', '9de1de00-0000-4000-a000-000000000002', 7,
   'Pin the station list to the shipped snapshot',
   'Upstream reordered the list and broke every saved harbour.',
   'done', 7168, 'engineer',
   now() - interval '11 days 2 hours', now() - interval '10 days 6 hours',
   'a91b0d4', now() - interval '10 days 5 hours'),

  -- Done, and its code is NOT on the integration branch. This is the ticket the
  -- "Done is not landed" section exists for, and it is the only one that can
  -- show that chip: `landingCardTreatment` renders nothing at all for a landed
  -- ticket, for one that never had a branch, and for one that has not settled.
  -- So the figure needs a ticket that is settled, HAD a branch, and did not
  -- land - which is exactly the shape that stranded real work.
  ('9de1de00-0000-4000-a000-000000000018'::uuid, '9de1de00-0000-4000-a000-000000000001', '9de1de00-0000-4000-a000-000000000002', 8,
   'Retry the station feed on a 502',
   'The upstream feed 502s under load and the reader sees an empty table.',
   'done', 8192, 'engineer',
   now() - interval '8 days 5 hours', now() - interval '6 days 4 hours',
   null, null);

-- ── Dependencies ───────────────────────────────────────────────────────────
-- Two blocking kinds and one that only refers, so the drawer's relations panel
-- shows the distinction the "what blocks, and what only refers" section makes.
-- A row reads in one direction: `(ticket, blocks_ticket)` records that `ticket`
-- is held by `blocks_ticket`.
insert into public.ticket_dependencies (ticket_id, blocks_ticket_id, relation_type) values
  -- The sunrise/sunset row builds on the harbour picker's branch.
  ('9de1de00-0000-4000-a000-000000000013'::uuid, '9de1de00-0000-4000-a000-000000000012'::uuid, 'builds_on'),
  -- Bright-sun readability cannot start until the picker is finished.
  ('9de1de00-0000-4000-a000-000000000015'::uuid, '9de1de00-0000-4000-a000-000000000012'::uuid, 'blocked_by'),
  -- A reference, and deliberately NOT a blocker - this is the row an @mention
  -- creates, and treating it as one used to wedge tickets with nothing on the
  -- board explaining why.
  ('9de1de00-0000-4000-a000-000000000011'::uuid, '9de1de00-0000-4000-a000-000000000016'::uuid, 'related');

-- ── The thread on the ticket that is waiting for you ───────────────────────
-- `Input required` is an agent asking a question, not a stall, and the section
-- that teaches it is about the reply resuming the run. The thread is what makes
-- that legible.
insert into public.comments (tenant_id, ticket_id, author_type, author_id, body, created_at) values
  ('9de1de00-0000-4000-a000-000000000001', '9de1de00-0000-4000-a000-000000000014'::uuid,
   'agent', 'engineer',
   'The station feed publishes heights as bare numbers with no datum. Chart datum and mean sea level differ by about 2.5m here, so the same number means two very different things on the beach.'
   || E'\n\n' ||
   'Which should the app display? I can also show the datum alongside the height, but that is a UI change I do not want to make without asking.',
   now() - interval '3 days 8 hours');

-- ── Two installed skills ───────────────────────────────────────────────────
-- Installing COPIES the public row into the tenant, body and all - which is
-- why the guide insists an install is a decision about prompt text rather than
-- a subscription. Copied from whichever public rows are present rather than
-- authored here: a hand-written body would be prompt text no reviewer upstream
-- ever saw, sitting in a figure captioned as a first-party skill.
--
-- The names are matched, not assumed. A migration that renames one of these
-- leaves the Installed tab empty and the figure showing a state no reader will
-- have - so if that happens, pick two names that still exist rather than
-- inventing a body.
insert into public.skills (tenant_id, name, version, manifest, body, installed_from_skill_id, targets, triggers)
select '9de1de00-0000-4000-a000-000000000001', s.name, s.version, s.manifest, s.body, s.id, s.targets, s.triggers
  from public.skills s
 where s.tenant_id is null
   and s.name in ('Conventional commits', 'OWASP Top 10 checklist');

-- ── One completed run with steps ───────────────────────────────────────────
-- The "connect a runner" section tells the reader to confirm the run appears
-- with steps accumulating. This is that run.
insert into public.runs (
  id, tenant_id, ticket_id, runner_kind, status, budget_cents, spent_cents,
  fan_out_role, created_at, last_event_at
) values (
  '9de1de00-0000-4000-a000-000000000003', '9de1de00-0000-4000-a000-000000000001', '9de1de00-0000-4000-a000-000000000016'::uuid,
  'local-cc', 'done', 500, 34, 'engineer',
  now() - interval '7 days 6 hours', now() - interval '7 days 3 hours'
);

-- `kind` is constrained to think/tool_call/tool_result/human_wait/system/human,
-- and `lib/runs/queries.ts` selects only the first three for the step tree.
-- `StepTree` titles a step from `payload.text` when present and otherwise
-- stringifies the whole payload - so tool payloads are kept to two short keys.
insert into public.run_steps (run_id, idx, kind, payload, created_at) values
  ('9de1de00-0000-4000-a000-000000000003', 0, 'think',
   '{"text":"Reading the fetch path and the existing cache helper.","model":"claude-sonnet-4-5","cost_cents":6}'::jsonb,
   now() - interval '7 days 5 hours 50 minutes'),
  ('9de1de00-0000-4000-a000-000000000003', 1, 'tool_call',
   '{"tool":"Read","file":"lib/tides/fetch-table.ts"}'::jsonb,
   now() - interval '7 days 5 hours 44 minutes'),
  ('9de1de00-0000-4000-a000-000000000003', 2, 'tool_call',
   '{"tool":"Edit","file":"lib/tides/fetch-table.ts"}'::jsonb,
   now() - interval '7 days 5 hours 31 minutes'),
  ('9de1de00-0000-4000-a000-000000000003', 3, 'tool_call',
   '{"tool":"Bash","command":"pnpm test"}'::jsonb,
   now() - interval '7 days 5 hours 12 minutes'),
  ('9de1de00-0000-4000-a000-000000000003', 4, 'tool_result',
   '{"tool":"Bash","exit_code":0,"summary":"41 passed"}'::jsonb,
   now() - interval '7 days 5 hours 9 minutes'),
  ('9de1de00-0000-4000-a000-000000000003', 5, 'think',
   '{"text":"Tests pass. Handing the ticket to QA.","model":"claude-sonnet-4-5","cost_cents":5}'::jsonb,
   now() - interval '7 days 5 hours 4 minutes');

-- ── One run that FAILED, and says why ──────────────────────────────────────
-- The troubleshooting section is about signals, and the signal it teaches to
-- read first is the run inspector rather than the column. A guide that only
-- ever shows a green run has not shown the reader the screen they will actually
-- open when something is wrong.
--
-- THE THREE NUMBERS ON THIS ROW HAVE TO AGREE WITH EACH OTHER, and the first
-- cut of it did not: it said `timed out after 1h` above `240m00s elapsed`, a
-- run that supposedly gave up after an hour and then ran for four. All three
-- come from `run-agent.ts`, and the mechanism is what fixes them:
--
--   * THE 1h IS PER STEP, NOT PER RUN. `LOCAL_CC_TIMEOUT` is the `waitForEvent`
--     ceiling on ONE step's `runner/step-result`. So elapsed is "everything
--     that already finished, PLUS one hour" - always somewhat OVER an hour,
--     never a multiple of it. Here: iteration 0 completes in 9 minutes,
--     iteration 1 is enqueued and never answered, and the engine gives up 1h
--     later. 9 + 60 = 69 minutes, which is what the inspector prints.
--
--   * THE STEP THAT TIMED OUT HAS NO ROW. `run_steps` is inserted AFTER a step
--     returns, so the iteration that hung left nothing behind. The four rows
--     below are iteration 0's think plus its tool calls; the one named in the
--     message is the NEXT one, which is why this says `step 1` and not
--     `step 3`. Numbering the message at an idx that exists is the mistake
--     that reads as plausible and is wrong.
--
--   * `spent_cents` IS ONLY ITERATION 0's. A step that never returned reported
--     no usage, so nothing was billed for the hour spent waiting on it.
insert into public.runs (
  id, tenant_id, ticket_id, runner_kind, status, budget_cents, spent_cents,
  fan_out_role, status_reason, created_at, last_event_at
) values (
  '9de1de00-0000-4000-a000-000000000005', '9de1de00-0000-4000-a000-000000000001', '9de1de00-0000-4000-a000-000000000018'::uuid,
  'local-cc', 'failed', 500, 21, 'engineer',
  'local-cc step 1 timed out after 1h',
  now() - interval '6 days 9 hours', now() - interval '6 days 7 hours 51 minutes'
);

-- Iteration 0, start to finish: the think, then the three tools it called. All
-- inside the first nine minutes, because everything after that is the engine
-- waiting on an iteration that never came back.
insert into public.run_steps (run_id, idx, kind, payload, created_at) values
  ('9de1de00-0000-4000-a000-000000000005', 0, 'think',
   '{"text":"Looking at how the feed client handles a non-200.","model":"claude-sonnet-4-5","cost_cents":7}'::jsonb,
   now() - interval '6 days 8 hours 57 minutes'),
  ('9de1de00-0000-4000-a000-000000000005', 1, 'tool_call',
   '{"tool":"Read","file":"lib/tides/feed-client.ts"}'::jsonb,
   now() - interval '6 days 8 hours 55 minutes'),
  ('9de1de00-0000-4000-a000-000000000005', 2, 'tool_call',
   '{"tool":"Edit","file":"lib/tides/feed-client.ts"}'::jsonb,
   now() - interval '6 days 8 hours 53 minutes'),
  ('9de1de00-0000-4000-a000-000000000005', 3, 'tool_call',
   '{"tool":"Bash","command":"pnpm test lib/tides"}'::jsonb,
   now() - interval '6 days 8 hours 51 minutes');

-- ── Work that is committed and has reached nobody ──────────────────────────
-- A `pending_pushes` row is what puts a ticket in the Changes queue, and it
-- exists only because the tracker found commits the remote does not have. This
-- one belongs to the stranded ticket above, so ONE fixture ticket carries the
-- whole "Done, but the code is still on the runner" story: a queue row to
-- review and a chip on the card saying so.
--
-- `workspace_path` names a directory that does not exist on any machine. That
-- is correct rather than sloppy: every reader of a stored workspace path
-- classifies it before touching it, and a path under a real workspace root
-- would invite a capture run to git-exec against a real checkout.
insert into public.pending_pushes (
  id, tenant_id, project_id, ticket_id, run_id, workspace_path, branch,
  unpushed_count, files_changed, unified_diff, head_sha, created_at, updated_at
) values (
  '9de1de00-0000-4000-a000-000000000006', '9de1de00-0000-4000-a000-000000000001',
  '9de1de00-0000-4000-a000-000000000002', '9de1de00-0000-4000-a000-000000000018'::uuid,
  '9de1de00-0000-4000-a000-000000000005',
  '/nonexistent/guide-fixture/workspaces/9de1de00-0000-4000-a000-000000000018',
  'devpilot/retry-the-station-feed-on-a-502',
  2,
  '[{"path":"lib/tides/feed-client.ts","additions":34,"deletions":6},{"path":"lib/tides/__tests__/feed-client.test.ts","additions":58,"deletions":0}]'::jsonb,
  '--- a/lib/tides/feed-client.ts' || E'\n' || '+++ b/lib/tides/feed-client.ts' || E'\n' ||
  '@@ -12,6 +12,14 @@' || E'\n' ||
  '-  const res = await fetch(url);' || E'\n' ||
  '+  const res = await fetchWithRetry(url, { retryOn: [502, 503], attempts: 3 });' || E'\n',
  'b4d51ce',
  now() - interval '6 days 5 hours', now() - interval '6 days 5 hours'
);

-- ── The landing that failed ────────────────────────────────────────────────
-- Every landing failure IS recorded; the defect that motivated the chip was
-- that none of it reached the board. `last_error` is what the card prints
-- verbatim, so it is written here the way the worker would write it.
insert into public.integration_queue (
  id, tenant_id, project_id, ticket_id, status, attempts, last_error,
  enqueued_at, created_at, updated_at
) values (
  '9de1de00-0000-4000-a000-000000000008', '9de1de00-0000-4000-a000-000000000001',
  '9de1de00-0000-4000-a000-000000000002', '9de1de00-0000-4000-a000-000000000018'::uuid,
  'failed', 3,
  'push rejected: refusing to allow an OAuth App to create or update workflow `.github/workflows/tides.yml` without `workflow` scope',
  now() - interval '6 days 4 hours', now() - interval '6 days 4 hours', now() - interval '6 days 3 hours'
);

-- ── A finished plan session ────────────────────────────────────────────────
-- Plan mode is four phases and the section says the Review phase is the one to
-- actually read - so the session is left AT that phase, `planned` and not yet
-- committed, which is the state the reader will be looking at when they have a
-- decision to make.
insert into public.planning_sessions (
  id, tenant_id, project_id, created_by, goal_summary, status, stack_flavor,
  team_tier, spent_cents, created_at, updated_at
) values (
  '9de1de00-0000-4000-a000-000000000007', '9de1de00-0000-4000-a000-000000000001',
  '9de1de00-0000-4000-a000-000000000002', '9de1de00-0000-4000-a000-000000000004',
  'Let a reader save a harbour and see its week at a glance',
  'planned', 'mixed', 'standard', 18,
  now() - interval '2 days 7 hours', now() - interval '2 days 5 hours'
);

insert into public.planning_messages (session_id, tenant_id, role, content, agent_role, created_at) values
  ('9de1de00-0000-4000-a000-000000000007', '9de1de00-0000-4000-a000-000000000001',
   'user',
   'I want a reader to save the harbour they care about and land straight on its week, without picking it again every visit.',
   null, now() - interval '2 days 7 hours'),
  ('9de1de00-0000-4000-a000-000000000007', '9de1de00-0000-4000-a000-000000000001',
   'assistant',
   'Two things worth settling before I draft tickets. Is a saved harbour per-device or tied to an account? And should the week view be seven days from today, or a calendar week starting Monday?',
   'tech_lead', now() - interval '2 days 6 hours 40 minutes'),
  ('9de1de00-0000-4000-a000-000000000007', '9de1de00-0000-4000-a000-000000000001',
   'user',
   'Per-device is fine for now, no accounts. Seven days from today.',
   null, now() - interval '2 days 6 hours 20 minutes');

-- `depends_on_ordinals` is what makes the committed backlog dependency-ordered
-- rather than a flat list, so the fixture carries a real chain: nothing can be
-- drafted before the store exists, and the week view needs the range query.
insert into public.planning_proposed_tickets (
  session_id, tenant_id, ordinal, title, description, acceptance_criteria,
  requested_role, depends_on_ordinals, selected
) values
  ('9de1de00-0000-4000-a000-000000000007', '9de1de00-0000-4000-a000-000000000001', 1,
   'Persist the chosen harbour on the device',
   'A small typed wrapper over local storage, with a migration path if the shape changes.',
   E'- Choosing a harbour survives a reload\n- An unreadable stored value falls back to the default rather than throwing',
   'frontend_engineer', '{}', true),
  ('9de1de00-0000-4000-a000-000000000007', '9de1de00-0000-4000-a000-000000000001', 2,
   'Land on the saved harbour instead of the picker',
   'Route the reader straight to their harbour when one is stored.',
   E'- A returning reader sees their harbour with no interaction\n- A first-time reader still sees the picker',
   'frontend_engineer', '{1}', true),
  ('9de1de00-0000-4000-a000-000000000007', '9de1de00-0000-4000-a000-000000000001', 3,
   'Seven-day tide range query',
   'Extend the table fetch to a range rather than a single day.',
   E'- Returns seven days from today in one request\n- A partial upstream response is reported, never silently padded',
   'backend_engineer', '{}', true),
  ('9de1de00-0000-4000-a000-000000000007', '9de1de00-0000-4000-a000-000000000001', 4,
   'The week view',
   'A compact seven-row summary with the day, both highs and both lows.',
   E'- Readable on a phone in one screen\n- Today is visually distinct from the rest of the week',
   'frontend_engineer', '{2,3}', true);

-- ── The mistake a lesson was drawn from ────────────────────────────────────
-- A lesson without its source renders "Source mistake no longer available",
-- which is a REAL state - a mistake can be reaped - but it is a degraded one,
-- and a figure of it would teach the reader that the provenance panel is broken.
-- The queue's whole argument is that you can check what a lesson was drawn from
-- before you approve it, so the fixture has to carry the thing being checked.
insert into public.agent_mistakes (
  id, tenant_id, role, ticket_id, run_id, type, counts_against_score,
  severity, evidence, dedupe_key, created_at
) values (
  '9de1de00-0000-4000-a000-000000000009', '9de1de00-0000-4000-a000-000000000001',
  'engineer', '9de1de00-0000-4000-a000-000000000018'::uuid, '9de1de00-0000-4000-a000-000000000005',
  'verification_fail', true, 2,
  '{"command":"pnpm test","exitCode":1,"outputTail":"FAIL lib/tides/__tests__/feed-client.test.ts\n  2 failed, 39 passed"}'::jsonb,
  'verification_fail:9de1de00-0000-4000-a000-000000000005',
  now() - interval '6 days 5 hours'
);

-- ── Lessons waiting for a human ────────────────────────────────────────────
-- The review queue is the whole safety story for lessons: an approved lesson
-- becomes standing guidance on every future run, so nothing reaches that state
-- without somebody saying yes. Left as `candidate` on purpose - an empty queue
-- is the one state that teaches nothing.
--
-- Three confidences, deliberately. The grade is what makes a forty-candidate
-- queue reviewable, and a fixture where everything is High would show the
-- triage affordance with nothing to triage.
insert into public.agent_learnings (
  tenant_id, scope, role_slug, category, body, status, confidence,
  confidence_reason, source_mistake_id, created_by, created_at
) values
  ('9de1de00-0000-4000-a000-000000000001', 'role', 'engineer', 'verification',
   'Run the test command from the repository root before handing a ticket to QA. Twice now a ticket was handed over with a failing suite that passed when run from inside a package directory.',
   'candidate', 'high',
   'Two separate rejections with the same cause, and the fix is a concrete command rather than a disposition.',
   '9de1de00-0000-4000-a000-000000000009', 'lesson_extractor', now() - interval '2 days 4 hours'),
  ('9de1de00-0000-4000-a000-000000000001', 'global', null, 'scope',
   'When the upstream feed shape is undocumented, record what was observed in a comment on the ticket rather than encoding the assumption silently in a type.',
   'candidate', 'medium',
   'Drawn from one incident, and the right scope is arguable - it may belong to the backend roles rather than everybody.',
   null, 'lesson_extractor', now() - interval '2 days 2 hours'),
  ('9de1de00-0000-4000-a000-000000000001', 'user', null, 'preference',
   'Prefer adding a test beside the code it covers over a separate integration suite, unless the ticket asks otherwise.',
   'candidate', 'low',
   'A single observation of the operator moving a test file; may be a one-off rather than a preference.',
   null, 'lesson_extractor', now() - interval '1 day 20 hours');

commit;
