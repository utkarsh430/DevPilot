// Server-side status composition for the Settings → Setup wizard. One shape
// answers, per credential: is it in the env file? is there an instance-store
// row? — plus the contextual facts the steps need (operator?, auth mode,
// runner liveness seed, supabase ref for the OAuth callback URL).

import "server-only";

import { isInstanceOperator } from "@/lib/platform-secrets/operator";
import { platformSecretsEnabled } from "@/lib/platform-secrets/resolver";
import { loadInstanceSecretsConfigured } from "@/lib/platform-secrets/store";
import { getLlmAuthMode } from "@/lib/llm/auth-mode.server";
import { loadSystemHealthSnapshot } from "@/lib/health/load";
import { isServerlessHost } from "@/lib/setup/env-file";
import type { LlmAuthMode } from "@/lib/llm/auth-mode";
import type { SystemHealthSnapshot } from "@/lib/health/types";

/** Env keys the wizard reports presence for (booleans only — never values). */
const WIZARD_ENV_KEYS = [
  "SECRETS_ENCRYPTION_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
  "DEVPILOT_RUNNER_REGISTRATION_KEY",
  "DEVPILOT_RUNNER_TENANT_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
] as const;

export type WizardEnvKey = (typeof WIZARD_ENV_KEYS)[number];

export type SetupWizardStatus = {
  /** Caller may write instance credentials (owner/admin of the first tenant). */
  operator: boolean;
  /** DEVPILOT_PLATFORM_SECRETS_ENABLED resolution (default on). */
  storeEnabled: boolean;
  /** No writable env file on this host (VERCEL). */
  serverless: boolean;
  /** `next start` — env writes only apply after a restart. */
  prodBuild: boolean;
  tenantId: string;
  supabaseUrl: string;
  llmAuthMode: LlmAuthMode;
  /** Presence (not values) of env-managed keys. */
  env: Record<WizardEnvKey, boolean>;
  /** Masked tails of configured INSTANCE-store keys, keyed by secret key. */
  instance: Record<string, string | null>;
  health: SystemHealthSnapshot;
};

function envPresent(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

export async function loadSetupWizardStatus(
  userId: string,
  tenantId: string,
): Promise<SetupWizardStatus> {
  const [operator, instanceConfigured, llmAuthMode, health] = await Promise.all([
    isInstanceOperator(userId),
    loadInstanceSecretsConfigured(),
    getLlmAuthMode(tenantId),
    loadSystemHealthSnapshot(tenantId),
  ]);

  const env = {} as Record<WizardEnvKey, boolean>;
  for (const k of WIZARD_ENV_KEYS) env[k] = envPresent(k);

  const instance: Record<string, string | null> = {};
  for (const c of instanceConfigured) instance[c.key] = c.tail;

  return {
    operator,
    storeEnabled: platformSecretsEnabled(),
    serverless: isServerlessHost(),
    prodBuild: process.env.NODE_ENV === "production",
    tenantId,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    llmAuthMode,
    env,
    instance,
    health,
  };
}

/** The steps the platform can't run tickets without. Drives the welcome
 *  screen's "Finish instance setup" nudge for operators. Inngest keys are NOT
 *  required: the documented local stack uses the keyless Inngest dev server,
 *  so their absence doesn't mean tickets can't run. */
export function requiredSetupComplete(status: SetupWizardStatus): boolean {
  const runnerKeysReady =
    status.env.DEVPILOT_RUNNER_REGISTRATION_KEY && status.env.DEVPILOT_RUNNER_TENANT_ID;
  return (
    status.env.SECRETS_ENCRYPTION_KEY &&
    status.env.UPSTASH_REDIS_REST_URL &&
    status.env.UPSTASH_REDIS_REST_TOKEN &&
    // API-mode tenants don't need the local-runner handshake keys.
    (status.llmAuthMode === "api_key" ? true : runnerKeysReady)
  );
}
