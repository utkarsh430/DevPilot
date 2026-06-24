-- DevPilot rename, batch 2b — backfill the persisted half of the MCP tool-name rename.
--
-- The code half of this PR renames the 10 MCP tools `ace_*` -> `devpilot_*`, the MCP
-- server key `ace-board` -> `devpilot-board`, and every `comments.author_id` literal the
-- tool routes WRITE and the reconciler READS. Three kinds of row still carry the old
-- strings, and each one is load-bearing:
--
--   1. comments.author_id — `ace_move_ticket` is not just a tool name, it is the stored
--      authorship stamp the engine string-matches. `lib/engine/ticket-reconciler.ts` does
--      `.eq("author_id", "devpilot_move_ticket")` twice: once to ask "did this run render a
--      verdict?", and once (loadPhaseStartIso) to find the PHASE BOUNDARY that resets the
--      reconcile cap. Rename the literal in code without this backfill and the reconciler
--      goes blind to every historical verdict: no phase boundary is ever found, the cap
--      never rolls over, and long-lived tickets freeze at it. The other authors
--      (`ace_qa_gate`, `ace_safety_gate`, `ace_qa_retry_ceiling`, `ace_runner`,
--      `ace_request_human`, `ace_request_secret`, `ace_agent_ticket`) have no equality
--      reader in prod code, but they are rendered on the ticket, so they move too — one
--      generic statement covers every `ace_` author, including any added since.
--
--   2. agents.config.role_config.systemPrompt — the JD synthesizer
--      (`app/(app)/agents/new/actions.ts`) FORCES the model to write the tool name into
--      the prompt it persists. Every JD-synthesized custom agent in this DB therefore
--      carries a stored prompt instructing it to call `ace_move_ticket`, a tool that no
--      longer exists after this PR. Code edits cannot reach those rows.
--
--   3. skills.body — the seeded `sql-safety-checks` skill (migration 20260603090000)
--      names `ace_query_db` in its body, and `lib/skills/merge.ts` injects skill bodies
--      straight into agent prompts. Same failure mode as (2).
--      skills.manifest->>'author' is display-only ('ACE first-party'); new installs
--      already write 'DevPilot first-party', so this is a cosmetic convergence.
--
-- Every statement is idempotent: after one run no `ace_` token is left for it to match,
-- so a re-run is a no-op. Applied by the operator in a quiet window, together with the
-- code in this PR — the tool name, the write literals, the read literals and this
-- backfill must land as one unit.
--
-- NOT migrated, deliberately: `api_keys` (the `ace_` vendor tag is inside the sha256
-- preimage and cannot be re-derived — a separate dual-accept change), and
-- `run_steps.payload->>'tool'` (a display-only trace label with no equality reader).

begin;

-- 1. Comment authorship. Covers every `ace_<x>` author in one statement.
--    `like 'ace\_%'` — the backslash escapes the `_` wildcard, so `ace_foo` matches and a
--    hypothetical `acex...` does not.
update comments
set author_id = 'devpilot_' || substring(author_id from 5)
where author_id like 'ace\_%';

-- 2. Persisted custom-role system prompts. The tool names are unique tokens, so a plain
--    text `replace` over the jsonb rendering is exact and cannot disturb JSON structure
--    (no quotes or escapes are involved). `ace_query_db` is a prefix of
--    `ace_query_db_smart`, and that is fine: rewriting the prefix leaves the suffix
--    intact, so `ace_query_db_smart` -> `devpilot_query_db_smart` either way.
update agents
set config = replace(
               replace(
                 replace(
                   replace(
                     replace(
                       replace(
                         replace(
                           replace(
                             replace(
                               replace(
                                 replace(config::text, 'mcp__ace-board__', 'mcp__devpilot-board__'),
                               'ace_move_ticket', 'devpilot_move_ticket'),
                             'ace_comment', 'devpilot_comment'),
                           'ace_handoff', 'devpilot_handoff'),
                         'ace_create_ticket', 'devpilot_create_ticket'),
                       'ace_spawn_agent', 'devpilot_spawn_agent'),
                     'ace_request_human', 'devpilot_request_human'),
                   'ace_request_secret', 'devpilot_request_secret'),
                 'ace_query_db', 'devpilot_query_db'),
               'ace_log_conflict_event', 'devpilot_log_conflict_event'),
             'ace_run_command', 'devpilot_run_command')::jsonb
where config::text like '%ace\_%'
   or config::text like '%mcp\_\_ace-board\_\_%';

-- 3. Skill bodies injected into agent prompts (seeded + any installed since).
update skills
set body = replace(
             replace(
               replace(
                 replace(
                   replace(
                     replace(
                       replace(
                         replace(
                           replace(
                             replace(body, 'mcp__ace-board__', 'mcp__devpilot-board__'),
                           'ace_move_ticket', 'devpilot_move_ticket'),
                         'ace_comment', 'devpilot_comment'),
                       'ace_handoff', 'devpilot_handoff'),
                     'ace_create_ticket', 'devpilot_create_ticket'),
                   'ace_spawn_agent', 'devpilot_spawn_agent'),
                 'ace_request_human', 'devpilot_request_human'),
               'ace_request_secret', 'devpilot_request_secret'),
             'ace_query_db', 'devpilot_query_db'),
           'ace_log_conflict_event', 'devpilot_log_conflict_event')
where body like '%ace\_%';

-- 4. Marketplace author label. Display-only; converges the catalog, which has shown a
--    mix since `marketplace/actions.ts` started writing 'DevPilot first-party'.
update skills
set manifest = jsonb_set(manifest, '{author}', '"DevPilot first-party"'::jsonb)
where manifest->>'author' = 'ACE first-party';

commit;
