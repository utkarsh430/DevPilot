// Per-credential live validators (server-only). Each one is TIME-BOXED and
// maps outcomes onto the tri-state ValidationResult:
//
//   parse error / positive rejection (401, wrong-credential error code) → invalid
//   positive acceptance                                                 → valid
//   anything inconclusive (network blip, unknown response shape)        → unverified
//
// "unverified" never blocks a save (see CredentialField) — a flaky network or
// an undocumented provider response must not lock an operator out of setup.

import "server-only";

import { invalid, unverified, valid, type ValidationResult } from "./types";

const CHECK_TIMEOUT_MS = 6_000;

function timeboxed(input: string | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

// ── Supabase (boot triplet, validated as one unit) ──────────────────────────

export async function validateSupabase(input: {
  url: string;
  publishableKey: string;
  secretKey: string;
}): Promise<ValidationResult> {
  const base = parseHttpUrl(input.url.trim().replace(/\/+$/, ""));
  if (!base) return invalid("That's not a valid URL — expected https://<project-ref>.supabase.co");

  // 1. Reachability + publishable key via the unauthenticated health endpoint.
  let health: Response;
  try {
    health = await timeboxed(`${base.origin}/auth/v1/health`, {
      headers: { apikey: input.publishableKey.trim() },
    });
  } catch {
    return unverified(`Couldn't reach ${base.origin} to confirm - check the URL; saving anyway`);
  }
  if (health.status === 401 || health.status === 403) {
    return invalid("Supabase rejected the publishable key (401) — re-copy it from API settings");
  }
  if (!health.ok) {
    return unverified(`Supabase health returned HTTP ${health.status} — is this a Supabase URL?`);
  }

  // 2. Secret (service-role) key via an admin endpoint only it can open.
  try {
    const admin = await timeboxed(`${base.origin}/auth/v1/admin/users?per_page=1`, {
      headers: {
        apikey: input.secretKey.trim(),
        Authorization: `Bearer ${input.secretKey.trim()}`,
      },
    });
    if (admin.status === 401 || admin.status === 403) {
      return invalid("The secret key was rejected — make sure you pasted the sb_secret_… key");
    }
    if (!admin.ok) {
      return unverified(`Admin ping returned HTTP ${admin.status} — keys look plausible`);
    }
  } catch {
    return unverified("Health check passed but the admin ping didn't complete — saved as-is");
  }
  return valid("Connected — URL, publishable key, and secret key all check out");
}

// ── SECRETS_ENCRYPTION_KEY (local shape check) ──────────────────────────────

export function validateEncryptionKey(value: string): ValidationResult {
  const decoded = Buffer.from(value.trim(), "base64");
  // Round-trip guard: Buffer.from(_, "base64") silently swallows garbage.
  if (decoded.length !== 32) {
    return invalid("Must be 32 random bytes, base64-encoded (44 characters ending in =)");
  }
  return valid("Key shape is right (32 bytes)");
}

// ── Upstash Redis (REST PING) ───────────────────────────────────────────────

export async function validateRedis(input: {
  url: string;
  token: string;
}): Promise<ValidationResult> {
  const base = parseHttpUrl(input.url.trim().replace(/\/+$/, ""));
  if (!base) return invalid("That's not a valid URL — expected https://<name>.upstash.io");
  try {
    // `POST / ["PING"]` rather than `GET /ping`: both are Upstash REST, but
    // only the POST form is answered by the local stand-in
    // (infra/local/docker-compose.yml), so a `pnpm setup:local` install
    // validates green here instead of reading as "reachable, not a PONG".
    const res = await timeboxed(`${base.origin}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["PING"]),
    });
    if (res.status === 401 || res.status === 403) {
      return invalid("Redis rejected the token (401) — re-copy the REST token, not the password");
    }
    if (!res.ok) return unverified(`Redis replied HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { result?: string } | null;
    if (body?.result?.toUpperCase() === "PONG") {
      return valid("PONG — Redis is reachable with this token");
    }
    return unverified("Reachable, but the reply wasn't a PONG — is this an Upstash REST URL?");
  } catch {
    return unverified(`Couldn't reach ${base.origin} — check the URL and your network`);
  }
}

// ── Inngest (format-only — keys are only exercised by a real event) ─────────

export function validateInngest(input: { eventKey: string; signingKey: string }): ValidationResult {
  if (input.signingKey.trim() && !input.signingKey.trim().startsWith("signkey-")) {
    return unverified('Signing keys normally start with "signkey-" — double-check the copy');
  }
  return valid("Format looks right — fully verified on the first durable run");
}

// ── Anthropic API key ───────────────────────────────────────────────────────

export async function validateAnthropicKey(key: string): Promise<ValidationResult> {
  try {
    const res = await timeboxed("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key.trim(), "anthropic-version": "2023-06-01" },
    });
    if (res.status === 401) return invalid("Anthropic rejected the key (401) — check for typos");
    if (res.ok) return valid("Key accepted by the Anthropic API");
    return unverified(`Anthropic replied HTTP ${res.status}`);
  } catch {
    return unverified("Couldn't reach api.anthropic.com — saved without verification");
  }
}

// ── Claude Code OAuth token (format-only) ───────────────────────────────────

export function validateClaudeToken(token: string): ValidationResult {
  if (token.trim().startsWith("sk-ant-")) {
    return valid("Token shape looks right — exercised on the runner's first job");
  }
  return unverified(
    'Tokens from `claude setup-token` start with "sk-ant-" — double-check the copy',
  );
}

// ── GitHub OAuth app (dummy-code exchange) ──────────────────────────────────
//
// GitHub's token endpoint distinguishes "your code is garbage but the client
// credentials are fine" (bad_verification_code) from "the client id/secret is
// wrong" (incorrect_client_credentials) — documented error codes, which makes
// a full credential check possible without a real OAuth dance. Unknown shapes
// degrade to unverified, never a false block.

export async function validateGithubOauth(input: {
  clientId: string;
  clientSecret: string;
}): Promise<ValidationResult> {
  try {
    const res = await timeboxed("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: input.clientId.trim(),
        client_secret: input.clientSecret.trim(),
        code: "devpilot-setup-probe",
      }),
    });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (body?.error === "bad_verification_code") {
      return valid("GitHub accepted the client id + secret");
    }
    if (body?.error === "incorrect_client_credentials") {
      return invalid("GitHub rejected the client id/secret — re-copy both from the OAuth App page");
    }
    return unverified(
      `GitHub replied ${body?.error ?? `HTTP ${res.status}`} — couldn't verify, saved anyway`,
    );
  } catch {
    return unverified("Couldn't reach github.com — saved without verification");
  }
}

// ── Langfuse (authenticated projects endpoint) ──────────────────────────────

export async function validateLangfuse(input: {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
}): Promise<ValidationResult> {
  const base =
    parseHttpUrl((input.baseUrl ?? "").trim() || "https://us.cloud.langfuse.com") ??
    new URL("https://us.cloud.langfuse.com");
  try {
    const auth = Buffer.from(`${input.publicKey.trim()}:${input.secretKey.trim()}`).toString(
      "base64",
    );
    const res = await timeboxed(`${base.origin}/api/public/projects`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (res.status === 401) return invalid("Langfuse rejected the key pair (401)");
    if (res.ok) return valid("Key pair accepted by Langfuse");
    return unverified(`Langfuse replied HTTP ${res.status}`);
  } catch {
    return unverified(`Couldn't reach ${base.origin} — saved without verification`);
  }
}

// ── Stripe (balance read — cheapest authenticated call) ────────────────────

export async function validateStripeKey(key: string): Promise<ValidationResult> {
  try {
    const res = await timeboxed("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${key.trim()}` },
    });
    if (res.status === 401) return invalid("Stripe rejected the key (401)");
    if (res.ok) {
      return valid(`Key accepted${key.trim().startsWith("sk_test_") ? " (test mode)" : ""}`);
    }
    return unverified(`Stripe replied HTTP ${res.status}`);
  } catch {
    return unverified("Couldn't reach api.stripe.com — saved without verification");
  }
}
