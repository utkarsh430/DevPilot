// Static catalog of platform config surfaced in the Platform secrets settings
// page. Drives the UI: label, description, grouping, required/optional, and
// whether it's editable (a per-tenant override) or "managed in environment"
// (bootstrap / shared-infra, read-only).
//
// NOT every env var lives here — only the operationally meaningful ones from
// `.env.local`. Advanced tuning knobs (DEVPILOT_MAX_*, reaper batches, cohort caps)
// stay env-only and can be added later.
//
// `editable: false` means the value is bootstrap (needed to reach/decrypt the
// store, or build-time-inlined) or shared instance infrastructure (Redis,
// Inngest) that no single tenant owns — shown read-only so the page still
// reflects ALL of `.env.local`, but not settable from this per-tenant surface.

export type PlatformSecretGroup =
  | "AI & runners"
  | "Tracing"
  | "Integrations"
  | "Deployment"
  | "Engineer workspace"
  | "Database"
  | "Cache & queue"
  | "Durable execution"
  | "Billing";

export type PlatformSecretCatalogEntry = {
  key: string;
  label: string;
  description: string;
  group: PlatformSecretGroup;
  /** The platform hard-requires this configured somewhere (env or DB). */
  required: boolean;
  /** false = bootstrap / shared-infra → read-only ("Managed in environment"). */
  editable: boolean;
  /** Where the setup wizard puts the value (design decision D4):
   *  "env"      — apps/web/.env.local via the allowlisted writer (a process
   *               reads it at boot: web init, the runner's --env-file), or the
   *               value must exist before the DB is reachable.
   *  "instance" — platform-secrets instance scope (tenant_id NULL); consumers
   *               already resolve through the resolver, so no restart needed. */
  storage: "env" | "instance";
  /** Optional "get one at …" link surfaced under the description. */
  url?: string;
  /** Mask the input + status (true) vs plain config like a URL/id (false). */
  secret: boolean;
  /** Restrict BOTH scopes' writes to an instance operator, not mere tenant
   *  membership.
   *
   *  WHY THIS EXISTS. Instance-scope writes were already operator-gated, but the
   *  TENANT-scope path (`setPlatformSecretAction`) checked only `requireUser()`
   *  + `requireTenantId()` — so any authenticated member of a tenant could set a
   *  tenant override for any `editable` catalog key, and the resolver reads
   *  tenant » instance » env, meaning that override WINS for the whole tenant.
   *
   *  For a deploy credential that is a full vault-exfiltration path wearing a
   *  config change as a disguise: point `VERCEL_TOKEN` at an attacker-controlled
   *  Vercel account and every environment variable DevPilot later pushes during a
   *  deploy is delivered to the attacker. So a key whose compromise redirects
   *  where OUR data goes (as opposed to merely spending our money) carries this
   *  flag, and both the set and the delete action enforce it. Deleting matters
   *  too — dropping an operator's override silently reverts the instance to a
   *  different credential.
   *
   *  Absent/false keeps the pre-existing behaviour byte-for-byte, so no
   *  currently-settable key changes gate here. */
  operatorOnly?: boolean;
  /** Deliver this platform secret into the AGENT's environment (the `claude -p`
   *  spawn + the workspace `.env.local`) when the project's own vault does not
   *  define the key. DEFAULT OFF, and it must stay per-key.
   *
   *  WHY NOT A BLANKET FALLBACK. `platform_secrets` holds ANTHROPIC_API_KEY,
   *  SUPABASE_SECRET_KEY, STRIPE_SECRET_KEY, UPSTASH_REDIS_REST_TOKEN,
   *  INNGEST_SIGNING_KEY. A general "missing at project level, so read platform
   *  level" rule would place every one of those into every agent's environment
   *  on every dispatch, permanently. An agent can read its own environment; a
   *  prompt-injected one will. So sharing is opt-in per key, in code.
   *
   *  THE RULE FOR APPLYING THIS FLAG: shareable if the credential identifies the
   *  OPERATOR, per-project if it identifies the APP. `VERCEL_TOKEN` identifies
   *  the operator's Vercel account and is the same value for every project —
   *  that is why it is shared. The Supabase keys identify one app's database;
   *  a fallback there would silently hand a project a tenant-wide Supabase
   *  instead of failing cleanly, which is worse than a missing value.
   *
   *  Eligibility is not delivery: a key on the runner's
   *  SUBSCRIPTION_BLOCKED_ENV_KEYS deny list stays out of the agent process even
   *  if marked here (see `lib/platform-secrets/agent-shared.ts`). */
  shareWithAgents?: boolean;
};

export const PLATFORM_SECRET_CATALOG: readonly PlatformSecretCatalogEntry[] = [
  // ── AI & runners ──────────────────────────────────────────────────────────
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    description:
      "Powers the API runner, plan mode, ticket auto-enrichment, and the LLM health check. Get one at console.anthropic.com.",
    group: "AI & runners",
    required: false,
    editable: true,
    storage: "instance",
    url: "https://console.anthropic.com",
    secret: true,
  },
  {
    key: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude Code subscription token",
    description:
      "Authenticates the local runner against your Claude Pro/Max subscription (run `claude setup-token`). The default runner uses this instead of the API key.",
    group: "AI & runners",
    required: false,
    editable: true,
    storage: "instance",
    secret: true,
  },
  // WI-12 — the instance/tenant-scoped fallback for an OpenAI-compatible
  // provider. A project can override both per-project (its own base URL + a key
  // in its own encrypted vault); these two are what a project inherits when it
  // doesn't. `instance` storage means the resolver already reads them tenant »
  // instance » env with no restart.
  {
    key: "LLM_PROVIDER_BASE_URL",
    label: "OpenAI-compatible endpoint",
    description:
      "Default base URL for the OpenAI-compatible provider (Ollama, vLLM, LiteLLM, a gateway). Must be https — SSRF-validated, and any host resolving to a private address is refused. Only used by projects set to that provider.",
    group: "AI & runners",
    required: false,
    editable: true,
    storage: "instance",
    secret: false,
  },
  {
    key: "LLM_PROVIDER_API_KEY",
    label: "OpenAI-compatible API key",
    description:
      "Credential for the endpoint above. Optional — a local Ollama authenticates nobody. Never reaches the Claude Code subscription runner.",
    group: "AI & runners",
    required: false,
    editable: true,
    storage: "instance",
    secret: true,
  },
  {
    key: "DEVPILOT_RUNNER_REGISTRATION_KEY",
    label: "Runner registration secret",
    description:
      "Shared secret for the runner↔engine handshake. Bootstrap: it's the credential used to call the runner endpoints, so it stays in the environment.",
    group: "AI & runners",
    required: true,
    editable: false,
    storage: "env",
    secret: true,
  },
  // ── Tracing ───────────────────────────────────────────────────────────────
  {
    key: "LANGFUSE_PUBLIC_KEY",
    label: "Langfuse public key",
    description:
      "Ingests LLM traces. Free tier at cloud.langfuse.com. Optional — falls back to the environment default.",
    group: "Tracing",
    required: false,
    editable: true,
    storage: "instance",
    url: "https://cloud.langfuse.com",
    secret: false,
  },
  {
    key: "LANGFUSE_SECRET_KEY",
    label: "Langfuse secret key",
    description:
      "Server-side Langfuse trace ingestion. Optional — falls back to the environment default.",
    group: "Tracing",
    required: false,
    editable: true,
    storage: "instance",
    secret: true,
  },
  {
    key: "LANGFUSE_BASE_URL",
    label: "Langfuse region URL",
    description:
      "Langfuse API base URL (US by default; use eu.cloud.langfuse.com for the EU region).",
    group: "Tracing",
    required: false,
    editable: true,
    storage: "instance",
    secret: false,
  },
  {
    key: "LANGFUSE_PROJECT_ID",
    label: "Langfuse project ID",
    description: "Drives deep links in the Run Inspector. Blank hides the links.",
    group: "Tracing",
    required: false,
    editable: true,
    storage: "instance",
    secret: false,
  },
  // ── Integrations ──────────────────────────────────────────────────────────
  {
    key: "GITHUB_OAUTH_CLIENT_ID",
    label: "GitHub OAuth client ID",
    description: "From your GitHub OAuth App. Needed only if GitHub tokens expire (token refresh).",
    group: "Integrations",
    required: false,
    editable: true,
    storage: "instance",
    url: "https://github.com/settings/developers",
    secret: false,
  },
  {
    key: "GITHUB_OAUTH_CLIENT_SECRET",
    label: "GitHub OAuth client secret",
    description: "Secret for your GitHub OAuth App. Needed only for token refresh.",
    group: "Integrations",
    required: false,
    editable: true,
    storage: "instance",
    secret: true,
  },
  // ── Deployment ────────────────────────────────────────────────────────────
  // The Vercel credential. All three are `operatorOnly` (see the field's doc
  // comment): a redirected deploy token exfiltrates the whole project vault.
  {
    key: "VERCEL_TOKEN",
    label: "Vercel API token",
    description:
      "Account-scoped Vercel token used to create projects, push environment variables, deploy, and roll back. Vercel has no granular token scopes — this token can do anything the account it was minted under can do, so mint it on an account dedicated to DevPilot and set an expiry.",
    group: "Deployment",
    required: false,
    editable: true,
    storage: "instance",
    url: "https://vercel.com/account/tokens",
    secret: true,
    operatorOnly: true,
    // The ONLY key shared with agents. It identifies the operator's Vercel
    // account, not any one app, so pasting it into every project's vault was
    // pure duplication. Note what an agent can do with it: Vercel has no
    // granular token scopes, so an agent holding this can deploy and otherwise
    // act across EVERY project on that account. The mitigation is to mint the
    // token on an account dedicated to DevPilot — the operator's call, not
    // something this flag can enforce.
    shareWithAgents: true,
  },
  {
    key: "VERCEL_TEAM_ID",
    label: "Vercel team ID",
    description:
      "Optional. Leave blank for a personal (Hobby) account — the normal case. Set it only if the token belongs to a Vercel Team, in which case every API call is scoped to that team. A wrong or missing value silently creates resources in the other scope.",
    group: "Deployment",
    required: false,
    editable: true,
    storage: "instance",
    secret: false,
    operatorOnly: true,
  },
  // The "Connect Vercel" integration's own credentials (PR 3). All three are
  // `operatorOnly` for a reason that is STRICTLY STRONGER than VERCEL_TOKEN's:
  // the client secret does not merely deploy to one account, it mints tokens
  // against this integration for any intercepted install code. The slug and
  // client id are not secrets (both appear in a URL the operator's browser
  // visits) but carry the flag anyway — repointing the slug sends the operator
  // to install someone else's integration, which is the same capture with an
  // extra step.
  {
    key: "VERCEL_OAUTH_CLIENT_ID",
    label: "Vercel integration client ID",
    description:
      "From your Vercel Integration Console entry. Enables the one-click Connect Vercel button; without it, paste a token below instead.",
    group: "Deployment",
    required: false,
    editable: true,
    storage: "instance",
    url: "https://vercel.com/dashboard/integrations/console",
    secret: false,
    operatorOnly: true,
  },
  {
    key: "VERCEL_OAUTH_CLIENT_SECRET",
    label: "Vercel integration client secret",
    description:
      "Secret for the integration above. Used only server-side, in the code→token exchange — it is never sent to the browser.",
    group: "Deployment",
    required: false,
    editable: true,
    storage: "instance",
    secret: true,
    operatorOnly: true,
  },
  {
    key: "VERCEL_INTEGRATION_SLUG",
    label: "Vercel integration slug",
    description:
      "The integration's URL slug (the last path segment of its install URL) — lowercase letters, digits and dashes, not a full URL.",
    group: "Deployment",
    required: false,
    editable: true,
    storage: "instance",
    secret: false,
    operatorOnly: true,
  },
  {
    key: "VERCEL_GIT_NAMESPACE",
    label: "Vercel Git namespace",
    description:
      "Optional. The GitHub owner (user or org) Vercel should link repositories under, when the Vercel GitHub App can see several. Blank means DevPilot uses the only visible namespace.",
    group: "Deployment",
    required: false,
    editable: true,
    storage: "instance",
    secret: false,
    operatorOnly: true,
  },
  // ── Engineer workspace ────────────────────────────────────────────────────
  {
    key: "ENGINEER_REPO_URL",
    label: "Engineer default repo",
    description: "Fallback git repo the Engineer clones when a ticket has no project. Optional.",
    group: "Engineer workspace",
    required: false,
    editable: true,
    storage: "instance",
    secret: false,
  },
  {
    key: "ENGINEER_QA_COMMAND",
    label: "QA verification command",
    description: "Shell command the QA role runs to verify a change. Defaults to `pnpm test`.",
    group: "Engineer workspace",
    required: false,
    editable: true,
    storage: "instance",
    secret: false,
  },
  // ── Database (bootstrap, read-only) ───────────────────────────────────────
  {
    key: "NEXT_PUBLIC_SUPABASE_URL",
    label: "Supabase URL",
    description:
      "Your Supabase project URL. Bootstrap: needed to reach the database and inlined into the browser bundle at build time — stays in the environment.",
    group: "Database",
    required: true,
    editable: false,
    storage: "env",
    secret: false,
  },
  {
    key: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    label: "Supabase publishable key",
    description: "RLS-gated browser key. Bootstrap: build-time-inlined — stays in the environment.",
    group: "Database",
    required: true,
    editable: false,
    storage: "env",
    secret: true,
  },
  {
    key: "SUPABASE_SECRET_KEY",
    label: "Supabase secret key",
    description:
      "Service-role key. Bootstrap: needed to reach and decrypt this very store — stays in the environment.",
    group: "Database",
    required: true,
    editable: false,
    storage: "env",
    secret: true,
  },
  // ── Cache & queue (instance infra, read-only) ─────────────────────────────
  {
    key: "UPSTASH_REDIS_REST_URL",
    label: "Upstash Redis URL",
    description:
      "Serverless Redis endpoint backing the job queue + locks. Instance-level infrastructure; managed in the environment.",
    group: "Cache & queue",
    required: true,
    editable: false,
    storage: "env",
    secret: false,
  },
  {
    key: "UPSTASH_REDIS_REST_TOKEN",
    label: "Upstash Redis token",
    description:
      "Auth token for Upstash Redis. Instance-level infrastructure; managed in the environment.",
    group: "Cache & queue",
    required: true,
    editable: false,
    storage: "env",
    secret: true,
  },
  // ── Durable execution (instance, read-only) ───────────────────────────────
  {
    key: "INNGEST_EVENT_KEY",
    label: "Inngest event key",
    description: "Emits durable-execution events. Instance-level; managed in the environment.",
    group: "Durable execution",
    required: true,
    editable: false,
    storage: "env",
    secret: true,
  },
  {
    key: "INNGEST_SIGNING_KEY",
    label: "Inngest signing key",
    description: "Verifies inbound Inngest webhooks. Instance-level; managed in the environment.",
    group: "Durable execution",
    required: true,
    editable: false,
    storage: "env",
    secret: true,
  },
  // ── Billing (instance, read-only) ─────────────────────────────────────────
  {
    key: "STRIPE_SECRET_KEY",
    label: "Stripe secret key",
    description:
      "Enables usage billing (meters, checkout, the billing page). Optional — without it billing surfaces stay dormant. Instance-level; managed in the environment.",
    group: "Billing",
    required: false,
    editable: false,
    storage: "env",
    url: "https://dashboard.stripe.com/apikeys",
    secret: true,
  },
  {
    key: "STRIPE_WEBHOOK_SECRET",
    label: "Stripe webhook secret",
    description:
      "Verifies inbound Stripe webhooks (subscription + payment events). Instance-level; managed in the environment.",
    group: "Billing",
    required: false,
    editable: false,
    storage: "env",
    secret: true,
  },
];

// Editable groups first, read-only infra last.
export const PLATFORM_SECRET_GROUP_ORDER: readonly PlatformSecretGroup[] = [
  "AI & runners",
  "Tracing",
  "Integrations",
  "Deployment",
  "Engineer workspace",
  "Database",
  "Cache & queue",
  "Durable execution",
  "Billing",
];

export const PLATFORM_SECRET_KEYS: readonly string[] = PLATFORM_SECRET_CATALOG.map((e) => e.key);

export function platformCatalogEntry(key: string): PlatformSecretCatalogEntry | undefined {
  return PLATFORM_SECRET_CATALOG.find((e) => e.key === key);
}
