// Centralized env-var access.
//
// `publicEnv` is browser-safe: only NEXT_PUBLIC_* vars, accessed as STATIC
// literals so Next.js's DefinePlugin can inline them at build time. Dynamic
// `process.env[name]` lookups are NOT inlined on the client, so we must write
// the literal property name here.
//
// `env` is server-only. Each field is a lazy getter — the required() check
// fires on access, not on module load — so importing this file into client
// code (transitively, via shared utilities) doesn't crash the bundle.

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const publicEnv = {
  SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  /** Where sign-in mail lands on a LOCAL install (Mailpit, written by
   *  `pnpm setup:local`). Blank everywhere else, and the login page shows
   *  nothing for blank. */
  LOCAL_MAIL_URL: process.env.NEXT_PUBLIC_LOCAL_MAIL_URL ?? "",
} as const;

export const env = {
  get SUPABASE_URL() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get SUPABASE_PUBLISHABLE_KEY() {
    return required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  },
  get SUPABASE_SECRET_KEY() {
    return required("SUPABASE_SECRET_KEY");
  },
  get ANTHROPIC_API_KEY() {
    return required("ANTHROPIC_API_KEY");
  },
  get LANGFUSE_PUBLIC_KEY() {
    return required("LANGFUSE_PUBLIC_KEY");
  },
  get LANGFUSE_SECRET_KEY() {
    return required("LANGFUSE_SECRET_KEY");
  },
  get LANGFUSE_BASE_URL() {
    return process.env.LANGFUSE_BASE_URL ?? "https://us.cloud.langfuse.com";
  },
  get LANGFUSE_PROJECT_ID() {
    return process.env.LANGFUSE_PROJECT_ID ?? "";
  },
  get INNGEST_EVENT_KEY() {
    return required("INNGEST_EVENT_KEY");
  },
  get INNGEST_SIGNING_KEY() {
    return required("INNGEST_SIGNING_KEY");
  },
  get UPSTASH_REDIS_REST_URL() {
    return required("UPSTASH_REDIS_REST_URL");
  },
  get UPSTASH_REDIS_REST_TOKEN() {
    return required("UPSTASH_REDIS_REST_TOKEN");
  },
  get DEVPILOT_RUNNER_REGISTRATION_KEY() {
    return required("DEVPILOT_RUNNER_REGISTRATION_KEY");
  },
  get LOCAL_CC_CONCURRENCY() {
    return Number(process.env.LOCAL_CC_CONCURRENCY ?? "2");
  },
  get LOCAL_CC_ENGINE_URL() {
    return process.env.LOCAL_CC_ENGINE_URL ?? "http://localhost:3000";
  },
  get CLAUDE_CODE_OAUTH_TOKEN() {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  },
  get APP_URL() {
    return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  },
};
