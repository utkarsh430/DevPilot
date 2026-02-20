# DevPilot

## Technical Design Document (TDD)

**Version:** 0.1 (Draft — retained as living design-of-record; much of this is implemented)
**Status:** Implemented / living (originally "For review, June 2026"; see `docs/IMPLEMENTATION_STATUS.md` for planned-vs-built)
**Companion to:** DEVPILOT_PRD.md
**Last updated:** June 2026 (status annotations refreshed 2026-07-05)

---

## 1. Architecture Overview

DevPilot is a Next.js app on Vercel, backed by Postgres (Supabase) and a durable-execution engine that runs the actual agent loops. The LLM is the only hard external dependency; it sits behind a model-agnostic adapter so it can be swapped.

```mermaid
flowchart TB
    subgraph Client["Browser (Next.js / React)"]
        Board["Work Board"]
        Inspector["Run Inspector"]
        Playground["Live Playground"]
        Builder["Agent Builder"]
    end

    subgraph Edge["Vercel (Next.js App Router)"]
        API["API routes / Server Actions"]
        SDKEP["Agents-as-API + OpenAI-compat endpoint"]
    end

    subgraph Core["Durable Execution Layer"]
        Engine["Workflow engine (Inngest / Trigger.dev)"]
        Harness["Agent Harness (the loop)"]
        Supervisor["Supervisor / spawner"]
    end

    subgraph Data["State & Data"]
        PG["Postgres + pgvector (Supabase)"]
        Redis["Upstash Redis (queue/cache/locks)"]
        Vec["Pinecone (optional managed vector)"]
        Files["Supabase Storage"]
    end

    subgraph Capabilities["Agent Capabilities"]
        Tools["Tool runtime"]
        Sandbox["E2B sandbox (code/tools)"]
        MCP["MCP clients"]
        Skills["Skill loader"]
    end

    subgraph External["External / Observability"]
        LLM["LLM endpoint (Anthropic Claude API)"]
        Langfuse["Langfuse (tracing/evals)"]
        Sentry["Sentry (errors)"]
        PostHog["PostHog (analytics)"]
        Stripe["Stripe (billing)"]
        Auth["Supabase Auth (Clerk optional)"]
    end

    Client --> Edge
    Edge --> Core
    Core --> Data
    Core --> Capabilities
    Harness --> LLM
    Capabilities --> MCP
    Core --> Langfuse
    Edge --> Auth
    Edge --> Stripe
    Edge --> Sentry
    Client --> PostHog
```

**Key idea:** the board, tickets, and agent state all live in Postgres. The durable-execution engine reads/writes that state and drives the harness. Because every step is checkpointed, a run can pause at `Input Required` for hours and resume on a webhook — the "works while offline" guarantee.

---

