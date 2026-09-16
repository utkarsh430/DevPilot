// The pure half of the Vercel client: request construction and response
// interpretation. NO fetch, NO server-only, NO credential resolution — all of
// that is `api.server.ts`. Everything here is a total function over plain data,
// which is what lets the request-shape guarantees below be asserted by tests
// that never touch a network.
//
// ── The teamId problem, and how the shape solves it ────────────────────────
// Every Vercel resource endpoint takes an OPTIONAL `teamId` QUERY parameter.
// Omit it and the call silently applies to the token's own default scope. That
// is the nastiest failure mode in this feature: nothing errors, the project is
// simply created somewhere else, and it stays invisible until someone opens the
// wrong dashboard and finds it empty. It is also the easiest mistake to make —
// one endpoint out of eight forgets a query param.
//
// So no call site ever passes `teamId`. `buildVercelRequest` reads it from the
// resolved credential and threads it centrally. What a call site MUST do is
// declare its `scope`, and that field is REQUIRED — omitting it is a compile
// error, so "forgot the team param" is not expressible. The two values:
//
//   "team"    — a resource call. `teamId` is threaded when configured.
//   "account" — an identity call (`/v2/user`, `/v2/teams/{id}`). These describe
//               the token holder rather than acting inside a scope, and
//               `/v2/user` in particular is what we use to establish what the
//               token IS. Threading a team id onto it would, on a mismatch,
//               turn "here is who you are" into a 403 and make the preflight
//               unable to tell a bad token from a bad team id — the exact
//               distinction the operator needs.
//
// `scope: "account"` is therefore a narrow, named exemption with a stated
// reason, not an escape hatch. PRs 2-5 add only `"team"` calls.

export const VERCEL_API_BASE = "https://api.vercel.com";

export type VercelRequestScope = "team" | "account";

export type VercelRequestSpec = {
  /** Path only, leading slash, no query string and no origin. */
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Required — see the header comment. Declares whether `teamId` applies. */
  scope: VercelRequestScope;
  /** Endpoint-specific query params. `undefined`/empty values are dropped so a
   *  caller never has to branch on an optional. `teamId` here is IGNORED — it
   *  comes from the credential; see `buildVercelRequest`. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON body. Serialised by `buildVercelRequest`. */
  body?: unknown;
};

export type VercelCredential = {
  token: string;
  /** Empty/absent means a personal (Hobby) account — the normal case for the
   *  dedicated-account setup this feature is built around. */
  teamId: string | null;
};

export type BuiltVercelRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

/** `teamId` is owned by the credential and must never be overridden by a call
 *  site — a per-call value would reintroduce exactly the drift the central
 *  threading exists to prevent. Stripped defensively rather than trusted. */
const RESERVED_QUERY_KEYS = new Set(["teamId", "slug"]);

/**
 * Build the absolute URL for a spec, threading `teamId` for `scope: "team"`.
 *
 * Exported separately from `buildVercelRequest` so tests can assert the URL —
 * including the threading property and its control case — without constructing
 * headers that would then have to be scrubbed from failure output.
 */
export function buildVercelUrl(spec: VercelRequestSpec, credential: VercelCredential): string {
  const url = new URL(spec.path, VERCEL_API_BASE);
  for (const [key, value] of Object.entries(spec.query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (RESERVED_QUERY_KEYS.has(key)) continue;
    url.searchParams.set(key, String(value));
  }
  const teamId = (credential.teamId ?? "").trim();
  if (spec.scope === "team" && teamId.length > 0) {
    url.searchParams.set("teamId", teamId);
  }
  return url.toString();
}

/** Build the full request. The token appears ONLY in the Authorization header —
 *  never in the URL, never in the body — so a logged URL is always safe to
 *  print and the scrubber has one predictable place to guard. */
export function buildVercelRequest(
  spec: VercelRequestSpec,
  credential: VercelCredential,
): BuiltVercelRequest {
  const method = spec.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.token}`,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (spec.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(spec.body);
  }
  return { url: buildVercelUrl(spec, credential), method, headers, body };
}

/** Endpoint path for a log line: the path we asked for, with no query string.
 *  Used instead of the built URL so `teamId` (and anything a later endpoint
 *  puts in the query) never reaches a log. */
export function logSafePath(spec: VercelRequestSpec): string {
  return spec.path;
}

// ── Request specs ───────────────────────────────────────────────────────────
// PR 1 needs only the read paths the preflight uses. They live here as named
// builders rather than inline objects so PRs 2-5 extend one list, and so the
// `scope` of every endpoint is reviewable in a single place.

/** Identity behind the token. Doubles as the token-validity probe: a 401 here
 *  is the cleanest possible "this token does not work". */
export function specGetUser(): VercelRequestSpec {
  return { path: "/v2/user", scope: "account" };
}

/** The configured team, for reporting which scope the credential resolves to. */
export function specGetTeam(teamId: string): VercelRequestSpec {
  return { path: `/v2/teams/${encodeURIComponent(teamId)}`, scope: "account" };
}

/** The preflight's centrepiece — see `VercelGitNamespace` in types.ts. */
export function specGitNamespaces(): VercelRequestSpec {
  return {
    path: "/v1/integrations/git-namespaces",
    scope: "team",
    query: { provider: "github" },
  };
}

// ── PR 2: linking and creating projects ─────────────────────────────────────

/** `GET /v10/projects` — the pick-list for "link an existing Vercel project".
 *  Bounded: an operator picking from a list does not need every project, and an
 *  unbounded list on a large account is a slow page for no benefit. */
export function specListProjects(args?: { search?: string; limit?: number }): VercelRequestSpec {
  return {
    path: "/v10/projects",
    scope: "team",
    query: { search: args?.search, limit: args?.limit ?? 50 },
  };
}

/** `GET /v9/projects/{idOrName}` — the READ-BACK. This is the call that makes
 *  the production auto-deploy gate honest: after asking Vercel to change
 *  something we re-read it and report what Vercel actually says, rather than
 *  assuming the PATCH took effect. */
export function specGetProject(idOrName: string): VercelRequestSpec {
  return { path: `/v9/projects/${encodeURIComponent(idOrName)}`, scope: "team" };
}

/**
 * `POST /v11/projects` — create a project and link it to a GitHub repo.
 *
 * `gitRepository` is what makes this fail with the unhelpful
 * `400 "…install the GitHub integration first"` when the Vercel-for-GitHub App
 * is absent. `decideLinkGate` blocks that case before we get here; the error
 * classifier recognises it as `git_integration_missing` as a second line.
 *
 * There is deliberately NO `productionBranch` field here — Vercel's API does not
 * accept one (see deploy-policy.ts). Passing one would be silently ignored,
 * which is worse than not trying.
 */
export function specCreateProject(args: {
  name: string;
  /** "owner/repo". */
  repo: string;
  framework?: string | null;
}): VercelRequestSpec {
  return {
    path: "/v11/projects",
    scope: "team",
    method: "POST",
    body: {
      name: args.name,
      ...(args.framework ? { framework: args.framework } : {}),
      gitRepository: { type: "github", repo: args.repo },
    },
  };
}

// ── PR 3: environment variables ─────────────────────────────────────────────

/**
 * `GET /v10/projects/{id}/env` — what Vercel has today.
 *
 * `decrypt` is deliberately NOT requested. It only ever decrypts `encrypted`
 * variables (never `sensitive`, which is the type DevPilot writes), so the extra
 * exposure buys almost nothing — and what it does buy is a response body full of
 * plaintext secrets flowing through a transport whose stated invariant is
 * "bodies are safe because the credential lives in the header". Keeping it off
 * means the only readable values in a response are ones already stored as
 * `plain`, i.e. ones nobody classified as secret in the first place.
 */
export function specListProjectEnv(projectId: string): VercelRequestSpec {
  return {
    path: `/v10/projects/${encodeURIComponent(projectId)}/env`,
    scope: "team",
  };
}

/**
 * `POST /v10/projects/{id}/env?upsert=true` — create or replace one variable.
 *
 * Two flags carry the whole security posture of this call and neither is
 * optional:
 *
 *   `type: "sensitive"` — Vercel marks the variable non-readable once created
 *     and redacts it from build logs. This is what makes a leaked VERCEL_TOKEN
 *     unable to READ BACK the secrets DevPilot pushed; it could only overwrite
 *     them. It is valid only for `production`/`preview`, which is exactly the
 *     target set `ENV_PUSH_TARGETS` pins.
 *
 *   `?upsert=true` — without it, a re-push of an existing name returns
 *     `403 "The environment variable cannot be created because it already
 *     exists"`, so every retry after a partial failure would fail.
 *
 * ⚠️ The BODY of this request is entirely secret material. It must never be
 * logged, never attached to an error, and never returned to a caller. The
 * transport already guarantees the first two (`vercelFetch` logs the path only);
 * this comment exists so nobody adds a debug line here later.
 */
export function specUpsertProjectEnv(
  projectId: string,
  body: {
    key: string;
    value: string;
    target: readonly string[];
    type: "sensitive" | "encrypted" | "plain";
    comment?: string;
  },
): VercelRequestSpec {
  return {
    path: `/v10/projects/${encodeURIComponent(projectId)}/env`,
    scope: "team",
    method: "POST",
    query: { upsert: "true" },
    body: {
      key: body.key,
      value: body.value,
      target: [...body.target],
      type: body.type,
      ...(body.comment ? { comment: body.comment } : {}),
    },
  };
}

// ── PR 4: deployments ───────────────────────────────────────────────────────

/**
 * `POST /v13/deployments` — build and deploy a git ref.
 *
 * ⚠️ The `target` field is the production/preview boundary, and its shape here
 * is deliberate. Vercel treats an ABSENT `target` as a preview deploy, so the
 * preview path below emits no `target` key at all rather than a falsy one. That
 * means a preview request is structurally incapable of carrying a production
 * target — there is no value a caller could pass that turns one into the other,
 * and a future bug that drops the field degrades to preview, never to
 * production. Same shape, and the same reasoning, as `devpilot_create_ticket`'s
 * forced `status: "backlog"`.
 *
 * `gitSource` uses the documented `{type, org, repo, ref}` form. DevPilot always
 * holds `githubOwner`/`githubRepo` for a linked project (the link gate refuses
 * without them), so there is no need for the `repoId` variant and no second
 * round trip to resolve one.
 */
export function specCreateDeployment(args: {
  /** The Vercel project NAME or id. Vercel wants `name` for the deployment. */
  name: string;
  /** Vercel project id, so the deployment lands on the linked project rather
   *  than creating a new one from the name. */
  projectId: string;
  org: string;
  repo: string;
  ref: string;
  target: "production" | "preview";
}): VercelRequestSpec {
  return {
    path: "/v13/deployments",
    scope: "team",
    method: "POST",
    body: {
      name: args.name,
      project: args.projectId,
      gitSource: { type: "github", org: args.org, repo: args.repo, ref: args.ref },
      // See above: production is named, preview is the ABSENCE of the field.
      ...(args.target === "production" ? { target: "production" } : {}),
    },
  };
}

/** `GET /v13/deployments/{id}` — the poll. Read-only and cheap; this is the call
 *  the durable poller makes on a backoff schedule. */
export function specGetDeployment(deploymentId: string): VercelRequestSpec {
  return {
    path: `/v13/deployments/${encodeURIComponent(deploymentId)}`,
    scope: "team",
  };
}

// ── PR 5: rollback and promote ──────────────────────────────────────────────
//
// These are TWO ENDPOINTS, not one mechanism with two names, and the difference
// is load-bearing. They share one underlying job (the project's
// `lastAliasRequest`, an async alias remap) but they target DISJOINT sets and
// carry different plan gates:
//
//   rollback — targets a deployment that HAS served production. Vercel declares a
//     `402` on it: the Hobby plan permits exactly one step back.
//   promote  — targets a deployment that has NOT been promoted before. No `402`
//     and no documented plan gate. This is Vercel's own documented way to UNDO a
//     rollback, which is the only reason it is here.
//
// So promote is NOT a Hobby workaround for deep rollback: the older production
// deployments you would want are precisely the ones it refuses. Anyone tempted
// to "simplify" these into one call should read `lib/vercel/rollback-state.ts`.

/**
 * `POST /v1/projects/{projectId}/rollback/{deploymentId}` — Instant Rollback.
 *
 * `/v1` deliberately, NOT the `/v9` the Vercel CLI uses. Both are live, but only
 * `/v1` appears in Vercel's published OpenAPI document and reference page; the
 * CLI's path is undocumented and could move without notice.
 *
 * The empty body is REQUIRED — Vercel rejects the request without one.
 *
 * A `201` means ACCEPTED, not applied. The remap is asynchronous and per-alias,
 * and it can partly fail; the caller reads the project's `lastAliasRequest` to
 * find out what actually happened.
 */
export function specRollbackDeployment(projectId: string, deploymentId: string): VercelRequestSpec {
  return {
    path: `/v1/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(deploymentId)}`,
    scope: "team",
    method: "POST",
    body: {},
  };
}

/**
 * `POST /v10/projects/{projectId}/promote/{deploymentId}` — promote, used here
 * ONLY as "undo rollback".
 *
 * ⚠️ Vercel's CLI, when handed a NON-production deployment, silently switches to
 * `POST /v13/deployments` and REBUILDS it against production environment
 * variables. DevPilot must never replicate that: a control labelled "undo" that
 * quietly builds a preview into production would breach the preview/production
 * boundary this whole feature is shaped around. The promote path here refuses a
 * non-production target up front (`classifyPromoteTarget`) rather than falling
 * back to anything.
 *
 * Distinguish `201` from `202`: a `202` means the promotion was QUEUED behind an
 * active rolling release and production has NOT moved yet. Reporting that as
 * success is the "silently no-ops" failure this endpoint is known for.
 */
export function specPromoteDeployment(projectId: string, deploymentId: string): VercelRequestSpec {
  return {
    path: `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`,
    scope: "team",
    method: "POST",
    body: {},
  };
}

/**
 * `GET /v7/deployments` — Vercel's own view of which deployments are eligible.
 *
 * `rollbackCandidate=true` is the important parameter: Vercel computes
 * "has this ever been aliased to a production domain" server-side. DevPilot asks
 * rather than reimplementing that rule, because a local mirror of someone else's
 * eligibility rule offers targets that fail.
 */
export function specListDeployments(args: {
  projectId: string;
  target?: "production" | "preview";
  state?: string;
  rollbackCandidate?: boolean;
  limit?: number;
}): VercelRequestSpec {
  return {
    path: "/v7/deployments",
    scope: "team",
    query: {
      projectId: args.projectId,
      target: args.target,
      state: args.state,
      // `false` would be dropped by the query builder's empty-value filter, which
      // is the behaviour we want: the parameter is only ever set to narrow.
      rollbackCandidate: args.rollbackCandidate === true ? "true" : undefined,
      limit: args.limit ?? 20,
    },
  };
}

/** `PATCH /v9/projects/{idOrName}` — used only to carry the `deploymentPolicy`
 *  body built by `buildProductionGitPolicy`. The body is passed in rather than
 *  built here so the safety decision stays in one pure, tested module. */
export function specUpdateProject(idOrName: string, body: unknown): VercelRequestSpec {
  return {
    path: `/v9/projects/${encodeURIComponent(idOrName)}`,
    scope: "team",
    method: "PATCH",
    body,
  };
}
