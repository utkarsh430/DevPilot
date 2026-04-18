// The provider credential REFERENCE — `projects.llm_credential_ref`.
//
// The projects row NEVER holds a provider API key. It holds an opaque pointer to
// where the key lives, and the key itself lives in one of the two stores that
// already encrypt at rest:
//
//   project_secret:<KEY>  → the per-project AES-256-GCM vault (`project_secrets`,
//                           lib/projects/secrets.ts). Written by the project
//                           form; scoped to exactly one project.
//   platform:<KEY>        → the platform-secrets store, resolved tenant »
//                           instance » env (lib/platform-secrets/resolver.ts).
//                           Lets an operator configure one key for the whole
//                           instance instead of per project.
//
// The ref is a NAME, not a secret: it's safe on a read surface, exactly like the
// `project_secret_names` view. The VALUE it points at is resolved server-side
// only (provider-config.server.ts) and is never returned from an action, never
// put in a prompt, and never logged.
//
// The write path only ever mints the `project_secret:` form with the fixed key
// name below — an operator can't hand-craft a ref, so this parser is defence
// against a hand-edited/legacy row, not a user-facing grammar.

/** The one vault key name the project form writes a provider key to. Fixed
 *  rather than operator-chosen so the runner-side blocklist (which must keep
 *  this key OFF the subscription spawn) has an exact name to match. Keep in
 *  lockstep with SUBSCRIPTION_BLOCKED_ENV_KEYS in apps/runner/src/subscription-env.ts. */
export const PROJECT_LLM_API_KEY = "DEVPILOT_LLM_API_KEY";

/** Instance/tenant-scoped provider key + base URL (platform-secrets catalog). */
export const LLM_PROVIDER_API_KEY = "LLM_PROVIDER_API_KEY";
export const LLM_PROVIDER_BASE_URL = "LLM_PROVIDER_BASE_URL";

export type CredentialRef =
  | { store: "project_secret"; key: string }
  | { store: "platform"; key: string };

/** The ref the project form writes when the operator pastes a key. */
export const PROJECT_VAULT_REF = `project_secret:${PROJECT_LLM_API_KEY}`;

const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Parse a stored ref. Returns null for absent/garbage — the caller then falls
 *  back down the precedence chain rather than throwing, so a corrupt ref
 *  degrades to "no project-level key" instead of breaking every run. */
export function parseCredentialRef(raw: string | null | undefined): CredentialRef | null {
  const value = (raw ?? "").trim();
  if (value.length === 0) return null;
  const idx = value.indexOf(":");
  if (idx <= 0) return null;
  const store = value.slice(0, idx);
  const key = value.slice(idx + 1);
  if (!KEY_RE.test(key)) return null;
  if (store === "project_secret") return { store: "project_secret", key };
  if (store === "platform") return { store: "platform", key };
  return null;
}

export function formatCredentialRef(ref: CredentialRef): string {
  return `${ref.store}:${ref.key}`;
}
