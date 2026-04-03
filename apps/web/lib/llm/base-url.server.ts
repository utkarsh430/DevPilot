import "server-only";

// The DNS half of the SSRF guard. `base-url.ts` holds the pure shape/policy
// checks and the IP-range predicates; this module resolves the hostname and
// judges the ADDRESSES, which is the only check that actually holds — a
// hostname string tells you nothing about where the packet goes.
//
// Called in BOTH places, deliberately:
//
//   • WRITE time — the project actions' Zod refinement. A base URL that fails
//     here never reaches the database, so there is no such thing as a stored
//     bad value waiting to be dereferenced by some future code path that forgot
//     to check.
//   • CALL time — `buildProviderClient` (models-tenant.ts), before the provider
//     factory is handed the URL. This covers the case the write check can't: a
//     DNS record that was public when it was saved and points at 169.254.169.254
//     today.

import { lookup } from "node:dns/promises";
import {
  allAddressesPublic,
  checkLlmBaseUrl,
  type BaseUrlCheck,
  type BaseUrlPolicy,
} from "@/lib/llm/base-url";

/** Dev-only escape hatch for a localhost endpoint (Ollama's default is
 *  http://localhost:11434). OFF unless explicitly set — a production instance
 *  must never treat "points at me" as a valid LLM endpoint. */
function allowLocalBaseUrl(): boolean {
  const raw = (process.env.DEVPILOT_LLM_ALLOW_LOCAL_BASE_URL ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Optional hostname pin. Comma-separated; a leading dot matches subdomains
 *  (`.example.com`). Unset = any host that passes the address checks. */
function hostAllowlist(): string[] {
  return (process.env.DEVPILOT_LLM_BASE_URL_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function baseUrlPolicy(): BaseUrlPolicy {
  return { allowLocal: allowLocalBaseUrl(), hostAllowlist: hostAllowlist() };
}

export type ValidatedBaseUrl =
  | { ok: true; normalized: string }
  | { ok: false; reason: string; message: string };

/**
 * Full validation: pure checks, then resolve the host and require every returned
 * address to be public unicast.
 *
 * A resolution FAILURE is a rejection, not a pass. "I couldn't look it up" is
 * not evidence that it's safe, and letting an unresolvable host through would
 * hand an attacker a trivial bypass (break resolution for our resolver, keep it
 * working for the connect).
 *
 * The one exception is the localhost dev allowlist: `localhost` resolves to
 * 127.0.0.1, which the address check exists to reject. When the operator has
 * explicitly opted in AND the host is a loopback name, that's the intended
 * configuration, so we accept it after the pure checks and skip the address gate
 * — the pure check already proved it's a loopback name and nothing else.
 */
export async function validateLlmBaseUrl(
  raw: string,
  policy: BaseUrlPolicy = baseUrlPolicy(),
): Promise<ValidatedBaseUrl> {
  const shape: BaseUrlCheck = checkLlmBaseUrl(raw, policy);
  if (!shape.ok) return { ok: false, reason: shape.reason, message: shape.message };

  const host = shape.url.hostname;
  // Opted-in loopback: the pure check already established this is a local name
  // under an explicit allowlist. Resolving it would only re-derive 127.0.0.1 and
  // reject the thing we just decided to permit.
  if (policy.allowLocal && isLoopbackTarget(host)) {
    return { ok: true, normalized: shape.normalized };
  }

  let addresses: string[];
  try {
    const results = await lookup(host, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    return {
      ok: false,
      reason: "unresolvable",
      message: `Couldn't resolve ${host}. Check the hostname — an endpoint we can't resolve isn't one we'll call.`,
    };
  }

  if (!allAddressesPublic(addresses)) {
    return {
      ok: false,
      reason: "private_address",
      message: `${host} resolves to a private or reserved address, which isn't allowed (SSRF protection).`,
    };
  }
  return { ok: true, normalized: shape.normalized };
}

function isLoopbackTarget(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]"
  );
}
