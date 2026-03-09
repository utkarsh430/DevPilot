# DevPilot

## Product Requirements Document (PRD)

**Version:** 0.1 (Draft — retained as living spec-of-record; much of this is implemented)
**Status:** Implemented / living (originally "For review, June 2026"; see `docs/IMPLEMENTATION_STATUS.md` for planned-vs-built)
**Author:** Founding team
**Last updated:** June 2026 (status annotations refreshed 2026-07-05)

---

## 1. Overview

### 1.1 What DevPilot is

DevPilot is a **production-grade platform for building, running, and orchestrating AI agents**. It takes a bare LLM endpoint and turns it into a reliable, observable, multi-agent system that can do real work — including long-running, autonomous software-product tasks — even while the user is offline.

The name is _dev_ + _pilot_: agents that fly your development work across a kanban board, with you holding the controls.
DevPilot is the **compute layer for agents**.

### 1.2 The problem

Today, building anything beyond a toy agent means re-implementing the same hard infrastructure every time: the agent loop, tool calling, retries, durable state, multi-agent coordination, tracing, evals, cost controls, and a UI to see what happened. Most teams either:

- ship a fragile wrapper that breaks the moment an agent runs for ten minutes and calls fifteen tools, or
- glue together five different libraries with no shared state, observability, or governance.

There is no single place where you can **define a team of specialized agents, hand them a board of work, and trust them to execute it reliably and transparently.**

### 1.3 The solution

DevPilot provides three things wrapped in one platform:

1. **A durable runtime** — agents run as resumable, checkpointed jobs that survive restarts and human-in-the-loop pauses.
2. **An orchestration layer** — a Kanban-style work board where tickets are the unit of work, plus dynamic supervisor trees that can spawn, monitor, and reap sub-agents under load.
3. **A team of role-based agents** — PM, Architect, Engineer, QA, Security, DevOps, etc. — that pick up tickets, collaborate, and gate each other's work, modeling a real software studio.

### 1.4 Design principles

- **The LLM is the only hard dependency.** Everything else is replaceable. Model-agnostic from day one.
- **Open-source first.** Use OSS for every layer where a credible option exists; only reach for paid services when there is no reasonable alternative.
- **Durability over cleverness.** A resumable, observable agent that survives a crash beats a clever one that loses its state.
- **The trace is the product.** If you can't see what the agent did, you can't trust it.
- **Hard ceilings everywhere.** Budgets, depth limits, and total-agent caps are not optional.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Let a developer define an agent (prompt + tools + skills + knowledge) as versioned config and run it reliably.
- Let multiple agents collaborate on a shared work board, async, with human-in-the-loop checkpoints.
- Provide first-class observability: full trace trees, replay, cost, and evals.
- Support dynamic, hierarchical agent spawning with strict safety guardrails.
- Expose every agent as an API and embeddable widget so other apps can build on DevPilot.
- Run the MVP on a near-zero-cost, OSS-first stack.

### 2.2 Non-Goals (for v1)

- Training or fine-tuning models. DevPilot consumes LLM endpoints; it does not produce them.
- Being a general workflow/BPM tool for non-agent automation.
- On-prem/air-gapped enterprise deployment (deferred to a later enterprise track).
- A mobile-native app (web responsive only for v1).
- Replacing human engineers — DevPilot augments and automates, with humans on the quality gates.

---

## 3. Target Users & Personas

| Persona                             | Who                                   | What they need from DevPilot                                         |
| ----------------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| **The solo builder / indie hacker** | Building a SaaS alone                 | A virtual software team to offload PM, coding, QA, and docs work     |
| **The platform engineer**           | At a startup                          | A reliable orchestration layer they don't have to build from scratch |
| **The AI app developer**            | Embedding agents in their own product | Agents-as-APIs and an embeddable widget                              |
| **The ops/automation lead**         | At a growing company                  | Async agents that work a backlog and only escalate when blocked      |
| **The agency**                      | Building agents for clients           | White-label, multi-tenant, usage-based billing                       |

---

## 4. Key Use Cases / User Stories

1. **"Build me a feature."** A user files a ticket ("add password reset"). The PM agent refines it into sub-tickets, the Architect designs it, Engineers implement, QA and Security gate it, DevOps deploys — all on the board, with the user only stepping in at `Input Required` cards.
2. **"Work my backlog overnight."** The user assigns ten tickets and logs off. Agents pull and complete what they can; anything ambiguous lands in the escalation swimlane for the morning.
3. **"Embed an agent in my app."** A developer publishes an agent, gets a REST + streaming endpoint and an OpenAI-compatible URL, and drops a chat widget into their product.
4. **"Scale under load."** A spike of tickets arrives; the supervisor detects queue depth and spawns additional worker agents (within caps), then reaps them when idle.
5. **"Debug a bad run."** A ticket failed. The user opens the trace tree, finds the failing step four tool calls deep, tweaks the input, and replays from that step.
6. **"Teach the team a new skill."** The user writes a skill from an internal doc; every relevant role-agent can now load it on demand.

---

## 5. Functional Requirements

Requirements are tagged with priority: **P0** (MVP), **P1** (v1), **P2** (later). IDs are stable for traceability into the TDD.

### 5.1 Core Orchestration Engine

| ID       | Requirement                                                                               | Priority |
| -------- | ----------------------------------------------------------------------------------------- | -------- |
| F-ORC-01 | Define an agent as versioned config (prompt, model, tools, skills, knowledge, guardrails) | P0       |
| F-ORC-02 | Composable agents (an agent usable as another agent's tool)                               | P0       |
| F-ORC-03 | Sequential workflows                                                                      | P0       |
| F-ORC-04 | Parallel workflows (fan-out / fan-in)                                                     | P1       |
| F-ORC-05 | Conditional branching                                                                     | P1       |
| F-ORC-06 | Loops with max-iteration caps                                                             | P0       |
| F-ORC-07 | Human-in-the-loop pause/resume points                                                     | P0       |
| F-ORC-08 | Durable, resumable execution (checkpoint every step)                                      | P0       |
| F-ORC-09 | Job queue + scheduler                                                                     | P0       |
| F-ORC-10 | Concurrency control + per-tenant rate limits                                              | P1       |

### 5.2 Agent Work Board (Kanban)

| ID       | Requirement                                                                                      | Priority |
| -------- | ------------------------------------------------------------------------------------------------ | -------- |
| F-BRD-01 | Tickets as first-class objects (desc, acceptance criteria, priority, assignee)                   | P0       |
| F-BRD-02 | Columns: Backlog, Ready, Assigned, In Progress, Input Required, In Review, Blocked, Done, Failed | P0       |
| F-BRD-03 | Comment threads shared by agents and humans                                                      | P0       |
| F-BRD-04 | Dependencies (blocks / blocked-by)                                                               | P1       |
| F-BRD-05 | Attachments and linked artifacts (PRs, docs, reports)                                            | P1       |
| F-BRD-06 | Auto-assignment via Dispatcher agent                                                             | P0       |
| F-BRD-07 | Pull or push assignment modes                                                                    | P1       |
| F-BRD-08 | WIP limits per agent                                                                             | P1       |
| F-BRD-09 | Backward ticket flow (QA/Security can reject to a prior column)                                  | P0       |
| F-BRD-10 | Escalate-to-human swimlane                                                                       | P0       |
| F-BRD-11 | Offline/async completion (work continues with user logged off)                                   | P0       |
| F-BRD-12 | Real-time board updates (live card movement)                                                     | P1       |

### 5.3 Role-Based Agents

| ID       | Requirement                                                                    | Priority |
| -------- | ------------------------------------------------------------------------------ | -------- |
| F-ROL-01 | Built-in roles: PM, Architect, Engineer, QA, Security, Code Reviewer           | P0       |
| F-ROL-02 | Additional roles: DevOps/SRE, Tech Writer, Designer, Data Engineer, Dispatcher | P1       |
| F-ROL-03 | Custom role creation from a job description                                    | P1       |
| F-ROL-04 | Role-to-data-source default wiring (e.g., Dev→codebase, QA→test DB)            | P1       |

### 5.4 Agent Capabilities (Tools / Skills / Knowledge / Memory)

| ID       | Requirement                                         | Priority |
| -------- | --------------------------------------------------- | -------- |
| F-CAP-01 | Tools (function calling)                            | P0       |
| F-CAP-02 | Skills (loadable, on-demand procedures/playbooks)   | P0       |
| F-CAP-03 | Skill registry / marketplace                        | P1       |
| F-CAP-04 | Teach-a-skill (from a doc or a successful run)      | P2       |
| F-CAP-05 | Progressive skill loading (load only when relevant) | P0       |
| F-CAP-06 | Short-term + long-term memory                       | P1       |
| F-CAP-07 | Tool marketplace                                    | P1       |

### 5.5 Data Connectivity

| ID       | Requirement                                             | Priority |
| -------- | ------------------------------------------------------- | -------- |
| F-DAT-01 | Managed Knowledge Bases (upload/ingest → chunk → embed) | P0       |
| F-DAT-02 | Vector DB connections (RAG)                             | P0       |
| F-DAT-03 | Relational DB connections (SQL)                         | P1       |
| F-DAT-04 | Retrieval mode (auto-RAG context injection)             | P0       |
| F-DAT-05 | Query-as-tool mode (text-to-SQL)                        | P1       |
| F-DAT-06 | Hybrid search (vector + keyword/metadata)               | P2       |
| F-DAT-07 | Per-agent data scoping                                  | P0       |
| F-DAT-08 | Re-indexing / freshness jobs                            | P1       |

### 5.6 Integrations & Connectivity

| ID       | Requirement                                               | Priority |
| -------- | --------------------------------------------------------- | -------- |
| F-INT-01 | MCP (Model Context Protocol) client support               | P0       |
| F-INT-02 | Pre-built connectors (GitHub, Slack, Gmail, Notion, etc.) | P1       |
| F-INT-03 | Webhook triggers                                          | P1       |
| F-INT-04 | Cron / schedulers                                         | P1       |
| F-INT-05 | Inbound API + SDK (TS/Python)                             | P0       |
| F-INT-06 | Model-agnostic adapter layer                              | P0       |

### 5.7 Dynamic Agents & Supervision

| ID       | Requirement                                               | Priority |
| -------- | --------------------------------------------------------- | -------- |
| F-SUP-01 | Runtime agent spawning                                    | P1       |
| F-SUP-02 | Subagent spawning (ephemeral children)                    | P1       |
| F-SUP-03 | Recursive/hierarchical supervision (supervisor trees)     | P1       |
| F-SUP-04 | Supervisor auto-scaling under load                        | P2       |
| F-SUP-05 | Load-detection triggers (queue depth, WIP, latency)       | P2       |
| F-SUP-06 | Lifecycle management (spawn → monitor → reap → terminate) | P1       |
| F-SUP-07 | Supervision strategies (restart, let-it-crash, escalate)  | P1       |
| F-SUP-08 | Result aggregation up the tree (fan-in)                   | P1       |
| F-SUP-09 | Orphan detection & cleanup                                | P1       |

### 5.8 Observability & Quality

| ID       | Requirement                                         | Priority |
| -------- | --------------------------------------------------- | -------- |
| F-OBS-01 | Full trace tree (waterfall of agent/tool/LLM steps) | P0       |
| F-OBS-02 | Replay / time-travel from any step                  | P1       |
| F-OBS-03 | Prompt/response diffing across versions             | P2       |
| F-OBS-04 | Eval harness (LLM-as-judge + assertions)            | P1       |
| F-OBS-05 | Regression alerts                                   | P2       |
| F-OBS-06 | Live cost & token dashboards                        | P0       |
| F-OBS-07 | Standup / daily summary job                         | P2       |
| F-OBS-08 | Velocity / burn-rate view                           | P2       |

### 5.9 Platform & Distribution

| ID       | Requirement                       | Priority |
| -------- | --------------------------------- | -------- |
| F-PLT-01 | Agents-as-APIs (REST + streaming) | P1       |
| F-PLT-02 | OpenAI-compatible endpoint        | P1       |
| F-PLT-03 | Embeddable widget / SDK           | P1       |
| F-PLT-04 | Sub-agent / skill publishing      | P2       |
| F-PLT-05 | White-label mode                  | P2       |
| F-PLT-06 | Usage-based billing               | P1       |

### 5.10 Execution Modes / Runners

DevPilot does not assume a single way of reaching the model. A **Runner** is a pluggable worker that executes an agent step; the durable engine dispatches jobs to whichever runner a tenant/agent is configured to use. This is what lets a solo builder run on their Claude subscription while the platform play runs on the API.

| ID       | Requirement                                                                                                                                                                                                                              | Priority |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F-RUN-01 | Pluggable Runner abstraction (engine dispatches a job to a registered runner)                                                                                                                                                            | P0       |
| F-RUN-02 | **API Runner** — calls the LLM endpoint per-token via the model adapter; scales; multi-tenant safe (offered as an option)                                                                                                                | P0       |
| F-RUN-03 | **Local Claude Code Runner (BYO subscription)** — executes steps via the Claude Agent SDK / `claude -p`, authenticated with the user's own Pro/Max subscription, drawing on the Agent SDK monthly credit. **Default runner from Day 1.** | P0       |
| F-RUN-04 | Runner registration & heartbeat (a runner registers, advertises capabilities, pulls jobs tagged for it)                                                                                                                                  | P0       |
| F-RUN-05 | Per-agent / per-tenant runner selection (default local; API selectable)                                                                                                                                                                  | P0       |
| F-RUN-06 | Full Claude Code toolset in the local runner (file edit, bash, git) for software-product work                                                                                                                                            | P0       |
| F-RUN-07 | Concurrency-aware routing (route bursts/high-concurrency to API Runner; steady low-concurrency to subscription)                                                                                                                          | P1       |

**Notes & constraints (important):**

- The **subscription/local runner is intended for a single user's own work** (the docs/pricing favor 1–3 concurrent agents). It is **not** the backend for the multi-tenant platform; many concurrent users' agents must use the API Runner. DevPilot must make this boundary explicit, not let a tenant accidentally fan out a subscription runner into rate-limit failures.
- The local runner requires an **always-on host** (see NFR: Persistence). A laptop is a _client_, not a host.

### 5.11 Persistence of Long-Running Work (NFR clarification)

- **Server-side durability is the default and the real guarantee.** Because runs are durable steps on the engine (F-ORC-08), work continues regardless of whether the user's laptop is open, asleep, or off. The user's device is only a viewport.
- **For the local/BYO runner**, the runner process must run on an always-on host under a **process supervisor** (systemd / pm2) that auto-restarts on crash and survives reboot. `tmux`/`screen` keep a session alive across terminal disconnects but do **not** survive the host sleeping or powering off, so they are a convenience, not the durability mechanism.

---

## 6. Non-Functional Requirements

| Category         | Requirement                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reliability**  | Retries with backoff; dead-letter queue; per-tool/step/run timeouts; circuit breakers; idempotency keys; graceful model fallback.                                |
| **Performance**  | Horizontal scalability; per-tenant rate limits; priority queues; back-pressure via WIP limits; low-latency token streaming to the UI.                            |
| **Security**     | Encrypted secrets; sandboxed tool/code execution; approval gates for dangerous actions; read-only-by-default data access; text-to-SQL guardrails; PII redaction. |
| **Governance**   | Immutable audit logs; RBAC; multi-tenant isolation; configurable data retention.                                                                                 |
| **Cost control** | Per-run dollar/token ceilings; per-agent budgets; budget inheritance for spawned agents; cost-aware model routing; cost-explosion circuit breaker.               |
| **Operability**  | Versioning (agents/skills/prompts); staging vs prod; one-click rollback; monitoring & alerting; scheduled re-indexing.                                           |
| **Usability**    | Visual + code parity; progressive disclosure; multi-language SDK; responsive web UI.                                                                             |

---

## 7. UX / Screens

| Screen               | Purpose                                                          | Priority                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Work Board**       | The Kanban; cards moving through columns; the day-to-day surface | P0                                                                                                                                                     |
| **Run Inspector**    | Trace-tree waterfall; the killer debugging screen                | P0                                                                                                                                                     |
| **Live Playground**  | Chat with an agent, watch tool calls stream                      | P0 — ⚠️ _not yet built as a screen_ (functionally approximated by the embeddable widget + `/v1/chat/completions`; see `docs/IMPLEMENTATION_STATUS.md`) |
| **Agent Builder**    | Config + visual node-graph editor (toggle)                       | P1                                                                                                                                                     |
| **Skill Registry**   | Browse / install / version skills                                | P1                                                                                                                                                     |
| **Tool Marketplace** | Browse / install tools & connectors                              | P1                                                                                                                                                     |
| **Data Sources**     | Connect KBs, vector DBs, SQL DBs; scope to agents                | P0 — ⚠️ _not yet built as a screen_ (SQL data sources exist backend-only; KB/vector-RAG is unbuilt; see `docs/IMPLEMENTATION_STATUS.md`)               |
| **Eval Dashboard**   | Test scores, regressions, A/B                                    | P1                                                                                                                                                     |
| **Observability**    | Cost, latency, error-rate graphs                                 | P0                                                                                                                                                     |
| **Deployment**       | Promote staging→prod, rollback                                   | P1                                                                                                                                                     |
| **Settings**         | Secrets, RBAC, budgets, billing                                  | P0                                                                                                                                                     |

---

## 8. Success Metrics

**Activation**

- % of new users who run an agent within 10 minutes of signup.
- % who create a board ticket that reaches `Done` without manual intervention.

**Reliability**

- Run success rate (excluding intentional human-blocked states).
- % of runs that resume correctly after a worker restart.
- Mean tool-call retry rate.

**Engagement**

- Tickets completed per active team per week ("agent velocity").
- DAU/WAU of the Run Inspector (proxy for trust).

**Economics**

- Avg cost per completed ticket.
- Gross margin per run (revenue − LLM/infra cost).

**Platform**

- # of agents exposed as APIs / embedded externally.
- # of published skills.

---

## 9. Phased Roadmap

### Phase 0 — Foundations (MVP, ~weeks 1–6)

The smallest thing that proves the magic: **the board + the quality loop**.

- F-ORC-01/02/03/06/07/08/09 (core runtime + durability)
- F-BRD-01/02/03/06/09/10/11 (board + backward flow + offline)
- F-ROL-01 with **3 roles only: PM, Engineer, QA**
- F-CAP-01/02/05 (tools + basic skills)
- F-DAT-01/02/04/07 (KB + vector RAG, scoped)
- F-OBS-01/06 (trace tree + cost)
- F-INT-01/05/06 (MCP + API + model adapter)
- F-RUN-01..06 (Runner abstraction; **Local Claude Code Runner as the default**, API Runner as an option)
- Screens: Work Board, Run Inspector, Live Playground, Data Sources, Settings

> **Status note (2026-07-05):** Phase 0 shipped, but two of the five P0 screens above — **Live Playground** and **Data Sources** — were never built as screens (superseded/deferred; Live Playground is functionally approximated by the widget + `/v1/chat/completions`, and only backend-only SQL data sources exist). The KB / vector-RAG data plane behind Data Sources is also unbuilt (schema-only). See `docs/IMPLEMENTATION_STATUS.md`. Phase 0 should not be read as "all five P0 screens complete."

**Exit criterion:** A user files "add password reset," and PM→Engineer→QA take it to `Done` with at least one QA rejection loop, fully resumable, with a complete trace — while the user is logged off.

### Phase 1 — The Studio (v1, ~weeks 7–14)

- Remaining roles (F-ROL-02), custom roles (F-ROL-03)
- Parallel/branching workflows (F-ORC-04/05)
- Supervisor trees + dynamic spawning (F-SUP-01/02/03/06/07/08/09)
- SQL connectivity + text-to-SQL (F-DAT-03/05)
- Skill & tool marketplaces (F-CAP-03/07)
- Eval harness + replay (F-OBS-02/04)
- Agents-as-APIs, OpenAI-compatible, embeddable widget (F-PLT-01/02/03)
- Billing (F-PLT-06)
- Screens: Agent Builder, Skill Registry, Tool Marketplace, Eval Dashboard, Deployment

### Phase 2 — Scale & Ecosystem (later)

> **Naming note:** this "Phase 2 — Scale & Ecosystem" roadmap is a _different, later_ scope from `docs/DEVPILOT_PHASE2_PLAN.md`, which is titled **"Phase 2 — Production Hardening"** (containerize the runner, multi-release dispatch, QA rubric, Vercel/Inngest-Cloud deploy). The production-hardening plan shipped first (partially); the Scale & Ecosystem items below are a subsequent phase. See `docs/IMPLEMENTATION_STATUS.md`.

- Supervisor auto-scaling (F-SUP-04/05)
- Self-improvement / teach-a-skill (F-CAP-04)
- Publishing, white-label (F-PLT-04/05)
- Standup, velocity, regression alerts (F-OBS-05/07/08)
- Hybrid search (F-DAT-06)
- Enterprise/on-prem track

---

## 10. Risks & Assumptions

| Risk                                                              | Mitigation                                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Runaway cost from self-spawning agents**                        | Hard depth/total/budget caps as P0; cost circuit breaker; budget inheritance.                  |
| **Durable execution is the hardest part and easy to under-build** | Adopt a proven OSS durable-execution engine rather than hand-rolling (see TDD).                |
| **Agents produce plausible-but-wrong work**                       | Quality gates (QA/Security agents) + eval harness + human escalation swimlane.                 |
| **Vendor lock-in to one LLM**                                     | Model-agnostic adapter layer from day one (P0).                                                |
| **Scope creep — too many features at once**                       | Phase 0 is deliberately the board + 3 roles; everything else is gated behind proving the loop. |
| **Prompt-injection via tools/data**                               | Treat all tool/data output as untrusted; approval gates; sandboxing; read-only defaults.       |

### Assumptions

- A single, reliable LLM endpoint (Anthropic Claude API) is available and usage-billed separately.
- Early users are technical enough to define agents and read traces.
- OSS components can be self-hosted or used on free tiers at MVP scale.

---

## 11. Open Questions

- Build a thin custom agent harness, or adopt an OSS framework (Mastra / LangGraph / Claude Agent SDK) as the harness? (See TDD §3.2 for the recommendation.)
- Default vector store: managed (Pinecone free tier) vs OSS pgvector on the primary Postgres? (TDD recommends pgvector for fewer dependencies.)
- Pull vs push as the default assignment model for agents?
- How opinionated should built-in roles be vs fully user-defined?
