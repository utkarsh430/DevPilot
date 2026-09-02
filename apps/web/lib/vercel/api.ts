// The Vercel transport: one `vercelFetch` every call goes through, plus the
// PR-1 read calls and the preflight gatherer built on it.
//
// This file has NO `server-only` marker and NO credential resolution, and that
// is deliberate: the fetch is INJECTED, so the whole transport — including
// error classification against real wire shapes and the teamId threading — is
// unit-testable without a network and without Next's server runtime. The
// `server-only` twin (`api.server.ts`) does exactly one thing: resolve the
// credential from platform-secrets and default the fetch to global. Same split
// as `lib/learning/write.ts` vs its action wrapper.
//
// ── The one rule for adding an endpoint in PRs 2-5 ─────────────────────────
// Call `vercelFetch` with a spec from `client.ts`. Never build a URL, never
// attach an Authorization header, never touch `teamId`, and never log a body.
// `POST /v10/projects/{id}/env` bodies are entirely secret values.

import {
  buildVercelRequest,
  logSafePath,
  specCreateDeployment,
  specCreateProject,
  specGetDeployment,
  specGetProject,
  specGetTeam,
  specGetUser,
  specGitNamespaces,
  specListDeployments,
  specListProjectEnv,
  specListProjects,
  specPromoteDeployment,
  specRollbackDeployment,
  specUpdateProject,
  specUpsertProjectEnv,
  type VercelCredential,
  type VercelRequestSpec,
} from "@/lib/vercel/client";
import {
  buildProductionGitPolicy,
  interpretProductionAutoDeploy,
  type ProductionAutoDeploy,
} from "@/lib/vercel/deploy-policy";
import {
  boundMessage,
  classifyVercelError,
  networkVercelError,
  VercelApiError,
  type VercelErrorKind,
} from "@/lib/vercel/errors";
import type { VercelCredentialSource } from "@/lib/vercel/connection";
import {
  buildTokenExchangeRequest,
  parseTokenExchangeResponse,
  type VercelOAuthToken,
} from "@/lib/vercel/oauth";
import {
  parseDeployment,
  parseDeploymentIds,
  parseEnvVars,
  parseGitNamespaces,
  parseProject,
  parseProjectList,
  parseTeam,
  parseUser,
  type VercelDeployment,
  type VercelEnvVar,
  type VercelGitNamespace,
  type VercelProject,
  type VercelTeam,
  type VercelUser,
} from "@/lib/vercel/types";
import { DEVPILOT_ENV_COMMENT, type EnvPushTarget } from "@/lib/vercel/env-plan";
import { evaluatePreflight, type PreflightReport } from "@/lib/vercel/preflight";

/** The subset of `fetch` we depend on. Narrowed so a test double is a few lines
 *  rather than a full `fetch` implementation. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type VercelClientOptions = {
  credential: VercelCredential;
  fetchImpl: FetchLike;
  /** Per-request timeout. Vercel is normally fast; a preflight that hangs is
   *  worse than one that fails, because the operator cannot tell it apart from
   *  a slow page. */
  timeoutMs?: number;
  /**
   * Extra scrubber needles for THIS call.
   *
   * The token is always a needle. This exists for the one call whose BODY is
   * also secret — the env var push. Vercel echoes request context back in
   * rejection messages often enough that this is not hypothetical, and a
   * `VercelApiError.message` reaches the operator's screen and the server log.
   * Without this, `400 "invalid value <the secret>"` would print the secret.
   *
   * Set by `pushVercelEnvVar`; callers do not need to think about it.
   */
  extraSecrets?: readonly string[];
};

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The single transport. Every Vercel call in this codebase goes through here.
 *
 * Returns the parsed JSON body on 2xx and THROWS a `VercelApiError` otherwise —
 * throwing rather than returning a result union because most callers have no
 * useful partial behaviour, and the preflight (which does) catches explicitly.
 *
 * Logging: status + the spec's PATH only. Never the URL (carries `teamId`),
 * never the headers (carry the token), never the body.
 */
export async function vercelFetch(
  spec: VercelRequestSpec,
  opts: VercelClientOptions,
): Promise<unknown> {
  return (await vercelFetchWithStatus(spec, opts)).body;
}

/**
 * The same transport, returning the STATUS alongside the body.
 *
 * Exists for the one PR-5 caller that must distinguish two success codes:
 * `POST .../promote/{id}` returns `201` when it starts the remap and `202` when
 * it QUEUES it behind an active rolling release — in which case production has
 * not moved at all. A client that treats every 2xx as done reports success for a
 * promotion that has not happened, which is the documented "silently no-ops"
 * failure of this endpoint.
 *
 * `vercelFetch` is the default and stays the shape every other caller uses;
 * there is no reason to thread a status through calls that have one success
 * code.
 */
export async function vercelFetchWithStatus(
  spec: VercelRequestSpec,
  opts: VercelClientOptions,
): Promise<{ status: number; body: unknown }> {
  const built = buildVercelRequest(spec, opts.credential);
  const path = logSafePath(spec);
  const secrets = [opts.credential.token, ...(opts.extraSecrets ?? [])];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await opts.fetchImpl(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body,
      signal: controller.signal,
    });
  } catch (cause) {
    throw networkVercelError({ cause, path, secrets });
  } finally {
    clearTimeout(timer);
  }

  // Parse defensively: an error response is not guaranteed to be JSON (a proxy
  // 502 is usually HTML), and a JSON parse failure must not mask the status.
  let body: unknown = null;
  try {
    const text = await res.text();
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    throw classifyVercelError({
      status: res.status,
      body,
      path,
      secrets,
      // A 403 can only mean "wrong scope" if a scope was configured. Passing
      // this is what keeps a dead token from being reported as a team-id
      // problem the operator does not have.
      teamConfigured: (opts.credential.teamId ?? "").trim().length > 0,
    });
  }
  return { status: res.status, body };
}

/** `GET /v2/user` — token validity + identity. */
export async function getVercelUser(opts: VercelClientOptions): Promise<VercelUser> {
  const body = await vercelFetch(specGetUser(), opts);
  const user = parseUser(body);
  if (!user) {
    throw new VercelApiError({
      kind: "malformed_response",
      status: 200,
      path: "/v2/user",
      message: "Vercel returned no identity for this token.",
    });
  }
  return user;
}

/** `GET /v2/teams/{id}` — confirms the configured team exists and is reachable. */
export async function getVercelTeam(
  teamId: string,
  opts: VercelClientOptions,
): Promise<VercelTeam> {
  const body = await vercelFetch(specGetTeam(teamId), opts);
  const team = parseTeam(body);
  if (!team) {
    throw new VercelApiError({
      kind: "malformed_response",
      status: 200,
      path: "/v2/teams",
      message: "Vercel returned no team for the configured VERCEL_TEAM_ID.",
    });
  }
  return team;
}

/** `GET /v1/integrations/git-namespaces?provider=github`.
 *
 *  An empty array is a MEANINGFUL result (the App is not installed), not a
 *  failure — which is why this returns `[]` rather than throwing, and why the
 *  gatherer below keeps `null` reserved for "the call failed". */
export async function getVercelGitNamespaces(
  opts: VercelClientOptions,
): Promise<VercelGitNamespace[]> {
  const body = await vercelFetch(specGitNamespaces(), opts);
  return parseGitNamespaces(body);
}

// ── PR 2: project link/create ───────────────────────────────────────────────

/** `GET /v10/projects` — the pick-list for linking an existing project. */
export async function listVercelProjects(
  opts: VercelClientOptions,
  args?: { search?: string; limit?: number },
): Promise<VercelProject[]> {
  const body = await vercelFetch(specListProjects(args), opts);
  return parseProjectList(body);
}

/** `GET /v9/projects/{idOrName}`. */
export async function getVercelProject(
  idOrName: string,
  opts: VercelClientOptions,
): Promise<VercelProject> {
  const body = await vercelFetch(specGetProject(idOrName), opts);
  const project = parseProject(body);
  if (!project) {
    throw new VercelApiError({
      kind: "malformed_response",
      status: 200,
      path: "/v9/projects",
      message: "Vercel returned no project for that id.",
    });
  }
  return project;
}

/** `POST /v11/projects` — create + link in one call. */
export async function createVercelProject(
  args: { name: string; repo: string; framework?: string | null },
  opts: VercelClientOptions,
): Promise<VercelProject> {
  const body = await vercelFetch(specCreateProject(args), opts);
  const project = parseProject(body);
  if (!project) {
    throw new VercelApiError({
      kind: "malformed_response",
      status: 200,
      path: "/v11/projects",
      message: "Vercel created something but returned no project id.",
    });
  }
  return project;
}

// ── PR 3: environment variables ─────────────────────────────────────────────

/** `GET /v10/projects/{id}/env` — everything Vercel currently holds for a
 *  project. Read-only; the reconciliation decides what to do with it. */
export async function listVercelProjectEnv(
  projectId: string,
  opts: VercelClientOptions,
): Promise<VercelEnvVar[]> {
  const body = await vercelFetch(specListProjectEnv(projectId), opts);
  return parseEnvVars(body);
}

/**
 * Push ONE variable.
 *
 * Deliberately one call per variable rather than Vercel's array form: a partial
 * failure then names the variable that failed, and the retry re-pushes only what
 * is missing. With a batched body a single rejected key fails the whole set and
 * the operator is told "the push failed" with no way to tell what landed.
 *
 * ⚠️ `value` is a secret. It appears in exactly one place — the request body
 * built by `specUpsertProjectEnv` — and must not be copied into a log line, an
 * error, or this function's return value. The return type carries the KEY only,
 * which is what makes that enforceable rather than aspirational.
 */
export async function pushVercelEnvVar(
  args: {
    projectId: string;
    key: string;
    value: string;
    targets: readonly EnvPushTarget[];
  },
  opts: VercelClientOptions,
): Promise<void> {
  await vercelFetch(
    specUpsertProjectEnv(args.projectId, {
      key: args.key,
      value: args.value,
      target: args.targets,
      // `sensitive` is only legal for production/preview, which is what
      // ENV_PUSH_TARGETS pins. See specUpsertProjectEnv.
      type: "sensitive",
      // The provenance marker the differing-value policy turns on.
      comment: DEVPILOT_ENV_COMMENT,
    }),
    // The value joins the token as a scrubber needle for this call ONLY. A
    // rejected push commonly echoes the offending value back, and that message
    // is rendered to the operator and written to the server log.
    { ...opts, extraSecrets: [...(opts.extraSecrets ?? []), args.value] },
  );
}

// ── PR 4: deployments ───────────────────────────────────────────────────────

/**
 * `POST /v13/deployments` — trigger a build.
 *
 * The `target` argument is passed straight to `specCreateDeployment`, which
 * emits the field only for production (see its comment: a preview request
 * carries no `target` key at all). Nothing else in this function can influence
 * which environment gets built.
 *
 * This is the only WRITE in the deploy path. Everything after it is polling.
 */
export async function createVercelDeployment(
  args: {
    name: string;
    projectId: string;
    org: string;
    repo: string;
    ref: string;
    target: "production" | "preview";
  },
  opts: VercelClientOptions,
): Promise<VercelDeployment> {
  const body = await vercelFetch(specCreateDeployment(args), opts);
  const deployment = parseDeployment(body);
  if (!deployment) {
    // A deployment may well have STARTED — Vercel returned 2xx. Say so rather
    // than implying nothing happened, because the operator's next move differs:
    // they need to look at the dashboard, not click deploy again.
    throw new VercelApiError({
      kind: "malformed_response",
      status: 200,
      path: "/v13/deployments",
      message:
        "Vercel accepted the deploy but returned no deployment id, so DevPilot cannot track it. " +
        "Check the Vercel dashboard before deploying again — a build may already be running.",
    });
  }
  return deployment;
}

/** `GET /v13/deployments/{id}` — one poll. */
export async function getVercelDeployment(
  deploymentId: string,
  opts: VercelClientOptions,
): Promise<VercelDeployment> {
  const body = await vercelFetch(specGetDeployment(deploymentId), opts);
  const deployment = parseDeployment(body);
  if (!deployment) {
    throw new VercelApiError({
      kind: "malformed_response",
      status: 200,
      path: "/v13/deployments",
      message: "Vercel returned no deployment for that id.",
    });
  }
  return deployment;
}

// ── PR 5: rollback and promote ──────────────────────────────────────────────

/**
 * `POST /v1/projects/{id}/rollback/{id}` — point production at a previous
 * deployment.
 *
 * Throws a `VercelApiError` on refusal, including `plan_required` for the `402`
 * that Vercel declares on this endpoint and not on promote. Callers surface that
 * kind specifically: "this needs a paid plan" and "your token is broken" look
 * identical to an operator and send them to opposite places.
 *
 * A `201` means the remap was ACCEPTED. It is asynchronous and per-alias, so the
 * caller re-reads the project's `lastAliasRequest` rather than treating the
 * response as proof production moved.
 */
export async function rollbackVercelDeployment(
  args: { projectId: string; deploymentId: string },
  opts: VercelClientOptions,
): Promise<{ status: number }> {
  const res = await vercelFetchWithStatus(
    specRollbackDeployment(args.projectId, args.deploymentId),
    opts,
  );
  return { status: res.status };
}

/**
 * `POST /v10/projects/{id}/promote/{id}` — promote, used only to UNDO a
 * rollback.
 *
 * ⚠️ NEVER add the Vercel CLI's fallback. When handed a non-production
 * deployment the CLI silently switches to `POST /v13/deployments` and rebuilds
 * it against production environment variables — a deploy wearing the word
 * "promote". The caller refuses a non-production target instead
 * (`classifyPromoteTarget`); there is no rebuild path here and there must not be
 * one.
 *
 * `202` is a real and DIFFERENT outcome from `201`: queued behind an active
 * rolling release, production unchanged. Returned rather than swallowed.
 */
export async function promoteVercelDeployment(
  args: { projectId: string; deploymentId: string },
  opts: VercelClientOptions,
): Promise<{ status: number; queued: boolean }> {
  const res = await vercelFetchWithStatus(
    specPromoteDeployment(args.projectId, args.deploymentId),
    opts,
  );
  return { status: res.status, queued: res.status === 202 };
}

/**
 * `GET /v7/deployments?…&rollbackCandidate=true` — Vercel's own eligible set.
 *
 * Read as a CROSS-CHECK against DevPilot's ledger, never as a replacement for it:
 * the ledger is what the card renders (it survives a Vercel outage and carries
 * DevPilot's own history), while this answers "does Vercel agree these are
 * candidates" — a rule Vercel owns and can change without our deploy.
 *
 * Returns `null` rather than throwing when the read fails, because a failed
 * cross-check must degrade to "unconfirmed", not remove the operator's only
 * rollback control.
 */
export async function listVercelRollbackCandidates(
  projectId: string,
  opts: VercelClientOptions,
): Promise<string[] | null> {
  try {
    const body = await vercelFetch(
      specListDeployments({
        projectId,
        target: "production",
        state: "READY",
        rollbackCandidate: true,
        limit: 20,
      }),
      opts,
    );
    return parseDeploymentIds(body);
  } catch {
    return null;
  }
}

/**
 * The outcome of asking Vercel to gate (or un-gate) git → production deploys.
 *
 * `applied` is NOT "the PATCH returned 200" — it is "we re-read the project and
 * Vercel's own response reports the state we asked for". That distinction is the
 * whole honesty mechanism of this PR: `deploymentPolicy` is in Vercel's OpenAPI
 * spec but undocumented, and this code was written without an account to test
 * against, so a 200 that quietly ignores the field is a real possibility. When
 * the read-back disagrees, `applied` is false and the caller MUST surface that
 * rather than reporting success.
 */
export type SetProductionAutoDeployResult = {
  applied: boolean;
  /** The state Vercel reports AFTER the attempt. */
  state: ProductionAutoDeploy;
  /** The project as re-read, for the caller's snapshot fields. */
  project: VercelProject | null;
  /** Present when the attempt or the read-back failed outright. */
  error: VercelApiError | null;
};

/**
 * Ask Vercel to enable/disable git-triggered PRODUCTION deploys for one repo,
 * then verify by reading the project back.
 *
 * Never throws: a failure here must degrade to a loud, specific warning on the
 * card, not a 500 that leaves the operator with a linked project and no idea
 * what state production is in.
 */
export async function setProductionGitAutoDeploy(
  args: { projectId: string; org: string; repo: string; enabled: boolean },
  opts: VercelClientOptions,
): Promise<SetProductionAutoDeployResult> {
  const patch = buildProductionGitPolicy({
    org: args.org,
    repo: args.repo,
    enabled: args.enabled,
  });

  let error: VercelApiError | null = null;
  try {
    await vercelFetch(specUpdateProject(args.projectId, patch), opts);
  } catch (err) {
    error = asVercelError(err, "/v9/projects");
  }

  // Read back REGARDLESS of whether the PATCH reported success. A PATCH that
  // errored may still have applied, and one that succeeded may have ignored the
  // field; only the read-back is evidence.
  let project: VercelProject | null = null;
  try {
    project = await getVercelProject(args.projectId, opts);
  } catch (err) {
    return {
      applied: false,
      state: "unknown",
      project: null,
      error: error ?? asVercelError(err, "/v9/projects"),
    };
  }

  const state = interpretProductionAutoDeploy(project.raw);
  const want: ProductionAutoDeploy = args.enabled ? "armed" : "gated";
  return { applied: state === want, state, project, error };
}

function asVercelError(err: unknown, path: string): VercelApiError {
  if (err instanceof VercelApiError) return err;
  return networkVercelError({ cause: err, path });
}

// ── PR 3: the OAuth code → access token exchange ────────────────────────────

/**
 * Exchange an install `code` for a long-lived access token.
 *
 * Deliberately does NOT go through `vercelFetch`. That transport's whole
 * contract is "the credential is in the Authorization header, so the URL and
 * the body are safe to log" — and this request is the one exception in the
 * codebase: its BODY carries the client secret, and its RESPONSE carries the
 * access token. Routing it through `vercelFetch` would mean silently violating
 * that transport's stated invariant, so it is a separate function whose comment
 * says why.
 *
 * ── Leak surface, and how each is closed ─────────────────────────────────
 *   * the request body        — never logged, never attached to an error, and
 *                               never returned. It exists only inside this call.
 *   * a thrown fetch error    — Node's fetch errors can echo request context, so
 *                               `networkVercelError` is given BOTH the secret
 *                               and the code as needles.
 *   * Vercel's error body     — echoed into the operator-facing message by
 *                               `classifyVercelError`, so it gets the same
 *                               needles. A rejected exchange commonly repeats
 *                               the parameters back.
 *   * the 200 response body   — the token itself. It is parsed and RETURNED,
 *                               never logged, and on a malformed 200 the error
 *                               message is a fixed string rather than anything
 *                               derived from the body.
 *
 * Never throws for a protocol-level rejection: returns a result union, because
 * the caller (a browser-facing callback route) must render a specific reason
 * rather than a 500.
 */
export async function exchangeVercelOAuthCode(
  args: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  },
  opts: { fetchImpl: FetchLike; timeoutMs?: number },
): Promise<{ ok: true; token: VercelOAuthToken } | { ok: false; error: VercelApiError }> {
  const req = buildTokenExchangeRequest(args);
  // The path we report is the endpoint only. `VERCEL_OAUTH_TOKEN_URL` carries no
  // query string, but naming it explicitly keeps the "never log a built URL"
  // habit intact for anyone adding a parameter later.
  const path = "/v2/oauth/access_token";
  const secrets = [args.clientSecret, args.code];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await opts.fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
  } catch (cause) {
    return { ok: false, error: networkVercelError({ cause, path, secrets }) };
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    const text = await res.text();
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    const classified = classifyVercelError({ status: res.status, body, path, secrets });
    // A rejected EXCHANGE is not a rejected API call: at this point there is no
    // token to be invalid, so "mint a new token" — what `unauthorized` says — is
    // advice for a problem the operator does not have. The overwhelmingly likely
    // causes are a reused/expired code or a redirect-URI mismatch, and the
    // exchange-specific wording names both.
    const remapped =
      classified.kind === "unauthorized" ||
      classified.kind === "forbidden_scope" ||
      classified.kind === "invalid_request"
        ? new VercelApiError({
            kind: "oauth_exchange_failed",
            status: res.status,
            code: classified.code,
            path,
            // Rebuilt from the already-scrubbed classified message rather than
            // from the raw body — one scrubbing pass, one place it can be
            // forgotten.
            message: describeExchangeFailure(classified.message),
          })
        : classified;
    return { ok: false, error: remapped };
  }

  const token = parseTokenExchangeResponse(body);
  if (!token) {
    return {
      ok: false,
      error: new VercelApiError({
        kind: "malformed_response",
        status: res.status,
        path,
        // Fixed string. NOTHING derived from this body may appear here — the
        // body is (or was meant to be) the access token.
        message: "Vercel accepted the installation but returned no access token.",
      }),
    };
  }
  return { ok: true, token };
}

function describeExchangeFailure(scrubbedDetail: string): string {
  return boundMessage(
    `Vercel refused to exchange the installation for an access token. The code is single-use and expires after 30 minutes, so the usual cause is a retried or stale callback — start the connection again. If it repeats, check that the Redirect URL registered in the Vercel Integration Console exactly matches this instance's callback URL. (${scrubbedDetail})`,
  );
}

export type PreflightConfig = {
  /** Absent/empty means no token is configured — reported as such, and no call
   *  is attempted. */
  token: string | null;
  teamId: string | null;
  gitNamespace: string | null;
  /** HOW the credential arrived: a "Connect Vercel" install, or a token pasted
   *  into the settings field. Optional so a caller that predates PR 3 still
   *  compiles; absent is reported as `pasted` when a token exists, which is
   *  what such a caller means. Reported to the operator because the whole point
   *  of connecting is to stop handling tokens by hand — they should be able to
   *  see that the connection is real, and see when a paste is being shadowed by
   *  one. */
  source?: VercelCredentialSource;
  /** Whether a pasted VERCEL_TOKEN exists REGARDLESS of which credential won.
   *  Feeds the shadowing row in the report; never a value. */
  pastedTokenConfigured?: boolean;
};

/** Kinds where continuing to the next call is pointless: the token itself is
 *  the problem, so every downstream call would fail identically and the extra
 *  requests would only add noise (and rate-limit pressure) to the report. */
const FATAL_TOKEN_KINDS: ReadonlySet<VercelErrorKind> = new Set<VercelErrorKind>(["unauthorized"]);

/**
 * Gather everything the preflight needs and evaluate it.
 *
 * Never throws — a preflight that throws is a settings page that 500s, which is
 * strictly worse than one reporting "could not check". Every call is caught and
 * routed into the corresponding `*Error` input so the pure rules can turn it
 * into a specific, remediable line.
 */
export async function runVercelPreflight(args: {
  config: PreflightConfig;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}): Promise<PreflightReport> {
  const token = (args.config.token ?? "").trim();
  const teamId = (args.config.teamId ?? "").trim() || null;
  const gitNamespace = (args.config.gitNamespace ?? "").trim() || null;

  const source: VercelCredentialSource =
    args.config.source ?? (token.length > 0 ? "pasted" : "none");

  if (token.length === 0) {
    return evaluatePreflight({
      credentialSource: source,
      tokenConfigured: false,
      pastedTokenConfigured: args.config.pastedTokenConfigured === true,
      configuredTeamId: teamId,
      configuredNamespace: gitNamespace,
      user: null,
      userError: null,
      team: null,
      teamError: null,
      namespaces: null,
      namespacesError: null,
    });
  }

  const opts: VercelClientOptions = {
    credential: { token, teamId },
    fetchImpl: args.fetchImpl,
    timeoutMs: args.timeoutMs,
  };

  let user: VercelUser | null = null;
  let userError: VercelApiError | null = null;
  try {
    user = await getVercelUser(opts);
  } catch (err) {
    userError = asVercelError(err, "/v2/user");
  }

  const tokenIsDead = userError !== null && FATAL_TOKEN_KINDS.has(userError.kind);

  let team: VercelTeam | null = null;
  let teamError: VercelApiError | null = null;
  if (teamId && !tokenIsDead) {
    try {
      team = await getVercelTeam(teamId, opts);
    } catch (err) {
      teamError = asVercelError(err, "/v2/teams");
    }
  }

  let namespaces: VercelGitNamespace[] | null = null;
  let namespacesError: VercelApiError | null = null;
  if (!tokenIsDead) {
    try {
      namespaces = await getVercelGitNamespaces(opts);
    } catch (err) {
      namespacesError = asVercelError(err, "/v1/integrations/git-namespaces");
    }
  }

  return evaluatePreflight({
    credentialSource: source,
    tokenConfigured: true,
    pastedTokenConfigured: args.config.pastedTokenConfigured === true,
    configuredTeamId: teamId,
    configuredNamespace: gitNamespace,
    user,
    userError,
    team,
    teamError,
    namespaces,
    namespacesError,
  });
}
