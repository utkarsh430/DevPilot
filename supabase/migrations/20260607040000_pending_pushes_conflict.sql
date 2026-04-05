-- Phase 2.5+ / Slice IB-B — pending_pushes conflict columns.
--
-- When pushPendingChangesAction tries to push a branch and the workspace's
-- `git rebase origin/<integration_branch>` fails with conflicts, we stamp
-- the conflict state + detail on the pending_push row and return without
-- pushing. The auto-spawned merger ticket consumes `conflict_detail` to
-- decide which files to resolve.
--
-- conflict_state values:
--   NULL       — push hasn't been attempted yet (legacy or pre-IB-B)
--   'clean'    — push attempted and succeeded; rebase was a no-op (head
--                was already up to date with integration tip)
--   'rebased'  — push attempted, rebase succeeded with replays; pushed
--                with --force-with-lease
--   'conflict' — push attempted, rebase failed; merger ticket spawned
--   'resolved' — conflict was resolved (by merger or operator override);
--                push retried successfully

alter table public.pending_pushes
  add column if not exists conflict_state text
    check (conflict_state in ('clean','rebased','conflict','resolved')),
  add column if not exists conflict_detail jsonb,
  add column if not exists rebased_onto_sha text,
  add column if not exists merger_ticket_id uuid
    references public.tickets(id) on delete set null;

comment on column public.pending_pushes.conflict_state is
  'Push-time rebase outcome: clean / rebased / conflict / resolved. NULL '
  'means no push attempt yet (legacy).';

comment on column public.pending_pushes.conflict_detail is
  'Structured conflict report from the failing rebase: {files:[…], stderr, '
  'base_sha, branch_sha}. NULL outside of conflict_state=conflict.';

comment on column public.pending_pushes.merger_ticket_id is
  'When conflict_state=conflict, the auto-spawned release_engineer ticket '
  'tasked with resolving the conflict. NULL until spawned (or if the '
  'operator chose Force-push instead).';
