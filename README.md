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

