-- =============================================================================
-- Migration : 20260736000000_agent_learnings_confidence.sql
-- Purpose   : Add `confidence` + `confidence_reason` to agent_learnings — the
--             machine grade that tells an operator which candidate lessons are
--             safe to bulk-approve and which genuinely need their own call.
--
-- Why this exists
-- ───────────────
-- PR 2's extractor drafts a candidate lesson per mistake and PR 3 queues them for
-- review one card at a time. With ~40 candidates that review is the bottleneck:
-- most are obviously fine, a few are sweeping or risky. Grading each candidate
-- lets the review UI (Agent B) sort/filter and bulk-approve the clear ones, and
-- lets auto-approve become a THRESHOLD rather than a blanket on/off switch.
--
-- Grading rubric (defined in lib/learning/confidence.ts — this column only stores it)
-- ──────────────────────────────────────────────────────────────────────────────────
--   high   — specific, actionable, safe to apply to EVERY future run, drawn from
--            clear objective failure evidence.
--   medium — sound but situational/narrow, or slightly vague. Worth a glance.
--   low    — vague, sweeping, risky if applied broadly, CONFLICTS with an
--            existing active lesson, or drawn from ambiguous evidence. Requires
--            an explicit human call; never auto-approved.
--
-- THE ASYMMETRY IS THE SAFETY STORY. A wrongly-`high` lesson gets bulk-approved
-- and is then injected into EVERY future run forever (PR 4 shipped that path). A
-- wrongly-`low` one costs one human glance. So the grader is instructed to grade
-- DOWNWARD when uncertain, and `normalizeConfidence` resolves anything
-- unparseable / missing / unknown to `low` — never `high`.
--
-- NULL means "not yet graded" — deliberately, and it is load-bearing
-- ─────────────────────────────────────────────────────────────────
-- Both columns are NULLABLE with NO default and are NOT backfilled. Three
-- reasons:
--   1. Grading is an LLM call and is FAIL-OPEN: a downed runner / timeout /
--      unparseable reply must leave the row ungraded rather than block or
--      mis-grade the extraction. `null` is that state, and it must be
--      distinguishable from a real grade.
--   2. Every pre-existing row (the queue this ships for) is ungraded until the
--      backfill (scripts/backfill-lesson-confidence.ts) runs. The review UI must
--      render an ungraded row, so a default value would be a LIE about rows
--      nothing has graded.
--   3. An ungraded candidate NEVER auto-approves (see
--      `clearsAutoApproveThreshold`). Defaulting the column to any grade — even
--      'low' — would erase the "we have not looked at this yet" signal.
--
-- Security / RLS
-- ──────────────
-- NO policy change. `agent_learnings` writes stay service-role-only by design
-- (see the 20260735000000 header): the human-review gate is the whole safety
-- story, and a browser-writable confidence would let a compromised client mark
-- an adversarial lesson `high` and have the bulk-approve path activate it. The
-- grader and the backfill write through the service client with the tenant
-- scoped in the statement, exactly like every other write in lib/learning.
--
-- No new FK, so no assert_tenant_matches_parent trigger and no change to the
-- generated audit SQL / tenant-scope-scan enumeration.
--
-- Execution notes
-- ───────────────
-- Two ADD COLUMN … NULL (metadata-only in PG11+, no table rewrite) plus one
-- partial index. The index is deliberately partial on `status='candidate'`: the
-- only query shape that needs it is the review queue's "candidates by grade"
-- sort/filter and the backfill's "ungraded candidates" scan. Plain CREATE INDEX —
-- CONCURRENTLY is illegal inside a transaction and the table is small.
-- =============================================================================
begin;

alter table public.agent_learnings
  add column if not exists confidence text null
    constraint chk_agent_learnings_confidence
      check (confidence in ('high', 'medium', 'low')),
  add column if not exists confidence_reason text null;

comment on column public.agent_learnings.confidence is
  'Machine grade of how safe this lesson is to apply broadly: high | medium | low. '
  'NULL means NOT YET GRADED (the grading LLM call is fail-open, and pre-existing '
  'rows are ungraded until scripts/backfill-lesson-confidence.ts runs) — it is '
  'never defaulted, and an ungraded lesson never auto-approves. Graded DOWNWARD '
  'when uncertain: a wrongly-high lesson is bulk-approved and then injected into '
  'every future run, a wrongly-low one costs one human glance. Written by '
  'lib/learning/confidence.server.ts; rubric in lib/learning/confidence.ts.';

comment on column public.agent_learnings.confidence_reason is
  'One short sentence explaining the grade, shown in the review queue so the '
  'operator can sanity-check a bulk approval. Model-authored and therefore '
  'UNTRUSTED like the body: redacted + length-bounded before insert, rendered as '
  'plain text, never as instructions.';

-- The review queue's "ungraded / by grade" candidate scan and the backfill's
-- "ungraded candidates" scan. Partial: graded non-candidate rows are not read
-- this way.
create index if not exists idx_agent_learnings_tenant_confidence_candidate
  on public.agent_learnings (tenant_id, confidence)
  where status = 'candidate';

commit;
