// Vercel API error types + the scrubber that keeps the token out of everything
// we surface. Pure — no fetch, no server-only, no I/O.
//
// ── Why scrubbing is not optional ──────────────────────────────────────────
// A Vercel error body is not a fixed shape. It can echo request context, and an
// operator-facing string here ends up in three places that are readable by
// people who must not see the credential: our server logs, the settings UI, and
// (from PR 4 onward) a ticket comment on a board an agent can also read. The
// token is in the `Authorization` header — which we never render — but "never
// rendered today" is a property of today's code, not an invariant. So every
// string that leaves this module is passed through `scrubSecrets` with the live
// token as a needle, plus a small set of shape-based patterns that catch a
// token we were not handed (an operator pasting one into a description, a
// different token echoed back by Vercel).
//
// The scrubber is deliberately conservative about false positives: replacing a
// harmless-looking string with `[redacted]` costs an operator a little clarity;
// missing a real one costs them the account.

/** How we classify a failed call, for message selection and for callers that
 *  need to branch (preflight distinguishes "bad token" from "network down"). */
export type VercelErrorKind =
  | "unauthorized" // 401/403 — token invalid, expired, or wrong scope
  | "forbidden_scope" // 403 that reads as a team/scope mismatch specifically
  | "integration_disabled" // 403 integration_configuration_disabled — see below
  | "oauth_exchange_failed" // the code→token exchange itself was rejected
  | "not_found" // 404
  | "git_integration_missing" // the 400 telling us the Vercel GitHub App is absent
  | "rate_limited" // 429
  | "plan_required" // 402 — the paid-plan gate. See below.
  | "conflict" // 409 — e.g. a project name already taken
  | "invalid_request" // other 4xx
  | "server_error" // 5xx
  | "network" // fetch threw: DNS, TLS, timeout, offline
  | "malformed_response"; // 2xx whose body was not the JSON shape we require

export class VercelApiError extends Error {
  readonly kind: VercelErrorKind;
  /** HTTP status, or null when the request never completed. */
  readonly status: number | null;
  /** Vercel's own machine-readable `error.code`, when present. */
  readonly code: string | null;
  /** Endpoint path only — never the query string, which carries `teamId` and
   *  could carry more later. */
  readonly path: string;

  constructor(args: {
    kind: VercelErrorKind;
    status?: number | null;
    code?: string | null;
    path: string;
    message: string;
  }) {
    super(args.message);
    this.name = "VercelApiError";
    this.kind = args.kind;
    this.status = args.status ?? null;
    this.code = args.code ?? null;
    this.path = args.path;
  }
}

/** Patterns for credential-shaped substrings we redact even when we were not
 *  given the value. Ordered longest-context-first so a `Bearer <tok>` is
 *  replaced as a unit rather than leaving a bare `Bearer`. */
const SECRET_PATTERNS: readonly RegExp[] = [
  // `Authorization: Bearer abc…` — the `bearer` keyword is OPTIONAL and must be
  // consumed by this pattern rather than being matched as the value. Getting
  // that wrong redacts the word "Bearer" and leaves the token in place, which
  // is worse than not scrubbing at all because the output LOOKS redacted.
  /\bauthorization\s*[:=]\s*(?:bearer\s+)?\S+/gi,
  /\bbearer\s+\S+/gi,
  // `token=abc…` / `"token":"abc…"` in any echoed context.
  /\b(token|api[_-]?key|secret)"?\s*[:=]\s*"?[A-Za-z0-9._~+/-]{8,}"?/gi,
  // Vercel's own token prefixes (project- and team-scoped tokens).
  /\bvc[apt]_[A-Za-z0-9]{8,}\b/g,
];

/**
 * Remove credential material from a string before it is logged or shown.
 *
 * `needles` are exact values we hold (the live token). They are removed first
 * and unconditionally — that is the reliable half. The pattern pass is the
 * defence-in-depth half for values we were never handed.
 *
 * A needle shorter than 8 characters is IGNORED: a 3-character "token" would
 * match inside ordinary prose and turn the whole message into redaction noise,
 * and no real credential is that short.
 */
export function scrubSecrets(
  text: string,
  needles: readonly (string | null | undefined)[],
): string {
  let out = text;
  for (const needle of needles) {
    if (typeof needle !== "string") continue;
    const n = needle.trim();
    if (n.length < 8) continue;
    out = out.split(n).join("[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

/** Bound an operator-facing message so an enormous echoed body can't flood a
 *  log line or a UI card. Applied after scrubbing, never before — truncating
 *  first could cut a needle in half and defeat the exact-match pass. */
export function boundMessage(text: string, max = 500): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Vercel's error envelope, as much of it as we rely on. */
type VercelErrorBody = { error?: { code?: unknown; message?: unknown } };

function readErrorBody(body: unknown): { code: string | null; message: string | null } {
  if (typeof body !== "object" || body === null) return { code: null, message: null };
  const err = (body as VercelErrorBody).error;
  if (typeof err !== "object" || err === null) return { code: null, message: null };
  const code = typeof err.code === "string" ? err.code : null;
  const message = typeof err.message === "string" ? err.message : null;
  return { code, message };
}

/** The exact 400 Vercel returns when the Vercel-for-GitHub App is not installed.
 *  Matched on substring rather than the code because the code has varied across
 *  API versions while this sentence has not. Recognising it is what turns a
 *  confusing 400 into an actionable "install the GitHub App" banner. */
function isGitIntegrationMissing(message: string | null, code: string | null): boolean {
  const m = (message ?? "").toLowerCase();
  if (m.includes("install the github integration")) return true;
  if (m.includes("github integration first")) return true;
  return code === "missing_git_integration" || code === "not_connected_github_account";
}

/** Does this 403 read as a team/scope mismatch rather than a dead token? The
 *  distinction matters for the operator: one means "fix VERCEL_TEAM_ID", the
 *  other means "mint a new token", and telling them the wrong one sends them
 *  down a long dead end.
 *
 *  `teamConfigured` is the load-bearing half and was learned the hard way: a
 *  revoked token returns `403 "Not authorized"`, whose wording is
 *  indistinguishable from a scope failure. Classifying on the message alone
 *  told an operator with NO team configured to "check VERCEL_TEAM_ID" — advice
 *  about a setting they had correctly left blank, for a problem that was
 *  actually a dead token. A scope mismatch is only POSSIBLE when a scope was
 *  configured, so requiring that first makes the wrong diagnosis unreachable.
 *  (Caught by `scripts/vercel-accept.mjs` against the real API; no fixture-based
 *  test would have surfaced it, because the fixture would have been invented
 *  with the shape the code already expected.) */
function isScopeMismatch(message: string | null, teamConfigured: boolean): boolean {
  if (!teamConfigured) return false;
  const m = (message ?? "").toLowerCase();
  return m.includes("do not have permission") || m.includes("not authorized") || m.includes("team");
}

/**
 * The 403 that only exists on the OAuth credential path.
 *
 * Vercel disables an integration CONFIGURATION when the developer who installed
 * it loses access to the team it was installed on. Every subsequent API call
 * then returns `403 integration_configuration_disabled`. PR 1 deliberately did
 * not handle this because a pasted personal token can never produce it — with
 * "Connect Vercel" it is reachable, so it is handled now.
 *
 * It MUST be classified apart from `unauthorized`. The two are indistinguishable
 * by status and nearly so by wording, but the remedies are opposites: a dead
 * token means "mint/reconnect a credential", while a disabled configuration
 * means "the credential is fine — re-enable the installation on Vercel". Telling
 * an operator to reconnect here sends them into a loop that cannot succeed,
 * because a fresh install of a disabled configuration is not what the dashboard
 * toggle does.
 *
 * It is also the one Vercel error with a DEADLINE attached: Vercel's docs state
 * that a configuration left disabled is removed after 30 days, and that
 * "any environment variables that were created by that integration will also be
 * removed — this may prevent new deployments from working". So the message says
 * so; a generic permissions error would let a clock run out silently.
 */
function isIntegrationDisabled(message: string | null, code: string | null): boolean {
  if (code === "integration_configuration_disabled") return true;
  const m = (message ?? "").toLowerCase();
  return m.includes("integration configuration") && m.includes("disabled");
}

function kindForStatus(
  status: number,
  message: string | null,
  code: string | null,
  teamConfigured: boolean,
): VercelErrorKind {
  if (isGitIntegrationMissing(message, code)) return "git_integration_missing";
  if (status === 401) return "unauthorized";
  if (status === 403) {
    // Ordered BEFORE the scope reading: a disabled configuration also matches
    // the loose "not authorized"/"team" wording `isScopeMismatch` looks for, and
    // reporting it as a team-id problem is the wrong-diagnosis failure that
    // classifier already exists to avoid.
    if (isIntegrationDisabled(message, code)) return "integration_disabled";
    return isScopeMismatch(message, teamConfigured) ? "forbidden_scope" : "unauthorized";
  }
  if (status === 402) return "plan_required";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "invalid_request";
}

/** Operator-facing wording per kind. Kept here, not at call sites, so a new
 *  endpoint in PR 2-5 inherits the same phrasing and the same scrubbing. */
function describe(kind: VercelErrorKind, detail: string | null): string {
  const suffix = detail ? ` (${detail})` : "";
  switch (kind) {
    case "unauthorized":
      return `Vercel rejected the token. It may be invalid, revoked, or expired — mint a new one and update VERCEL_TOKEN${suffix}`;
    case "forbidden_scope":
      return `Vercel refused this request for the configured scope. Check VERCEL_TEAM_ID: it must be empty for a personal account, or match the team the token was minted under${suffix}`;
    case "integration_disabled":
      return `The DevPilot integration is DISABLED on this Vercel account, so Vercel is refusing every request — the credential itself is fine, and reconnecting will not fix it. Re-enable it under Vercel ▸ Integrations ▸ DevPilot ▸ Manage. Vercel removes a configuration left disabled for 30 days and deletes the environment variables it created, which can break new deployments${suffix}`;
    case "oauth_exchange_failed":
      return `Vercel refused to exchange the installation for an access token. The code is single-use and expires after 30 minutes, so the usual cause is a retried or stale callback — start the connection again. If it repeats, check that the Redirect URL registered in the Vercel Integration Console exactly matches this instance's callback URL${suffix}`;
    case "git_integration_missing":
      return `The Vercel for GitHub App is not installed on the account this token belongs to. Install it, then re-run the check${suffix}`;
    case "plan_required":
      // ⚠️ This MUST NOT read as a permissions or credential failure. A 402 and a
      // 403 are indistinguishable to an operator looking at a red banner, and the
      // remedies could not be further apart: one is "upgrade the plan", the other
      // is "your token is broken". Reporting a plan gate as an auth failure sends
      // someone to rotate a perfectly good credential and conclude the feature is
      // broken when it is working exactly as Vercel intends.
      //
      // The only endpoint in this codebase that can produce a 402 is Instant
      // Rollback: Vercel declares `402` on `POST /v1/projects/{id}/rollback/{id}`
      // and NOT on promote, and the Hobby plan permits rolling back exactly one
      // step. So the wording names that specific limit rather than guessing.
      return `Vercel refused this because it needs a paid plan. On the Hobby plan you can roll back one step — to the immediately previous production deployment — and rolling back further requires Pro. Your Vercel credential is fine; nothing here is a permissions problem${suffix}`;
    case "not_found":
      return `Vercel returned 404 for this resource${suffix}`;
    case "conflict":
      return `Vercel reported a conflict${suffix}`;
    case "rate_limited":
      return `Vercel rate-limited this request. Wait a moment and retry${suffix}`;
    case "server_error":
      return `Vercel returned a server error. This is usually transient${suffix}`;
    case "network":
      return `Could not reach the Vercel API${suffix}`;
    case "malformed_response":
      return `The Vercel API returned an unexpected response shape${suffix}`;
    case "invalid_request":
      return `Vercel rejected the request${suffix}`;
  }
}

/**
 * Turn a non-2xx response into a `VercelApiError` with a scrubbed, bounded,
 * operator-actionable message.
 *
 * `secrets` are the values to redact — the caller passes the live token. The
 * detail we surface is Vercel's own message, which is the useful part, so it
 * MUST go through the scrubber; that is the whole reason this is one function
 * rather than a switch at each call site.
 */
export function classifyVercelError(args: {
  status: number;
  body: unknown;
  path: string;
  secrets?: readonly (string | null | undefined)[];
  /** Whether a VERCEL_TEAM_ID is configured. Gates the scope-mismatch reading
   *  of a 403 — see `isScopeMismatch`. Defaults to false, the conservative
   *  answer: "your token is dead" is never misleading advice, whereas "check
   *  your team id" is, when there is no team id. */
  teamConfigured?: boolean;
}): VercelApiError {
  const { code, message } = readErrorBody(args.body);
  const kind = kindForStatus(args.status, message, code, args.teamConfigured === true);
  const detail = message ? boundMessage(scrubSecrets(message, args.secrets ?? []), 240) : null;
  return new VercelApiError({
    kind,
    status: args.status,
    code,
    path: args.path,
    message: boundMessage(describe(kind, detail)),
  });
}

/** A fetch that threw (DNS/TLS/timeout/offline) rather than returning a status.
 *  The thrown error's message is scrubbed too — a Node fetch error can echo the
 *  full request URL, and a future endpoint may put more than `teamId` there. */
export function networkVercelError(args: {
  cause: unknown;
  path: string;
  secrets?: readonly (string | null | undefined)[];
}): VercelApiError {
  const raw = args.cause instanceof Error ? args.cause.message : String(args.cause);
  const detail = boundMessage(scrubSecrets(raw, args.secrets ?? []), 200);
  return new VercelApiError({
    kind: "network",
    status: null,
    path: args.path,
    message: boundMessage(describe("network", detail)),
  });
}
