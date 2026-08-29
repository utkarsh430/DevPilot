-- Seed 40 first-party skills, batch 2.
--
-- WHAT THIS IS. The M11 marketplace seeded twelve skills against the eight
-- roles that existed then (20260603090000). Phase 2 added ~43 more roles;
-- 20260744000000 realigned the twelve onto the roles that exist, and recorded
-- three roles (`sre`, `release_engineer`, `platform_engineer`) as
-- DELIBERATELY_UNCOVERED because "the skill that would fit does not exist
-- yet". This batch is those skills, and thirty-seven more.
--
-- WHAT A BODY IS, AND THEREFORE WHAT IT MAY SAY. `lib/skills/merge.ts` splices
-- a selected body into the role's SYSTEM PROMPT behind a fence stating that
-- skills are guidance which does NOT grant tools, does NOT change the ticket
-- state machine, and does NOT override the role's MCP-tool contract. Every
-- body below is therefore phrased as something to CHECK or PRODUCE. None
-- instructs a status transition, and none names a tool the targeted role does
-- not already hold.
--
-- THE BAR EACH ONE CLEARED. A skill costs prompt budget on every dispatch of
-- every role it targets, and `lib/skills/select.ts` fires only the top three —
-- so a mediocre skill does not merely waste budget, it wins a slot from a good
-- one. Each body below therefore had to answer "what goes wrong without it,
-- and why does the role prompt not already say it". Bodies that restated a
-- role prompt, or that described a failure nobody had observed, were cut
-- rather than seeded; the cut list and its reasoning are in the PR body.
--
-- VERSION 1.0.0, AND WHY THAT IS SAFE HERE. `installSkillAction` is idempotent
-- on (tenant_id, name, version) and COPIES the body into the tenant's own row
-- at install time, so a same-version body edit reaches nobody who already
-- installed. These are all NEW names, so no tenant holds a clone of any of
-- them and there is nothing to migrate. That changes the moment one of these
-- bodies is revised: a revision needs a version bump AND a migration over
-- tenant clones scoped to `(tenant_id is null or installed_from_skill_id is
-- not null)` — see 20260744000000, whose scoping predicate exists because an
-- operator may author their own skill of the same name and it must never be
-- rewritten.
--
-- IDEMPOTENT, AND *NOT* VIA `on conflict`. `public.skills` carries
-- `unique (tenant_id, name, version)` (20260601000000), which looks like it
-- makes a public seed row unique and DOES NOT: Postgres treats NULLs as
-- DISTINCT in a unique constraint, and every public row has `tenant_id IS
-- NULL`. So two inserts of the same public skill both succeed, and an
-- `on conflict (tenant_id, name, version)` clause would never fire for these
-- rows — it would read as a guard while being decoration. The insert below is
-- therefore guarded by an explicit `where not exists` on
-- (tenant_id is null, name, version), which is the predicate the constraint
-- cannot express. Recommended follow-up, deliberately NOT done here because it
-- would fail closed against a database this change cannot inspect: a partial
-- `unique (name, version) where tenant_id is null` index, so the duplicate is
-- unrepresentable rather than merely avoided by every writer remembering.
--
-- Targets are mirrored in apps/web/lib/skills/first-party-targets.ts and the
-- two are drift-asserted by
-- apps/web/lib/skills/__tests__/first-party-targets.test.ts, which also fails
-- on any target naming a role slug that does not exist. That assertion is the
-- whole reason the module exists: exact-slug matching drifts SILENTLY, which
-- is how the original twelve survived ~43 role additions unnoticed.

insert into public.skills (tenant_id, name, version, manifest, targets, triggers, body)
select s.tenant_id, s.name, s.version, s.manifest, s.targets, s.triggers, s.body
from (values

-- ===========================================================================
-- Core engineering
-- ===========================================================================

  (
    null::uuid,
    'Use-server export rule',
    '1.0.0',
    jsonb_build_object(
      'summary', 'A "use server" file may export only async functions; anything else breaks every server action on the importing route, at runtime only.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["engineer","backend_engineer","fullstack_engineer","frontend_engineer","staff_engineer"]'::jsonb,
    '["server action","actions.ts","use server","form","zod","schema","mutation"]'::jsonb,
    $skill$SKILL — "use server" export rule:
A file whose first line is `"use server"` may export ONLY async functions.
Exporting a const, an object, a Zod schema, a type-with-value, or a class
throws at RUNTIME — and it poisons the server-action manifest of EVERY route
that imports the file, disabling all server actions on those routes, not just
the offending export.
Nothing catches it. Build, typecheck, lint and the unit suite all pass. It
surfaces only when an authed page is loaded in a running app, which is why it
has shipped latent for days before.
So, whenever you add or edit a file under a `"use server"` directive:
  1. Check every export. If it is not `export async function`, it does not
     belong in this file.
  2. Move the schema / constant / type to a sibling module without the
     directive and re-import it. Do not delete it and inline it.
  3. State in your hand-off comment which `"use server"` files you touched
     and that every export in them is an async function.
The same rule applies to a file you merely ADD an export to — the violation is
a property of the file, not of your diff.$skill$
  ),

  (
    null,
    'Build-time env is a cache key',
    '1.0.0',
    jsonb_build_object(
      'summary', 'A new NEXT_PUBLIC_* var must be declared in turbo.json''s build env, or builds from different environments share a cache key.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["frontend_engineer","fullstack_engineer","backend_engineer"]'::jsonb,
    '["env","NEXT_PUBLIC","environment variable","config","turbo","build","client"]'::jsonb,
    $skill$SKILL — A new NEXT_PUBLIC_* var is also a turbo.json change:
Next inlines `NEXT_PUBLIC_*` values into the browser bundle at BUILD time. If
the variable is not in the `env` array of `turbo.json`'s `build` task, two
builds made under different environments hash identically — so a cached build
from a different environment can be replayed onto yours, with the wrong value
baked into the chunks.
The symptom is never an error at build time. It is a bundle that builds green
and fails at first page load, with a message that points at the consuming
library rather than at the cache.
So, when you add a `NEXT_PUBLIC_*` variable:
  1. Add its exact name to `turbo.json` -> `tasks.build.env`. The list is
     hand-maintained; nothing derives it, and nothing warns you.
  2. Add it to `.env.example` with a one-line comment, as every other var
     there has.
  3. Do not remove `.env.local` from that task's `inputs`. It is there so the
     FILE's content is part of the key — `env` alone hashes only variables
     present in the shell that invokes the build, and the framework reads the
     dotenv inside the child process where the cache tool cannot see it.
Say in your hand-off that you updated turbo.json, so the reviewer can see both
halves landed together.$skill$
  ),

  (
    null,
    'A control that exists is not a control that runs',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Before relying on a named guard, confirm it has a caller, a refusing path, and inputs something actually produces.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["tech_lead","staff_engineer","software_architect"]'::jsonb,
    '["gate","guard","review","risk","flag","enforce","check","validate","adr","pre-merge"]'::jsonb,
    $skill$SKILL — A control that exists is not a control that runs:
The recurring high-cost defect in this codebase is not a missing guard. It is
a guard that exists, is named, is rendered in the UI or cited in a review, and
does nothing. Each of these shipped and was believed for a while:
  - a stamp function with a complete doc comment and ZERO call sites;
  - an enforcement gate switched on while the process that supplies its
    evidence was configured separately and off — so the gate, which fails open
    on a missing record, allowed everything;
  - a per-agent model field written by two editors and rendered as a badge,
    while being a documented no-op on the path that actually runs.
When your work depends on a guard — or when you name one as a pre-merge gate,
a mitigation, or an ADR consequence — establish three things and say which:
  1. It has a CALL SITE. Grep for it. A function nothing calls is
     documentation.
  2. It has a REFUSING path, and something exercises it. A gate that has never
     returned "no" has not been shown to be able to.
  3. Its INPUTS are actually produced. A check that fails open on absent
     evidence is only as strong as whatever writes that evidence, which is
     often a different process with its own configuration.
Write the gate as a command someone runs, not as a name. "CI will catch it" is
a claim about a specific workflow file — read it before you make it.$skill$
  ),

-- ===========================================================================
-- Infrastructure and data
-- ===========================================================================

  (
    null,
    'Deploy smoke check',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Prove a deploy actually serves the app before reporting it as deployed.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["devops","cloud_engineer","platform_engineer"]'::jsonb,
    '["deploy","vercel","production","preview","ship","release","rollout"]'::jsonb,
    $skill$SKILL — Deploy smoke check:
A deploy that returns a URL has not been verified. The CLI exits 0 when the
BUILD succeeded, which is a different claim from "the app works".
Before you report a deploy as done:
  1. FETCH the deployed URL over HTTP. A 200 with real content, not just a
     process exit code.
  2. Fetch a route that exercises the real app, not only `/` and `/login`.
     Those two are the cheapest thing to check and the least likely to break:
     an unauthenticated request to an authed route redirects to the login page
     WITHOUT loading that route's server module, so a route-wide server
     failure returns a clean 307 and looks healthy. If everything you can
     reach unauthenticated is a redirect, say in your report that you could
     not verify the authed surface — do not let the redirect stand in as
     evidence.
  3. Confirm the page does not fail on client boot. Build-time values are
     inlined into the bundle when it is built, so a bundle built without them
     (or with another environment's values) deploys successfully and then
     fails at first page load, with nothing wrong at deploy time. An error
     naming a missing URL or key at page load means the BUILD had the wrong
     environment; re-deploying the same bundle reproduces it exactly.
  4. Report the URL, its label (preview or production), and what you observed
     when you fetched it. A bare URL is not a result.
If you cannot verify, report the deploy as UNVERIFIED and say what you could
not check. A URL that returns 500 is a failed deploy whatever the CLI printed.$skill$
  ),

  (
    null,
    'Constraint audit before a schema change',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Read the constraints already on a table before changing what it may hold.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["dba","dataeng","analytics_engineer"]'::jsonb,
    '["migration","constraint","unique","index","schema","alter table","cardinality"]'::jsonb,
    $skill$SKILL — Constraint audit before a schema change:
Before a migration changes WHAT A TABLE MAY HOLD — a new unique key, a relaxed
one, a column that changes how many rows per parent are legal — read the
constraints and indexes that already exist on that table, from the live
catalog, not from the migration file you happen to be looking at.
  1. List what is really there:
       select conname, pg_get_constraintdef(oid) from pg_constraint
         where conrelid = '<table>'::regclass;
       select indexname, indexdef from pg_indexes where tablename = '<table>';
     A constraint declared inline in an old CREATE TABLE is easy to miss by
     reading migrations in order, and it is exactly the one that bites.
  2. If a pre-existing constraint contradicts the new cardinality, DROP IT IN
     THE SAME MIGRATION, using the name you just read from the catalog. Never
     a guessed `drop constraint if exists <name>` — a wrong name silently
     succeeds and changes nothing, leaving you certain you handled it.
  3. Say in your comment which constraints you read, which you dropped, and
     which you deliberately kept.
This failure is invisible to unit tests. Pure tests never touch a real unique
index, so a suite can be entirely green while every insert the change was
written to enable is being rejected. If the calling code catches write errors
best-effort and continues, nothing surfaces at all: the operation reports
success and persists zero rows.$skill$
  ),

  (
    null,
    'Build cache and environment',
    '1.0.0',
    jsonb_build_object(
      'summary', 'A cached build can be the wrong build; prove which environment was inlined.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["platform_engineer"]'::jsonb,
    '["turbo","cache","build","ci","pipeline","monorepo","env"]'::jsonb,
    $skill$SKILL — Build cache and environment:
A build cache keys on what the cache tool can SEE. Values a framework loads
inside the build child process — a gitignored dotenv the bundler reads itself
— are invisible to the parent, so two builds with completely different
environments can hash identically and replay each other's output.
When you touch build-cache configuration:
  1. Declaring the variable names in the task's `env` list is necessary and
     NOT sufficient. `env` hashes variables present in the SHELL that invokes
     the build; it does nothing for values read from a file inside the child.
     For those, the FILE must be a cache input, so its CONTENT is part of the
     key. A gitignored dotenv listed under `inputs` is that fix, not a mistake
     to tidy away.
  2. Prove the fix with a test that a broken implementation fails. Build with
     environment A, then B: that must be a cache MISS with B's values in the
     output. Then re-run A: that must be a cache HIT with the SAME hash as the
     first run. A change that only ever misses has not fixed caching, it has
     disabled it, and both look "fixed" if you only check the miss.
  3. Any inlined value belongs in the cache key. If a value ends up in a built
     artifact, a build with a different value is a different build.
When you are investigating a suspect build rather than configuring one: a full
cache hit right after a change is itself the alarm. Confirming the new CODE is
present does not tell you which ENVIRONMENT was inlined beside it — grep the
built output for the value you expect and for the one you don't.$skill$
  ),

  (
    null,
    'Schema is not shipped by a deploy',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Merging and deploying code does not apply the migration; do not report the feature live.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["dba","dataeng","analytics_engineer","devops"]'::jsonb,
    '["migration","deploy","live","schema","release","ship","rollout"]'::jsonb,
    $skill$SKILL — Schema is not shipped by a deploy:
Shipping code and changing a database are separate acts. A merge and a
redeploy carry the application only: the migration file travels with the code
and is not applied by arriving. Until it is applied, the feature is not live
no matter how green the deploy was.
  1. When your change includes a migration, say so explicitly in your comment,
     name the file, and state that the change is NOT live until the migration
     is applied to the target database. Applying it is a separate,
     human-gated step — do not run it against a production database yourself
     and do not describe the work as deployed or live before it has happened.
  2. Know what the gap looks like from the outside, because it does not look
     like an error. The app logs a "could not find the table/column … in the
     schema cache" style message on a loop, and code written to degrade
     gracefully degrades — a missing column falls back to its default and the
     UI shows something plausible rather than failing. Nobody notices until
     somebody checks.
  3. After a schema change is applied, a PostgREST-style schema cache can lag
     roughly 30-90 seconds. Confirm the errors STOP GROWING rather than
     reading older log lines as a live failure.
Two siblings with the same shape: a merge that adds a DEPENDENCY needs an
install before the build, and a runtime flag gating NEW code needs a REBUILD,
not just a restart — the running process serves the build it started with.$skill$
  ),

  (
    null,
    'Row caps and counting',
    '1.0.0',
    jsonb_build_object(
      'summary', 'The query validator appends a row cap silently; aggregate in SQL or your number is wrong.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["data_analyst","data_scientist","dataeng","analytics_engineer"]'::jsonb,
    '["query","count","how many","metric","rate","analysis","dashboard","kpi"]'::jsonb,
    $skill$SKILL — Row caps and counting:
The query tools available to you run behind a validator that enforces a
maximum row count, and when your SQL has no LIMIT of its own the validator
APPENDS one. It does not warn you and it does not fail. A query that would
have matched fifty thousand rows returns the cap, successfully.
So: if you count returned rows, you are measuring the cap, not the data.
  1. Aggregate IN SQL. Write `count(*)`, `sum(...)`, `avg(...)`, `group by` —
     so the cap bounds the number of RESULT rows, which is tiny, instead of
     bounding the population you are measuring. This is the whole fix; almost
     every question a row cap ruins is answerable in one aggregate query.
  2. Treat a result that lands exactly on the cap as truncated until proven
     otherwise. An exact round number is the signature of a ceiling, not a
     finding.
  3. A percentage or rate computed over a truncated sample is not a smaller
     version of the true answer — it is drawn from whatever arbitrary rows the
     engine returned first, with no ordering guarantee, so it is not a sample
     in any sense that supports an estimate.
  4. State the row count each number came from. A reader cannot tell a ceiling
     from a real population without it.$skill$
  ),

  (
    null,
    'Evidence before hypothesis',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Collect evidence before theorising, and check the thing you are testing is fresh.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["sre","devops","platform_engineer","technical_support_engineer"]'::jsonb,
    '["incident","outage","down","broken","failing","timeout","investigate","debug","slow"]'::jsonb,
    $skill$SKILL — Evidence before hypothesis:
The first plausible explanation is usually wrong, and acting on it destroys
the evidence for the real one.
  1. Establish WHAT is observed, exactly — verbatim error text, exit code,
     which process, which host, which URL. Not a paraphrase.
  2. Establish WHEN it started and what changed just before. Compare against
     timestamps rather than against what you remember doing: a failure you
     assume your own recent change caused may predate it by hours, and the
     check costs one command.
  3. CHECK FRESHNESS BEFORE TRUSTING ANY LIVE TEST. A long-running process
     serves the code it started with. If a server, worker or daemon started
     before your change reached disk, testing against it tells you nothing
     about your change — and it fails in the most misleading way possible, by
     reproducing the original symptom perfectly. Compare the process start
     time against the mtime of what you changed. The same trap applies to
     artifacts: verify against the path the process ACTUALLY reads, computed
     rather than assumed, not a same-named file somewhere more convenient.
  4. Only then propose a cause, and state what observation would DISPROVE it.
     If nothing would, it is not a hypothesis.
Do not raise timeouts, add retries, restart things "to see if it helps", or
widen a permission before step 3. Each of those hides the signal you need, and
a latency symptom is frequently a delivery failure wearing a costume —
something finished successfully and the result had nowhere to land.$skill$
  ),

  (
    null,
    'What a migration touches outside its own file',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Correct SQL can still break the app; check the three places a schema change reaches.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["dba","dataeng","analytics_engineer","backend_engineer","fullstack_engineer"]'::jsonb,
    '["migration","foreign key","references","column","schema","alter table","relation","embed"]'::jsonb,
    $skill$SKILL — What a migration touches outside its own file:
A migration can be flawless SQL and still break the application, because some
application behaviour is DERIVED from schema shape rather than written down.
Three places to check before you hand off, in order of how quietly they fail:
  1. A NEW FOREIGN KEY between two tables that are already related. Query
     builders that embed a related table by bare name resolve the relationship
     by inference. Add a second foreign key between the same pair — in EITHER
     direction — and that inference becomes ambiguous, and every existing
     query using the short form starts erroring. Before adding one, grep for
     existing embeds of both tables in both directions, and make each one name
     the specific key it means, using the COLUMN-hint form rather than the
     auto-generated constraint name. This surfaces as a generic-looking error
     or, where the caller collapses errors to a null, as a plain "not found"
     page with nothing in the logs — so never swallow a database error without
     at minimum logging it first.
  2. A NEW COLUMN on a table that some code reads through an explicit column
     LIST rather than `select *`. Grep for the table's existing column-list
     constants AND for stored functions that select from it, and update both
     in the SAME migration, carrying every prior column forward. A list that
     is not updated does not error — the reader gets the column's default
     instead of its real value, so one code path silently disagrees with every
     other.
  3. A NEW TABLE, if it will be read by anything other than the writer.
     Confirm the read paths that will query it filter on what actually scopes
     it, rather than assuming a filtered parent id implies a filtered child.
Name in your comment which of these three you checked and what you found.
"Not applicable" is a fine answer; not having looked is not.$skill$
  ),

  (
    null,
    'Polling against a metered service',
    '1.0.0',
    jsonb_build_object(
      'summary', 'A polling loop against a metered API is a standing bill; back off when idle and do the arithmetic.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["sre","platform_engineer","devops"]'::jsonb,
    '["poll","polling","queue","worker","loop","quota","rate limit","redis","interval","cron"]'::jsonb,
    $skill$SKILL — Polling against a metered service:
A loop that polls a per-request-billed API is a permanent bill that nothing in
the code reads as expensive. Before adding or changing one:
  1. DO THE ARITHMETIC AND WRITE IT DOWN. Requests per day = 86400 / interval,
     times the number of loops, times the number of processes running them. A
     one-second poll is ~86k requests per day per loop; four such loops in one
     always-on worker is ~350k. Put the number in your comment next to the
     quota it must fit under. An interval chosen without this arithmetic is a
     guess.
  2. BACK OFF WHEN IDLE. An empty poll should lengthen the interval up to a
     cap; any message resets it to the fast base. This costs nothing in
     latency — after the first message the loop is hot again — and cuts
     steady-state cost several-fold. On a polling ERROR, jump straight to the
     cap: the most likely cause is the quota you just exhausted, and hammering
     it is how a limit becomes an outage.
  3. COUNT THE PROCESSES, NOT THE CODE PATHS. The budget is per host, not per
     loop. Two copies of a worker that each fit the quota do not. If a restart
     procedure is supposed to stop the old process first, verify the kill
     pattern matches the process's REAL command line — run the match and
     confirm it selects the intended process and nothing else. A pattern that
     silently matches nothing turns every restart into an additional running
     copy, and the symptom appears hours later somewhere unrelated.
  4. Quota exhaustion does not look like quota exhaustion. Writes start
     failing, queues stop draining, and whatever those queues carried simply
     stops working with no error at the feature that broke.$skill$
  ),

  (
    null,
    'Prove the rebase preserved the work',
    '1.0.0',
    jsonb_build_object(
      'summary', '"Successfully rebased" can mean the branch''s commits were dropped; count them.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["release_engineer"]'::jsonb,
    '["conflict","rebase","merge","integration","resolve"]'::jsonb,
    $skill$SKILL — Prove the rebase preserved the work:
`git rebase` reports success in cases where your branch's commits are no
longer on your branch. It is not lying — a commit whose changes are already
present upstream is genuinely redundant — but it decides that by content, and
it is wrong whenever the two sides reached similar-looking changes for
different reasons. The output says "Successfully rebased and updated
refs/heads/<branch>" with the dropped commits mentioned only in a preceding
hint line, and the working tree is clean afterwards.
So a successful rebase is not evidence that the work survived it.
  1. COUNT BEFORE AND AFTER. Take `git rev-list --count <base>..HEAD` before
     you start and again when the rebase completes. If the count dropped by
     more than the commits you deliberately squashed, commits were dropped —
     recover them (`git reflog` still has the pre-rebase tip) rather than
     proceeding.
  2. A count of ZERO after the rebase is the loudest possible signal and the
     easiest to misread as success, because every other check passes: clean
     status, clean diff, no conflict markers, no error. Never hand off a
     branch that is zero commits ahead of its base as a resolved conflict.
  3. Never `git rebase --skip`. When a step goes wrong git's own advice will
     often suggest it, and it permanently discards that commit — which is the
     work the conflict exists to preserve. If you are stuck, stop and ask a
     human.
  4. Check the WHOLE tree for leftover conflict markers, not just the files
     you edited: `git grep -n '^<<<<<<< '`. A marker can arrive inside a file
     the rebase brought in that you never opened.$skill$
  ),

  (
    null,
    'What a green eval run proves',
    '1.0.0',
    jsonb_build_object(
      'summary', 'A green eval job may have measured nothing; state what was actually compared.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["ml_engineer"]'::jsonb,
    '["eval","gold set","prompt","baseline","regression","model","promptfoo","pass rate"]'::jsonb,
    $skill$SKILL — What a green eval run actually proves:
An evaluation pipeline has two halves that fail independently, and only one of
them is loud:
  - a STRUCTURAL half (a snapshot or fixture regenerated, a file diffed),
    which proves a file was regenerated and says NOTHING about quality; and
  - a MEASUREMENT half (scoring against a recorded baseline), which is the
    only part that can catch a regression.
The measurement half commonly skips itself rather than failing. Two ways, both
of which exit zero and render green:
  1. NO CREDENTIAL — with no model API key in the environment the comparison
     cannot run, so it is skipped and the job passes. A pipeline that gates on
     model output but takes its credential from an environment configured
     elsewhere can be green everywhere and measuring nowhere.
  2. NO BASELINE — a case with no recorded baseline score is treated as
     bootstrapping and does not block. Correct on day one, and permanent
     unless someone records the baseline.
So, when you change a prompt or model selection:
  - Do not cite a green pipeline as evidence the change is safe. Cite the
    NUMBERS: baseline pass rate, new pass rate, and how many cases were
    actually scored.
  - Say explicitly if a case ran with no baseline, and record one.
  - If you ran nothing, say you measured nothing. An unmeasured prompt change
    is a legitimate thing to hand over; an unmeasured one described as
    validated is not.$skill$
  ),

  (
    null,
    'A rotation is not finished at the vault',
    '1.0.0',
    jsonb_build_object(
      'summary', 'A credential change takes effect only where it is re-read; enumerate every consumer.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["cloud_engineer","it_admin"]'::jsonb,
    '["rotate","rotation","credential","secret","key","token","revoke","offboard","access","scope"]'::jsonb,
    $skill$SKILL — A rotation is not finished when the new value is stored:
Changing a credential at its source changes nothing about who is currently
using the old one. Rotation, revocation and re-authorisation are three
different acts, and doing one does not accomplish the others. When you plan or
execute one, enumerate the consumers explicitly:
  1. PROCESSES THAT READ CREDENTIALS AT STARTUP keep using the old value until
     they restart. Editing a config or env file does nothing to a running
     process. List every process that reads the credential — including the
     non-obvious ones. A service you think of as a user interface can be a
     mandatory relay for a background path, and if only some processes
     restart, the surviving one fails in a way that points away from the
     rotation entirely.
  2. WHEN THE ENDPOINT MOVES TOO, a stale process fails at DNS or connection
     rather than on auth, which reads like an outage rather than a
     configuration change. Say so in the runbook.
  3. ROTATING A SECRET DOES NOT END SESSIONS ALREADY ISSUED. Tokens, cookies
     and grants minted under the old secret keep working until they expire or
     are explicitly revoked. For a leaver this is the whole risk: a credential
     change that does not revoke active sessions is not deprovisioning. Order
     the steps revoke-then-rotate, and name where sessions are revoked,
     separately from where the secret is changed.
  4. WIDENING A PERMISSION DOES NOT REACH GRANTS ALREADY ISSUED. Adding a
     scope changes what NEW authorisations request; every existing one keeps
     the old, narrower set until its holder re-authorises. So a scope change
     always has a second half — telling the affected people, in the product,
     that they must reconnect — and without it the change half-lands and the
     failure appears later as a permission error nobody connects to it.
Every step names its owner and how it is verified.$skill$
  ),

  (
    null,
    'Pushes that touch CI definitions',
    '1.0.0',
    jsonb_build_object(
      'summary', 'A push touching CI definitions is rejected for a scope reason; surface it, never route around it.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["platform_engineer","devops"]'::jsonb,
    '["ci","workflow","actions","pipeline","push","yml","github"]'::jsonb,
    $skill$SKILL — When a push touching CI files is rejected:
A push whose diff includes continuous-integration definitions can be refused
on authorisation grounds even when the same credential writes every other file
in the repository fine. Editing what CI runs is a separately-granted
permission, because whoever can change CI can make CI execute code with the
repository's secrets.
The rejection reads like a generic push failure. If a push fails and the diff
touches CI configuration, check that first — before rebasing, re-cloning,
regenerating credentials, or re-attempting.
What to do:
  1. Report it precisely: the push was rejected because the diff touches CI
     definitions and the credential lacks the permission for that. Name the
     files.
  2. Do NOT work around it. Do not drop the CI files from the commit to get
     the rest through, do not rewrite history to hide them, and do not request
     or widen the permission yourself. Splitting the change is the worst
     outcome available: the push then SUCCEEDS, the CI half is silently
     missing, and the ticket looks complete.
  3. Granting the wider permission is a human decision, because it grants more
     than this one push needs. Hand it back with what is needed and why.$skill$
  ),

-- ===========================================================================
-- Quality and security
-- ===========================================================================

  (
    null,
    'Green until proven red',
    '1.0.0',
    jsonb_build_object(
      'summary', 'A passing test is not evidence until you have seen it fail.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["sdet","qa_automation_engineer","qa","appsec_engineer","security_engineer","engineer","backend_engineer","fullstack_engineer","staff_engineer"]'::jsonb,
    '["test","coverage","regression","assert","flaky","mock","fake","verify","guard"]'::jsonb,
    $skill$SKILL — Green until proven red:
A test that has never been observed failing is not evidence that anything
works. Before you claim a test covers something, make it go red on purpose.
  1. NEUTER THE THING IT GUARDS, run it, confirm it FAILS, restore. Delete the
     tenant predicate, invert the condition, remove the fix. A test that stays
     green with its subject removed is testing nothing. Where the convention
     allows, leave the neutered case in as an explicit CONTROL test.
  2. A FAKE THAT IGNORES ITS ARGUMENTS MAKES EVERY TEST USING IT VACUOUS. If
     the test asserts a query was scoped, the fake client must actually APPLY
     the filters it is handed and return the filtered rows. A fake that
     records calls and returns a fixed array proves only that code ran.
  3. A PURE TEST ASSERTING SHAPE DOES NOT PROVE THE WRITE LANDS. It cannot see
     a unique index, a CHECK, or a trigger. For a schema-touching change,
     either exercise a real Postgres or state plainly in your comment that the
     DB half is untested and trace code -> migration -> the live constraint by
     reading.
  4. A SINGLE GREEN RUN CAN BE LUCK. If you suspect flakiness, loop it (or add
     a many-iteration case) before calling it stable.
Report which of these you actually did. A named guard with a vacuous test is
worse than an untested one, because it stops anyone looking again.$skill$
  ),

  (
    null,
    'Where tests actually run',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Tests outside lib/**/__tests__/ are silently never collected.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["qa_automation_engineer","sdet"]'::jsonb,
    '["test","vitest","e2e","playwright","coverage","fixture","spec"]'::jsonb,
    $skill$SKILL — Where tests actually run:
Before adding a test file, read `apps/web/vitest.config.ts` and check its
`include` glob against the path you were about to use. At the time of writing
it collects exactly `lib/**/__tests__/**/*.test.ts`, in the `node`
environment. Three consequences, and each one fails SILENTLY — the suite still
exits 0:
  1. A test outside that glob is NEVER COLLECTED. Writing to `apps/web/tests/`
     or `apps/web/e2e/` produces a file that is committed, reviewed, and never
     executed. Co-locate: `lib/<area>/__tests__/<thing>.test.ts`.
  2. `.test.tsx` is not collected either — the glob is `.test.ts`. A test that
     needs JSX builds elements with `React.createElement` in a `.test.ts`.
  3. The environment is `node`, NOT jsdom. There is no `document` and no
     `window`. Component-shaped assertions go through `renderToStaticMarkup`,
     so anything under test must not reach for a browser API or a Radix
     primitive.
Before you claim a new test passes, confirm it actually RAN: the suite output
must name your file. A run that reports the same count as before you started
did not execute yours.$skill$
  ),

  (
    null,
    'What can be tested here',
    '1.0.0',
    jsonb_build_object(
      'summary', 'server-only and "use server" modules cannot load under Vitest; put the decision where a test can reach it.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["sdet","qa_automation_engineer","engineer","backend_engineer","fullstack_engineer","staff_engineer","software_architect"]'::jsonb,
    '["test","server action","route","coverage","unit","refactor","untestable","policy","decide","guard"]'::jsonb,
    $skill$SKILL — Put the decision where a test can reach it:
Two markers make a module unloadable under Vitest, and finding out by writing
the test first wastes the iteration:
  - `import "server-only"`;
  - the `"use server"` directive.
Anything importing `next/headers`, a server database client, or a session
helper is in the same boat transitively. Grep for both markers up the import
chain BEFORE you start. Logic written inside one is logic no test can execute,
and real bugs have lived in exactly that gap.
The established response is to SPLIT, not to skip. Three files, not one:
  <name>.ts          pure decision — no server-only import, no DB client;
                     takes facts, returns a verdict
  <name>-<io>.ts     dependency-injected IO — takes a client and a resolved
                     tenant id as ARGUMENTS, so a test can pass a fake
  <name>.server.ts   the `server-only` wiring that supplies the real deps
Name the pure function after the DECISION (`decideX`, `classifyX`, `planX`),
not after the plumbing — that is the convention here and it is how the next
engineer finds the rule.
Two corollaries:
  - If a property is about EVERY path rather than one call ("no path writes a
    null tenant", "this action re-checks the gate"), a runtime test cannot
    state it. The convention here is a SOURCE-SCAN test that reads the files
    and fails on a new violation. Prefer that over asserting nothing.
  - A CLI or script must import NOTHING `server-only` unless it genuinely
    needs a server-only capability. A script that imports a `.server.ts`
    throws at import time while its unit tests — which import the pure half —
    stay green. Run the script to prove it loads past its imports.$skill$
  ),

  (
    null,
    'Verify the artifact you tested',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Prove the thing you ran your checks against is the thing under review.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["verifier","qa"]'::jsonb,
    '["build","verify","boot","start","smoke","deploy","restart","reproduce"]'::jsonb,
    $skill$SKILL — Verify the artifact you tested:
A green check is only evidence if it ran against the code under review. Three
ways that silently fails, all of which have happened here:
  1. STALE PROCESS. A server started before your change serves pre-change
     code, so a live check is a FALSE NEGATIVE and you will debug a phantom.
     Confirm freshness before concluding anything: find the listening process,
     read its start time, and compare it against the mtime of what you changed
     and against the build id on disk. If the process predates the change,
     RESTART and re-check — do not debug the code.
  2. STALE TREE. "Build successful" says nothing about WHICH source compiled.
     Prove the change is in the tree you built: the HEAD commit plus a grep
     for a distinctive string from the diff.
  3. WRONG ENV BAKED IN. Build-time public env values are inlined into the
     bundle. Right code plus wrong env produces a build that exits 0 and a
     page that dies on first load. Verifying a build means BOTH halves: what
     code went in AND what env was inlined beside it.
State which of these you checked. If you cannot establish freshness, say the
result is unverified rather than reporting it as a pass.$skill$
  ),

  (
    null,
    'Did the work actually land',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Approved and landed are different facts; check commits and push before either verdict.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["qa","verifier"]'::jsonb,
    '["approve","done","verify","landed","merge","commit","delivered","integration"]'::jsonb,
    $skill$SKILL — Did the work actually land:
"The engineer says it is done" and "the work exists" are different claims, and
your verdict is the last place the second one gets checked. Before an
approving verdict on a ticket that was supposed to produce code:
  1. COUNT THE COMMITS, do not read the summary:
        git rev-list --count origin/<base>..HEAD
     Zero is a real and legitimate outcome for review-only work — but for a
     ticket whose deliverable was code it means nothing was delivered, and a
     retry that commits nothing looks IDENTICAL to a branch that never had
     anything. Say which of the two you are looking at.
  2. CONFIRM IT LEFT THE MACHINE:
        git log --branches --not --remotes
     Non-empty means commits exist ONLY in this workspace. They are one
     workspace reap away from gone, and the ticket will read done on the board
     while the code is nowhere.
  3. CHECK THE CLAIM AGAINST THE TREE. A commit hash cited in a comment that
     `git show` cannot resolve is not evidence. Verify the files named in the
     acceptance criteria actually changed.
Put the command output in your verdict comment, not a paraphrase. If (1) or
(2) fails, do not approve — say precisely what is missing and hand back.
Landing onto the integration branch is the engine's job; never merge by hand.$skill$
  ),

  (
    null,
    'Authed-route boot check',
    '1.0.0',
    jsonb_build_object(
      'summary', 'A request to / or /login never loads an authed route''s server module.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["verifier"]'::jsonb,
    '["boot","smoke","start","server action","route","verify","runtime"]'::jsonb,
    $skill$SKILL — Authed-route boot check:
A whole class of runtime failure passes build, typecheck, the unit suite and
CI, and then throws the first time an authenticated page is loaded. The known
one: a `"use server"` file may export ONLY async functions. Exporting a const,
object, schema or class throws at RUNTIME and poisons the server-action
manifest of EVERY route importing that file, disabling all server actions on
those routes, not just the offending export.
So a smoke check that hits `/` or `/login` proves nothing about it. An
unauthenticated request to an authed route redirects to the login page WITHOUT
ever loading that route's server module, so the check that is easiest to run
is the one that cannot fail.
When your smoke check matters:
  1. Say WHICH path you loaded and whether it was authenticated. "The server
     printed Ready" is not a boot check.
  2. If you cannot authenticate, say the authed surface is UNVERIFIED rather
     than reporting a clean boot.
  3. Cheap static substitute when you cannot load the app: for every
     `"use server"` file in the diff, confirm every export is an async
     function.$skill$
  ),

  (
    null,
    'Agent trust boundary review',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Where untrusted text reaches another agent''s context, and the three checks on it.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["appsec_engineer","security_engineer","security"]'::jsonb,
    '["prompt","injection","untrusted","comment","handoff","agent","mcp","tool","context"]'::jsonb,
    $skill$SKILL — Agent trust boundary review:
This platform's most novel attack surface is not in the OWASP list: text
written by one agent (or pasted by a user) is later spliced into ANOTHER
agent's model context. Ticket titles, comments, handoffs, lesson bodies, skill
bodies, prompt overlays, README and manifest excerpts and image attachments
all reach a prompt. When a diff touches any of them, check three things:
  1. FENCED, AND ON THE RIGHT SIDE. Untrusted text belongs in the TICKET
     prompt, wrapped by the shared fencing helper — never routed into the
     system prompt, where trusted role directives live. Placement is the
     control; a fence in the wrong layer promotes attacker text above the role
     contract. Grep the existing call sites for the established shape.
  2. SCOPE DERIVED SERVER-SIDE, NOT ARGUED FOR. An agent-facing route must
     derive tenant and project from the run or ticket the server already
     knows, and the tool's input schema must have NO tenant or project field —
     so a prompt-injected agent has nothing to point elsewhere. A field that
     exists is a field that can be forged.
  3. A NEW SYSTEM COMMENT NEEDS ITS OWN AUTHOR. A comment's author id is
     string-matched downstream: one authored as the ticket-move tool is read
     as a VERDICT. Give any new engine-authored comment its own author id, and
     confirm the agent-facing comment route cannot forge one.
Every value crossing this boundary must also be LENGTH-BOUNDED, and refused
rather than truncated. Report a miss with the concrete path from writer to
prompt, not as a category.$skill$
  ),

  (
    null,
    'Which database are you touching',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Establish which instance before running anything that touches a database.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["security_engineer","appsec_engineer","backend_engineer","fullstack_engineer","engineer","dba","dataeng"]'::jsonb,
    '["migration","rls","policy","supabase","database","sql","backfill","schema","seed"]'::jsonb,
    $skill$SKILL — Which database are you touching:
The workspace `.env.local` can carry credentials for a REAL, shared database.
The public frontend URL and the database URL frequently point at DIFFERENT
instances, and the frontend one is the misleading one — the DB target is
`DATABASE_URL`.
Before any command that writes, migrates, resets or backfills:
  1. RESOLVE THE TARGET from `DATABASE_URL`, not from a frontend URL, and say
     out loud in your comment which instance you resolved.
  2. If it is not a local instance you started yourself, DO NOT WRITE TO IT.
     Applying a migration to a shared database is a human-gated, hard-to-undo
     act. Escalate, naming the exact statements — do not run them and report
     afterwards.
  3. `supabase db reset` targets a LOCAL supabase. Never point it at a URL you
     did not start. Verify your own migration by replaying from scratch
     against a local instance: that proves it applies in order against a clean
     database, which is the thing that actually breaks.
  4. For a read-only check, keep it read-only, and never echo the connection
     string into output.
Verifying a schema change is a READ — a migration list against the target, or
a query against `information_schema`. Reading to confirm is always in scope;
writing to confirm is not.$skill$
  ),

  (
    null,
    'Compliance claims need a citation',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Cite the file for every claim about current behaviour, or mark it UNVERIFIED.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["compliance_grc"]'::jsonb,
    '["policy","retention","audit","evidence","control","gdpr","soc2","dsar","compliance"]'::jsonb,
    $skill$SKILL — Compliance claims need a citation:
A compliance artifact makes two kinds of statement and they carry opposite
risk. A statement about what SHOULD happen is a proposal. A statement about
what DOES happen is an assertion an auditor will test — and if it is wrong,
the artifact is worse than no artifact, because it is documented evidence of a
control that does not exist.
So for every sentence describing CURRENT platform behaviour — a retention
period, a deletion mechanism, an encryption property, an access control, a log
that is kept:
  1. GROUND IT IN THE REPO and cite the source inline: the migration, the
     reaper or cron, the RLS policy, the route. `[verified: <path>]`.
  2. If you cannot find it, write `[UNVERIFIED — not confirmed in the repo]`
     and carry the item into the `Gaps:` section. Never infer a mechanism from
     the presence of a column, and never let a proposed period read as a
     current one.
  3. DELETION IS THE ONE MOST OFTEN ASSUMED. A retention period is only real
     if something actually deletes. Name the job or the query that performs
     it, or mark deletion UNVERIFIED — a policy promising erasure the platform
     does not perform is a live regulatory exposure, not a documentation gap.
State the split up front: how many controls you verified against the repo and
how many are unverified. An auditor's first question is how you know.$skill$
  ),

-- ===========================================================================
-- Product, design and research
-- ===========================================================================

  (
    null,
    'Handoff to dependents',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Record a handoff note so the agents on dependent tickets can see what you decided.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["pm","product_manager","technical_product_manager","product_owner","business_analyst","designer","ui_designer","ux_designer","product_designer","ux_researcher"]'::jsonb,
    '["spec","brief","design","story","requirements","prd","handoff","depends","downstream","implement"]'::jsonb,
    $skill$SKILL — Handoff to dependents:
Your artifact is a ticket COMMENT. Comments are scoped to their own ticket:
the agent working a ticket that depends on yours sees your handoff entries,
NOT your comments. So a spec, story or brief that exists only as a comment is
invisible to whoever implements it, with no error anywhere.
After you post the artifact, record a handoff entry for each decision a
dependent ticket must code against:
  - kind 'interface' — the concrete contract: exact component name, route,
    field names, status values, copy strings that must match.
  - kind 'decision' — a choice that constrains dependents, and what it rules
    out.
  - kind 'assumption' — what you took as given that they should re-check.
  - kind 'built' — what now exists as a result of this ticket.
Only the LATEST entry per kind survives into a dependent's prompt, so put the
whole contract in one entry per kind rather than posting three 'interface'
notes and expecting all three to arrive. Keep each well under the length
limit, and write the entry the moment you decide, not at the end.
This does not replace the comment — the comment is for this ticket's
reviewers, the handoff is for the next ticket's agent. Both.$skill$
  ),

  (
    null,
    'Acceptance criteria a verifier can check',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Write acceptance criteria the QA agent can actually render a verdict on.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["pm","product_owner","business_analyst","technical_product_manager"]'::jsonb,
    '["acceptance criteria","user story","refine","requirements","story","testable","definition of done"]'::jsonb,
    $skill$SKILL — Acceptance criteria a verifier can check:
The thing that renders PASS/FAIL on your criteria is an agent with a git
checkout and a shell. It reads the diff, runs the project's test command, runs
the build, and reads the files your criteria name. It cannot open a browser,
click anything, watch a video, measure a real user, or wait a week.
So write each criterion so it can be settled by one of exactly these:
  - a named file or symbol existing and containing something specific;
  - a command with an expected exit code or output substring;
  - a test that exists and passes;
  - a row, column or constraint present in a migration.
Rewrite anything that cannot be. Common offenders and their fix:
  "the page loads faster"         -> name the measurement and where it is taken
  "the flow feels intuitive"      -> name the observable step count or copy
  "users can complete onboarding" -> name the test or the route that must 200
  "works on mobile"               -> name the breakpoint and the assertion
If a criterion genuinely needs human judgement (visual polish, wording,
pricing), say so ON that criterion and mark it human-verified. That is a
legitimate outcome and it is far better than an ambiguous criterion the
verifier resolves by guessing.
Every criterion is independently checkable: no compound ANDs, because half a
criterion has no verdict.$skill$
  ),

  (
    null,
    'Metrics only from live telemetry',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Ground success metrics in telemetry this platform actually collects.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["product_manager","product_designer","technical_product_manager","product_owner"]'::jsonb,
    '["success metric","metrics","kpi","measure","instrument","analytics","funnel","adoption","brief","launch"]'::jsonb,
    $skill$SKILL — Metrics only from live telemetry:
Check what is instrumented before you name a metric. In this codebase today:
  INSTRUMENTED — Langfuse (run/step/tool/LLM spans); the Postgres board itself
  (tickets and their statuses, ticket_number, retry_count, gate_retry_count,
  landed_sha); runs (status, spent_cents, role); agent_mistakes and
  agent_learnings; Stripe usage metering.
  NOT INSTRUMENTED — PostHog: zero imports, not a dependency, so there is no
  event stream, no funnel and no retention cohort to read. Sentry: same.
  Resend: no send path exists; notifications are in-app only.
A metric that names a PostHog event, a funnel drop-off, an email open rate or
a Sentry error rate is not measurable here, however reasonable it sounds — and
naming one is easy, because the stack list in your own instructions describes
the INTENDED stack rather than the wired one.
When the metric you want needs telemetry that does not exist, do not quietly
pick a weaker metric and do not assert the good one. State it as an
instrumentation gap: what you would measure, what would have to be added to
measure it, and who owns adding it. That gap is a real deliverable and it is
the honest version of the section.
Verify rather than trusting this list — it is accurate as written but the
stack moves. `apps/web/package.json` and `docs/IMPLEMENTATION_STATUS.md`
settle it in one read.$skill$
  ),

  (
    null,
    'Spec against the installed design system',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Check components/ui/ before naming a primitive; four the instructions name are not installed.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["designer","ui_designer","ux_designer","product_designer"]'::jsonb,
    '["component","spec","design","ui","wireframe","token","shadcn","primitive","screen","layout"]'::jsonb,
    $skill$SKILL — Spec against the installed design system:
Before you name a component or a token, list what exists:
  `ls apps/web/components/ui/` and read `apps/web/app/globals.css`.
Do this even when a primitive is named in your own instructions, because
several named there are NOT installed in this repo:
  Select    — not present. The pattern here is a styled native <select>
              (see ModelLadderSelect in components/metrics/model-picker.tsx).
  Form      — not present. Forms are composed from Input/Textarea/Button plus
              a server action; there is no Form primitive to compose.
  Toast     — not present under that name. Toasts are Sonner:
              `import { toast } from "sonner"` (components/ui/sonner.tsx).
  Accordion — not present. Use a native <details> or Tabs.
Specifying one of those makes the engineer either install a new dependency you
did not scope or improvise silently — either way the contract is broken and
neither of you finds out at spec time.
Tokens: the suite is wider than stock shadcn — it includes success, warning
and the sidebar-* family, so those states have tokens and do not need
inventing. Every token has a DIFFERENT value in light and dark, both in
globals.css.
If the design genuinely needs a primitive that is not installed, say so
explicitly as a dependency the ticket adds. That is a scoping fact the
engineer needs, not a detail to leave implicit.$skill$
  ),

  (
    null,
    'Contrast from resolved tokens',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Compute contrast ratios from the actual HSL values, or mark them unverified.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["ui_designer","product_designer","designer"]'::jsonb,
    '["contrast","accessibility","wcag","a11y","token","color","dark mode","aa","ratio"]'::jsonb,
    $skill$SKILL — Contrast from resolved tokens:
You are asked to state a contrast ratio for each text/background pair. A ratio
is a computed number, and a plausible-looking one you did not compute is worse
than no number: the engineer trusts it, ships it, and the accessibility
failure you exist to prevent goes out with a passing note beside it.
Token names carry no value. Resolve them first — `apps/web/app/globals.css`
holds the HSL triples, and the LIGHT and DARK blocks hold DIFFERENT values for
the same token, so one ratio cannot cover both modes.
For each pair you report:
  1. quote both resolved HSL values and which mode they are from;
  2. compute the ratio (relative luminance per WCAG 2.x, (L1+0.05)/(L2+0.05));
  3. state it against the threshold that applies — 4.5:1 body text, 3:1 large
     text and non-text UI such as borders, focus rings and icons.
Do the arithmetic rather than recalling it. If you cannot resolve a token
because it is new or the file is unavailable, write "unverified" and say which
pair — a flagged gap is actionable, a fabricated 4.8:1 is not.
A pair that fails inside the existing suite is a FINDING (a new token is
needed), not something to round up.$skill$
  ),

  (
    null,
    'Research from evidence that exists',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Plan research against sources this platform has, not a user panel it does not.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["ux_researcher"]'::jsonb,
    '["research","interview","usability","survey","synthesis","evidence","customer","user feedback","themes","discovery"]'::jsonb,
    $skill$SKILL — Research from evidence that exists:
Before proposing a method, establish what you can actually reach. This
platform has no participant panel, no CRM, no support-ticket system, and no
survey or interview store — there is no customer, support, interview or
feedback table in the schema, and no product-analytics event stream (PostHog
is not installed, whatever your instructions imply). A plan that recruits n=5
with an incentive policy, or reads a funnel, is proposing infrastructure
rather than research.
What IS readable as evidence:
  - Langfuse traces: what agent runs actually did, step by step.
  - The board: tickets, statuses, retry_count (the QA reject loop),
    gate_retry_count, landed_sha, how long things sat where.
  - runs: outcomes, spend, role attribution.
  - agent_mistakes and agent_learnings: recorded failures and the lessons
    approved from them — the closest thing here to a longitudinal study.
  - The ticket thread itself: the operator's own words, verbatim.
  - A database query tool ONLY if the operator has granted this agent a data
    source; it is off by default and you cannot grant it to yourself.
So: if the question can be answered from those, answer it from those and say
which. If it genuinely needs people, your deliverable is the PLAN plus an
explicit statement that fielding it requires recruitment that does not exist
yet, and what it would take. Do not quietly substitute a weaker source and
present it as the finding.
Your triangulation rule still binds, and it binds harder here: three
independent sources drawn from the list above, not one source read three ways.$skill$
  ),

  (
    null,
    'Delivery signals, not sprint metrics',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Report the delivery data this board actually holds; there are no sprints to measure.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["scrum_master","project_program_manager"]'::jsonb,
    '["velocity","sprint","retro","status","health","capacity","estimate","throughput","raid","program","burndown"]'::jsonb,
    $skill$SKILL — Delivery signals, not sprint metrics:
There is no sprint in this system. No sprint, iteration, story-point, velocity
or capacity table exists in the schema, so a velocity trend, a
commit-vs-completed ratio, a carry-over rate or a burndown cannot be computed
here — any number you produce for one is invented, and it will be read as
measured.
Report from what the board actually holds:
  - ticket counts by status, and how long tickets sat in each;
  - retry_count — the QA reject loop, the closest real signal for rework;
  - gate_retry_count — hand-offs refused by the pre-QA gate;
  - failed runs and their reasons; agent_mistakes by type;
  - spend per ticket and per role;
  - landed_sha — whether completed work actually reached the integration
    branch, which is a different fact from a ticket being Done.
Two framing corrections that follow:
  - The workers are agents, not people. Capacity is the parallel drain window
    plus the budget ceiling, not headcount or hours. An estimate in
    person-days describes a team that is not doing the work.
  - Owners are ROLES, and there is one human. Naming invented individuals as
    DRIs makes a plan that reads accountable and is not.
If the ticket asks for a metric that cannot be computed, say which one and
why, and offer the nearest real signal. If you need a number only the operator
has, ask for it rather than estimating it.$skill$
  ),

-- ===========================================================================
-- Leadership, docs and go-to-market
-- ===========================================================================

  (
    null,
    'Docs land in the repo',
    '1.0.0',
    jsonb_build_object(
      'summary', 'A doc drafted only in a ticket comment never reaches the repo — write the file too.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["techwriter"]'::jsonb,
    '["runbook","readme","changelog","docs","documentation","guide","reference"]'::jsonb,
    $skill$SKILL — Docs land in the repo:
Some artifacts belong in a ticket comment (release notes for review, a draft
for a stakeholder). Others have a HOME IN THE REPO — a runbook, a README
section, a changelog entry, an API reference. For those, the comment is a copy
for review, not the delivery.
When the artifact has a repo home:
  1. Write the actual FILE at its real path, in the same run.
  2. Commit it. `git log --oneline origin/<base>..HEAD` must show your commit.
  3. Push it. `git log --branches --not --remotes` must be EMPTY. Commits that
     exist only in this workspace are one cleanup away from gone, and nothing
     downstream will notice they were lost.
  4. Name the file path in your comment, so a reviewer can find it.
Never hand-edit a file marked auto-generated (CHANGELOG.md is the usual one) —
add the entry through whatever generates it, or say in your comment that a
human must.
If a doc is genuinely comment-only, say so in one line. Ambiguity here reads
as an omission.$skill$
  ),

  (
    null,
    'Runbook conventions',
    '1.0.0',
    jsonb_build_object(
      'summary', 'This repo''s runbooks have a template, a size limit, and an index row that is easy to skip.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["techwriter"]'::jsonb,
    '["runbook","procedure","operator steps","how do we","recurring","on-call"]'::jsonb,
    $skill$SKILL — Runbook conventions (this repo):
A runbook here is a recipe for a RECURRING task, not a design doc. The
conventions are recorded in docs/runbooks/README.md and are easy to miss:
  - Start from docs/runbooks/_TEMPLATE.md. Do not invent a structure.
  - One task per file, named kebab-case after the task
    (e.g. `rotate-runner-credentials.md`), in docs/runbooks/.
  - Keep it to roughly one screen: prerequisites, ordered steps with EXACT
    files and commands, then verification and gotchas. If the theory is
    growing, LINK to docs/DEVPILOT_PRD.md or docs/DEVPILOT_TDD.md instead of
    restating it.
  - ADD A ROW TO THE INDEX TABLE at the bottom of docs/runbooks/README.md. A
    runbook missing from the index is a runbook nobody finds, and nothing in
    the build or the tests will tell you it is missing.
Every step names the file or command it operates on. "Restart the runner" is
not a step; the command that restarts it is.$skill$
  ),

  (
    null,
    'Shipped vs planned',
    '1.0.0',
    jsonb_build_object(
      'summary', 'IMPLEMENTATION_STATUS.md is the source of truth for what exists; the PRD is intent.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["sales_account_executive","solutions_engineer","marketing_manager","customer_success_manager","cto"]'::jsonb,
    '["roadmap","available","support","does it","can it","launch","announce","compliance","feature","ship"]'::jsonb,
    $skill$SKILL — Shipped vs planned:
Before you assert that DevPilot does something, check
docs/IMPLEMENTATION_STATUS.md — specifically its "Not yet implemented" gap
list. That file is the truthful planned-vs-built map.
docs/DEVPILOT_PRD.md and the phase plans are DESIGN INTENT. They describe
things in the present tense that have not been built. Reading a capability out
of the PRD and putting it in front of a buyer, a customer, or a launch post is
how we ship a false claim.
The stack list in your own instructions is the same trap: it names the
INTENDED stack. Some of it is wired and some of it is aspirational.
  - Capability you can cite as available: it is in "What's built".
  - Capability in the gap list: say "planned, not shipped". Give a date only
    if you actually have one. "Planned, no committed date" is an acceptable
    and credible answer.
  - Capability you cannot find in either: do not claim it. Ask.
If you are writing for an audience that will act on the claim, cite where you
checked. A wrong yes is more expensive than a slow answer.$skill$
  ),

  (
    null,
    'Board state is not the whole truth',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Two silent states a support diagnosis will otherwise read as healthy.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["technical_support_engineer"]'::jsonb,
    '["stuck","no response","not replying","done but","nothing happened","ignored","never shipped","waiting"]'::jsonb,
    $skill$SKILL — Board state is not the whole truth:
Two failure shapes here look FINE on the board and cause most "nothing is
happening" reports. Check both before concluding no fault.
1. A ticket in `in_progress` whose run died SWALLOWS HUMAN REPLIES. Replies
   re-dispatch on `input_required`, not on `in_progress`. So a customer
   comments, the comment lands, nothing runs, and the board shows a ticket in
   progress with an engaged customer. Check: is there a live run for this
   ticket, or a queued dispatch? Neither means the ticket is orphaned — the
   reaper moves it to `input_required` after its idle window, and until then
   every reply is lost. If a customer says "I replied twice and got nothing",
   check this first.
2. `done` DOES NOT MEAN SHIPPED. `done` means the reviewer approved. Landing
   the work on the integration branch happens afterwards and can fail on its
   own — a conflict, a push rejection, a branch that never reached the remote.
   So "it says complete but the change isn't there" is usually a landing
   failure, not a lie and not a bug in the work. Check the ticket's landing
   state and report the reason, not just "it says done".
Report which of these you checked, including when they came back clean. A
diagnosis that skipped them is not a diagnosis.$skill$
  ),

  (
    null,
    'Follow-up work must be filed',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Action items in a memo are prose until someone files them; make that one step, not a project.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["cto","vp_engineering","engineering_manager"]'::jsonb,
    '["postmortem","action items","follow-up","next steps","okr","roadmap","decision","adr","rfc","retro"]'::jsonb,
    $skill$SKILL — Follow-up work must be filed:
A memo that produces work produces NOTHING until that work is on the board.
Action items buried in prose are read once and then lost, and this is the
usual reason a postmortem's improvements never happen.
End any artifact that implies work with a section headed `Follow-up tickets`,
one entry per item, each with:
  - a title someone could file verbatim,
  - the role that should pick it up (use a real role slug),
  - one line of acceptance criteria — what is true when it is done,
  - the blocker, if it must wait on another item.
Then, if a ticket-creation tool is available to you, file them. Do not assume
it is: it is off by default per project, and being unable to file is normal
rather than an error. If you cannot file them, say so explicitly in one line
so a human knows the section is a to-do list and not a record.
Do not widen the current ticket to do the follow-up work yourself.$skill$
  ),

  (
    null,
    'Isolation claims need the real mechanism',
    '1.0.0',
    jsonb_build_object(
      'summary', '"RLS isolates tenants" is an over-claim; the engine runs service-role. Say what actually holds.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["solutions_engineer"]'::jsonb,
    '["isolation","tenant","security","multi-tenant","rls","data residency","vendor review","soc","questionnaire"]'::jsonb,
    $skill$SKILL — Isolation claims need the real mechanism:
"Tenant isolation is enforced by Postgres Row-Level Security" is the summary
an architect will push on, and on its own it is an over-claim. RLS applies to
requests carrying a user session. Much of the engine — schedulers, reapers,
background jobs, export workers — runs with the SERVICE ROLE, which BYPASSES
RLS entirely.
What actually holds it together is three layers, and saying all three is
stronger than saying one:
  1. RLS policies on member-session paths, scoped per tenant.
  2. An explicit tenant predicate on every service-role read and write — the
     app-layer control on the paths RLS does not cover.
  3. Database TRIGGERS that refuse to write a row whose tenant does not match
     its parent's, so a mismatched row cannot be stored even if application
     code is wrong. This is the layer that does not depend on a developer
     remembering, and it is the one a skeptical reviewer will care about.
Say which layer covers which path. A reviewer who finds the service-role paths
after you claimed RLS covers everything will discount the rest of your answer,
and they will be right to.$skill$
  ),

  (
    null,
    'Health metrics have engine noise',
    '1.0.0',
    jsonb_build_object(
      'summary', 'Board counts include engine-authored moves and structurally-zero spend; caveat them or don''t show them.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["customer_success_manager"]'::jsonb,
    '["qbr","health","adoption","usage","metrics","churn","renewal","convergence","spend","report"]'::jsonb,
    $skill$SKILL — Health metrics have engine noise:
The numbers in your metric list are not clean readings, and a QBR that
presents them as clean is worse than one that omits them.
  - Not every transition is agent progress. Self-healing machinery moves
    tickets on its own: a stranded ticket reconciled forward, a review parked
    to `blocked` because no verdict was recorded, a retry ceiling parking a
    ticket that bounced too many times, an orphan handed back for human input.
    Counting these as outcomes inflates convergence and understates the human
    rescue rate — which is the exact dial you are reporting.
  - Spend can be structurally zero. Runs on a self-hosted or
    OpenAI-compatible endpoint are recorded as unpriced rather than free,
    because we have no price table for that endpoint. A tenant on one shows a
    low spend number that means "not measurable here", not "cheap". Never
    present that as cost efficiency.
  - `done` is reviewer approval, not delivery. If landing failed, the ticket
    still counts as done.
Where you cannot separate the signal, say what the number includes rather than
quietly presenting it. Honesty about a metric's limits reads as competence;
being caught by the customer's own engineer does not.$skill$
  ),

  (
    null,
    'Cost claims about DevPilot',
    '1.0.0',
    jsonb_build_object(
      'summary', '"What will this cost" has three different answers depending on runner and provider.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["sales_account_executive","solutions_engineer","cto","customer_success_manager"]'::jsonb,
    '["cost","price","pricing","budget","tco","spend","expensive","cheaper","billing","roi","build vs buy"]'::jsonb,
    $skill$SKILL — Cost claims about DevPilot:
"What does a ticket cost" has no single answer here, and giving one gets
challenged. The honest structure is three facts:
  1. WHICH RUNNER. The default runner executes on the operator's own Claude
     subscription — a flat monthly cost, not per-token, and capped by a
     concurrency ceiling of roughly 1-3 steady agents. The API runner is
     per-token and is what multi-tenant serving requires. Cost per ticket
     means different things under each; say which one you are quoting.
  2. WHAT IS METERED. Spend is recorded per run and checked against a per-run
     ceiling BEFORE the spend happens, with a cost-explosion circuit breaker.
     This is the strongest cost claim we have and it is a real control, not a
     dashboard.
  3. WHAT IS NOT PRICED. Runs against a self-hosted or OpenAI-compatible
     endpoint are recorded as unpriced, not zero. If a projection includes
     those, it is incomplete and must say so.
Never quote a blended cost-per-ticket without naming the runner and the model
tier it assumes. A buyer who later sees a different number treats the first
one as a sales number, and every other figure you gave inherits that.$skill$
  ),

  (
    null,
    'Identifiers and the staged rename',
    '1.0.0',
    jsonb_build_object(
      'summary', 'The product renamed ACE to DevPilot; several user-visible identifiers are still legacy, on purpose.',
      'author', 'DevPilot first-party',
      'verified', true
    ),
    '["techwriter","marketing_manager","solutions_engineer"]'::jsonb,
    '["api key","example","curl","sample","quickstart","getting started","branch","integration","snippet","docs"]'::jsonb,
    $skill$SKILL — Identifiers and the staged rename:
This product was renamed and the rename is DELIBERATELY INCOMPLETE. Several
identifiers a reader will see or type still carry the old name, and
"correcting" them in a doc, an example, or a launch post publishes something
that does not work.
The one that matters most in customer-facing writing: an API key is issued
with a fixed legacy vendor prefix. That prefix is inside the hash preimage of
every issued key, so it cannot be changed without invalidating every key, and
it is not going to change. Never rewrite a sample key to match the product
name — a reader who copies the shape and validates against it will reject real
keys.
Others in the same category: an older git branch namespace, some legacy
environment-variable aliases, and the local database project identifier.
Before writing any identifier into a customer-facing artifact, copy it from
the code or from a real value. Do not normalise it to match the product name.
Prose is a different matter: the product is DevPilot everywhere, and legacy
names should not appear in narrative text.$skill$
  )

) as s(tenant_id, name, version, manifest, targets, triggers, body)
where not exists (
  select 1
    from public.skills e
   where e.tenant_id is null
     and e.name = s.name
     and e.version = s.version
);
