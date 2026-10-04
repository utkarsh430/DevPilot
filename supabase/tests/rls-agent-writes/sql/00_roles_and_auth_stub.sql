-- WP 1.3 RLS harness: roles + an `auth` schema stub.
--
-- Supabase injects a real `auth` schema (auth.uid(), auth.jwt(), auth.users)
-- and a Postgres role per JWT `role` claim. This throwaway local cluster has
-- neither, so we stub the one piece every RLS policy in devpilot actually
-- depends on: auth.uid() reading a per-connection GUC. This is the standard
-- local-RLS testing trick and is not a simplification that changes what is
-- being proven — production auth.uid() is defined the same way, populated by
-- PostgREST/supabase-js from the verified JWT before the query runs. Based
-- on the devpilot-desktop probe's 00_roles_and_auth_stub.sql, with `anon` and
-- `service_role` added (the probe's own harness only ever exercised
-- `authenticated`; this repo's real schema subset transcribes GRANT
-- statements naming both, and 20260762000000's REVOKE-from-anon fix needs
-- the role to exist to apply).

create schema if not exists auth;

create table auth.users (
  id    uuid primary key,
  email text
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

-- The role every signed-in desktop-app connection runs queries as. In real
-- Supabase this is the role PostgREST/supabase-js SETs after verifying the
-- JWT; here the test harness `SET ROLE authenticated` directly since we are
-- proving the RLS/RPC design, not re-implementing the JWT-verification hop.
-- `service_role` also stubbed (nologin, unused by any test — RLS bypass is
-- not what is being proven here) because the real schema subset's DDL,
-- transcribed verbatim, grants a function to it alongside `authenticated`
-- (current_user_tenants) and that GRANT statement must resolve to a real
-- role to apply cleanly.
--
-- `anon` also stubbed (nologin) so 20260762000000's `revoke ... from public,
-- anon` statements — the fix for Postgres's default PUBLIC EXECUTE grant on
-- new functions, closing the gap an unauthenticated caller could otherwise
-- reach a SECURITY DEFINER RPC — resolve to a real role and actually apply.
-- `SET ROLE anon` works from the harness's superuser connection despite
-- `nologin` (that flag only blocks a fresh client CONNECTION, not SET ROLE
-- from a role that already has it, and postgres-the-superuser has every
-- role implicitly) — 16_request_secret.sql exercises exactly that to prove
-- the revoke actually took.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $$;

grant usage on schema public to authenticated, service_role;
grant usage on schema auth to authenticated, service_role;
-- No `extensions`/pgcrypto schema needed here: it was only ever pulled in by
-- 01_schema_subset.sql's (now-removed) local `set_project_secret` transcript,
-- which 20260763000000 makes moot — that function was already dropped in the
-- real schema (20260615010000) and devpilot_set_project_secret no longer
-- delegates to it.
