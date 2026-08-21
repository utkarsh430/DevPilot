# Runbook: Add an Inngest durable function

**When to use:** You need a new durable, resumable step-function in the engine - a background
worker, a cron, a fan-in aggregator, or anything that must survive restarts and multi-day human
pauses (README.md → design rules (durability)). Model the work as durable steps and
use `waitForEvent` for human pauses; never hold **agent state** in a long-lived in-memory loop.

> That rule is about agent state - iteration position, tool results, checkpoints, human pauses -
> not about resident processes as such. The runner deliberately runs several stateless loops, one
> of which (the project supervisor, `apps/runner/src/supervisor-loop.ts`) exists precisely because
> every cron here shares one scheduler and they all die together when it wedges. See
> `docs/DEVPILOT_TDD.md` §3.2 and `lib/engine/supervisor-policy.ts`. **If you are adding a cron,
> assume it can silently stop running** - that is what the liveness canary
> (`lib/engine/liveness.ts`) measures, and why nothing may be the only thing recovering itself.

## Prerequisites

- The local stack running with the Inngest dev server - the app, the Inngest dev server, and the
  runner (see README.md → Quick start). The dev server on :8288 auto-discovers functions via
  `/api/inngest`.

## Steps

1. **Add the event type** (if your function reacts to a new event) to the `Events` map in
   `apps/web/lib/engine/inngest.ts`. This is the shared Inngest client; typing the event here
   gives every producer/consumer a checked payload.
2. **Define the function** with `inngest.createFunction(...)` in a co-located `inngest.ts` (or a
   feature module), returning the function value. Follow an existing one for the step/retry
   shape - e.g. `apps/web/lib/engine/ticket-scheduler.ts` (cron + drain) or
   `apps/web/lib/engine/aggregator.ts` (fan-in). Wrap durable work in `step.run(...)`; use
   `step.waitForEvent(...)` for human-in-the-loop pauses; emit a trace span for each run/step
   (README.md).
3. **Register it** by importing the function and adding it to the `functions` array in
   `apps/web/app/api/inngest/route.ts`. A function that is defined but not in this array is
   never served.
4. **Emit the triggering event** from wherever the work originates (a server action or another
   function) via the `inngest` send client.

## Verify

- `pnpm --filter @devpilot/web typecheck` passes (catches event-payload mismatches).
- With the stack running, open the Inngest dev UI at http://localhost:8288 and confirm the
  function is listed (discovered) and, after emitting its event, that a run appears and
  completes / pauses as expected.
- Check the Langfuse trace for the run's spans if the function does LLM/tool work.

## Gotchas

- Forgetting step 3 (the `functions` array) is the classic miss: the function type-checks and
  imports cleanly but silently never runs because it was never served.
- Any spend path inside the function must check the budget first, and any agent spawn must pass
  the hard ceilings (README.md → design rule 3 (hard ceilings)). Durable ≠ unbounded.
- Put non-idempotent side effects inside `step.run` so a retry does not double-execute them.
