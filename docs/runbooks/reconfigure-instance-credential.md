# Reconfigure an instance credential

Use this when a platform credential (Redis, Inngest, LLM keys, GitHub OAuth app, Langfuse, Stripe, runner keys, the secrets master key) is new, rotated, expired, or failing.

## Prerequisites

- You are an **instance operator**: an `owner`/`admin` member of the _first_ tenant created on the install (`lib/platform-secrets/operator.ts`).
  Non-operators see Settings → Setup read-only.
- For store-backed keys, `SECRETS_ENCRYPTION_KEY` must be set (step 2 of the wizard generates it).

## Where each credential lives (design decision D4)

| Storage                                                                                | Keys                                                                                                                                                                           | Why                                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `apps/web/.env.local` (written by the wizard's atomic writer, `lib/setup/env-file.ts`) | Supabase triplet, `SECRETS_ENCRYPTION_KEY`, `UPSTASH_REDIS_*`, `INNGEST_*`, `DEVPILOT_RUNNER_REGISTRATION_KEY`, `DEVPILOT_RUNNER_TENANT_ID`, `NEXT_PUBLIC_APP_URL`, `STRIPE_*` | Read at process boot (web init, runner `--env-file`) or needed before the DB is reachable     |
| Platform-secrets store, **instance scope** (`platform_secrets` with `tenant_id NULL`)  | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_OAUTH_CLIENT_ID/SECRET`, `LANGFUSE_*`, `ENGINEER_*`                                                                    | Consumers resolve through `lib/platform-secrets/resolver.ts` at call time — no restart needed |

## Steps

1. Open **Settings → Setup** (`/settings/setup`).
   Every step shows a detected/missing state and a `env file` / `instance store` chip telling you where the value goes.
2. Jump to the step (anchors: `#supabase`, `#encryption-key`, `#redis`, `#inngest`, `#runner`, `#llm-auth`, `#github-oauth`, `#langfuse`, `#stripe`) — failure surfaces ("Fix in setup", health "How to fix →") deep-link to these.
3. Paste the new value and use **Validate & save**.
   Validation is tri-state (`lib/setup/validators.ts`): a positive rejection blocks the save; an inconclusive check saves with a warning ("couldn't verify"), never a false block.
4. Propagation:
   - **Store-backed keys**: live everywhere within ~60s (resolver TTL, `DEVPILOT_PLATFORM_SECRETS_TTL_SECONDS`); the writing process sees it immediately.
   - **Env-backed keys, dev** (`next dev`): picked up automatically on the next request.
   - **Env-backed keys, prod** (`next start`): restart the server; if a `NEXT_PUBLIC_*` var changed, **rebuild first** (browser values are build-inlined).
   - **Runner keys**: restart the runner worker (it reads `apps/web/.env.local` only at boot).
5. Verify in **Settings → System health** — the matching probe should go green (Langfuse/LLM read the store directly, no env entry needed).

## Special cases

- **Boot Supabase triplet**: the wizard refuses to touch it on a live install. Edit `apps/web/.env.local` by hand (or wipe those three keys and go through first-run `/setup` again — every route redirects there once they're missing, and the write API unlocks with the console-printed token).
- **`SECRETS_ENCRYPTION_KEY` rotation**: not supported by tooling (v1). Changing it orphans every stored secret — decrypts fail and resolution falls back to env. Re-enter stored secrets after a forced rotation.
- **GitHub OAuth**: the same client id/secret pair must ALSO be pasted into the Supabase dashboard (Authentication → Providers → GitHub) — Supabase performs the sign-in handshake; DevPilot's copy is for token refresh. The wizard step shows the exact callback URL to configure on the GitHub OAuth app.
- **Store disabled** (`DEVPILOT_PLATFORM_SECRETS_ENABLED=0`): store-backed saves fail with an explicit error (never a silent no-op). Manage those keys in `.env.local` or remove the flag (it is default-on).
- **Serverless hosts** (`VERCEL` set): there is no writable env file, so env-backed saves fail with an explicit error - set those variables in the deployment's environment settings and redeploy. Store-backed keys still save normally. First-run `/setup` degrades there to read-only copy-paste guidance (no token; the write/validate routes are hard-disabled).

## Gotchas

- Values never render back in the UI — only masked tails (`••••abcd`). Keep your own copy of generated values (encryption key, registration key) in a password manager.
- The first-run `/setup` surface is dead (403) the moment the boot triplet exists; it cannot be used to reconfigure a live instance.
