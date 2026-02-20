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

