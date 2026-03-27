// SSRF-safe validation for an operator-supplied LLM base URL.
//
// WHY THIS EXISTS. `projects.llm_base_url` is a user-controlled string that the
// SERVER dereferences: every provider call is a server-side fetch to it, from
// inside our network, with our egress identity. That is the textbook SSRF
// primitive — point it at `http://169.254.169.254/…` and the "LLM response" is
// the instance's cloud credentials; point it at `http://10.0.0.5:6379` and it's
// a port-scanner. The generic `parseHttpUrl` in lib/setup/validators.ts is
// scheme-only and nowhere near sufficient for this.
//
// The controls, in order of what they actually buy:
//
//   1. https only. The single exception is an explicit, opt-in localhost dev
//      allowlist (Ollama's default is `http://localhost:11434`), which is off
//      unless the operator sets DEVPILOT_LLM_ALLOW_LOCAL_BASE_URL.
//   2. No credentials in the URL (`https://user:pass@host`) — those get sent
//      somewhere we didn't intend and land in logs.
//   3. No query / no fragment. We append paths to this origin; a `?` or `#` in
//      the stored value silently rewrites the request we think we're making.
//   4. THE LOAD-BEARING ONE: the host is resolved and EVERY resulting address
//      must be a public unicast IP. Checking the hostname string is theatre —
//      `evil.com` can have an A record of 127.0.0.1. This check runs at WRITE
//      time (so a bad URL can never persist) AND again at CALL time (so a
//      record that turns malicious later still doesn't get dereferenced).
//   5. An optional hostname allowlist (DEVPILOT_LLM_BASE_URL_ALLOWLIST) for
//      operators who want to pin to a known set of endpoints.
//
// This file is the PURE half — scheme/credential/shape checks and the IP-range
// predicates. The DNS resolution lives in `base-url.server.ts`, which is what
// both the write path (the Zod schema in the project actions) and the call path
// (the provider factory) actually call.
//
// KNOWN RESIDUAL: resolve-then-fetch is a TOCTOU window — a rebinding attacker
// can flip the record between our check and Node's connect. Closing it fully
// needs a pinned-IP custom dispatcher, which is a bigger change than this WI
// carries; the write-time rejection plus the call-time re-check means an
// attacker has to win a sub-second race on EVERY call, and the stored value is
// still rejected outright. Documented, not forgotten.

/** Ports are deliberately NOT restricted. Self-hosted gateways legitimately sit
 *  on 4000/8000/8443, and the resolved-IP check already makes internal-port
 *  scanning impossible — the only thing a port restriction would add is friction
 *  against legitimate users. */

export type BaseUrlRejection =
  | "empty"
  | "unparseable"
  | "bad_scheme"
  | "http_not_allowed"
  | "credentials_in_url"
  | "query_or_fragment"
  | "no_host"
  | "private_host"
  | "not_allowlisted"
  | "private_address";

export type BaseUrlCheck =
  | { ok: true; url: URL; normalized: string }
  | { ok: false; reason: BaseUrlRejection; message: string };

export const BASE_URL_MAX = 300;

export type BaseUrlPolicy = {
  /** Permit `http://` + a loopback host. Dev only (Ollama on localhost). */
  allowLocal: boolean;
  /** When non-empty, the hostname must match one of these (exact, or a
   *  `.suffix` match). Empty = any host that passes the IP checks. */
  hostAllowlist: readonly string[];
};

export const DEFAULT_BASE_URL_POLICY: BaseUrlPolicy = { allowLocal: false, hostAllowlist: [] };

/** Hostnames that name something inside the network by convention. Checked as a
 *  cheap pre-filter — the resolved-IP check is what actually enforces this, but
 *  rejecting these by name gives the operator a far better error message and
 *  covers hosts that don't resolve for us at all. */
const PRIVATE_HOST_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa"] as const;
const PRIVATE_HOST_EXACT = ["localhost", "metadata", "metadata.google.internal"] as const;

/** Loopback hosts the dev allowlist permits over plain http. */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"] as const;

export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (LOCAL_HOSTS as readonly string[]).includes(h) || h.endsWith(".localhost");
}

function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if ((PRIVATE_HOST_EXACT as readonly string[]).includes(h)) return true;
  return PRIVATE_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

function matchesAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return allowlist.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry.length === 0) return false;
    if (entry.startsWith(".")) return h.endsWith(entry);
    return h === entry;
  });
}

/**
 * Shape + policy checks. Everything that can be decided WITHOUT a DNS lookup.
 * `base-url.server.ts` runs this first, then resolves the host — so a malformed
 * URL never even reaches the resolver.
 */
export function checkLlmBaseUrl(
  raw: string,
  policy: BaseUrlPolicy = DEFAULT_BASE_URL_POLICY,
): BaseUrlCheck {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty", message: "Base URL is required for this provider." };
  }
  if (trimmed.length > BASE_URL_MAX) {
    return {
      ok: false,
      reason: "unparseable",
      message: `Base URL must be ≤ ${BASE_URL_MAX} characters.`,
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: "unparseable",
      message: "That isn't a valid URL — expected something like https://api.example.com/v1",
    };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      reason: "bad_scheme",
      message: "Base URL must be https:// (http:// is only allowed for a localhost dev endpoint).",
    };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return {
      ok: false,
      reason: "credentials_in_url",
      message:
        "Don't put credentials in the URL. Enter the API key in the key field — it's stored encrypted.",
    };
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return {
      ok: false,
      reason: "query_or_fragment",
      message: "Base URL can't carry a query string or fragment — give the bare endpoint.",
    };
  }
  if (url.hostname.length === 0) {
    return { ok: false, reason: "no_host", message: "Base URL has no host." };
  }

  const local = isLocalHostname(url.hostname);
  if (url.protocol === "http:" && !(policy.allowLocal && local)) {
    return {
      ok: false,
      reason: "http_not_allowed",
      message: policy.allowLocal
        ? "Plain http:// is only allowed for localhost. Use https:// for any other host."
        : "Base URL must use https://. (A localhost http:// endpoint needs DEVPILOT_LLM_ALLOW_LOCAL_BASE_URL=1.)",
    };
  }
  // A local host is only ever acceptable under the explicit dev allowlist —
  // including over https, where the resolved-IP check below would otherwise be
  // the only thing stopping it.
  if (local && !policy.allowLocal) {
    return {
      ok: false,
      reason: "private_host",
      message:
        "That points at this server itself. Set DEVPILOT_LLM_ALLOW_LOCAL_BASE_URL=1 to allow a local endpoint (dev only).",
    };
  }
  if (!local && isPrivateHostname(url.hostname)) {
    return {
      ok: false,
      reason: "private_host",
      message: "That hostname names an internal network address, which isn't allowed.",
    };
  }
  if (policy.hostAllowlist.length > 0 && !matchesAllowlist(url.hostname, policy.hostAllowlist)) {
    return {
      ok: false,
      reason: "not_allowlisted",
      message: `This instance only allows LLM endpoints on: ${policy.hostAllowlist.join(", ")}.`,
    };
  }

  // Normalise: origin + path, no trailing slash, no query/fragment (already
  // rejected). This is what we persist, so the stored value is exactly what we
  // later dereference — no surprises from a re-parse.
  const path = url.pathname.replace(/\/+$/, "");
  const normalized = `${url.origin}${path}`;
  return { ok: true, url, normalized };
}

// ─── IP range predicates (the load-bearing check) ───────────────────────────

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isBlockedIpv4(o: number[]): boolean {
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — incl. 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

/** 16 bytes, or null when `host` isn't a valid IPv6 literal. Handles `::`
 *  compression and a trailing embedded IPv4 (`::ffff:127.0.0.1`). */
function parseIpv6(host: string): number[] | null {
  let s = host.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  // Drop a zone id (fe80::1%eth0) — the address itself is what we judge.
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(":")) return null;

  // An embedded IPv4 tail becomes two 16-bit groups.
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIpv4(maybeV4);
    if (!v4) return null;
    tail = v4;
    s = s.slice(0, lastColon + 1) + "0:0";
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      const n = parseInt(g, 16);
      out.push((n >> 8) & 0xff, n & 0xff);
    }
    return out;
  };
  const head = toGroups(halves[0] ?? "");
  const rest = toGroups(halves[1] ?? "");
  if (head === null || rest === null) return null;

  let bytes: number[];
  if (halves.length === 2) {
    const fill = 16 - head.length - rest.length;
    if (fill < 0) return null;
    bytes = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    bytes = [...head, ...rest];
  }
  if (tail.length === 4) {
    // The "0:0" placeholder we substituted occupies the last 4 bytes.
    bytes = [...bytes.slice(0, 12), ...tail];
  }
  return bytes.length === 16 ? bytes : null;
}

function isBlockedIpv6(b: number[]): boolean {
  const allZero = b.every((x) => x === 0);
  if (allZero) return true; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — judge the embedded v4,
  // or `::ffff:169.254.169.254` walks straight past every check above.
  const v4Mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  const v4Compat = b.slice(0, 12).every((x) => x === 0);
  if (v4Mapped || v4Compat) return isBlockedIpv4(b.slice(12));
  // 64:ff9b::/96 NAT64 embeds an IPv4 destination in the low 32 bits.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return isBlockedIpv4(b.slice(12));
  }
  // 2002::/16 6to4 embeds the IPv4 in bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIpv4(b.slice(2, 6));
  return false;
}

/**
 * Is this resolved address one we refuse to talk to? FAIL-CLOSED: an address we
 * can't parse is treated as blocked. A resolver only ever hands us well-formed
 * addresses, so "unparseable" here means something is wrong, and the safe answer
 * to "should I connect to something I don't understand" is no.
 */
export function isBlockedIp(ip: string): boolean {
  const v4 = parseIpv4(ip.trim());
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(ip);
  if (v6) return isBlockedIpv6(v6);
  return true;
}

/** Every resolved address must be public. One bad address is enough to reject:
 *  a host with both a public and a private A record is a rebinding setup, and
 *  which one Node's connect picks is not ours to bet on. */
export function allAddressesPublic(addresses: readonly string[]): boolean {
  if (addresses.length === 0) return false; // resolved to nothing → don't dereference
  return addresses.every((a) => !isBlockedIp(a));
}
