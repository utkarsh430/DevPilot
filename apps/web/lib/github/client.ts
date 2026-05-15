// Phase 2 / M5b — minimal fetch-based GitHub REST client. We deliberately
// avoid pulling in `@octokit/rest` (or `octokit`) here: those packages add
// ~300 KB of transitive deps for a handful of REST calls, and we want this
// module to be safe to import from server actions, edge routes, and the
// Inngest worker without bloating any one of those bundles. Every public
// function below maps to a single REST endpoint and uses the caller-supplied
// token — there is no environment-level fallback, by design. Tokens live in
// the encrypted `github_tokens` table (M5a) and are decrypted just-in-time by
// the calling action.
//
// Conventions:
//   • Auth header uses `Bearer <token>` — GitHub still accepts `token <token>`
//     but the docs as of 2024+ list `Bearer` as the canonical form for fine-
//     grained PATs and GitHub App user-to-server tokens (which is what our
//     OAuth flow produces).
//   • Accept header pins to `application/vnd.github+json` — explicit so we're
//     not at the mercy of GitHub's default media type drift.
//   • X-GitHub-Api-Version: 2022-11-28 — also explicit, because GitHub bumps
//     the date occasionally and we'd rather break loudly than silently.
//   • Every function camelCases the response keys it returns. The wire format
//     is snake_case; our TypeScript callers should never have to see that.
//   • All non-2xx responses throw, except `getRepo()` which returns null on
//     404 (a legitimate "this repo doesn't exist for this user" signal).
//   • Rate-limit aware: if a 403 comes back with `X-RateLimit-Remaining: 0`,
//     the thrown error names the reset time so the caller can surface a
//     useful message rather than "Forbidden".

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 15_000;

export type GithubAuth = { token: string };

export type GithubUser = {
  id: number;
  login: string;
  avatarUrl: string;
};

export type GithubRepoSummary = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
  updated_at: string;
};

export type GithubRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
};

export type GithubCreatedRepo = {
  id: number;
  full_name: string;
  clone_url: string;
  default_branch: string;
  html_url: string;
};

export type GithubPullRequest = {
  number: number;
  html_url: string;
};

/**
 * Custom error thrown by every function in this module on a non-2xx response
 * (except `getRepo`'s 404). Carries the HTTP status plus whatever GitHub put
 * in the error body so the calling action can map it to a user-facing message.
 */
export type GithubValidationError = {
  resource?: string;
  field?: string;
  code?: string;
  message?: string;
};

export class GithubApiError extends Error {
  readonly status: number;
  readonly githubMessage: string | undefined;
  readonly documentationUrl: string | undefined;
  /**
   * `errors[]` field from a GitHub validation response (typically 422). For
   * repo create the entries carry the actual reason ("name already exists",
   * "invalid name", …) — the top-level `message` is usually generic.
   */
  readonly githubErrors: GithubValidationError[] | undefined;

  constructor(
    status: number,
    message: string,
    opts?: {
      githubMessage?: string;
      documentationUrl?: string;
      githubErrors?: GithubValidationError[];
    },
  ) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
    this.githubMessage = opts?.githubMessage;
    this.documentationUrl = opts?.documentationUrl;
    this.githubErrors = opts?.githubErrors;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
};

// Centralized request helper. Every public function in this file goes through
// here so we have exactly one place that knows about headers, timeouts, and
// the GitHub error-body shape.
async function githubFetch(
  auth: GithubAuth,
  path: string,
  opts: RequestOptions = {},
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${GITHUB_API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "devpilot",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new GithubApiError(
        0,
        `GitHub request timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms: ${path}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Reads the response body as JSON, tolerating empty bodies (e.g. 204s) by
// returning null. Used by the per-endpoint helpers below.
async function readJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Inspects rate-limit headers and (if the response is a 403 with
// X-RateLimit-Remaining: 0) throws a rate-limit-specific error naming the
// reset time. Otherwise it's a no-op. Centralized here so every endpoint
// gets consistent treatment.
function checkRateLimit(res: Response, path: string): void {
  if (res.status !== 403) return;
  const remaining = res.headers.get("X-RateLimit-Remaining");
  if (remaining !== "0") return;
  const resetRaw = res.headers.get("X-RateLimit-Reset");
  const resetEpoch = resetRaw ? Number.parseInt(resetRaw, 10) : NaN;
  const resetIso = Number.isFinite(resetEpoch)
    ? new Date(resetEpoch * 1000).toISOString()
    : "unknown";
  throw new GithubApiError(403, `GitHub rate limit exceeded for ${path}. Resets at ${resetIso}.`);
}

// Converts a non-2xx response into a thrown GithubApiError carrying the
// GitHub error message and documentation URL when present. The caller has
// already short-circuited on `res.ok`; this is the failure path.
async function throwFromResponse(res: Response, path: string): Promise<never> {
  checkRateLimit(res, path);
  const body = await readJsonBody(res);
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const githubMessage = obj && "message" in obj ? String(obj.message) : undefined;
  const documentationUrl =
    obj && "documentation_url" in obj ? String(obj.documentation_url) : undefined;
  const githubErrors =
    obj && Array.isArray(obj.errors) ? (obj.errors as GithubValidationError[]) : undefined;
  throw new GithubApiError(
    res.status,
    `GitHub ${res.status} on ${path}${githubMessage ? `: ${githubMessage}` : ""}`,
    { githubMessage, documentationUrl, githubErrors },
  );
}

// ─── public API ────────────────────────────────────────────────────────────

/**
 * GET /user — returns the authenticated user. Used to confirm a token is
 * still valid and to populate the GitHub-connected indicator in the UI.
 */
export async function getAuthenticatedUser(auth: GithubAuth): Promise<GithubUser> {
  const path = "/user";
  const res = await githubFetch(auth, path);
  if (!res.ok) await throwFromResponse(res, path);
  const body = (await readJsonBody(res)) as {
    id: number;
    login: string;
    avatar_url: string;
  };
  return {
    id: body.id,
    login: body.login,
    avatarUrl: body.avatar_url,
  };
}

/**
 * GET /user/repos — lists repos the authenticated user has access to. We
 * forward the raw GitHub keys (snake_case) for the list endpoint because
 * downstream is mostly a wire-through to the connect-existing autocomplete;
 * camelCase'ing every field on the list would be busywork. The "single repo"
 * endpoints below (`getRepo`, `createRepoForAuthenticatedUser`) do convert
 * because their consumers project the fields into our own row shapes.
 */
export async function listUserRepos(
  auth: GithubAuth,
  opts?: { per_page?: number; page?: number },
): Promise<GithubRepoSummary[]> {
  const params = new URLSearchParams();
  params.set("per_page", String(opts?.per_page ?? 30));
  if (opts?.page) params.set("page", String(opts.page));
  // Sort by recent activity — what the operator most-likely wants to pick.
  params.set("sort", "updated");
  params.set("direction", "desc");
  const path = `/user/repos?${params.toString()}`;
  const res = await githubFetch(auth, path);
  if (!res.ok) await throwFromResponse(res, path);
  const body = (await readJsonBody(res)) as Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch: string;
    clone_url: string;
    updated_at: string;
  }>;
  return body.map((r) => ({
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    private: r.private,
    default_branch: r.default_branch,
    clone_url: r.clone_url,
    updated_at: r.updated_at,
  }));
}

/**
 * GET /repos/{owner}/{repo} — single-repo lookup. Returns null on 404
 * (legitimate "doesn't exist" signal used by the connect-existing flow to
 * tell the operator "we couldn't find that repo"). Any other non-2xx still
 * throws.
 */
export async function getRepo(
  auth: GithubAuth,
  owner: string,
  repo: string,
): Promise<GithubRepo | null> {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const res = await githubFetch(auth, path);
  if (res.status === 404) return null;
  if (!res.ok) await throwFromResponse(res, path);
  const body = (await readJsonBody(res)) as {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch: string;
    clone_url: string;
  };
  return {
    id: body.id,
    name: body.name,
    full_name: body.full_name,
    private: body.private,
    default_branch: body.default_branch,
    clone_url: body.clone_url,
  };
}

/**
 * GET /repositories/{id} — canonical lookup by GitHub's stable numeric id.
 * The numeric id survives renames AND owner transfers, so this is the safe
 * way to re-read a repo's current `full_name` / `default_branch` after the
 * operator has reshuffled things on github.com. Returns null on 404 (repo
 * was deleted entirely) so callers can degrade gracefully.
 */
export async function getRepoById(auth: GithubAuth, repoId: number): Promise<GithubRepo | null> {
  const path = `/repositories/${encodeURIComponent(String(repoId))}`;
  const res = await githubFetch(auth, path);
  if (res.status === 404) return null;
  if (!res.ok) await throwFromResponse(res, path);
  const body = (await readJsonBody(res)) as {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch: string;
    clone_url: string;
  };
  return {
    id: body.id,
    name: body.name,
    full_name: body.full_name,
    private: body.private,
    default_branch: body.default_branch,
    clone_url: body.clone_url,
  };
}

/**
 * POST /user/repos — creates a new repo under the authenticated user. We
 * default to `private: true` (safer default for a freshly-scaffolded project
 * that may contain placeholder secrets) and `auto_init: false` (we want the
 * repo to start empty so the scaffolder role controls the first commit
 * verbatim — auto_init creates a default README we'd then have to overwrite).
 */
export async function createRepoForAuthenticatedUser(
  auth: GithubAuth,
  opts: {
    name: string;
    description?: string;
    private?: boolean;
    auto_init?: boolean;
  },
): Promise<GithubCreatedRepo> {
  const path = "/user/repos";
  const res = await githubFetch(auth, path, {
    method: "POST",
    body: {
      name: opts.name,
      description: opts.description,
      private: opts.private ?? true,
      auto_init: opts.auto_init ?? false,
    },
  });
  if (!res.ok) await throwFromResponse(res, path);
  const body = (await readJsonBody(res)) as {
    id: number;
    full_name: string;
    clone_url: string;
    default_branch: string;
    html_url: string;
  };
  return {
    id: body.id,
    full_name: body.full_name,
    clone_url: body.clone_url,
    default_branch: body.default_branch,
    html_url: body.html_url,
  };
}

/**
 * POST /repos/{owner}/{repo}/pulls — opens a PR from `head` (e.g.
 * `devpilot/<slug>`) into `base` (typically the repo's default branch). Returns
 * the PR number and HTML URL so the caller can surface a "View PR" link in
 * the /changes UI.
 */
export async function createPullRequest(
  auth: GithubAuth,
  opts: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body?: string;
    draft?: boolean;
  },
): Promise<GithubPullRequest> {
  const path = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/pulls`;
  const res = await githubFetch(auth, path, {
    method: "POST",
    body: {
      title: opts.title,
      head: opts.head,
      base: opts.base,
      body: opts.body,
      draft: opts.draft ?? false,
    },
  });
  if (!res.ok) await throwFromResponse(res, path);
  const body = (await readJsonBody(res)) as {
    number: number;
    html_url: string;
  };
  return {
    number: body.number,
    html_url: body.html_url,
  };
}

/**
 * GET /repos/{owner}/{repo}/branches — list all branches on the repo.
 * Used by the dev-server branch picker to populate the "Switch branch"
 * dropdown. Pages through results so repos with > 30 branches still get
 * the full set (capped at 200 to bound the response).
 */
export async function listRepoBranches(
  auth: GithubAuth,
  opts: { owner: string; repo: string; maxBranches?: number },
): Promise<Array<{ name: string; sha: string; protected: boolean }>> {
  const max = opts.maxBranches ?? 200;
  const out: Array<{ name: string; sha: string; protected: boolean }> = [];
  let page = 1;
  while (out.length < max) {
    const path = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/branches?per_page=100&page=${page}`;
    const res = await githubFetch(auth, path);
    if (!res.ok) await throwFromResponse(res, path);
    const body = (await readJsonBody(res)) as Array<{
      name: string;
      commit: { sha: string };
      protected: boolean;
    }>;
    if (!Array.isArray(body) || body.length === 0) break;
    for (const b of body) {
      out.push({ name: b.name, sha: b.commit.sha, protected: b.protected });
      if (out.length >= max) break;
    }
    if (body.length < 100) break;
    page++;
  }
  return out;
}

/**
 * PUT /repos/{owner}/{repo}/contents/README.md — seed an empty repo with a
 * single initial commit on `main` (or whichever branch you name).
 *
 * Why this exists (2026-06-08 hotfix): `createRepoForAuthenticatedUser`
 * intentionally creates the repo with `auto_init: false` so the scaffolder
 * role controls the first commit. But that leaves the repo truly empty —
 * no branches at all. The first ticket to push then creates `devpilot/<slug>`
 * which GitHub auto-promotes to default (the only branch wins). Result:
 * no stable trunk, ticket pushes can't rebase against any sane base.
 *
 * The fix is to seed `main` immediately after repo creation with a one-
 * line README. GitHub adopts `main` as default since it's the first branch.
 * Subsequent ticket branches cut from origin/main, push, PR into main —
 * the workflow we actually want.
 *
 * Returns the SHA of the seed commit. Throws on any non-2xx (including the
 * 422 you'd get if the file already exists — caller can catch and treat
 * that as a no-op).
 */
export async function seedRepoMainBranch(
  auth: GithubAuth,
  opts: {
    owner: string;
    repo: string;
    /** Branch to create. Defaults to "main". */
    branch?: string;
    /** Display name used in the README body. Defaults to the repo name. */
    displayName?: string;
  },
): Promise<{ sha: string; branch: string }> {
  const branch = opts.branch ?? "main";
  const title = opts.displayName ?? opts.repo;
  const body =
    `# ${title}\n\n` +
    `Scaffolded by [DevPilot](https://github.com/utkarsh430/DevPilot). ` +
    `Ticket branches land here via pull request.\n`;
  const content =
    typeof Buffer !== "undefined" ? Buffer.from(body, "utf8").toString("base64") : btoa(body);
  const path = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/contents/README.md`;
  const res = await githubFetch(auth, path, {
    method: "PUT",
    body: {
      message: "Initial commit (DevPilot scaffold seed)",
      content,
      branch,
    },
  });
  if (!res.ok) await throwFromResponse(res, path);
  const responseBody = (await readJsonBody(res)) as {
    content?: { sha?: string };
    commit?: { sha?: string };
  };
  const sha = responseBody.commit?.sha ?? responseBody.content?.sha ?? "";
  return { sha, branch };
}

/**
 * Create branch `newBranch` pointing at the tip of `sourceBranch`. Idempotent
 * — if `newBranch` already exists, returns `{ created: false }` rather than
 * throwing. Used to seed the integration branch (default: `dev`) off `main`
 * when a project is created so the runner's `git clone --branch dev` doesn't
 * fail on the first dispatch.
 *
 * Walks the GitHub Git Data API:
 *   1. GET /git/refs/heads/{sourceBranch}  → read its SHA
 *   2. POST /git/refs                      → create the new ref at that SHA
 *
 * The 422 "Reference already exists" response from step 2 is treated as a
 * clean no-op so this can be called repeatedly without surfacing a fake
 * error on already-seeded repos.
 */
export async function ensureBranchFromBranch(
  auth: GithubAuth,
  opts: {
    owner: string;
    repo: string;
    sourceBranch: string;
    newBranch: string;
  },
): Promise<{ created: boolean; sha: string }> {
  const sourcePath = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/git/refs/heads/${encodeURIComponent(opts.sourceBranch)}`;
  const sourceRes = await githubFetch(auth, sourcePath, { method: "GET" });
  if (!sourceRes.ok) await throwFromResponse(sourceRes, sourcePath);
  const sourceJson = (await readJsonBody(sourceRes)) as {
    object?: { sha?: string };
  };
  const sha = sourceJson.object?.sha;
  if (!sha) {
    throw new Error(
      `ensureBranchFromBranch: source branch ${opts.sourceBranch} has no sha in response`,
    );
  }

  const createPath = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/git/refs`;
  const createRes = await githubFetch(auth, createPath, {
    method: "POST",
    body: { ref: `refs/heads/${opts.newBranch}`, sha },
  });
  if (createRes.ok) return { created: true, sha };
  // 422 == "Reference already exists" — treat as idempotent no-op.
  if (createRes.status === 422) return { created: false, sha };
  await throwFromResponse(createRes, createPath);
  // throwFromResponse always throws; this is here to satisfy the type checker.
  throw new Error("unreachable");
}

/**
 * PATCH /repos/{owner}/{repo} — set the repository's default branch.
 *
 * Belt-and-suspenders for `seedRepoMainBranch`: GitHub usually adopts the
 * first-pushed branch as default automatically, but if the user's account
 * has a non-`main` default branch name preference, we want to explicitly
 * land on `main` for predictable downstream behavior.
 *
 * No-op if the repo's default_branch already matches.
 */
export async function setRepoDefaultBranch(
  auth: GithubAuth,
  opts: { owner: string; repo: string; branch: string },
): Promise<void> {
  const path = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`;
  const res = await githubFetch(auth, path, {
    method: "PATCH",
    body: { default_branch: opts.branch },
  });
  if (!res.ok) await throwFromResponse(res, path);
}

/**
 * POST /repos/{owner}/{repo}/merges — direct API-side merge of `head` into
 * `base` (Phase 2.5+ / Slice IB). Used by the "Promote integration →
 * production" flow when the operator picks the *direct* strategy (faster
 * than a PR, but bypasses branch protection — the calling action shows a
 * warning before invoking this).
 *
 * Returns the merge commit's SHA + HTML URL. GitHub returns a 204 No Content
 * when `head` is already up-to-date with `base` (nothing to merge); we
 * surface that as `{merged: false, reason: 'already-up-to-date'}` so the
 * caller can stamp the promotion row as a no-op rather than an error.
 * On 409 (merge conflict) we throw a GithubApiError with the conflict
 * message — the caller routes the operator back to the PR strategy.
 */
export async function mergeBranches(
  auth: GithubAuth,
  opts: {
    owner: string;
    repo: string;
    base: string;
    head: string;
    commit_message?: string;
  },
): Promise<
  { merged: true; sha: string; html_url: string } | { merged: false; reason: "already-up-to-date" }
> {
  const path = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/merges`;
  const res = await githubFetch(auth, path, {
    method: "POST",
    body: {
      base: opts.base,
      head: opts.head,
      commit_message: opts.commit_message,
    },
  });
  if (res.status === 204) {
    return { merged: false, reason: "already-up-to-date" };
  }
  if (!res.ok) await throwFromResponse(res, path);
  const body = (await readJsonBody(res)) as { sha: string; html_url: string };
  return { merged: true, sha: body.sha, html_url: body.html_url };
}

/**
 * Convenience helper around `GET /repos/{owner}/{repo}` that returns just
 * the default branch name. Used by the push-and-open-PR action to populate
 * the PR's `base` without forcing the caller to hardcode "main". Throws if
 * the repo doesn't exist (unlike `getRepo`, where 404 is a meaningful
 * signal) — at the point we're opening a PR the repo must exist.
 */
export async function getDefaultBranch(
  auth: GithubAuth,
  owner: string,
  repo: string,
): Promise<string> {
  const repoData = await getRepo(auth, owner, repo);
  if (!repoData) {
    throw new GithubApiError(
      404,
      `GitHub repo ${owner}/${repo} not found while fetching default branch.`,
    );
  }
  return repoData.default_branch;
}

// ─── WI-4: the auto-land primitives ────────────────────────────────────────
//
// WHY A PR + SQUASH, AND NOT `mergeBranches`. `mergeBranches` above posts to
// /repos/{owner}/{repo}/merges, which can only produce a MERGE COMMIT — the
// REST API offers no squash option on that endpoint. And a squash done locally
// (`git merge --squash` + push) would have to force-push the shared integration
// branch to stay replay-stable, which is exactly the thing we never do. So the
// land is a per-ticket PR merged with `merge_method: "squash"`: GitHub does the
// squash server-side and hands back a stable merge sha, and the integration
// branch only ever fast-forwards.

/**
 * GET /repos/{owner}/{repo}/branches/{branch} — the branch's tip sha.
 *
 * This is the "read the ref" the crash-safe stamp depends on (see
 * `resolveLandedSha` in lib/integration/land-policy.ts). We read the REMOTE ref
 * rather than shelling out to `git rev-parse origin/dev` because the reaper has
 * to resolve the same sha with no workspace to stand in — the remote ref is the
 * truth, and a local `origin/dev` is only ever a cached copy of it.
 *
 * Returns null on 404 (branch doesn't exist) — a meaningful answer, not an error.
 */
export async function getBranchSha(
  auth: GithubAuth,
  opts: { owner: string; repo: string; branch: string },
): Promise<string | null> {
  const path = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/branches/${encodeURIComponent(opts.branch)}`;
  const res = await githubFetch(auth, path);
  if (res.status === 404) return null;
  if (!res.ok) await throwFromResponse(res, path);
  const body = (await readJsonBody(res)) as { commit?: { sha?: string } };
  return body.commit?.sha ?? null;
}

/**
 * GET /repos/{owner}/{repo}/compare/{base}...{head} — is `head` already
 * contained in `base`?
 *
 * GitHub reports `behind` when head has no commits base lacks, and `identical`
 * when they're the same commit. Either way the head's work IS on base. This is
 * how the reaper reconciles a row whose worker died mid-merge: it asks GitHub
 * whether the land already happened rather than guessing from the row's state,
 * and so never re-merges a branch that is already in.
 */
export async function isBranchContainedIn(
  auth: GithubAuth,
  opts: { owner: string; repo: string; base: string; head: string },
): Promise<boolean> {
  const path = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/compare/${encodeURIComponent(opts.base)}...${encodeURIComponent(opts.head)}`;
  const res = await githubFetch(auth, path);
  // A missing head branch (404) means there is nothing left to land from it.
  // Treat "gone" as "not contained" and let the caller's own checks decide —
  // guessing "contained" here would stamp a landing that never happened.
  if (res.status === 404) return false;
  if (!res.ok) await throwFromResponse(res, path);
  const body = (await readJsonBody(res)) as { status?: string; ahead_by?: number };
  return body.status === "behind" || body.status === "identical" || body.ahead_by === 0;
}

/**
 * GET /repos/{owner}/{repo}/pulls?head=…&base=… — the open PR for this exact
 * head→base pair, if one is already open.
 *
 * Idempotency: a worker that crashed after opening the PR but before merging it
 * must find its own PR on replay rather than trying to open a second one (which
 * GitHub rejects with a 422 that reads like a real failure).
 */
export async function findOpenPullRequest(
  auth: GithubAuth,
  opts: { owner: string; repo: string; head: string; base: string },
): Promise<GithubPullRequest | null> {
  const head = `${opts.owner}:${opts.head}`;
  const path =
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/pulls` +
    `?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(opts.base)}&per_page=1`;
  const res = await githubFetch(auth, path);
  if (!res.ok) await throwFromResponse(res, path);
  const body = (await readJsonBody(res)) as Array<{ number: number; html_url: string }>;
  const pr = Array.isArray(body) ? body[0] : undefined;
  return pr ? { number: pr.number, html_url: pr.html_url } : null;
}

export type SquashMergeResult =
  | { merged: true; sha: string }
  /** GitHub refused because the branch isn't mergeable (405) — a conflict with
   *  the base. The caller spawns a merger rather than treating it as an error. */
  | { merged: false; reason: "not_mergeable"; message: string }
  /** Nothing to merge: the PR is already merged, or its head has no commits the
   *  base lacks. On a REPLAY after a successful merge this is what we come back
   *  to — and it is NOT a null sha, it means "go read the ref". */
  | { merged: false; reason: "already_merged" };

/**
 * PUT /repos/{owner}/{repo}/pulls/{number}/merge with `merge_method: "squash"`.
 *
 * The returned sha is deliberately NOT what gets stamped as `landed_sha` — see
 * `resolveLandedSha`. It is a cross-check; the ref is the truth.
 */
export async function squashMergePullRequest(
  auth: GithubAuth,
  opts: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitTitle?: string;
    commitMessage?: string;
  },
): Promise<SquashMergeResult> {
  const path = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/pulls/${opts.pullNumber}/merge`;
  const res = await githubFetch(auth, path, {
    method: "PUT",
    body: {
      merge_method: "squash",
      commit_title: opts.commitTitle,
      commit_message: opts.commitMessage,
    },
  });
  if (res.ok) {
    const body = (await readJsonBody(res)) as { sha?: string; merged?: boolean };
    if (body.sha) return { merged: true, sha: body.sha };
    return { merged: false, reason: "already_merged" };
  }
  // 405 Method Not Allowed — "Pull Request is not mergeable" (conflict), and
  // 409 Conflict — head moved under us. Both mean: don't retry blindly, resolve.
  if (res.status === 405 || res.status === 409) {
    const body = (await readJsonBody(res)) as { message?: string };
    return {
      merged: false,
      reason: "not_mergeable",
      message: body.message ?? "pull request is not mergeable",
    };
  }
  // 422 on this endpoint is GitHub's "already merged / nothing to do".
  if (res.status === 422) return { merged: false, reason: "already_merged" };
  await throwFromResponse(res, path);
  // unreachable — throwFromResponse never returns
  return { merged: false, reason: "already_merged" };
}

export type GithubPullRequestState = {
  number: number;
  merged: boolean;
  /** The squash commit, when merged. */
  mergeCommitSha: string | null;
};

/**
 * GET /repos/{owner}/{repo}/pulls/{number} — is this PR merged?
 *
 * The branch-deletion-proof landing signal, and the reason the land worker
 * records its PR number on the queue row BEFORE merging. A repo with "auto-delete
 * head branches" on (a common setting) deletes `devpilot/<slug>` the instant the
 * squash lands. If the worker then dies before stamping, a reaper that asks "is
 * the BRANCH contained in dev?" gets a 404, concludes "not landed", and — if the
 * workspace has also been reaped — can never recover the fact that the work IS on
 * dev. The ticket stays unlanded and every dependent wedges forever.
 *
 * The PR outlives the branch. Asking GitHub whether it merged is the one question
 * that still has a truthful answer.
 */
export async function getPullRequest(
  auth: GithubAuth,
  opts: { owner: string; repo: string; pullNumber: number },
): Promise<GithubPullRequestState | null> {
  const path = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/pulls/${opts.pullNumber}`;
  const res = await githubFetch(auth, path);
  if (res.status === 404) return null;
  if (!res.ok) await throwFromResponse(res, path);
  const body = (await readJsonBody(res)) as {
    number: number;
    merged?: boolean;
    merge_commit_sha?: string | null;
  };
  return {
    number: body.number,
    merged: body.merged === true,
    mergeCommitSha: body.merge_commit_sha ?? null,
  };
}
