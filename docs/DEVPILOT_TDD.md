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

## 2. Tech Stack (OSS-first)

Every layer prefers open source; paid services are used only where there's no reasonable free/OSS option at MVP scale. The "Founders Pack" services are used as-is.

| Layer                       | Choice                                                     | OSS?  | License / Cost         | Why                                                                                                    |
| --------------------------- | ---------------------------------------------------------- | ----- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| **Frontend**                | Next.js + React + Tailwind + shadcn/ui                     | ✅    | MIT / Free             | Vercel-native; shadcn is OSS component base                                                            |
| **Hosting**                 | Vercel                                                     | ⚪    | Free tier              | In pack; serverless-native                                                                             |
| **Backend / DB**            | Supabase (Postgres)                                        | ✅    | Apache 2.0 / Free      | In pack; Postgres + Auth + Storage + Realtime + **pgvector** in one                                    |
| **Vector store**            | **pgvector** (primary) / Pinecone (optional)               | ✅/⚪ | Free                   | pgvector = one less dependency; Pinecone in pack as managed fallback                                   |
| **Cache / queue / locks**   | Upstash Redis                                              | ⚪    | Free tier              | In pack; serverless Redis                                                                              |
| **Durable execution**       | **Inngest** (pragmatic) or **Trigger.dev** (OSS self-host) | ⚪/✅ | Free tier / Apache 2.0 | The hard part — see §3.3                                                                               |
| **LLM adapter**             | **Vercel AI SDK**                                          | ✅    | Apache 2.0 / Free      | Provider-agnostic, tool calling, streaming; serves F-INT-06                                            |
| **Execution runners**       | API Runner (AI SDK) + **Claude Agent SDK** local runner    | ✅    | Apache 2.0 / Free      | BYO Claude Pro/Max subscription via `claude -p`; full file/bash/git tools (F-RUN-\*)                   |
| **LLM endpoint**            | Anthropic Claude API                                       | ⚪    | Usage-based            | The one hard dependency; abstracted by AI SDK                                                          |
| **Agent harness**           | Thin custom loop (+ optional Mastra)                       | ✅    | —                      | Keep control; honors "only the LLM endpoint." See §3.2                                                 |
| **Tracing / observability** | **Langfuse** (self-host or cloud free)                     | ✅    | MIT / Free             | OSS LLM-observability leader; OTel-compatible                                                          |
| **Code/tool sandbox**       | **E2B**                                                    | ✅    | Apache 2.0 / Free tier | Firecracker microVM sandboxes for untrusted code                                                       |
| **Eval harness**            | **Promptfoo** + Langfuse datasets                          | ✅    | MIT / Free             | Assertion + LLM-as-judge evals                                                                         |
| **Board drag-drop**         | **dnd-kit**                                                | ✅    | MIT / Free             | Kanban interactions                                                                                    |
| **Node-graph builder**      | **React Flow (@xyflow)**                                   | ✅    | MIT / Free             | Visual agent/workflow editor                                                                           |
| **Auth**                    | **Supabase Auth** (default) / Clerk (optional)             | ✅    | Apache 2.0 / Free      | Already in the stack via Supabase; one fewer vendor/bill. Clerk swappable later for richer org/RBAC UX |
| **Payments**                | Stripe                                                     | ⚪    | 2.9%/txn               | In pack                                                                                                |
| **Email**                   | Resend                                                     | ⚪    | Free tier              | In pack (notifications, escalations)                                                                   |
| **Error tracking**          | Sentry                                                     | ⚪    | Free tier              | In pack — ⚠️ **not yet wired** (0 imports, no dep as of 2026-07-05)                                    |
| **Product analytics**       | PostHog                                                    | ✅    | MIT / Free             | In pack; OSS, self-hostable — ⚠️ **not yet wired** (0 imports, no dep as of 2026-07-05)                |
| **DNS / CDN**               | Cloudflare                                                 | ⚪    | Free                   | In pack                                                                                                |
| **MCP**                     | Official MCP SDK                                           | ✅    | Open protocol          | Connector ecosystem for free                                                                           |

---

## 3. System Components

### 3.1 The LLM Adapter Layer (F-INT-06)

All model calls go through the Vercel AI SDK so the rest of DevPilot never imports a vendor SDK directly. This is what makes DevPilot model-agnostic.

```ts
// llm/model.ts
import { anthropic } from "@ai-sdk/anthropic";
// swappable: import { openai } from "@ai-sdk/openai";

// Model IDs are illustrative; the as-built locked IDs (apps/web/lib/llm/models.ts)
// are claude-sonnet-4-6 / claude-opus-4-7 / claude-haiku-4-5-20251001.
export const models = {
  default: anthropic("claude-sonnet-4-6"), // workhorse
  heavy: anthropic("claude-opus-4-7"), // architect/reasoning
  cheap: anthropic("claude-haiku-4-5-20251001"), // dispatcher/routing
};
// Cost-aware routing (NFR): pick the cheapest model that passes the task's eval bar.
```

The adapter centralizes token counting and cost accounting. **As-built correction (2026-07-05):** it does _not_ yet centralize retries-with-backoff, timeouts, or graceful fallback to a secondary model — those were planned but are not implemented (the adapter relies on the AI SDK's defaults; timeouts are caller-imposed; there is no fallback chain). See `docs/IMPLEMENTATION_STATUS.md`.

### 3.2 The Agent Harness (F-ORC-01, F-CAP-01)

The harness is the loop from first principles — kept thin and owned in-house so DevPilot controls checkpointing and tracing. (Mastra or the Claude Agent SDK can be adopted later as an accelerator; the interface below stays the same.)

```ts
// Each iteration is a durable STEP so the engine can resume mid-loop.
async function agentStep(ctx: RunContext): Promise<StepResult> {
  const messages = await loadHistory(ctx.runId); // from Postgres
  const skills = await selectSkills(ctx, messages); // progressive load (F-CAP-05)
  const res = await generateText({
    model: pickModel(ctx),
    system: buildSystemPrompt(ctx.agent, skills),
    tools: ctx.tools, // function defs
    messages,
  });
  await persistStep(ctx.runId, res); // checkpoint (F-ORC-08)
  if (res.finishReason === "tool-calls") {
    return { kind: "tool_calls", calls: res.toolCalls }; // engine runs tools as child steps
  }
  if (needsHuman(res)) return { kind: "await_human" }; // → Input Required (F-ORC-07)
  return { kind: "done", output: res.text };
}
```

The harness never runs the loop in a single long-lived process. Each iteration and each tool call is a **durable step** owned by the engine (§3.3). That is what survives restarts and human pauses.

**Scope of that rule (clarified 2026-08-03).** It is about **agent state**, not about long-lived processes as such.
What must never live in memory is anything whose loss would lose work: an agent's iteration position, its tool results, its checkpoints, and its human pauses.
Those belong to the durable engine so a crash or a multi-day wait resumes from the exact step.

It is _not_ a prohibition on the runner having resident loops - it already has five (`pullLoop`, `cancelLoop`, `devServerPullLoop`, `takeoverPullLoop`, `cleanupLoop`), and one of them, the **project supervisor** (`apps/runner/src/supervisor-loop.ts`), exists precisely _because_ the durable engine can stop.
Every recovery mechanism in DevPilot is an Inngest cron, so they share one point of failure; when it wedged on 2026-08-03 all of them died together and the board sat deadlocked for seven hours with no alarm.
A supervisor scheduled by the thing it supervises is not a supervisor.

The distinction that keeps both statements true is **statelessness between iterations**: the supervision loop carries no knowledge of the board from one tick to the next.
Every decision is re-derived from the database on each pass (`lib/engine/supervisor-store.ts`), and the only thing held in memory is a poll-backoff counter - rate limiting, not knowledge.
A resident loop that accumulated board state would be the rule being broken; one that re-reads everything each pass is not.

**As-built correction (2026-07-09):** `buildSystemPrompt(agent, skills)` above is illustrative.
The real seam is `composeRoleSystemPrompt(config, skills, hasTicket)` (`apps/web/lib/roles/compose-prompt.ts`), and it is composed once per dispatch rather than once per iteration.
It appends two fenced, idempotent layers to the role's stored `systemPrompt`: the reviewer-awareness note (§5.1's QA loop, gated on the run being ticket-bound _and_ the role's `onSuccessStatus` being `in_review`), then the installed-skill fence (§3.6).
The third argument exists because composition cannot infer it: a ticket-less run (a supervisor's ad-hoc child spawn, a replay of a ticket-less original) passes `false` so it is never told about a review gate it can never reach, and the ticket-less headless surfaces of §3.11 (agents-as-APIs, the OpenAI-compat shim, the widget) sidestep the seam entirely for the same reason.

### 3.3 Durable Execution / Orchestration (F-ORC-08, F-ORC-09)

This is the most important and most under-built layer in naive agent platforms.

**Recommendation:** start with **Inngest** (free tier, serverless-native, zero ops, durable step functions that fit Vercel perfectly). For the OSS-purist / self-hosted path at scale, **Trigger.dev** (Apache 2.0, self-hostable, built for long-running tasks) is the drop-in alternative. Both model a run as a sequence of durable steps with automatic retry and replay.

```ts
// orchestration/run-agent.ts (Inngest example)
export const runAgent = inngest.createFunction(
  { id: "run-agent", concurrency: { limit: 50, key: "event.data.tenantId" } }, // F-ORC-10
  { event: "agent/run.requested" },
  async ({ event, step }) => {
    let state = await step.run("init", () => initRun(event.data));

    for (let i = 0; i < MAX_ITERS; i++) {
      // F-ORC-06 hard loop cap
      const r = await step.run(`think-${i}`, () => agentStep(state));

      if (r.kind === "done") return step.run("finish", () => finish(state, r));
      if (r.kind === "await_human") {
        await moveTicket(state.ticketId, "input_required"); // F-BRD-02
        // Durable wait — process exits; resumes on the human's reply event (F-ORC-07/F-BRD-11)
        const reply = await step.waitForEvent("human-reply", {
          match: "data.runId",
          timeout: "7d",
        });
        state = applyHumanReply(state, reply);
        continue;
      }
      // Run tool calls as parallel child steps (F-ORC-04)
      const results = await Promise.all(
        r.calls.map((c) => step.run(`tool-${i}-${c.id}`, () => runTool(state, c))),
      );
      state = appendToolResults(state, results);
    }
    return moveTicket(state.ticketId, "failed"); // max iters → dead-letter
  },
);
```

Why this matters: `step.run` results are persisted, so a crash mid-run replays only un-completed steps; `waitForEvent` lets a run sleep for up to days at `Input Required` with no compute cost — the offline guarantee.

