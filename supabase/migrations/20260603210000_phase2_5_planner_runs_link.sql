-- Migration: 20260603210000_phase2_5_planner_runs_link.sql
--
-- Phase 2.5+ / M7 (REVISION 2026-06-04) — Runner-route correction.
--
-- The original M7 server actions called `@ai-sdk/anthropic` inline, which
-- violates CLAUDE.md #1 ("Runner-first, Local Claude Code Runner is the
-- default. Never hardwire a vendor SDK outside the runner/adapter layer.").
-- The redesign moves planner LLM calls onto the same local-cc Redis queue +
-- Inngest `step.waitForEvent` shape that `lib/engine/run-agent.ts` already
-- uses for ticket-bound agents.
--
-- To track these synthetic planner runs against their owning plan session
-- (so the operator can correlate a planner reply with the Langfuse trace
-- and audit-trail spend by session), we attach a nullable FK from `runs`
-- back to `planning_sessions`. ON DELETE SET NULL so runs survive a
-- session being discarded (the runs row remains queryable for the trace).

begin;

alter table public.runs
  add column if not exists plan_session_id uuid
    references public.planning_sessions(id) on delete set null;

create index if not exists runs_plan_session_idx
  on public.runs(plan_session_id)
  where plan_session_id is not null;

commit;
