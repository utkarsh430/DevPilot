# DevPilot Phase 2 — Production Hardening — Implementation Plan

> **⚠️ Commit hashes below predate a history rewrite and no longer resolve** on the current branch. Treat them as historical labels, not addresses. For the authoritative planned-vs-built status, see `docs/IMPLEMENTATION_STATUS.md`.

> **Naming note:** this is **"Phase 2 — Production Hardening"** (containerize the runner, multi-release dispatch, QA rubric, prod deploy, reaper). It is a _different_ scope from the PRD §9.3 "Phase 2 — Scale & Ecosystem" (auto-scaling, self-improvement, publishing/white-label, hybrid search, enterprise); those PRD roadmap items are a later phase. The two docs previously used "Phase 2" for disjoint scopes — see `docs/IMPLEMENTATION_STATUS.md`.

> Status: drafted 2026-06-03 afternoon, expanded 2026-06-03 evening. The five original milestones (M0–M4) were modeled on the Phase 1 plan. **M0 (stale-run reaper) shipped at `b7fb1a1`. A larger M5 series shipped the same evening — see §"Phase 2 / M5 series (shipped)" below — covering per-project repos, GitHub OAuth, scaffolder, review-and-push UX, Run on localhost, Live workspace tab, project metrics, role picker, and the LLM auto-classifier.** M1 / M2 / M3 / M4 from the original plan remain unshipped. Phase 1 (M0–M16) is shipped at `95c258a`. Read `CLAUDE.md`, `docs/DEVPILOT_PRD.md` §9.2/§9.3, `docs/DEVPILOT_TDD.md` §8, `docs/DEVPILOT_PHASE1_PLAN.md`, and `docs/SESSION_HANDOFF.md` §0/§7/§8b/§9 alongside this plan.

## Phase 2 / M5 series (shipped 2026-06-03 evening)

These weren't in the original 5-milestone plan but landed in the same evening session, in response to the operator's question "I file a ticket — where does the work go?" Each sub-milestone is one commit; full descriptions in `docs/SESSION_HANDOFF.md` §1b.

| Sub-milestone                                                            | Commit    | Headline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **39 specialized roles**                                                 | `1468d3e` | Catalog grew 10 → 49 (Leadership/Engineering/Data/Infra/QA-Sec/Design/GTM/Ops). Materialization migration; non-breaking. Unreachable from the UI until M5g+h.                                                                                                                                                                                                                                                                                                                                 |
| **M5 — per-project repos + GitHub OAuth + scaffolder + review-and-push** | `b40b4f9` | `projects` + `github_oauth_tokens` (pgcrypto-encrypted via security-definer fns) + `pending_pushes` + `ace_audit_log`. Supabase Auth GitHub provider; runner injects `x-access-token` into origin URL. `pendingPushTracker` Inngest fn. UI: `/projects`, `/changes`, `/settings/github-integration`, topbar ProjectSwitcher, sidebar ChangesBadge. 50th role `project_scaffolder`.                                                                                                            |
| **M5e — Run on localhost + Live workspace tab**                          | `dd95303` | `dev_server_sessions` table. Runner stack-detect (Next/Vite/uv/cargo/go) + port probe from 3100 + heartbeat + log ring. Three reapers (heartbeat 90s, idle 30 min, runner SIGTERM cascade). RunPanel on `/projects/<id>` AND `/changes/<id>`. Live tab on `/changes/<id>` (git tree + read-only preview). Bundles: `lib/auth/browser.ts` extraction + `useLivePendingPushes` per-mount `React.useId()` fix.                                                                                   |
| **M5f — project metrics dashboard**                                      | `99e3e28` | `lib/metrics/project.ts` joins runs ⨝ tickets.project_id ⨝ agents. ProjectStatsRow (4 tiles) + SpendChart (14-day inline SVG) + RoleUsageTable. Per-ticket role + cost + duration badges via `COALESCE(runs.fan_out_role, agents.role)`. No schema.                                                                                                                                                                                                                                           |
| **M5g+h — role picker + Haiku auto-classifier**                          | `b2ba965` | **Breaks the dispatcher's hardcoded pm→engineer→qa loop.** 50-entry `lib/roles/catalog.ts` (slug + displayName + category + purpose). `<RoleSelect>` cmdk combobox on the New Ticket dialog (auto-pick default). Inline classifier hook in `decideNextRole` calls `generateObject(claude-haiku-4-5)` with the catalog when `requested_role IS NULL && agentAuthors=∅ && status ∈ {backlog,ready}`. CAS-style UPDATE so operator pick always wins. Cost ~$0.0003 per ticket on first dispatch. |

> **Count note (2026-07-05):** the "49"/"50th role" figures above are historical snapshots at those commits. The catalog has since grown — **52 roles are registered today** in `lib/roles/index.ts`. Treat any fixed role count in this doc as approximate.

The M5 series closes the "I built a large role catalog and the dispatcher only ever picks pm/engineer/qa" surprise — the catalog is now reachable both manually (M5g picker) and automatically (M5h classifier). M5e closes "where does the work go" by giving the operator a Run-on-localhost button + live workspace browser. M5f gives the operator visible metrics per project: total spend, daily timeline, per-role usage, per-ticket cost/role/duration.

Known gap that surfaced during M5/M5e live testing: the `handle_new_user()` trigger doesn't auto-create a Default project for tenants minted by GitHub OAuth signup. Documented in `docs/SESSION_HANDOFF.md` §8b incident #3 and §7 deferred list.

## Context

Phase 0 proved the loop on one host. Phase 1 graduated the loop into a platform: parallel agents, real engineer diffs against a per-ticket git workspace, OS-agnostic data sources, agents-as-APIs + Stripe billing, eval harness, replay, visual builder. The end-state is demoable but operator-bound: DevPilot only runs while a laptop is awake, the dispatch queue drains conservatively (one release per completion to avoid the 2026-06-02 runaway), QA's REJECT-on-first-pass is a static prompt heuristic, and there is no scheduled function to reap a crashed run's WIP slot (the 2026-06-03 WIP-zombification incident).

Phase 2 ("Production", PRD §9.2/§9.3 deferred items + 2026-06-03 incident learnings) is the smallest set of changes that lets a non-developer-operator host DevPilot without babysitting a laptop. Two failure classes are closed (zombified WIP, conservative dispatch drain that compounds under load), one heuristic gives way to its eval-backed replacement, and the engine relocates to managed infra. The runner becomes portable.

The phase is deliberately tight — five milestones, ~2½ weeks of focused effort — because the Phase 1 exit criterion already covers everything Phase 2 doesn't: roles, marketplace, replay, billing, builder. Phase 2 is plumbing for what Phase 1 shipped.

Stack additions are minimal: Docker (for runner portability), Vercel + Inngest Cloud (already on the roadmap, just not configured), no new libraries.

## Phase 2 exit criterion (ratified)

> **A second operator (not the original developer) provisions a Vercel project + Inngest Cloud workspace from a one-line runbook, registers a containerized runner from any Linux host via `REGISTRATION_KEY` + `ENGINE_URL`, and runs the Phase 1 password-reset scenario without operator-side babysitting: every WIP slot self-recovers from a simulated runner crash within 5 minutes, the dispatcher drains ≥1 queued ticket per completion under bursty load without re-introducing the 2026-06-02 runaway, and QA's rejection items are rubric-checkable in the M12 eval suite (with regression catching pre-merge). No `ssh user@laptop` anywhere in the loop.**

The CLAUDE.md hard ceilings (`MAX_DEPTH=3`, `MAX_FAN_OUT=4`, `MAX_TOTAL_AGENTS=20`, `DEFAULT_RUN_BUDGET_CENTS=500`) and the cost-explosion circuit breaker (M8) remain **non-negotiable P0** in Phase 2.

---

## Milestone breakdown (dependency order)

Build in order. M0 unblocks every other milestone — without the stale-run reaper, M2's multi-release dispatch increases the surface area of the WIP zombification class.

### M0 · Stale-run reaper — ✅ Live (uncommitted, 2026-06-03)

Closed the 2026-06-03 WIP-zombification class: crashed runners no longer hold WIP slots indefinitely; the dispatch_queue self-drains on stale-run reap. Shipped as part of this Phase 2 plan's drafting session.

- `apps/web/lib/engine/stale-run-reaper.ts` (new) — Inngest scheduled function, dual-trigger: `cron: "*/5 * * * *"` + `event: "internal/reap-stale-runs"`.
- `apps/web/lib/engine/inngest.ts` — added the `internal/reap-stale-runs` event to the Events schema so TypeScript accepts the second trigger.
- `apps/web/app/api/inngest/route.ts` — registered `staleRunReaper` next to `workspaceReaper`.
- Scan `runs` where `status='running' AND last_event_at <= now() - 15m` (override via `DEVPILOT_STALE_RUN_THRESHOLD_MINUTES`). `awaiting_human` is deliberately excluded (legitimate paused state).
- Per stale run, in a single `step.run()`: conditional UPDATE `status='failed' WHERE status='running'` (idempotent across cron ticks); INSERT a `run_steps` system row at `idx=99_996` with `payload={ kind: "stale-run-reaped", thresholdMinutes, last_event_at }`; emit synthetic `agent/run.completed` with `status: "failed"`, `fanOutGroup` from the row, and `role` from `runs.fan_out_role` (the column where role lives for fan-out siblings; non-fanout runs route by `tickets.requested_role` instead and the synthetic event carries no role).
- Opt-out: `DEVPILOT_STALE_RUN_REAPER=0`.
- Acceptance: `apps/web/scripts/phase1-stale-run-reaper-accept.mjs` PASS (5 assertions: seed → trigger → wait for `status='failed'` → audit step at `idx=99_996` with correct payload → idempotent on re-trigger).
- **Accept:** `node --env-file=.env.local scripts/phase1-stale-run-reaper-accept.mjs` exits 0; a manually-killed runner mid-step results in the stuck run reaching `failed` within 5 min and the next ticket dispatching off the queue.

### M1 · Containerize the runner (4 days) — ❌ NOT SHIPPED (no `apps/runner/Dockerfile`, no `infra/docker/`)

Today the runner only runs where the operator's laptop runs (and only via `tsx watch` from the repo). Phase 2 ships a Docker image so the runner can register from any host — a small VPS, an always-on box, a Fly Machine, anywhere with `docker run`.

- `apps/runner/Dockerfile` — multi-stage build: pnpm install + `tsc -p tsconfig.json` → distroless or `node:20-slim` runtime; `CMD ["node", "dist/index.js"]`. Add a `pnpm build` step to the runner package if it doesn't already produce `dist/`.
- Image accepts at minimum: `REGISTRATION_KEY`, `ENGINE_URL`, `WORKSPACE_ROOT` (defaults `/var/lib/ace/workspaces`), `ENGINEER_REPO_URL`, `CONCURRENCY`. The existing `apps/runner/src/env.ts` validates these on boot.
- Volume guidance: `WORKSPACE_ROOT` is a Docker volume; without persistence, every container restart loses the per-ticket workspaces and forces a re-clone (functional but slow on big repos).
- Subscription auth in a container: the existing local-cc runner uses the operator's `claude -p` subscription via `CLAUDE_CODE_OAUTH_TOKEN`. Containerized hosts mount this token at runtime; the image does NOT bake it in. **OPEN:** when no `CLAUDE_CODE_OAUTH_TOKEN` is available (e.g., a fresh CI host), the runner should fall back to `runner_kind='api'` automatically and consume `ANTHROPIC_API_KEY` instead — operator confirmation: is auto-fallback the right shape, or should the runner refuse to start without an explicit `runner_kind`?
- `infra/docker/README.md` — operator runbook: how to build, push, and run; minimum host requirements (git installed in image; claude CLI installed in image).
- **OPEN:** publish as `ghcr.io/<org>/devpilot-runner:latest` (one-click `docker run` for operators) or leave image-build to the operator (no upstream supply chain to maintain)?
- Acceptance script: `apps/web/scripts/phase2-m1-container-accept.mjs` — spin a runner via `docker run -e REGISTRATION_KEY=… -e ENGINE_URL=…`, assert it registers within 30s, file a one-step ticket against `engineer` role, assert completion + a real commit on the host volume.
- **Accept:** an operator on a fresh Linux VM runs `docker run -e … ghcr.io/<org>/devpilot-runner:latest` (or `docker build` locally) and a ticket completes end-to-end without their laptop being involved.

### M2 · Multi-release dispatch with safety budget (2 days) — ❌ NOT SHIPPED (the `claim_next` → `claim_up_to` RPC change never happened; only `dispatch_queue_claim_next` exists)

Today `claimNext` releases at most one queued ticket per `dispatch_queue` completion event (intentionally conservative after the 2026-06-02 runaway). Under bursty load (many completions in quick succession) this leaves throughput on the table. Phase 2 raises the cap to a small, explicit safety budget.

- `apps/web/lib/engine/dispatch-queue.ts` — change `claimNext(tenantId, agentId)` → `claimUpTo(tenantId, agentId, n)`. SQL RPC `dispatch_queue_claim_next` becomes `dispatch_queue_claim_up_to(p_tenant_id, p_agent_id, p_n)`; still `SELECT FOR UPDATE SKIP LOCKED` so siblings can't double-claim. Returns 0–N rows.
- `dispatchOnRunComplete` computes `n = min(remainingWipSlots, SAFETY_BUDGET)`, where `SAFETY_BUDGET = DEVPILOT_DISPATCH_SAFETY_BUDGET ?? 3`. Iterates and re-dispatches each row in sequence (one `agent/run.requested` per claimed entry; preserves the existing per-row Inngest concurrency key).
- The 2026-06-02 runaway was caused by RECURSIVE chains releasing N>>1 per completion. The safety budget here is per _completion-event_, not per _function-tick_; the original runaway shape (`releaseAll`) stays banned.
- Telemetry: emit `dispatch/release-batch` (`{ tenantId, agentId, claimed, budget }`) every batch so the trace shows N per drain.
- **OPEN:** is the safety budget tenant-scoped (3 per tenant per completion) or per-(tenant, agent) (3 per dispatcher concurrency-key per completion)? Per-(tenant, agent) matches the existing concurrency key but allows more total throughput per tenant; tenant-scoped is more conservative.
- Migration: `supabase/migrations/<ts>_m2_dispatch_claim_up_to.sql` — drop the old RPC, create the new one. The Inngest function ID changes (because the SQL function changed); operator restart of Inngest dev clears the cached registration.
- Acceptance script: `apps/web/scripts/phase2-m2-multi-release-accept.mjs` — seed K (>safety budget) queued entries, fire one `agent/run.completed`, assert exactly `SAFETY_BUDGET` `agent/run.requested` events follow within 10s; replay-protection check (no row claimed twice across concurrent ticks).
- **Accept:** with `SAFETY_BUDGET=3` and `WIP_LIMIT=4` and 10 queued entries, three completion events release all 10 within 30s; with `SAFETY_BUDGET=1` (regression fallback), throughput matches the Phase 1 baseline (proves it's a knob, not a rewrite).

### M3 · Real QA eval criteria via M12 harness (3 days)

Today QA's first-pass-REJECT is a static prompt instruction enforced by an LLM-rubric in `tests/evals/qa.eval.yaml`. The rubric checks that the rejection raises ≥2 concrete improvement items — a useful safety net but a thin proxy for "QA caught a real issue." Phase 2 replaces the heuristic with structured rejection criteria the rubric can score per dimension.

- `apps/web/lib/roles/qa.ts` — replace the "you MUST REJECT on first pass" instruction with a rubric-driven instruction: QA outputs a structured `{ verdict: "REJECT" | "APPROVE", findings: Array<{ category: string, severity: "low"|"med"|"high", description: string, evidence?: string }> }` JSON block inside the comment body. `Category` enum: `correctness | security | observability | tests | docs | perf | accessibility | edge_case`. Postprocess parses the block; rubric scores each `findings[]` entry.
- `tests/evals/qa.eval.yaml` — gold rubric updated to: (a) verdict matches expected; (b) ≥2 distinct `category` values in findings; (c) at least one `severity=high` finding for the deliberate-regression case; (d) `evidence` field non-empty when severity is `high`. Existing test cases regenerated against the new prompt.
- The regression-catching CI job (`.github/workflows/evals.yml`) continues to fail at >5% drop; Phase 2 adds per-role pass-rate breakdown to the GitHub Actions summary so a regression in one role doesn't get masked by the overall.
- **OPEN:** keep the "first-pass-REJECT-or-rubric-fails" heuristic as a hard fallback when the rubric coverage is below a confidence threshold? The conservative choice is yes (don't ship a QA that suddenly APPROVEs everything); the aggressive choice is full replacement (the rubric IS the contract).
- Acceptance script: `apps/web/scripts/phase2-m3-qa-rubric-accept.mjs` — seed three tickets (a known-good engineer diff; a deliberate-regression diff missing rate limiting; a marginal diff with one ambiguous finding). Assert (a) first APPROVES, (b) second REJECTs with `severity=high` + `category=security` finding, (c) third produces ≥1 finding with `evidence` populated.
- **Accept:** the M12 eval suite passes with the new rubric on three production-realistic role outputs (PM-refined ticket → engineer diff → QA judgment) without the first-pass-REJECT prompt instruction.

### M4 · Vercel + Inngest Cloud production deploy (2 days) — ❌ NOT SHIPPED (no `vercel.json`, no `infra/deploy-vercel.md`, no `app/api/health/route.ts`)

Phase 1 runs on `localhost:3000` + Inngest dev. Phase 2 puts the engine on Vercel + Inngest Cloud so the dispatcher, reapers, billing aggregator, and replay engine all run without an open laptop.

- `vercel.json` at repo root — `buildCommand`, `framework: "nextjs"`, env-var allowlist documented in `infra/deploy-vercel.md`.
- `infra/deploy-vercel.md` — operator runbook: (1) create Vercel project pointing at `apps/web/`; (2) set env vars (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `STRIPE_SECRET_KEY`, etc. — full list); (3) connect Inngest Cloud workspace via the `/api/inngest` webhook; (4) verify all registered functions show up in the Inngest dashboard (**there are now 25 registered functions**, not the 11 this plan assumed — see `apps/web/app/api/inngest/route.ts`); (5) Stripe webhook re-points to the prod URL; (6) Supabase realtime allowlist updated with the prod domain.
- No new code surface — this is config + docs.
- **OPEN:** publish a `vercel/template` one-click deploy button (lower friction for new operators, but couples DevPilot to Vercel's template-review surface), or keep the runbook as the only path (more control, slightly slower onboarding)?
- Acceptance script: `apps/web/scripts/phase2-m4-prod-deploy-accept.mjs` (operator-driven) — point at `https://<vercel-url>/api/health` (planned new endpoint — **note: `/api/health` was never built**; a richer `/api/system-health` and a trivial `/health` liveness exist instead), returns the registered Inngest function names + Supabase pingback, assert all expected functions (**25 today**, not 11) are listed and Supabase reachable.
- **Accept:** the exit-criterion scenario (containerized runner on a third-party host pointed at the Vercel-hosted engine) runs end-to-end without any local `pnpm dev` process.

**Total estimate:** ~12 working days (~2½ weeks). M0 and M2 can run in parallel after M0's reaper file is merged; M3 is independent of all others; M1 and M4 are independent of each other but both required for the exit criterion.

---

## Locked decisions (drafted 2026-06-03; pending operator ratification)

| Decision                           | Choice                                                                                                                                                             | Why                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Exit criterion**                 | Containerized runner + reaper-stabilized WIP + multi-release dispatch + rubric-checked QA + Vercel + Inngest Cloud, all proven by a runner on a non-developer host | Phase 1 already proved the platform on the developer's machine; Phase 2 is the smallest delta to "someone else can run this."                                                                                        |
| **Stale-run threshold**            | 15 minutes default, env-overridable, opt-out via `DEVPILOT_STALE_RUN_REAPER=0`                                                                                     | Matches the engine's longest expected single-step (heavy claude -p with file tools). 30 min was too lenient (incident response window); 5 min would false-positive on slow steps.                                    |
| **Reaper audit idx**               | `99_996` (kind=`system`, payload.kind=`stale-run-reaped`)                                                                                                          | One below cascade-kill's `99_998`; greppable distinct signature; avoids collisions with `9999` (runAgentFailed) and `99_997` (supervision outcome).                                                                  |
| **Multi-release safety budget**    | Default 3 per completion, per `(tenant, agent)` concurrency key, env-overridable                                                                                   | Matches the existing `dispatchOnRunComplete` concurrency key shape. 3 is enough to drain a typical fan-out without re-introducing the runaway; falls back to 1 cleanly via env.                                      |
| **QA structured-findings schema**  | `{ verdict, findings: [{ category, severity, description, evidence? }] }` with a closed `category` enum and 3-tier severity                                        | A closed enum gives the rubric a hard contract to score against; severity is a coarse but reliable signal; evidence makes high-severity findings auditable.                                                          |
| **Container runtime base**         | `node:20-slim` (multi-stage build; final image ~150MB)                                                                                                             | Distroless would shave 50MB but blocks `git` and `claude` CLI which the engineer role hard-requires. node:20-slim has both via apt.                                                                                  |
| **Prod hosting target**            | Vercel (web/api) + Inngest Cloud (functions) + Supabase Cloud (already there)                                                                                      | Zero migration cost — Phase 1 already runs on this stack locally. Fly/Railway as alternative was rejected: not in current stack, requires additional config language.                                                |
| **Subscription auth in container** | Mount `CLAUDE_CODE_OAUTH_TOKEN` at runtime via env; auto-fall-back to `runner_kind='api'` when absent                                                              | Subscription mode is the default per CLAUDE.md; API mode is the documented escape hatch. The container should not silently switch — env presence is the explicit signal. (See OPEN below for fallback confirmation.) |

## Open decisions (defer to their milestone)

- **M1 — Image distribution.** Publish a maintained `ghcr.io/<org>/devpilot-runner` (zero-friction `docker run` but creates an upstream supply chain to keep updated), or runbook-only with `docker build` (operator owns the supply chain). Decide once we have the Dockerfile working and can measure how often the image needs to refresh.
- **M1 — Subscription auth fallback.** Should the runner auto-degrade to `runner_kind='api'` when `CLAUDE_CODE_OAUTH_TOKEN` is missing, or refuse to boot? Auto-fallback reduces friction; explicit refusal prevents accidental billing surprises (per CLAUDE.md hard ceilings). Operator's risk tolerance call.
- **M2 — Safety-budget scope.** Tenant-scoped vs `(tenant, agent)`-scoped. Per-(tenant, agent) matches the existing concurrency key and allows more throughput; tenant-scoped is more conservative. Decide after M0 ships and we have stable WIP telemetry to estimate the realistic burst rate.
- **M3 — First-pass-REJECT fallback.** Keep the heuristic as a hard floor when the rubric is below a confidence threshold, or fully replace? Conservative path keeps it; aggressive path retires it. Decide once M12 gold-set coverage is measured against real QA decisions.
- **M4 — One-click template.** Publish a `vercel/template` deploy button or runbook-only. Template lowers onboarding friction but couples to Vercel's review surface and can rot. Decide once M4 is otherwise done.

## Data model deltas

| Table            | Phase 2 additions                                                                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs`           | (no schema change) — reaper writes through existing columns.                                                                                                                                                                                    |
| `run_steps`      | (no schema change) — reserved `idx=99_996` for stale-run audit.                                                                                                                                                                                 |
| `dispatch_queue` | (no schema change) — ~~RPC signature changes (`claim_next` → `claim_up_to`); migration drops the old function and creates the new one.~~ **Never happened (M2 unshipped): only `dispatch_queue_claim_next` exists; there is no `claim_up_to`.** |
| `runners`        | (no schema change) — Docker image registers via the existing `/api/runners/register` flow with new headers/env.                                                                                                                                 |

Phase 2 ships almost no schema. Everything below the API line is configuration + ops surface, not data model.

## Out of scope (Phase 3+)

- **Supervisor auto-scaling** (F-SUP-04/05) — hard caps continue to hold from M8; auto-scaling needs different telemetry.
- **Teach-a-skill from successful run** (F-CAP-04) — requires a curation surface DevPilot doesn't have yet.
- **Publishing / white-label / SSO / RBAC beyond RLS** (F-PLT-04/05) — Phase 3 platform-graduation work.
- **Standup / velocity / regression alerts** (F-OBS-05/07/08) — Langfuse + Promptfoo data is there; the dashboard surface isn't.
- **Hybrid search** (F-DAT-06) — pgvector + tsvector + filters. Lands when text-only retrieval starts losing.
- **Multi-region / on-prem** — Phase 3 enterprise track.

## Critical files (where the work lands)

| Concern                       | Path                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stale-run reaper              | `apps/web/lib/engine/stale-run-reaper.ts` (new), `apps/web/app/api/inngest/route.ts` (register), `apps/web/scripts/phase1-stale-run-reaper-accept.mjs` (new)                                                                      |
| Containerized runner          | `apps/runner/Dockerfile` (new), `infra/docker/README.md` (new), `apps/web/scripts/phase2-m1-container-accept.mjs` (new)                                                                                                           |
| Multi-release dispatch        | `apps/web/lib/engine/dispatch-queue.ts`, `apps/web/lib/engine/dispatcher.ts` (`dispatchOnRunComplete`), `supabase/migrations/<ts>_m2_dispatch_claim_up_to.sql` (new), `apps/web/scripts/phase2-m2-multi-release-accept.mjs` (new) |
| QA rubric replacement         | `apps/web/lib/roles/qa.ts`, `tests/evals/qa.eval.yaml`, `apps/web/scripts/phase2-m3-qa-rubric-accept.mjs` (new)                                                                                                                   |
| Vercel + Inngest Cloud deploy | `vercel.json` (new), `infra/deploy-vercel.md` (new), `apps/web/app/api/health/route.ts` (new), `apps/web/scripts/phase2-m4-prod-deploy-accept.mjs` (new)                                                                          |

## Verification (Phase 2 done)

The exit criterion at the top of this doc is the demo. In addition:

- **Reaper acceptance:** `phase1-stale-run-reaper-accept.mjs` exits 0 in both the dev-stack and prod-stack environments.
- **Crash-resilience scenario:** a `kill -9` against a runner mid-step results in the orphaned run reaching `failed` within 5 min (default threshold) and the next ticket dispatching off the queue without operator intervention.
- **Multi-release smoke:** 10 queued tickets + 3 completion events fully drain within 30s with `SAFETY_BUDGET=3`; same scenario with `SAFETY_BUDGET=1` matches Phase 1 baseline (proves the knob).
- **QA rubric regression:** introduce a deliberate engineer regression (e.g., remove rate-limit code); M12 eval suite catches it with a `severity=high category=security` finding.
- **Containerized runner round-trip:** `docker run` on a host outside the developer's laptop registers, completes a ticket, commits to the volume, gets reaped on terminal state.
- **Prod-deploy smoke:** `https://<vercel-url>/api/health` lists all registered Inngest functions including `staleRunReaper` and pings Supabase. _(As-built note: `/api/health` was never created; there are 25 registered functions today, not 11. This whole M4 smoke is unshipped — see the M4 header.)_

---

## Tasks for a fresh Claude resuming Phase 2

> Resume DevPilot Phase 2 from `docs/DEVPILOT_PHASE2_PLAN.md`. Phase 1 (M0–M16) is shipped at `95c258a`. Read `CLAUDE.md`, `docs/SESSION_HANDOFF.md`, `docs/DEVPILOT_PRD.md` §9.2/§9.3, `docs/DEVPILOT_TDD.md` §8, `docs/DEVPILOT_PHASE1_PLAN.md`, and this plan in that order. Confirm each `**OPEN:**` callout in this doc with the operator before writing code for that milestone. Start at the lowest-numbered milestone not yet acceptance-proved. Enter plan mode for any milestone whose scope is ambiguous in this doc.
