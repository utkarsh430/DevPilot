#!/usr/bin/env bash
# WP 1.3 local harness for the devpilot-desktop RLS foundation
# (supabase/migrations/20260761000000_desktop_rls_baseline_policies.sql,
# supabase/migrations/20260762000000_desktop_rls_security_definer_rpcs.sql,
# supabase/migrations/20260763000000_secret_rpc_ciphertext_columns.sql,
# supabase/migrations/20260764000000_desktop_engine_write_rpcs.sql - the
# ENGINE-scoped RPC family, sibling to 20260762000000's AGENT-scoped RPCs;
# see that file's header for why it is a sibling and not a widening -
# supabase/migrations/20260765000000_desktop_engine_queue_rls.sql - the
# THIRD RLS slice: dispatch_queue's INSERT policy plus a tenant-membership
# guard added to dispatch_queue_claim_next/integration_queue_claim_next,
# closing devpilot-desktop PR #24's finding F6).
#
# Never connects to production Supabase. Spins up a throwaway local Postgres
# 16 cluster in ./.pgdata, loads a real-schema subset (sql/01_schema_subset.sql
# — transcribed column-for-column from devpilot's real `supabase/migrations/`,
# see that file's header for citations and omissions) plus seed data, then
# applies the ACTUAL MIGRATION FILES UNDER TEST VERBATIM (not copies — this
# proves the real deliverable, not a paraphrase of it), then replays every
# write shape as an RLS-constrained `authenticated` user with paired
# same-tenant/foreign-tenant controls, then re-applies all of them a SECOND
# time to prove idempotence.
#
# Modeled directly on the devpilot-desktop probe's own harness
# (projects/devpilot-desktop/probes/rls/run.sh) — same phased psql-per-file
# structure, same ON_ERROR_STOP posture (schema/seed/migration files must
# apply cleanly; test files intentionally contain statements expected to
# fail, so they run with ON_ERROR_STOP off and every statement is echoed so
# pass/fail is visible in the transcript rather than swallowed).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$HERE/../../migrations" && pwd)"
# The migration files under test, applied verbatim, in order. Single list
# consumed by both phase 2 (first apply) and phase 4 (idempotence re-apply)
# so adding a migration to this harness means adding ONE line, not four.
MIGRATIONS=(
  "20260761000000_desktop_rls_baseline_policies.sql"
  "20260762000000_desktop_rls_security_definer_rpcs.sql"
  "20260763000000_secret_rpc_ciphertext_columns.sql"
  "20260764000000_desktop_engine_write_rpcs.sql"
  "20260765000000_desktop_engine_queue_rls.sql"
)
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
if [ ! -x "$PGBIN/initdb" ]; then
  # Fall back to whatever is on PATH (e.g. a non-Homebrew Postgres 16 install).
  PGBIN="$(dirname "$(command -v initdb)")"
fi
PGDATA_DIR="$HERE/.pgdata"
# Unix-domain socket paths are capped at ~103 bytes on macOS/BSD; this
# worktree's own path is already close to that limit, so the socket dir
# (unlike PGDATA, whose path length isn't constrained) lives under /tmp with
# a short, fixed name instead of alongside the harness.
SOCK_DIR="/tmp/devpilot-wp13-rls-sock"
PORT="55438"
DB="devpilot_wp13_rls_harness"
LOG="$PGDATA_DIR/postgres.log"
OUT="$HERE/transcript/last-run.log"

export PATH="$PGBIN:$PATH"

start_cluster() {
  mkdir -p "$SOCK_DIR"
  if [ ! -f "$PGDATA_DIR/PG_VERSION" ]; then
    echo "== initdb ($PGDATA_DIR) =="
    initdb -D "$PGDATA_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
  fi
  if ! pg_ctl -D "$PGDATA_DIR" status >/dev/null 2>&1; then
    echo "== starting postgres on port $PORT (unix socket only, no TCP) =="
    pg_ctl -D "$PGDATA_DIR" -l "$LOG" -o "-p $PORT -k $SOCK_DIR -h ''" start
  fi
  for _ in $(seq 1 30); do
    if pg_isready -h "$SOCK_DIR" -p "$PORT" >/dev/null 2>&1; then break; fi
    sleep 0.3
  done
}

stop_cluster() {
  echo "== stopping postgres =="
  pg_ctl -D "$PGDATA_DIR" stop -m fast >/dev/null 2>&1 || true
}

trap stop_cluster EXIT

start_cluster

psql -v ON_ERROR_STOP=1 -h "$SOCK_DIR" -p "$PORT" -U postgres -d postgres \
  -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" >/dev/null

mkdir -p "$HERE/transcript"
: > "$OUT"

# $1 = label for the transcript, $2 = absolute path to the .sql file,
# $3 = "strict" (ON_ERROR_STOP=1 — schema/seed/migration files) or "loose"
# (ON_ERROR_STOP=0 — test files that deliberately contain refused statements).
run_file() {
  local label="$1" path="$2" mode="$3"
  echo "" | tee -a "$OUT"
  echo "########## $label ##########" | tee -a "$OUT"
  local stop=1
  [ "$mode" = "loose" ] && stop=0
  PGOPTIONS='--client-min-messages=notice' psql -h "$SOCK_DIR" -p "$PORT" -U postgres -d "$DB" \
    --set ON_ERROR_STOP="$stop" -a -e -f "$path" 2>&1 | tee -a "$OUT"
}

echo "== phase 1: auth stub + real-schema subset + seed ==" | tee -a "$OUT"
run_file "sql/00_roles_and_auth_stub.sql" "$HERE/sql/00_roles_and_auth_stub.sql" strict
run_file "sql/01_schema_subset.sql"       "$HERE/sql/01_schema_subset.sql"       strict
run_file "sql/02_seed.sql"                "$HERE/sql/02_seed.sql"                strict

echo "" | tee -a "$OUT"
echo "== phase 2: apply the REAL migration files under test (first application) ==" | tee -a "$OUT"
for m in "${MIGRATIONS[@]}"; do
  run_file "migrations/$m (1st apply)" "$MIGRATIONS_DIR/$m" strict
done

echo "" | tee -a "$OUT"
echo "== phase 3: replay every write shape with paired tenant controls ==" | tee -a "$OUT"
for f in "$HERE"/tests/*.sql; do
  run_file "tests/$(basename "$f")" "$f" loose
done

echo "" | tee -a "$OUT"
echo "== phase 4: idempotence — re-apply ALL migration files a SECOND time ==" | tee -a "$OUT"
for m in "${MIGRATIONS[@]}"; do
  run_file "migrations/$m (2nd apply)" "$MIGRATIONS_DIR/$m" strict
done

echo "" | tee -a "$OUT"
echo "== phase 5: post-idempotence smoke check — the RPCs and policies still behave after the double-apply ==" | tee -a "$OUT"
psql -v ON_ERROR_STOP=1 -h "$SOCK_DIR" -p "$PORT" -U postgres -d "$DB" -a -e <<'SQL' 2>&1 | tee -a "$OUT"
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select (public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000006', 'in_progress', 'agent', 'post-idempotence smoke check')).status;
-- 20260764000000's engine RPCs, same smoke posture: ticket a3..0021 ends
-- test 20 at 'ready' (backlog->ready), so ready->assigned is a legal edge.
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000021',
  p_to_status => 'assigned',
  p_actor     => 'system'
) ->> 'transitioned' as engine_transition_smoke_check;
select public.devpilot_engine_system_comment(
  'a3000000-0000-0000-0000-000000000021', 'dispatcher', 'post-idempotence smoke check', null
) is not null as engine_system_comment_smoke_check;
reset role;
-- 20260765000000's claim functions, seeding fresh pending rows since the
-- ones 02_seed.sql provided were already claimed in phase 3 - proves the
-- CREATE OR REPLACE (with its new require_tenant_member guard) still lets a
-- same-tenant caller actually claim a row, not merely that the grant exists.
-- Ticket a3..0033's dispatch_queue row is now 'dispatched' (test 24), so a
-- fresh 'pending' row for the SAME (ticket, agent) pair does not collide
-- with uq_dispatch_queue_ticket_agent_pending; ticket a3..0032 has never had
-- an integration_queue row at all, so it is free of
-- uq_integration_queue_ticket_active too.
insert into public.dispatch_queue (id, tenant_id, ticket_id, agent_id, wip_limit_snapshot)
values ('a8000000-0000-0000-0000-00000000000f', 'a0000000-0000-0000-0000-000000000001',
        'a3000000-0000-0000-0000-000000000033', 'a4000000-0000-0000-0000-000000000001', 1);
insert into public.integration_queue (id, tenant_id, project_id, ticket_id)
values ('a9000000-0000-0000-0000-00000000000f', 'a0000000-0000-0000-0000-000000000001',
        'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000032');
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select (public.dispatch_queue_claim_next(
  'a0000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001'
)).ticket_id as dispatch_queue_claim_smoke_check;
select (public.integration_queue_claim_next(
  'a2000000-0000-0000-0000-000000000001'
)).ticket_id as integration_queue_claim_smoke_check;
reset role;
SQL

echo "" | tee -a "$OUT"
echo "== done. full transcript: $OUT ==" | tee -a "$OUT"

# Machine-checkable summary: a real failure inside a "loose" test file shows
# up in the transcript as a line starting with the psql error prefix but
# annotated by context; the authoritative pass/fail read is a human (or a
# follow-up grep) walking $OUT against each test file's stated expectation,
# exactly as the probe's own out/last-run.log is read. What THIS script
# guarantees mechanically: every "strict" phase (schema, seed, both
# migrations applied twice) exited 0 — set -e above means the script itself
# would already have aborted with a non-zero exit code if any of them failed.
echo "All strict phases (schema/seed/migrations x2) completed without error." | tee -a "$OUT"
