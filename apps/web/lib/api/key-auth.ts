// Phase 1 / M14 — API key auth for the public platform surface.
//
// Wire shape:   Authorization: Bearer ace_<prefix>_<secret>
//   where:
//     - "ace_" is a literal vendor tag (helps operators / log scrubbers
//       distinguish DevPilot keys from other Bearer tokens)
//     - <prefix> is 8 lowercase hex chars stored on `api_keys.prefix`,
//       used as an O(log n) DB lookup hint
//     - <secret> is 43 url-base64 chars (= 32 raw bytes of entropy)
//
// At rest: ONLY the sha256(full-cleartext) is stored, alongside the prefix.
// `resolveApiKey` runs a constant-time compare against the stored hash and
// returns the owning tenant_id on success.
//
// CLAUDE.md non-negotiable: this auth wrapper does NOT call into
// `lib/auth/index.ts` (which is user-session auth) — but it doesn't bypass
// it either. The platform surface is a SEPARATE auth realm (machine-to-
// machine). User-session features still go through requireUser/requireTenantId.

import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { supabaseService } from "@/lib/db/server";

// ⚠️ LOAD-BEARING VALUE — DO NOT CHANGE THE STRING "ace".
//
// This vendor tag is part of the sha256 PREIMAGE of every issued key
// (`sha256("ace_" + prefix + "_" + secret)`, see mintApiKey). At rest we store
// only that hash — never the cleartext. Change the value and:
//   1. parseAuthorizationHeader rejects every issued key at the vendor gate; and
//   2. even past that gate, the stored hash cannot be re-derived. sha256 is
//      one-way and the secret is gone. There is no migration, no backfill, and
//      no backup that recovers an issued key. It is a one-way door.
//
// The DevPilot rename therefore renamed this SYMBOL only. Retiring the "ace"
// vendor tag is a separate, deliberate change that needs a dual-accept window
// (accept {"devpilot","ace"}, mint "devpilot") held open until every key issued
// before the cutover is revoked.
export const DEVPILOT_KEY_VENDOR = "ace";
export const DEVPILOT_KEY_PREFIX_LEN = 8;
// 32 raw bytes → 43 chars in url-base64 (no padding).
export const DEVPILOT_KEY_SECRET_BYTES = 32;

export type ApiKeyScope = "api" | "widget";

export type ApiKeyRecord = {
  id: string;
  tenantId: string;
  scope: ApiKeyScope;
  agentId: string | null;
  name: string;
  prefix: string;
};

export type ApiKeyAuthFailure =
  | { ok: false; status: 401; reason: string }
  | { ok: false; status: 403; reason: string };

export type ApiKeyAuthResult = { ok: true; key: ApiKeyRecord } | ApiKeyAuthFailure;

/**
 * Generate a fresh API key.
 *
 * Returns:
 *   - `cleartext` — full key, shown to the operator ONCE.
 *   - `hash`      — sha256 of cleartext; stored on api_keys.hash.
 *   - `prefix`    — first DEVPILOT_KEY_PREFIX_LEN chars of the secret portion;
 *                   stored on api_keys.prefix; serves as a stable, narrow
 *                   lookup hint that doesn't reveal the secret.
 */
export function mintApiKey(): { cleartext: string; hash: string; prefix: string } {
  const secret = randomBytes(DEVPILOT_KEY_SECRET_BYTES).toString("base64url");
  // Prefix is the first 8 chars of the secret portion — printable, stable,
  // and not enough entropy on its own to brute force.
  const prefix = secret.slice(0, DEVPILOT_KEY_PREFIX_LEN);
  const cleartext = `${DEVPILOT_KEY_VENDOR}_${prefix}_${secret}`;
  const hash = sha256(cleartext);
  return { cleartext, hash, prefix };
}

/**
 * Parse an `Authorization: Bearer …` header into the three components of a
 * DevPilot key. Returns null on any structural failure (wrong scheme, wrong
 * vendor, missing fragments).
 *
 * The parse is POSITIONAL, not `split("_")`, and that is load-bearing. The key
 * is `<vendor>_<prefix>_<secret>` where the secret is base64url — whose alphabet
 * INCLUDES `_` — and the prefix is just the secret's first 8 chars, so both can
 * legitimately contain `_`. Splitting on `_` misaligns whenever the prefix does:
 * `parts[1]` comes back as a fragment shorter than 8, the length check fires, and
 * a perfectly valid freshly-minted key is rejected. That happens with probability
 * 1-(63/64)^8 ≈ 12%, which is what made key-auth.test.ts flaky (~1 in 8 runs).
 *
 * It failed CLOSED, never open (a short fragment can't masquerade as an 8-char
 * prefix), so this is a false-reject bug rather than an auth bypass — and it has
 * never bitten in production only because no API key has ever been issued.
 */
export function parseAuthorizationHeader(
  raw: string | null,
): { vendor: string; prefix: string; cleartext: string } | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // Tolerate case on the scheme; preserve the token bytes exactly.
  const m = trimmed.match(/^Bearer\s+(\S+)$/i);
  if (!m || !m[1]) return null;
  const cleartext = m[1];

  // The vendor tag is the only field guaranteed `_`-free, so the FIRST `_` is
  // the only delimiter we can find by searching. Everything after it is parsed
  // by fixed width.
  const firstUnderscore = cleartext.indexOf("_");
  if (firstUnderscore <= 0) return null;
  const vendor = cleartext.slice(0, firstUnderscore);
  if (vendor !== DEVPILOT_KEY_VENDOR) return null;

  const afterVendor = cleartext.slice(firstUnderscore + 1);
  const prefix = afterVendor.slice(0, DEVPILOT_KEY_PREFIX_LEN);
  if (prefix.length !== DEVPILOT_KEY_PREFIX_LEN) return null;
  // The prefix is fixed-width, so the delimiter must sit at exactly this index.
  // Checking it explicitly keeps the shape strict: without it, a token whose
  // 9th char is part of the secret would still parse.
  if (afterVendor[DEVPILOT_KEY_PREFIX_LEN] !== "_") return null;

  const secret = afterVendor.slice(DEVPILOT_KEY_PREFIX_LEN + 1);
  if (secret.length === 0) return null;

  // `cleartext` is returned unchanged and in full: the stored hash is sha256 over
  // the ENTIRE key, so any normalisation here would break every issued key.
  return { vendor, prefix, cleartext };
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Constant-time hex string compare. Both inputs must be the same length;
 * mismatched lengths return false WITHOUT timingSafeEqual (which would
 * itself throw).
 */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Look up an API key by Authorization header. Returns the owning tenant_id
 * + scope on success; an error shape on failure.
 *
 * Order of operations:
 *   1. Parse the header. Bad shape → 401.
 *   2. Look up rows by prefix (cheap, indexed). Zero matches → 401.
 *   3. Hash the presented cleartext and constant-time-compare against EACH
 *      candidate row's hash. (Prefix isn't a uniqueness constraint — a
 *      collision is astronomically unlikely but we don't depend on its
 *      absence.)
 *   4. Filter on `revoked_at IS NULL` before declaring success.
 *   5. Best-effort touch `last_used_at` (fire-and-forget; auth result does
 *      NOT block on this write).
 */
export async function resolveApiKey(request: Request): Promise<ApiKeyAuthResult> {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  const parsed = parseAuthorizationHeader(header);
  if (!parsed) {
    return { ok: false, status: 401, reason: "missing or malformed Authorization header" };
  }

  const supabase = supabaseService();
  const { data: candidates, error } = await supabase
    .from("api_keys")
    .select("id, tenant_id, name, hash, prefix, scope, agent_id, revoked_at")
    .eq("prefix", parsed.prefix);
  if (error) {
    return { ok: false, status: 401, reason: "lookup failed" };
  }
  if (!candidates || candidates.length === 0) {
    return { ok: false, status: 401, reason: "unknown key" };
  }

  const presentedHash = sha256(parsed.cleartext);
  // Walk all candidates so a single matching row is still constant-time
  // relative to the candidate set (very small in practice — prefix is 8 hex).
  let match: (typeof candidates)[number] | null = null;
  for (const row of candidates) {
    if (constantTimeHexEqual(row.hash as string, presentedHash)) {
      match = row;
      // Don't break — keep the loop work uniform. (n is tiny.)
    }
  }
  if (!match) {
    return { ok: false, status: 401, reason: "bad key" };
  }
  if (match.revoked_at) {
    return { ok: false, status: 401, reason: "key revoked" };
  }

  // Best-effort touch. We don't await; the auth path returns immediately.
  void supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", match.id)
    .then(() => undefined);

  return {
    ok: true,
    key: {
      id: match.id as string,
      tenantId: match.tenant_id as string,
      scope: (match.scope as ApiKeyScope) ?? "api",
      agentId: (match.agent_id as string | null) ?? null,
      name: match.name as string,
      prefix: match.prefix as string,
    },
  };
}

/**
 * Require a key with scope `'api'` (full surface). Widget tokens are 403.
 */
export async function requireApiKey(request: Request): Promise<ApiKeyAuthResult> {
  const res = await resolveApiKey(request);
  if (!res.ok) return res;
  if (res.key.scope !== "api") {
    return { ok: false, status: 403, reason: "widget tokens cannot access /v1/agents" };
  }
  return res;
}
