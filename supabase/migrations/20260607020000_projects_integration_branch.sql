-- Phase 2.5+ / Slice IB — optional integration branch per project.
--
-- When `integration_branch` is set, the runner cuts ticket branches from it
-- (rather than from `default_branch`), the push action PR'es into it, and a
-- separate "Promote integration → production" action moves work from
-- integration_branch into default_branch. NULL = legacy (current behavior):
-- branches cut from default_branch and PR straight into it.
--
-- The column is intentionally a free-form text so operators can use whatever
-- branch name their workflow already has (`dev`, `develop`, `staging`,
-- `next`, …). We do NOT validate the branch exists on GitHub at insert time
-- — the runner's first `git clone --branch <name>` is the authoritative
-- check, and we'd rather surface the failure in the workspace lifecycle
-- (where the operator can act on it) than in the settings dialog.

alter table public.projects
  add column if not exists integration_branch text;

comment on column public.projects.integration_branch is
  'Optional integration branch (e.g. "dev"). When set, ticket branches cut '
  'from and PR into this; promotion to default_branch is a separate action. '
  'NULL = legacy (cut from default_branch).';
