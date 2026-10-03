-- Route under test: request-secret (ask half — same split as request-human)
-- plus the secret-VALUE subsystem it hands off to (devpilot_set_project_secret
-- / devpilot_get_project_secret_names, 20260762000000 as fixed by
-- 20260763000000). `devpilot_set_project_secret` now writes
-- `value_encrypted`/`value_iv` DIRECTLY — it delegates to nothing. devpilot's
-- real `project_secrets` table carries no member-read/write policy and no
-- grant to `authenticated` at all (20260606000000 / 20260761000000); these
-- two RPCs are the only sanctioned access path, values-in included.
--
-- The ciphertext/iv below are OPAQUE bytes as far as this harness is
-- concerned — this file proves the RPC stores caller-supplied bytes
-- byte-for-byte (never re-derives, re-encrypts, or otherwise mangles them),
-- not that AES-GCM itself round-trips (that is Node's job,
-- apps/web/lib/secrets/crypto.ts, already covered elsewhere).

\echo '--- [request-secret ask] Alice: secret-request comment (names only, never values, in metadata) — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.comments (tenant_id, ticket_id, author_type, author_id, body, metadata)
values ('a0000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000007','agent','impl_a',
        'need STRIPE_API_KEY to proceed',
        jsonb_build_object('kind','secret_request','keys', array['STRIPE_API_KEY'], 'project_id','a2000000-0000-0000-0000-000000000001'))
returning id;
reset role;

\echo '--- [request-secret ask] transition in_progress -> input_required — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select (public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000007', 'input_required', 'agent', 'waiting on secret')).status;
reset role;

\echo '--- [secret values] direct table access to project_secrets is granted NOTHING to authenticated — expect REFUSED (permission denied for table project_secrets) even for Alice on her own tenant row ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select secret_key from public.project_secrets where project_id = 'a2000000-0000-0000-0000-000000000001';
reset role;

\echo '--- [secret values] Alice (standing in for "the human who fills the secret in") sets it via devpilot_set_project_secret(project_id, key, ciphertext, iv) — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_set_project_secret(
  'a2000000-0000-0000-0000-000000000001',
  'STRIPE_API_KEY',
  '\x0102030405060708090a0b0c0d0e0f1011121314151617',
  '\x000102030405060708090a0b'
);
select public.devpilot_get_project_secret_names('a2000000-0000-0000-0000-000000000001');
reset role;

\echo '--- [secret values] superuser check (bypassing RLS entirely): the row landed with the CALLER-SUPPLIED bytes verbatim (proves the RPC is a dumb writer, not a reimplementation of encryption) and created_by = Alice''s auth uid — expect exact match, not merely non-null ---'
select
  secret_key,
  value_encrypted = '\x0102030405060708090a0b0c0d0e0f1011121314151617'::bytea as ciphertext_matches_exactly,
  value_iv = '\x000102030405060708090a0b'::bytea as iv_matches_exactly,
  created_by
from public.project_secrets
where project_id = 'a2000000-0000-0000-0000-000000000001' and secret_key = 'STRIPE_API_KEY';

\echo '--- [secret values] re-set (update path): a second call with different bytes overwrites in place, same row (unique (project_id, secret_key) + ON CONFLICT DO UPDATE) — expect SUCCESS, one row, new bytes ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_set_project_secret(
  'a2000000-0000-0000-0000-000000000001',
  'STRIPE_API_KEY',
  '\xffeeddccbbaa99887766554433221100',
  '\xaabbccddeeff001122334455'
);
reset role;
select count(*) as should_be_one from public.project_secrets
  where project_id = 'a2000000-0000-0000-0000-000000000001' and secret_key = 'STRIPE_API_KEY';
select value_encrypted = '\xffeeddccbbaa99887766554433221100'::bytea as ciphertext_updated_exactly
from public.project_secrets
where project_id = 'a2000000-0000-0000-0000-000000000001' and secret_key = 'STRIPE_API_KEY';

\echo '--- [secret values] control: Bob (tenant B only) tries to set a secret on tenant A''s project — expect REFUSED (not a member of tenant) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
select public.devpilot_set_project_secret(
  'a2000000-0000-0000-0000-000000000001',
  'STRIPE_API_KEY',
  '\xdeadbeef',
  '\xdeadbeefdeadbeefdeadbeef'
);
reset role;

\echo '--- [secret values] control: Bob tries to read tenant A''s secret names via the RPC — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
select public.devpilot_get_project_secret_names('a2000000-0000-0000-0000-000000000001');
reset role;

-- Confirm the "stolen" ciphertext was never written.
select count(*) as should_be_zero from public.project_secrets
  where project_id = 'a2000000-0000-0000-0000-000000000001'
    and value_encrypted = '\xdeadbeef'::bytea;

\echo '--- [secret values] control: anon (unauthenticated) tries to set a secret — expect REFUSED (permission denied for function devpilot_set_project_secret; EXECUTE was revoked from anon) ---'
set role anon;
select public.devpilot_set_project_secret(
  'a2000000-0000-0000-0000-000000000001',
  'STRIPE_API_KEY',
  '\xdeadbeef',
  '\xdeadbeefdeadbeefdeadbeef'
);
reset role;

\echo '--- [secret values] control: anon tries to read secret names — expect REFUSED (permission denied for function devpilot_get_project_secret_names) ---'
set role anon;
select public.devpilot_get_project_secret_names('a2000000-0000-0000-0000-000000000001');
reset role;

\echo '--- [secret values] control: the OLD plaintext-accepting 3-arg signature (project_id, key, value) must no longer exist — expect REFUSED (function public.devpilot_set_project_secret(...) does not exist), NOT a successful plaintext write ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_set_project_secret(
  'a2000000-0000-0000-0000-000000000001',
  'DANGEROUS_PLAINTEXT_KEY',
  'this-should-never-be-accepted-as-plaintext'
);
reset role;

-- Confirm the 3-arg call above never inserted anything under that key.
select count(*) as should_be_zero from public.project_secrets
  where project_id = 'a2000000-0000-0000-0000-000000000001' and secret_key = 'DANGEROUS_PLAINTEXT_KEY';
