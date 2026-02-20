# DevPilot Phase 1 — Implementation Plan

> **⚠️ Commit hashes below predate a history rewrite and no longer resolve** on the current branch. Treat them as historical labels, not addresses; the work is shipped and committed under different hashes. For the authoritative planned-vs-built status, see `docs/IMPLEMENTATION_STATUS.md`.

> Status: ratified 2026-06-02. Five foundational decisions confirmed (exit criterion, M8 hard caps, realtime transport, billing model, marketplace governance) — all locked to the originally-recommended choices. Phase 0 (M0–M9) is shipped at `ac2dde6`. Read `CLAUDE.md`, `docs/DEVPILOT_PRD.md` §9/§10, and `docs/DEVPILOT_TDD.md` §3–§5 alongside this plan.

## Context

Phase 0 proved the runner-first orchestration loop end-to-end on a single host: a Kanban-style ticket walks through PM → Engineer → QA(reject) → Engineer → QA(approve) → done, durably, with the operator logged off. The Local Claude Code Runner survives lid-close under launchd/systemd. Every step lands in Postgres and Langfuse. The Run Inspector renders the full waterfall.

Phase 1 ("The Studio", PRD §9.1, ~weeks 7–14) graduates DevPilot from "one demo loop" to "a platform other people can use." The four headline graduations are:

1. **Multiple agents on multiple tickets in parallel** — supervisor trees + dynamic spawning with hard caps, parallel/branching workflows, more roles, custom roles from a JD.
2. **Real engineering output, not text proposals** — the Engineer actually edits a repo in a per-ticket scratch git workspace; QA runs `pnpm test` against the branch; MCP board tools let `claude -p` drive transitions itself.
3. **Other people's data, skills, and tools plug in** — SQL connectors with text-to-SQL, skill marketplace, tool marketplace, OS-agnostic data sources.
4. **A platform surface other systems can call** — agents-as-APIs (REST + streaming), OpenAI-compatible endpoint, embeddable widget, Stripe usage billing.

Stack additions are locked to the existing stack (Next.js + Supabase + Upstash + Inngest + Vercel AI SDK + Langfuse). New pieces: **Promptfoo** (evals), **E2B** (sandbox), **React Flow** (Agent Builder), **Stripe** (billing), **Supabase Realtime** (board live updates — open decision below).

## Phase 1 exit criterion (ratified)

PRD §10 does not specify a numeric exit. Ratified criterion, derived from §9.1:

> **A second operator (not the original developer) signs up via a public landing page, files a ticket against their own GitHub repo, and watches a five-agent team — including at least one role they created from a JD — drive it through a parallel sub-workflow (e.g., Engineer + Security review fan-out → join) into a merged-PR-ready branch, with QA runs `pnpm test` against that branch, all on the same lid-closed always-on host. They open the Run Inspector and replay any step. Stripe records the spend. The whole loop is reachable via `POST /v1/agents/{id}/runs` with SSE streaming.**

Hard caps from CLAUDE.md (max depth, max total agents, fan-out limit, per-run budget) and the cost-explosion circuit breaker are **non-negotiable P0** even in Phase 1.

---

## Milestone breakdown (dependency order)

Each milestone is demoable. Build in order. The early items (M0–M3) close out Phase 0 leftovers and are deliberately small — they unblock everything that follows.

### M0 · Engineer git workspace + `devpilot_run_command` (2 days)

Phase 0 ships textual proposals. Phase 1 ships diffs.

- `apps/runner/src/workspace.ts` — clone `ENGINEER_REPO_URL` into `~/.ace/workspaces/<ticketId>/<runId>/`, checkout a branch named `ace/<ticket-slug>`, set `cwd` for `claude -p`, snapshot the workspace path into `run_steps.payload.workspace_path`. Reaper cleans on terminal status.
- Wire `--permission-mode=acceptEdits` against the workspace (already passed in `claude.ts`, just not pointed anywhere yet).
- Add `devpilot_run_command(cmd, args[])` to the runner — runs inside the workspace, streams stdout/stderr to the ticket comments and to a new `run_steps` kind = `tool_result`. Used by QA to actually verify tests pass.
- New env vars: `ENGINEER_REPO_URL`, `ENGINEER_QA_COMMAND` (default `pnpm test`).
- **Accept:** the password-reset scenario produces a real `git diff` on a branch; QA's APPROVE step shows `pnpm test` exit code 0 in its comment.

### M1 · MCP board tools (1½ days)

Plan §5 promised these in Phase 0 and we didn't ship them. Phase 1 needs them so `claude -p` drives the board from inside the runner, instead of postprocess heuristics.

- `apps/runner/src/mcp/mcp-config.example.json` — MCP config exposing:
  - `devpilot_comment(ticketId, body)` → writes a `comments` row
  - `devpilot_move_ticket(ticketId, status, reason?)` → applies state-machine transition (calls back to `/api/board/tickets/{id}/transition`)
  - `devpilot_request_human(question)` → moves to `input_required`, long-polls until human reply, returns the reply
- `apps/web/app/api/runners/tools/*` — MCP server endpoints behind the runner-registration key.
- Retire the role-postprocess heuristic for QA REJECT/APPROVE detection; QA calls `devpilot_move_ticket` directly with a structured reason.
- **Accept:** an M6-style run completes with zero postprocess-driven transitions; all transitions visible as tool calls in the Run Inspector.

### M2 · Realtime board (F-BRD-12) + `tool_call`/`tool_result` step kinds in inspector (1½ days)

Polling-every-5s was Phase 0. Phase 1 is realtime.

- Decision: **Supabase Realtime** (already in the stack, single dependency). Subscribe to `tickets` + `comments` + `runs` filtered by `tenant_id`. Open decision below if Realtime's egress quota turns out too tight in practice.
- `apps/web/components/board/BoardClient.tsx` swaps the 5s poll for a `useSubscription` hook; the `PollingIndicator` becomes a `LiveIndicator`.
- TicketDrawer's Runs section and the Run Inspector subscribe similarly so an in-flight run streams its steps live.
- Inspector now renders `tool_call` and `tool_result` payload shapes (added by M1's MCP integration). Add a "Tool" badge + a side-by-side input/output renderer.
- **Accept:** with two browser tabs open on the same ticket, dragging a card in tab A moves it in tab B within ~500ms; a fresh run's steps appear in the Inspector as they're persisted, not at next refresh.

### M3 · WIP limits + assignment modes + ticket dependencies (1½ days)

Operationalizes the board.

- F-BRD-04: `ticket_dependencies` table already exists (Phase 0 schema). Add `loadDependencies()` and render blockers in the drawer. Dispatcher refuses to move a ticket to `ready` if any blocker isn't `done`.
- F-BRD-07: per-agent `assignment_mode` enum (`pull` | `push`). Push = dispatcher picks; pull = an agent (or human) self-assigns from `ready`.
- F-BRD-08: `agents.config.wip_limit` (default 3). Dispatcher checks remaining capacity before assigning.
- **Accept:** a ticket with an open blocker stays in `backlog` even when manually dragged to `ready` (snaps back with a comment). An agent at WIP limit gets skipped over by the dispatcher; the next-best agent picks up.

### M4 · Additional roles: DevOps/SRE, Tech Writer, Designer, Data Engineer (3 days)

Strictly mechanical — each role is a new file in `apps/web/lib/roles/`.

- One file per role: system prompt, allowed tools (each gets a sensible subset of Read/Edit/Bash/Grep/SQL), `modelTier`, `onSuccessStatus`, `runnerPolicy`.
- Dispatcher's classifier widens to 7 roles (PM, Engineer, QA, DevOps/SRE, Tech Writer, Designer, Data Engineer). Cheap classifier may need a second-pass disambiguation against the role catalog.
- Acceptance scripts in `apps/web/scripts/` — one per new role: file a representative ticket, watch it land in `done`.
- **Accept:** each role completes a representative ticket end-to-end. Cost ceiling per role documented.

### M5 · Custom roles from a JD (F-ROL-03) (2 days)

- `apps/web/app/agents/new/page.tsx` — paste a job description; a Sonnet call generates `{systemPrompt, suggestedTools, suggestedModelTier, suggestedRunnerPolicy, onSuccessStatus}` into an editable form; operator approves → persists as a row in `agents`.
- `agents.role` becomes free-form text (constraint relaxed; built-in roles keep their fixed slugs).
- Dispatcher's classifier reads from the `agents` table at request time instead of a hardcoded ROLES map.
- **Accept:** create a "Localization Reviewer" role from a paragraph; it picks up a ticket about translating UI strings; lands in `done`.

### M6 · Parallel workflows / fan-out + fan-in (F-ORC-04) (3 days)

The first orchestration upgrade beyond linear PM → Engineer → QA.

- New ticket field: `acceptance_strategy` — `single | all | quorum(n)`. Default `single` (Phase 0 behavior).
- Dispatcher gains the ability to emit **multiple** `agent/run.requested` events for one transition. Engineer + Security review in parallel on the same in-review ticket is the canonical demo.
- `lib/engine/aggregator.ts` — a new Inngest function on `agent/run.completed` checks if all sibling runs for a ticket+phase are done; if so, transitions the ticket to the next state (e.g. fan-in `in_review`).
- Run Inspector's `parent_run_id` chain renders as a vertical tree with sibling branches.
- **Accept:** a ticket triggers Engineer + Security review in parallel; both runs land; QA sees both proposals in its prompt; ticket lands in `done`.

### M7 · Conditional branching (F-ORC-05) (2 days)

- Role configs gain an optional `branches` map: `{ "small_change": "qa", "large_change": "tech_lead" }`. The role's final message includes a structured `next: "small_change"` field; the dispatcher reads it.
- Used to route low-risk changes straight to QA and high-risk changes to a Tech Lead review step.
- **Accept:** two acceptance scripts — one small-change ticket (skips Tech Lead) and one large-change ticket (hits Tech Lead) — both land in `done`.

### M8 · Supervisor trees + dynamic spawning + hard caps (5 days)

The high-risk, high-value milestone. **No agent spawn without passing every gate.**

- Extend `lib/engine/budget.ts`'s `assertCanProceed(parent, action)` so `action: "spawn"` checks:
  1. `parent.depth + 1 <= MAX_DEPTH` (default 3)
  2. `parent.children_count + 1 <= MAX_FAN_OUT` (default 4)
  3. `global active runs <= MAX_TOTAL_AGENTS` (default 20)
  4. `parent.budget_cents - parent.spent_cents - estimated_child_budget >= 0` (budget inheritance)
  5. Cost-explosion circuit breaker: if `spent_cents / wall_clock_minutes` crosses a configured threshold, refuse and emit `ops/cost.spike`.
- New role: **Supervisor** — its tool set includes `devpilot_spawn_agent(role, prompt, budget)`, `devpilot_monitor_subtree()`, `devpilot_terminate(runId)`. Supervisor is an ordinary role; spawned children are ordinary runs with `parent_run_id` set.
- Reaper: an Inngest function on `inngest/function.failed` for any run cascades termination to all children via a `ops/cascade-kill` event.
- Orphan cleanup: nightly scheduled function (Inngest `cron`) terminates runs whose parent is in a terminal state but whose status is still `running`.
- Inspector renders `parent_run_id` as a real tree; per-subtree spend rolls up.
- **Accept (and a HARD CAP TEST):** a Supervisor spawned with budget=$1 and MAX_DEPTH=2 tries to recursively spawn 100 children; the runaway is killed at the first cap violation; total spend stays under $1; Langfuse trace shows the refusal span.

### M9 · Supervision strategies + restart / let-it-crash / escalate (2 days)

- `runs.supervision_strategy` enum: `restart_n_times(n) | let_it_crash | escalate_to_human`.
- The Inngest failure handler reads the strategy: restart re-emits `agent/run.requested` with `parent_run_id` preserved; let-it-crash propagates failure up; escalate creates an `input_required` ticket on the supervisor's behalf.
- **Accept:** three scripts, one per strategy, each producing the expected outcome.

### M10 · SQL data sources + query-as-tool (F-DAT-03/05) (3 days)

The first non-vector data source.

- `data_sources` row with `kind = sql`, `config = { connection_secret_ref, allowed_tables: [...], read_only: true }`. Connection lives in a secrets manager (env vars in Phase 1; Doppler/Vault later).
- New tool: `query_db(dataSourceId, sql, params?)`. Server-side validation: must be `SELECT`; must touch only allow-listed tables; mandatory `LIMIT 1000`; statement timeout 30s.
- For text-to-SQL: a `query_db_smart(naturalLanguageQuery, dataSourceId)` wraps `query_db` — uses Sonnet to translate NL → SQL, runs through the validator.
- Per-agent scoping: `agents.config.data_source_ids[]` — RLS function `current_agent_data_sources()`.
- **Accept:** a Data Engineer role asks "show me last week's signups by referrer" against a sample Postgres; gets a row count; ticket lands in `done`.

### M11 · Skill marketplace + tool marketplace (F-CAP-03/07) (4 days)

Bundles `agents.config` into reusable artifacts other tenants can install.

- `skills` table: already in Phase 0 schema. Phase 1 actually uses it.
- Marketplace UI at `/app/marketplace`. Read public skills (`tenant_id is null`), install into the current tenant (clones the skill row with the new tenant_id), uninstall.
- Skills have `manifest` (declared tools + trigger keywords) and `body` (a fragment merged into the system prompt at runtime).
- Skill selection at runtime: cheap relevance pass (Haiku) over installed skills, picks top-N matching the ticket's text and the agent's role.
- Tools follow the same shape — `tool_packages` table mirrors `skills` for tool bundles (MCP server URLs + auth refs).
- **Accept:** publish a "RFC writer" skill from one tenant; install in another tenant; use it on a ticket; trace shows the merged-in system prompt fragment.

### M12 · Evals harness — Promptfoo + LLM-as-judge (F-OBS-04) (3 days)

- `tests/evals/` directory; `promptfoo` config keyed to DevPilot's role prompts. Each role gets a gold set: ticket → expected next-state, expected substring/regex in output, optional LLM-judge rubric.
- CI: GitHub Actions job runs Promptfoo on PR; fails if pass-rate drops > 5%.
- Failed production runs auto-flow into a Langfuse "candidate gold set" dataset — operator triages weekly into the real gold set.
- **Accept:** introduce a deliberate regression (loosen QA's REJECT criteria); CI catches it.

### M13 · Replay / time-travel from any step (F-OBS-02) (2 days)

- Run Inspector gains a `Replay from here` button on every step.
- New Inngest function `replayRun(originalRunId, fromStepIdx, overrides?)` — clones the run row with a new id and `parent_run_id = originalRunId`, copies `run_steps` up to `fromStepIdx`, then resumes the loop with optional prompt overrides.
- Inspector shows a "replay chain" navigator: original → replay-1 → replay-2 …
- **Accept:** replay an M6-era QA REJECT step with a tightened prompt; the new run lands in `done` (or differently-failed) in <3min; trace shows the replay parentage.

### M14 · Agents-as-APIs + OpenAI-compatible endpoint + embeddable widget (5 days)

The platform surface.

- `POST /v1/agents/{id}/runs` — body: `{ prompt, budgetCents?, stream?: boolean, metadata? }`. Async by default (returns `{ runId, status: "queued" }`). With `stream: true` returns SSE of run-step events.
- `POST /v1/chat/completions` — OpenAI shape: maps to a single-shot agent (configurable default role) and streams chunks as OpenAI deltas.
- API auth: per-tenant API keys (`api_keys` table, sha256 hashed). Rate limits via Upstash sliding window keyed on `apiKeyId`.
- Embeddable widget: a tiny iframe-able React app served from `/widget/[agentId]`; uses the API with a public widget token (scoped to one agent, read-only audit log).
- **Accept:** drive the password-reset scenario from `curl` only; observe SSE chunks; OpenAI-compat endpoint runs a `gpt-4o`-shaped request against the platform's default role; widget embedded in a static HTML page processes a ticket end-to-end.

### M15 · Stripe usage-based billing (F-PLT-06) (3 days)

- Per-tenant Stripe customer; meter on `runs.spent_cents` aggregated nightly via Inngest cron.
- Usage tier: included free credits per month, then per-cent overage at a markup. Configurable.
- Hard cutoff when `tenant.balance_cents < 0` AND tenant has no valid payment method: dispatcher refuses to `agent/run.requested`; ticket holds in `ready` with a `system` comment.
- **Accept:** simulate a month of activity; Stripe shows correct usage line items; cut off a tenant by removing the test card; new tickets stall.

### M16 · Agent Builder — React Flow visual editor (4 days)

The last UX layer.

- `/app/builder/[agentId]` — a React Flow canvas where nodes are role + tool + skill + data-source + budget; edges are conditional routing (M7's `branches`).
- Compiles to the existing `agents.config` JSON on save; loads from it on open.
- A "Test run" sidebar runs the agent against an ad-hoc ticket without persisting.
- **Accept:** build the password-reset multi-role workflow (PM → Engineer + Security parallel → QA) visually; save; the saved agent reproduces the M6 scenario when fed a similar ticket.

**Total estimate:** ~50 working days (~10 weeks of focused effort). Phase 1 §9.1's "weeks 7–14" implies ~8 weeks; some milestones will compress (M4 is parallelizable across roles; M11 and M15 can run in parallel with M12/M13 since they're independent surfaces).

---

## Locked decisions (ratified 2026-06-02)

| Decision                     | Choice                                                                                                                | Why                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Exit criterion**           | Full proposal as drafted (second-operator demo with parallel sub-workflow, custom role, merge-ready PR, APIs, Stripe) | One demo proves the platform graduation; tighter scope cuts were rejected in favor of one credible end-state.                                                                                                 |
| **Supervisor hard caps**     | `MAX_DEPTH=3`, `MAX_FAN_OUT=4`, `MAX_TOTAL_AGENTS=20`, `DEFAULT_RUN_BUDGET_CENTS=500`                                 | Sized for one operator's subscription. No risk of accidental $$$ blowup. Easy to relax per-agent later; hard to recall a charge. Enforced engine-side, not per-agent.                                         |
| **Realtime board transport** | Supabase Realtime                                                                                                     | Already in stack; zero new dependencies. Subscribe per-page (not globally) to stay within free-tier egress; revisit if quota bites in M2 load testing.                                                        |
| **Billing model**            | Usage-based with included monthly bucket + per-cent overage at a markup                                               | Maps directly to `runs.spent_cents`. Soft cutoff when balance < 0 and no valid card. Flat tiers and pure-usage were rejected for not matching the cost surface and for first-time-user friction respectively. |
| **Marketplace governance**   | Phase 1: read-only verified first-party bundles (~10–20 skills, curated). No user submissions.                        | Lowest risk, clearest demo. Public submissions punted to Phase 2 once governance + content scanning land. Marketplace UI still ships; only the publish-flow is gated.                                         |
| Promptfoo location           | Repo-local under `tests/evals/`, CI via GitHub Actions                                                                | Co-located with the code under test; same review surface as application code.                                                                                                                                 |
| Sandbox boundary             | **E2B** for any `devpilot_run_command` that touches an untrusted repo URL (not on the operator's own repo)            | Untrusted-content rule (CLAUDE.md). Operator-owned repos run in the local workspace; everything else in E2B.                                                                                                  |
| API auth                     | Per-tenant API keys, sha256-hashed at rest                                                                            | No OAuth2 surface in Phase 1; Phase 2 if needed.                                                                                                                                                              |
| Custom role definition       | Free-form `agents.role` text + JD → prompt synthesis                                                                  | No DSL; the role IS its system prompt + tools + model tier.                                                                                                                                                   |

## Open decisions (defer to their milestone)

- **Replay storage** (M13): replay clones can multiply DB storage. Cap at 5 replays per original run? Soft-delete originals after 30 days? Decide when M13 starts and we have real storage numbers.
- **Widget auth** (M14): widget tokens are scoped to one agent + rate-limited; is a domain-allowlist also required to prevent token reuse? Decide when M14 starts and we know the integration surface.

## Data model deltas

> **Correction (2026-07-05):** several deltas below were _planned_ as first-class columns but _implemented_ as JSONB config keys or under different names. The as-built truth is noted inline. See `docs/IMPLEMENTATION_STATUS.md`.

| Table           | Phase 1 additions                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents`        | ~~`assignment_mode` text; `wip_limit` int~~ — **as-built: both are JSONB keys in `agents.config`, never became columns** (dispatch casts `config->>'wip_limit'`); `role` constraint relaxed to text; `config` jsonb gains `branches`, `data_source_ids[]`, `skill_ids[]` |
| `tickets`       | `acceptance_strategy` text (`single` \| `all` \| `quorum(n)`); ~~`workspace_branch` text~~ — **as-built: the column is named `git_branch_name`**                                                                                                                         |
| `runs`          | `supervision_strategy` text; `children_count` int; index on `parent_run_id`                                                                                                                                                                                              |
| `run_steps`     | `kind` enum expands: `tool_call`, `tool_result` actually emitted (Phase 0 reserved them but never wrote them)                                                                                                                                                            |
| `data_sources`  | ~~`connection_secret_ref` text; `allowed_tables` jsonb~~ — **as-built: neither is a column; both live in `data_sources.config` JSONB** (the SQL allow-list is read from `config.allowed_tables`)                                                                         |
| `skills`        | actually used; add `installed_from_skill_id` for marketplace clone tracking                                                                                                                                                                                              |
| `tool_packages` | NEW — same shape as `skills`                                                                                                                                                                                                                                             |
| `api_keys`      | NEW — `id`, `tenant_id`, `name`, `hash`, `last_used_at`, `revoked_at`                                                                                                                                                                                                    |
| `tenants`       | `stripe_customer_id`, `balance_cents`, `monthly_included_cents`                                                                                                                                                                                                          |

All deltas land as forward-only migrations in `supabase/migrations/`. RLS policies extended where new tables are added.

## Out of scope (Phase 2)

- **Hybrid search** (pgvector + tsvector + filters) — F-DAT-04 P2.
- **Teach-a-skill from a successful run** — F-CAP-04 P2.
- **Auto-scaling supervisors** — F-SUP-04/05 P2; only the hard caps land in M8.
- **Prompt/response diffing across versions** — F-OBS-03 P2.
- **White-label / SSO / org-level RBAC beyond RLS** — F-PLT-04/05 P2.
- **Multi-region deploy / on-prem** — Phase 2+.

## Critical files (where the work lands)

| Concern                                   | Path                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Engineer workspace + devpilot_run_command | `apps/runner/src/workspace.ts`, `apps/runner/src/tools/run-command.ts`                                          |
| MCP board tools                           | `apps/runner/src/mcp/mcp-config.example.json`, `apps/web/app/api/runners/tools/*`                               |
| Realtime hooks                            | `apps/web/lib/realtime/*`                                                                                       |
| Dependencies / WIP                        | `apps/web/lib/board/dependencies.ts`, `apps/web/lib/engine/dispatcher.ts`                                       |
| Additional roles                          | `apps/web/lib/roles/{devops,techwriter,designer,dataeng}.ts`                                                    |
| Custom roles                              | `apps/web/app/agents/new/`, `apps/web/lib/roles/load.ts`                                                        |
| Parallel + branching                      | `apps/web/lib/engine/aggregator.ts`, dispatcher updates                                                         |
| Supervisor / spawning                     | `apps/web/lib/engine/budget.ts` (extended), `apps/web/lib/roles/supervisor.ts`, `apps/web/lib/engine/reaper.ts` |
| SQL data sources                          | `apps/web/lib/data/sql.ts`, `apps/web/lib/data/text-to-sql.ts`                                                  |
| Skill marketplace                         | `apps/web/app/marketplace/`, `apps/web/lib/skills/*`                                                            |
| Evals                                     | `tests/evals/`, `.github/workflows/evals.yml`                                                                   |
| Replay                                    | `apps/web/lib/engine/replay.ts`, Inspector additions                                                            |
| Platform API                              | `apps/web/app/v1/agents/[id]/runs/route.ts`, `apps/web/app/v1/chat/completions/route.ts`                        |
| Widget                                    | `apps/web/app/widget/[agentId]/`                                                                                |
| Billing                                   | `apps/web/lib/billing/stripe.ts`                                                                                |
| Agent Builder                             | `apps/web/app/builder/[agentId]/`, React Flow nodes                                                             |

## Verification (Phase 1 done)

The exit criterion at the top of this doc is the demo. In addition:

- **Cap-tampering tests:** four runaway scenarios (deep, wide, total, budget) all halt at the cap with a Langfuse-recorded refusal span.
- **Marketplace round-trip:** publish a skill from tenant A, install in tenant B, run it, uninstall.
- **API contract test:** OpenAI Python SDK pointing at `/v1/chat/completions` runs a basic `chat.completions.create` call against the default agent.
- **Billing simulation:** run for 1h with metered usage; Stripe dashboard line items match `runs.spent_cents` to the cent.
- **Eval regression:** introduce a deliberate role regression on a PR; CI blocks the merge.

---

## Tasks for a fresh Claude resuming Phase 1

> Resume DevPilot Phase 1 from `docs/DEVPILOT_PHASE1_PLAN.md`. Phase 0 (M0–M9) is shipped at `ac2dde6`. Read `CLAUDE.md`, `docs/SESSION_HANDOFF.md`, `docs/DEVPILOT_PRD.md` §9–§10, and this plan in that order. Start at the lowest-numbered milestone not yet acceptance-proved. Enter plan mode for any milestone whose scope is ambiguous in this doc.
