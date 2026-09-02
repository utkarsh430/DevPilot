<div align="center">

# DevPilot

### The board your agents run.

**A production-grade orchestration runtime for teams of AI agents — where a Kanban board is the scheduler, every run is durable and replayable, every dollar has a ceiling, and the system repairs itself when a run goes wrong.**

[![CI](https://github.com/utkarsh430/DevPilot/actions/workflows/ci.yml/badge.svg)](https://github.com/utkarsh430/DevPilot/actions/workflows/ci.yml)
[![Format](https://github.com/utkarsh430/DevPilot/actions/workflows/format.yml/badge.svg)](https://github.com/utkarsh430/DevPilot/actions/workflows/format.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Next.js](https://img.shields.io/badge/Next.js-App%20Router-000000)
![Supabase](https://img.shields.io/badge/Postgres-Supabase%20%2B%20RLS-3ecf8e)
![Inngest](https://img.shields.io/badge/Durable%20execution-Inngest-5b5bd6)
![Tests](https://img.shields.io/badge/tests-4%2C100%2B-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[Why DevPilot](#why-devpilot) · [How it works](#how-it-works) · [Capabilities](#capabilities) · [Architecture](#architecture) · [Security model](#security-model) · [Quick start](#quick-start) · [Status & roadmap](#status--roadmap) · [Docs](#documentation)

</div>

---

## Why DevPilot

Most "AI agent" products are a loop in a terminal: a model, some tools, and a prompt that hopes for the best. They demo beautifully and fail in exactly the ways production systems fail — a dropped connection loses the work, a runaway agent spends the budget, nobody can say afterwards what actually happened, and the only remedy for a stuck job is a human with database access.

DevPilot starts from the opposite premise: **autonomy is a property of the server-side runtime, never of a terminal you keep open.** It takes the operational discipline we already demand of distributed systems — durable state machines, checkpoints, idempotent workers, hard resource ceilings, observability, trust boundaries, self-healing — and applies all of it to teams of LLM agents.

The result is a system where you describe work as tickets on a board, and a crew of specialised agents (Product Manager, Engineer, QA, Security, Release Engineer, and ~50 more) picks them up, hands them off role to role, reviews each other's output, lands the code on an integration branch, and reports back — **including while you are logged off**, with every step recorded and every failure mode caught by a named mechanism rather than by luck.

The name is **dev** + **pilot**: agents that fly your development work across a kanban board, with you holding the controls.

### What makes it a different kind of system

| Ordinary agent tooling                                             | DevPilot                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents coordinate through in-memory messages that die with the run | **The board is the orchestration substrate.** Agents coordinate by moving tickets and writing comments, so every hand-off is durable, inspectable and resumable by construction.                                                                     |
| A crash, a restart or a closed laptop loses the work               | **Every iteration and tool call is a checkpointed durable step.** A run can wait days on a human reply and resume from the exact step; the runner re-queues any job caught mid-flight on shutdown.                                                   |
| Cost is discovered on the invoice                                  | **Hard ceilings are enforced before spend**: per-run budgets re-checked at every step boundary, a per-tenant cost-velocity circuit breaker, and recursion / fan-out / total-agent caps on every spawn.                                               |
| "Done" means the model said so                                     | **Done is gated.** Producers cannot hand off a failing build, cannot hand off an empty delivery, reviewers cannot finish without recording a verdict, and safety-critical tickets need a human to approve the final move.                            |
| A stuck job needs a human with a database console                  | **Four independent self-healing layers** (ticket reconciler, orphan reaper, dispatch rescue, and a supervisor that lives outside the scheduler) detect stranded work from database facts, repair it, and keep a ledger that flags recurring defects. |
| You find out what the agent did by reading its chat log            | **The trace is the product**: a per-run waterfall of agent → tool → model steps with cost and latency, replayable from any step, exportable as an audit-grade PDF.                                                                                   |
| Everything the model reads is treated as an instruction            | **Untrusted content is fenced as data everywhere it enters a prompt** — tool output, peer-agent hand-offs, repository files, operator comments — and dangerous actions pause on a human gate.                                                        |
| The vendor SDK is wired through the codebase                       | **One pluggable `Runner` interface.** The default runs on your own Claude subscription with the full Claude Code toolset; an API runner is a switch away; a custom OpenAI-compatible endpoint is a per-project setting.                              |

---

## How it works

```
                 ┌──────────────┐    dispatch    ┌──────────────────┐   claim   ┌────────────────────┐
  you file a ──▶ │  Board       │ ─────────────▶ │  Durable engine  │ ────────▶ │  Runner            │
  ticket         │  (tickets,   │                │  (checkpointed   │           │  isolated git      │
                 │   comments,  │ ◀───────────── │   steps, gates,  │ ◀──────── │  workspace +       │
                 │   relations) │  move / comment│   reapers)       │  result   │  claude -p + tools │
                 └──────────────┘                └──────────────────┘           └────────────────────┘
                        ▲                                  │
                        │   verdicts, hand-offs, questions  │  trace, cost, verification record
                        └──────────────────────────────────┘
```

1. **File work on the board.** A ticket carries a title, acceptance criteria, attachments, dependencies (`blocked_by`, `builds_on`, sub-issues) and, optionally, a safety-critical flag. Moving it to **Ready** is what starts the machine.
2. **The engine dispatches it as a durable run.** Role selection, WIP limits, budget checks and spawn caps happen first — refusals are written back to the ticket as system comments, never swallowed.
3. **A runner executes the step** in an isolated per-ticket git workspace, on your Claude subscription (`claude -p`) or through the API runner, with ten board tools exposed over MCP: move the ticket, comment, hand off context, file a follow-up ticket, ask a human, request a secret, spawn a sub-agent, query the project database, log a conflict.
4. **Roles hand the ticket to each other.** PM scopes → Engineer builds → QA breaks → Security clears; a rejection sends it back (bounded by a retry ceiling); a question parks it in **Input Required** until you answer, and your reply is the event that resumes it.
5. **Quality gates sit on the transitions.** A producer's hand-off is refused if the build fails or nothing was committed; a reviewer who reaches a verdict and forgets to record it is prompted to do so before the run can end.
6. **Approved work lands.** The ticket's branch is rebased and squash-merged onto the project's integration branch by a serialised landing pipeline; conflicts spawn a merger agent; dependents are released the moment their parent's code is actually on the branch.
7. **Everything is observable and self-healing.** Each step is a span with its cost; stranded tickets, lost dispatch events and dead runs are detected from database state and repaired, and a supervisor that does not depend on the scheduler watches the healers themselves.

---

## Capabilities

### The board as a runtime

- Kanban (dnd-kit) with a state machine enforced at a single seam: `Backlog → Ready → Assigned → In Progress ⇄ (Input Required | Blocked) → In Review → Done`, plus `Failed` and `Paused`.
- Dependency graph (React Flow) with `blocked_by`, `builds_on` (child workspaces re-root on the parent's landed commit), `related`, `duplicate` and sub-issues; only blocking relations gate readiness.
- Backlog drain as a sliding window (default three tickets in flight), topped up from the next dependency-eligible ticket; recurring schedules; per-column WIP limits; realtime comment threads shared by humans and agents.
- Human-in-the-loop primitives: answer a question, approve a safety-critical move, land now, restart from the integration branch, or deliberately discard and restart — each with the confirmation weight the action deserves.
- Agent-filed tickets: a running agent that discovers out-of-scope work files a new backlog ticket (with declared dependencies) instead of widening its own scope — opt-in per project, capped per run, deduplicated.

### A crew of 53 roles, and the ones you invent

- Product Manager, Engineer (frontend / backend / fullstack / mobile), QA, SDET, Security (AppSec), Release Engineer, Verifier, DevOps, SRE, DBA, Data Engineer, Architect, Technical Writer, designers, analysts, and more — each with a prompt split into **style guidance** and an inviolable **safety contract**.
- **Describe a job, get a role**: a JD-to-role synthesiser drafts a complete role configuration; a visual **Agent Builder** (React Flow) edits agents as graphs.
- **Layered prompts, resolved at dispatch**: role contract → reviewer-awareness → operator overlay (plain-English house rules, with an AI assistant that drafts them) → installed skills → approved lessons. Every layer is fenced, idempotent and never baked into stored config.
- **Browser automation for every role that needs it** (Playwright over MCP), with the prompts told exactly what the tools are and are not.

### Durable execution, pause and replay

- Every agent iteration, tool call and side-effect is a durable Inngest step keyed on deterministic ids, so a replay re-derives the same decisions.
- Pause a ticket or an entire board; in-flight runs halt at the next step boundary with a resumable checkpoint, never mid-model-turn.
- **Replay / time-travel** from any step of any run; fan-out cohorts (several roles on one ticket) are first-class, with an aggregator that gates every sibling.
- A local install runs the **self-hosted Inngest server** with its queue in Redis, so a sleeping run survives a full stack restart (measured, not assumed).

### Runners: your subscription, or any model endpoint

- **Local Claude Code Runner (default)** — executes steps on your own Claude Pro/Max subscription with file, bash and git tools; API keys are stripped from the child environment so a project secret can never silently flip you to per-token billing.
- **API Runner** — stateless, horizontally scalable, required for multi-tenant serving; per-project **custom OpenAI-compatible endpoints** with SSRF-safe base-URL validation at write _and_ call time.
- Per-agent and per-project **model overrides** with truthful UI ("not in effect" is shown as such, never hidden).
- Runner engineering that earned its keep: an Upstash request budget with shared idle back-off, a libuv thread-pool guard with a measurable regression test, graceful shutdown that re-queues the in-flight job, and a stacked-runner detector.

### Quality and safety gates (structural, not prompt-based)

- **L1 QA hand-off gate** — a producer cannot move a ticket to review with a failing test/build; the runner records verification evidence (installing dependencies first, with a frozen lockfile), the engine enforces, and both halves are configured from one switch so "enforcing but recording nothing" is inexpressible.
- **Empty-delivery refusal and commit nudge** — code-producing roles that leave their work uncommitted get one bounded, tool-restricted turn to commit it before the hand-off is judged.
- **Verdict nudge** — a reviewer that finishes without recording a verdict is handed its own conclusion back and asked to record it, with no path that could synthesise an approval.
- **SME safety gate** — a `safety_critical` ticket can reach Done only by a human; no environment flag can disable it.
- **Economics** — per-run budget ceilings checked before _and after_ every step; a tenant-wide cost-velocity breaker that no override can bypass; recursion-depth, fan-out and total-agent caps on every spawn; a QA retry ceiling and a gate-retry ceiling so two disagreeing roles cannot loop forever.
- **Operator-only controls** for every escape hatch (budget override, agent ticket filing, supervisor remediation), so an agent can never arm its own exemption.

### Self-healing, with a conscience

- **Ticket reconciler + stuck-ticket sweeper** — a run that completes without advancing its ticket is reconciled against the role's contract; verdict-less reviews are parked for a human, never silently re-run.
- **Orphan reaper** — a ticket in a working state with no live run and no queued dispatch is handed back to you with a comment that names the idle window, the last run's recorded failure reason and how to resume.
- **Dispatch rescue** — WIP slots are released from the _fact_ of capacity, not from an event that may have been lost; the "at capacity with nothing running" contradiction surfaces in the health indicator.
- **Supervisor loop** — runs in the always-resident runner, outside the scheduler it supervises; observes while the engine's own healers are alive and remediates only when they are provably wedged, reusing their exact primitives.
- **Indictment ledger** — every automatic fix is recorded with its cause, and repeats are escalated as a suspected defect, so a self-healing system cannot quietly hide a leak forever.
- **Supervisor console** — ask the board "why is DevPilot-86 blocked?" in plain English and get a grounded answer with the one action that would change it; the model can never name a target the operator did not.

### From ticket to shipped code

- Per-ticket branches in isolated workspaces; **review-before-push** with split diffs, conflict handling and Push & PR.
- **Auto-land**: approved work is rebased and squash-merged onto the project's integration branch by a serialised pipeline; readiness of dependents gates on the code being _landed_, not merely approved.
- Conflicts spawn a **merger agent** in the source workspace; every landing outcome — landed, nothing to land, not landed and _why_ — is recorded and rendered on the card.
- Never-queued, never-triggered and never-pushed landings are each recovered by a dedicated sweep; nothing ever force-pushes, and no workspace holding the only copy of a commit is ever deleted.
- **Vercel integration**: OAuth connect, repo link with explicit production-branch and auto-deploy posture, provenance-aware environment-variable push, preview/production deploys, rollback and undo — all human-only.

### Observability you can hand to an auditor

- **Run Inspector** — a wall-clock waterfall of think / tool / result steps with per-step cost, a cumulative cost curve against the budget, cohort lanes, Langfuse deep links, live tmux attach and take-the-wheel takeover.
- **Audit-grade PDF export** per ticket and per project: narration, cost, verification evidence, landing state, attachments — rendered server-side, tenant-scoped at every read, injection-safe by construction.
- **Agent scoreboard** with Bayesian-smoothed, per-category rankings; synthetic platform runs are excluded and unattributable work is reported, never ranked.
- Browser screenshots agents take are captured per step and attached to the trace as evidence, with retention stated rather than silent.

### Agents that learn — under human review

- Every failure signal (failed run, failing verification, QA reject, gate refusal, human correction) is harvested into a **mistake record**; an extractor drafts a **candidate lesson**, graded for confidence and deduplicated lexically and semantically.
- Lessons enter a **review queue** (card and table views, bulk approval with confidence thresholds, standing operator preferences) and only `active` lessons reach agents — as fenced data in the ticket prompt, bounded and ranked by relevance.
- A rejected lesson stays rejected without blacklisting its subject.

### Planning, stack and marketplace

- **Plan mode**: a multi-agent planning session (parallel specialist panels + consolidator) that commits a dependency-ordered backlog; a **document-seeded project create** (Markdown / PDF / DOCX) that pre-fills the brief.
- **Stack advisor**: a closed service catalogue (130 entries) and capability taxonomy drive AI-assisted, ranked, ecosystem-coherent stack selection that becomes a hard frame in every plan prompt.
- **Skills marketplace**: 52 first-party skills, operator-authored skills with AI drafting, a pre-install **scanner** that flags prompt-content hazards without pretending to be a verdict, and provenance tracking so you always know whether your copy, or the catalogue, moved.

### Platform

- Multi-tenant on Postgres **Row-Level Security**, with a schema-level trigger that makes a cross-tenant row unwritable across 48 parent/child relationships.
- **Encrypted secrets vault** per project (AES-256-GCM in the application layer), a platform-secrets manager with tenant » instance » environment resolution, and explicit per-key opt-in for anything an agent may read.
- **Headless API** (`POST /v1/agents/{id}/runs`, bearer keys, rate limits, SSE), an **OpenAI-compatible** `/v1/chat/completions` shim, and an embeddable widget.
- Stripe usage metering with a soft-cutoff dispatch gate; team tiers; notifications; GitHub OAuth per project.
- **Operator experience**: a pre-auth setup wizard for a fresh instance, a guided Settings → Setup for every credential with live validation, seven-dependency system-health probes with "Fix →" links, an in-app user guide with a downloadable manual, and a one-command local stack.

---

## Architecture

```
┌──────────────────────────────── apps/web (Next.js, App Router) ───────────────────────────────┐
│  Board · Run Inspector · Agent Builder · Plan mode · Projects · Marketplace · Learnings ·      │
│  Scoreboard · Guide · Settings/Setup · Supervisor console · /v1 headless API · widget          │
│                                                                                                │
│  lib/engine ── durable functions (dispatcher, run loop, reconciler, reapers, landing, supervisor)│
│  lib/board · lib/roles · lib/integration · lib/learning · lib/export · lib/llm · lib/security   │
└──────────────┬──────────────────────────┬──────────────────────────────┬───────────────────────┘
               │ SQL + RLS                │ durable steps / events        │ LPUSH / RPOP (per-request)
     ┌─────────▼─────────┐      ┌─────────▼─────────┐            ┌───────▼────────┐
     │ Supabase Postgres │      │ Inngest           │            │ Upstash Redis  │
     │ auth · storage ·  │      │ self-hosted or    │            │ job queues ·   │
     │ realtime · RLS    │      │ cloud             │            │ locks · breaker│
     └───────────────────┘      └───────────────────┘            └───────┬────────┘
                                                                         │
                                               ┌─────────────────────────▼─────────────────────────┐
                                               │ apps/runner (resident worker, one per host)        │
                                               │ claim → prepare git workspace → claude -p (MCP     │
                                               │ board tools, Playwright) → verify → report → trace │
                                               │ + heartbeat, cancel, dev-server, takeover,         │
                                               │   supervisor loops                                 │
                                               └────────────────────────────────────────────────────┘
```

**Design rules the architecture is built on**

1. **Runner-first.** All model access sits behind one `Runner` interface; no vendor SDK is imported outside the adapter layer (enforced by lint).
2. **Durability over cleverness.** Work resumes from the exact step after a crash or a multi-day pause.
3. **Hard ceilings everywhere.** No spawn without passing depth, fan-out, total-agent and budget checks; a cost-explosion breaker is mandatory.
4. **The LLM is the only hard dependency.** Everything else is open-source-first and replaceable.
5. **The trace is the product.** If it is not a span, it did not happen.
6. **Untrusted content is data, never instructions.** Dangerous tools pause on a human gate.

### Technology

| Layer                   | Choice                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Web application         | Next.js (App Router) · React · TypeScript (strict) · Tailwind · shadcn/ui · dnd-kit · React Flow          |
| State, auth, storage    | Supabase Postgres with pervasive Row-Level Security · Supabase Auth · Storage · Realtime                  |
| Durable execution       | Inngest — self-hosted server for local installs, Inngest Cloud for hosted                                 |
| Queues, locks, breakers | Upstash Redis (REST), request-budgeted                                                                    |
| Runners                 | Claude Agent SDK / `claude -p` (default) · API runner via the Vercel AI SDK · OpenAI-compatible endpoints |
| Agent ↔ board protocol  | MCP (10 board tools) · Playwright MCP for browser automation                                              |
| Observability           | Per-step spans · Langfuse · Promptfoo role evals with committed prompt snapshots                          |
| Documents               | `@react-pdf/renderer` (audit exports, user manual)                                                        |
| Payments & integrations | Stripe metering · GitHub OAuth · Vercel OAuth                                                             |

**By the numbers:** 110 forward-only migrations · 40+ durable functions · 53 built-in roles · 10 board tools · 52 first-party skills · 296 test files / 4,100+ tests · 4 CI workflows.

---

## Security model

- **Tenant isolation is schema-enforced.** Every table is RLS-scoped; a generated trigger (`assert_tenant_matches_parent`) refuses any row whose tenant disagrees with its parent's across every tenant-scoped foreign key; service-role reads carry co-located tenant predicates, verified by filter-applying test fakes with controls, and a source scan fails CI on any new unscoped read.
- **Secrets never reach the database in plaintext** (app-layer AES-256-GCM). Platform credentials are never exposed to agents unless a key is explicitly, statically marked shareable; the agent spawn environment strips model credentials regardless.
- **Agents cannot escalate.** They cannot arm their own escape hatches (budget override, ticket filing, supervisor remediation, safety flag), cannot choose a tenant or project (both derive from the spawning ticket), and cannot reach production deploys at all — those surfaces have no agent-facing tool.
- **Untrusted text is fenced** everywhere it enters a prompt — tool output, peer hand-offs, repository manifests, screenshots, lesson bodies, operator comments — and the console's model can never name a target the operator did not type.
- **Human gates on irreversible acts**: safety-critical completion, discarding work, production deploys, rollbacks, credential changes — each with a confirmation shaped like the risk (type-to-confirm where it matters).
- **Push-protection-clean repository**: no live credential is committed; local development uses the Supabase CLI's local keys only.

---

## Quick start

DevPilot is a pnpm monorepo (`apps/web` + `apps/runner`). Everything runs on your machine; the only account you need is a Claude subscription for the agents (or an API key).

**Prerequisites:** Node 20+ · pnpm 10 (`corepack enable`) · Docker Desktop running · the [Supabase CLI](https://supabase.com/docs/guides/cli) · the `claude` CLI signed in (`npm install -g @anthropic-ai/claude-code && claude`).

```bash
git clone https://github.com/utkarsh430/DevPilot.git && cd DevPilot
pnpm install
pnpm setup:local      # once: local Supabase + Redis, your sign-in account, apps/web/.env.local
pnpm dev:local        # every time: web app + durable Inngest server + runner, one terminal
```

Open **http://127.0.0.1:3000**, enter the email you gave, and you are in — a local install signs you in directly. Create a project, file a ticket, move it to Ready, and watch the runner pick it up.

`setup:local` is safe to re-run (it never overwrites a value you have set — blank a line in `.env.local` and re-run to change it). `dev:local` starts Docker Desktop, Supabase and Redis if they are down, applies pending migrations, and refuses to start on a missing key or a busy port rather than failing quietly. No Claude subscription? Put an `ANTHROPIC_API_KEY` in `.env.local` and switch the tenant to API auth under **Settings → LLM auth**.

### Connect GitHub (one-time)

Every project is a GitHub repository. Register an OAuth App at <https://github.com/settings/developers> with callback URL `http://127.0.0.1:54321/auth/v1/callback`, then:

```bash
pnpm setup:local --github-client-id <id> --github-client-secret <secret>
```

### What survives a restart

Everything. Projects, tickets, runs and settings live in local Postgres; the job queue in Redis; agent workspaces under `~/.devpilot/workspaces`; in-flight durable runs in the self-hosted Inngest server. A run that was sleeping or waiting for a step result when you stopped the stack resumes where it was; a step that was mid-`claude -p` is re-queued and simply runs again. `.env.local` is backed up to `~/.devpilot/env-backups/` so the key that encrypts stored secrets is never lost. To start over: `supabase db reset` and `docker compose -f infra/local/docker-compose.yml down -v`.

### Always-on host

To let agents work while you are logged off, install the runner under launchd (macOS) or systemd (Linux) — see [`infra/README.md`](infra/README.md).

