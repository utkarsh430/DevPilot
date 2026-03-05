-- =============================================================================
-- Migration : 20260603080000_m9_supervision_strategies.sql
-- Phase     : 1 / M9 — Supervision strategies (restart / let-it-crash / escalate)
-- Purpose   : Let each run declare what should happen when it fails. The
--             failure handler reads `supervision_strategy` and either:
--               • starts a fresh attempt (restart_n_times:N)
--               • lets the failure propagate up the parent_run_id chain
--                 (let_it_crash; the M8 cascade-kill handler does the rest)
--               • files an `input_required` ticket for a human (escalate_to_human)
--
-- What this adds
-- ──────────────
-- • runs.supervision_strategy text — null = let_it_crash semantics
--     Accepted forms:
--       'restart_n_times:N'  where N is a positive int  (e.g. restart_n_times:2)
--       'let_it_crash'
--       'escalate_to_human'
--     Parsed by `lib/engine/supervision.ts`. A CHECK constraint enforces the
--     shape so a bad string can't sneak into prod.
--
-- • runs.attempt_index int default 0 — which attempt this is. Original run is
--   0; restart_n_times bumps to 1, 2, … up to N. Used by the strategy parser
--   to refuse a further restart once N is exhausted (falls through to
--   let_it_crash semantics).
--
-- • Index runs_strategy_idx on (status, supervision_strategy) for the
--   failure-handler hot path.
-- =============================================================================

begin;

alter table public.runs
  add column if not exists supervision_strategy text;

alter table public.runs
  add column if not exists attempt_index int not null default 0
    check (attempt_index >= 0);

-- Shape guard. The failure handler trusts this constraint; only valid forms
-- can land in the column.
alter table public.runs
  add constraint runs_supervision_strategy_chk
    check (
      supervision_strategy is null
      or supervision_strategy in ('let_it_crash', 'escalate_to_human')
      or supervision_strategy ~ '^restart_n_times:[1-9][0-9]*$'
    );

create index if not exists runs_strategy_idx
  on public.runs(status, supervision_strategy)
  where supervision_strategy is not null;

commit;
