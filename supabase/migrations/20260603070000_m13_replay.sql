-- =============================================================================
-- Migration : 20260603070000_m13_replay.sql
-- Phase     : 1 / M13 — Replay / time-travel from any step
-- Purpose   : Add the discriminator column the replay engine reads/writes when
--             cloning a run, plus the index that makes the per-original replay
--             cap query cheap.
--
-- What this adds
-- ──────────────
-- • runs.replay_of_run_id uuid (nullable, FK runs.id on delete set null)
--     The clean discriminator between an M8 supervisor child and an M13 replay
--     clone. The replay engine DELIBERATELY does NOT set `parent_run_id` on
--     replay clones — that column means "supervisor parent" and is walked by
--     cascade-kill (`lib/engine/cascade-kill.ts`) and `walkSubtree`
--     (`lib/engine/spawning.ts`). If a replay clone shared its `parent_run_id`
--     with the original, then failing the original would cascade-kill every
--     replay too, which is the opposite of what time-travel debugging needs.
--
--     The Run Inspector renders two separate trees: the supervisor subtree
--     (via parent_run_id) and the replay chain (via replay_of_run_id).
--
-- • runs_replay_of_run_id_idx — supports the per-original cap check
--     (`select count(*) from runs where replay_of_run_id = $1`) and the
--     inspector's chain navigator (sibling replays of a common original).
--
-- Storage implications
-- ────────────────────
-- Each replay clone copies `run_steps` rows up to fromStepIdx so the replay's
-- timeline shows the prior context. A 20-step run that gets replayed from
-- idx 10 carries 10 cloned step rows plus however many new ones the resumed
-- loop appends. The per-original cap (default 5) bounds the total multiplier:
--   max_storage(original) = base + 5 * (avg_clone_size + avg_new_steps)
-- For Phase 1's typical runs (≤20 steps, ≤4KB payload each) the worst case
-- is well under 1MB of duplicated rows per original. We do NOT soft-delete
-- originals on replay; the original is immutable, full stop.
--
-- Cap mechanism
-- ─────────────
-- ACE_MAX_REPLAYS_PER_RUN (default 5) is enforced in the replay engine, not
-- via a DB constraint. The cap is operator-tunable per deployment and we want
-- a clean error message rather than a constraint violation. The index makes
-- the count query a single index-only scan.
-- =============================================================================

begin;

alter table public.runs
  add column if not exists replay_of_run_id uuid
    references public.runs(id) on delete set null;

-- Per-original cap counter + inspector chain navigator.
create index if not exists runs_replay_of_run_id_idx
  on public.runs(replay_of_run_id)
  where replay_of_run_id is not null;

commit;
