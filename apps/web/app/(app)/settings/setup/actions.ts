"use server";

// Settings → Setup server actions. Everything that MUTATES here is gated on
// the instance-operator check (these writes affect every tenant on the
// install); validation actions are operator-gated too — they relay pasted
// credentials to third parties, which is an operator's call to make.
//
// Env-backed steps write through the same allowlisted atomic writer the boot
// wizard uses — EXCEPT the Supabase boot triplet, which this surface refuses
// to touch: swapping the database under a live session is not a wizard action.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { isInstanceOperator } from "@/lib/platform-secrets/operator";
import { writeEnvLocal } from "@/lib/setup/env-file";
import {
  validateAnthropicKey,
  validateClaudeToken,
  validateEncryptionKey,
  validateGithubOauth,
  validateInngest,
  validateLangfuse,
  validateRedis,
  validateStripeKey,
} from "@/lib/setup/validators";
import type { ValidationResult } from "@/lib/setup/types";

type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

/** Env keys THIS surface may write. The Supabase boot triplet is deliberately
 *  absent — it only moves via first-run /setup or a hand edit. */
const WIZARD_ENV_WRITABLE = new Set([
  "SECRETS_ENCRYPTION_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
  "DEVPILOT_RUNNER_REGISTRATION_KEY",
  "DEVPILOT_RUNNER_TENANT_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "NEXT_PUBLIC_APP_URL",
]);

async function requireOperator(): Promise<{ userId: string; tenantId: string } | string> {
  const user = await requireUser();
  const tenantId = await requireTenantId();
  if (!(await isInstanceOperator(user.id))) {
    return "Only an instance operator (owner/admin of the first workspace) can change instance setup";
  }
  return { userId: user.id, tenantId };
}

// ── Validation ───────────────────────────────────────────────────────────────

const ValidateInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("encryption_key"), value: z.string().min(1).max(4_000) }),
  z.object({
    kind: z.literal("redis"),
    url: z.string().min(1).max(2_000),
    token: z.string().min(1).max(4_000),
  }),
  z.object({
    kind: z.literal("inngest"),
    eventKey: z.string().min(1).max(4_000),
    signingKey: z.string().min(1).max(4_000),
  }),
  z.object({ kind: z.literal("anthropic"), value: z.string().min(1).max(4_000) }),
  z.object({ kind: z.literal("claude_token"), value: z.string().min(1).max(8_000) }),
  z.object({
    kind: z.literal("github"),
    clientId: z.string().min(1).max(2_000),
    clientSecret: z.string().min(1).max(4_000),
  }),
  z.object({
    kind: z.literal("langfuse"),
    publicKey: z.string().min(1).max(4_000),
    secretKey: z.string().min(1).max(4_000),
    baseUrl: z.string().max(2_000).optional(),
  }),
  z.object({ kind: z.literal("stripe"), value: z.string().min(1).max(4_000) }),
]);

export async function validateSetupCredentialAction(
  input: z.infer<typeof ValidateInput>,
): Promise<ActionResult<ValidationResult>> {
  const parsed = ValidateInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  const gate = await requireOperator();
  if (typeof gate === "string") return { ok: false, error: gate };

  const body = parsed.data;
  let result: ValidationResult;
  switch (body.kind) {
    case "encryption_key":
      result = validateEncryptionKey(body.value);
      break;
    case "redis":
      result = await validateRedis(body);
      break;
    case "inngest":
      result = validateInngest(body);
      break;
    case "anthropic":
      result = await validateAnthropicKey(body.value);
      break;
    case "claude_token":
      result = validateClaudeToken(body.value);
      break;
    case "github":
      result = await validateGithubOauth(body);
      break;
    case "langfuse":
      result = await validateLangfuse(body);
      break;
    case "stripe":
      result = await validateStripeKey(body.value);
      break;
  }
  return { ok: true, value: result };
}

// ── Env writes ───────────────────────────────────────────────────────────────

const WriteInput = z.object({
  values: z.record(z.string().min(1).max(8_000)),
});

export async function writeSetupEnvAction(
  input: z.infer<typeof WriteInput>,
): Promise<ActionResult> {
  const parsed = WriteInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid input" };
  const unknown = Object.keys(parsed.data.values).filter((k) => !WIZARD_ENV_WRITABLE.has(k));
  if (unknown.length > 0) {
    return { ok: false, error: `Not wizard-writable env keys: ${unknown.join(", ")}` };
  }
  const gate = await requireOperator();
  if (typeof gate === "string") return { ok: false, error: gate };

  try {
    await writeEnvLocal(parsed.data.values);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath("/settings/setup");
  return { ok: true, value: undefined };
}

/** Mint the runner↔engine handshake pair in one click: a fresh random
 *  registration key plus this tenant's id, both written to .env.local (the
 *  runner reads that same file via --env-file). Returns the key so a remote
 *  runner host can be configured by copy-paste. */
export async function generateRunnerCredentialsAction(): Promise<
  ActionResult<{ registrationKey: string }>
> {
  const gate = await requireOperator();
  if (typeof gate === "string") return { ok: false, error: gate };

  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const registrationKey = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  try {
    await writeEnvLocal({
      DEVPILOT_RUNNER_REGISTRATION_KEY: registrationKey,
      DEVPILOT_RUNNER_TENANT_ID: gate.tenantId,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath("/settings/setup");
  return { ok: true, value: { registrationKey } };
}
