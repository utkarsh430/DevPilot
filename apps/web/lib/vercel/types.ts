// Hand-written Vercel API response types, narrowed to the fields we actually
// read, plus the runtime narrowers that get us there from `unknown`.
//
// We deliberately do NOT depend on `@vercel/sdk`. We touch roughly eight
// endpoints; the SDK would add a dependency, a version-pinning obligation, and
// its own abstraction between us and the wire, in exchange for types we can
// write here in a few dozen lines. The deciding factor is testability: a thin
// fetch client is trivially driven by an injected fetch, which is how every
// test in this directory avoids the network.
//
// Every narrower below is TOTAL: it takes `unknown` and returns either a value
// or null/[]. A field Vercel adds later is ignored; a field Vercel removes
// degrades to null rather than throwing mid-render. This matters because these
// shapes are a third party's and can change without our deploy.

/** `GET /v2/user` — identity behind the token. */
export type VercelUser = {
  id: string;
  username: string | null;
  email: string | null;
  name: string | null;
};

/** `GET /v2/teams/{id}` — the team a scoped token acts within. */
export type VercelTeam = {
  id: string;
  slug: string | null;
  name: string | null;
};

/**
 * One entry of `GET /v1/integrations/git-namespaces?provider=github`.
 *
 * This is the single most informative object in the whole preflight:
 *   - an EMPTY array means the Vercel for GitHub App is not installed at all;
 *   - `isAccessRestricted: true` means it was installed with "Selected
 *     repositories", which costs one manual click per new project forever;
 *   - `requireReauth: true` means the install exists but its grant has lapsed.
 * All three are invisible until someone tries to link a repo and gets a 400,
 * which is exactly the diagnosis-failure this preflight exists to prevent.
 */
export type VercelGitNamespace = {
  /** Vercel's own id for the namespace; string or number on the wire. */
  id: string;
  /** The GitHub owner login (user or org). */
  slug: string | null;
  provider: string | null;
  installationId: number | null;
  isAccessRestricted: boolean;
  requireReauth: boolean;
};

/**
 * A Vercel project, narrowed to what PR 2 reads.
 *
 * `raw` is deliberately retained: `interpretProductionAutoDeploy`
 * (deploy-policy.ts) reads `deploymentPolicy` off the untouched response rather
 * than a field parsed here. That is on purpose — `deploymentPolicy` is present
 * in Vercel's OpenAPI spec but undocumented in prose, and parsing it into a
 * narrowed shape would mean a shape change upstream degrades to "field absent",
 * which reads as `unknown` at best and could read as `gated` if a later parser
 * were less careful. Keeping the raw object means the interpreter always sees
 * exactly what Vercel said.
 */
export type VercelProject = {
  id: string;
  name: string | null;
  accountId: string | null;
  /** The git connection. Null for a "sourceless" project (no repo attached),
   *  which is a real and legitimate state. */
  link: VercelProjectLink | null;
  /** Untouched response body — see above. */
  raw: unknown;
};

export type VercelProjectLink = {
  type: string | null;
  org: string | null;
  repo: string | null;
  /** READ-ONLY upstream. Vercel's REST API exposes no way to set this: it is
   *  absent from every request body in the official OpenAPI document and
   *  appears only in responses. DevPilot reports it; it cannot change it. */
  productionBranch: string | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Vercel returns namespace ids as either a string or a number depending on
 *  provider. Normalise to string so callers never branch on it. */
function idish(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Absent boolean flags read as FALSE, never true. `isAccessRestricted` is a
 *  warning and `requireReauth` is an error; defaulting either to true would
 *  make a healthy install report as broken, which trains operators to ignore
 *  the banner. Defaulting to false only ever under-warns, and the real link
 *  attempt in PR 2 is the backstop. */
function flag(v: unknown): boolean {
  return v === true;
}

export function parseUser(body: unknown): VercelUser | null {
  const root = asRecord(body);
  if (!root) return null;
  // `/v2/user` wraps the payload in `{ user: {...} }`.
  const u = asRecord(root.user) ?? root;
  const id = str(u.id) ?? str(u.uid);
  if (!id) return null;
  return {
    id,
    username: str(u.username),
    email: str(u.email),
    name: str(u.name),
  };
}

export function parseTeam(body: unknown): VercelTeam | null {
  const root = asRecord(body);
  if (!root) return null;
  const t = asRecord(root.team) ?? root;
  const id = str(t.id);
  if (!id) return null;
  return { id, slug: str(t.slug), name: str(t.name) };
}

/** `GET /v1/integrations/git-namespaces` returns a bare array. A wrapped
 *  `{ namespaces: [...] }` shape is accepted too so a future envelope change
 *  degrades to "we read it" rather than "the App looks uninstalled" — that
 *  particular false negative would tell the operator to redo a browser grant
 *  they already completed. */
export function parseGitNamespaces(body: unknown): VercelGitNamespace[] {
  const arr = Array.isArray(body) ? body : (asRecord(body)?.namespaces ?? null);
  if (!Array.isArray(arr)) return [];
  const out: VercelGitNamespace[] = [];
  for (const raw of arr) {
    const n = asRecord(raw);
    if (!n) continue;
    const id = idish(n.id) ?? idish(n.installationId);
    if (!id) continue;
    out.push({
      id,
      slug: str(n.slug) ?? str(n.name),
      provider: str(n.provider),
      installationId:
        typeof n.installationId === "number" && Number.isFinite(n.installationId)
          ? n.installationId
          : null,
      isAccessRestricted: flag(n.isAccessRestricted),
      requireReauth: flag(n.requireReauth),
    });
  }
  return out;
}

/** `POST /v11/projects`, `GET /v9/projects/{idOrName}`, `PATCH /v9/projects/…`
 *  all return a project object at the top level. */
export function parseProject(body: unknown): VercelProject | null {
  const p = asRecord(body);
  if (!p) return null;
  const id = str(p.id);
  if (!id) return null;
  const l = asRecord(p.link);
  return {
    id,
    name: str(p.name),
    accountId: str(p.accountId),
    link: l
      ? {
          type: str(l.type),
          org: str(l.org) ?? str(l.owner),
          repo: str(l.repo),
          productionBranch: str(l.productionBranch),
        }
      : null,
    raw: body,
  };
}

/**
 * One environment variable as `GET /v10/projects/{id}/env` returns it.
 *
 * `value` is present ONLY for `type: "plain"`. For `encrypted` and `sensitive`
 * Vercel omits it (or returns an opaque placeholder), which is the whole reason
 * the reconciliation in `env-plan.ts` reasons about provenance rather than
 * equality. `hasReadableValue` makes that distinction explicit at the parse
 * boundary rather than leaving every caller to re-derive "is this string the
 * real value or a placeholder?".
 */
export type VercelEnvVar = {
  id: string | null;
  key: string;
  type: string | null;
  target: string[];
  comment: string | null;
  /** The plaintext, when Vercel returned one. Null otherwise. Never logged. */
  value: string | null;
};

/** Vercel's `target` is an array, but older/edge responses have used a bare
 *  string. Normalised so callers never branch. */
function targets(v: unknown): string[] {
  if (typeof v === "string" && v.length > 0) return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => typeof t === "string" && t.length > 0);
}

export function parseEnvVars(body: unknown): VercelEnvVar[] {
  const arr = Array.isArray(body) ? body : (asRecord(body)?.envs ?? null);
  if (!Array.isArray(arr)) return [];
  const out: VercelEnvVar[] = [];
  for (const raw of arr) {
    const e = asRecord(raw);
    if (!e) continue;
    const key = str(e.key);
    if (!key) continue;
    const type = str(e.type);
    // Only trust `value` for a `plain` variable. Vercel has historically
    // returned an encrypted blob in this field for other types, and treating
    // that as the plaintext would make every comparison report "differs" —
    // which, given the policy, means every variable would look like a conflict
    // and the operator would learn to tick every override box.
    const value = type === "plain" ? str(e.value) : null;
    out.push({
      id: str(e.id),
      key,
      type,
      target: targets(e.target),
      comment: str(e.comment),
      value,
    });
  }
  return out;
}

/**
 * A deployment, as `POST /v13/deployments` and `GET /v13/deployments/{id}`
 * return it.
 *
 * `readyState` is kept as the RAW string rather than a narrowed union. Vercel
 * owns that vocabulary and can add to it without our deploy; narrowing here
 * would turn an unrecognised state into `null`, and a null state is
 * indistinguishable from "we could not read it" at exactly the moment the
 * distinction matters. `classifyDeployState` (deploy-state.ts) does the
 * branching, treats what it does not recognise as non-terminal, and the raw
 * string is what gets stored so an operator can always see what Vercel said.
 */
export type VercelDeployment = {
  id: string;
  /** The deployment's own hostname, WITHOUT a scheme (Vercel returns it bare). */
  url: string | null;
  readyState: string | null;
  /** `"production"` for a production build; absent/null for a preview. */
  target: string | null;
  /** Deep link to the build log. The whole failure surface hangs off this. */
  inspectorUrl: string | null;
  /** Vercel's failure text, when the build errored. UNTRUSTED third-party
   *  content — bound and scrub before rendering or storing. */
  errorMessage: string | null;
  commitSha: string | null;
  branch: string | null;
  /** Epoch ms when the build reached a terminal state, per Vercel. */
  readyAt: number | null;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseDeployment(body: unknown): VercelDeployment | null {
  const d = asRecord(body);
  if (!d) return null;
  const id = str(d.id) ?? str(d.uid);
  if (!id) return null;

  // Git metadata lives under `meta` with provider-prefixed keys. GitHub is the
  // only provider this feature links, but the gitlab/bitbucket fallbacks cost a
  // line each and mean a differently-linked project shows its branch rather than
  // a blank.
  const meta = asRecord(d.meta) ?? {};
  const commitSha =
    str(meta.githubCommitSha) ?? str(meta.gitlabCommitSha) ?? str(meta.bitbucketCommitSha);
  const branch =
    str(meta.githubCommitRef) ?? str(meta.gitlabCommitRef) ?? str(meta.bitbucketCommitRef);

  return {
    id,
    url: str(d.url),
    // `status` is the newer alias for `readyState`; accept either so a version
    // bump does not stall every poller on an "unknown" state.
    readyState: str(d.readyState) ?? str(d.status),
    target: str(d.target),
    inspectorUrl: str(d.inspectorUrl),
    errorMessage: str(d.errorMessage) ?? str(asRecord(d.error)?.message),
    commitSha,
    branch,
    readyAt: num(d.ready) ?? num(d.readyAt),
  };
}

/**
 * `GET /v7/deployments` — the ids only.
 *
 * Deliberately narrow: this response is used ONLY to cross-check DevPilot's own
 * ledger against Vercel's `rollbackCandidate` rule, so the ids are the entire
 * payload of interest. Parsing more would invite a second, divergent source for
 * fields the card already renders from the ledger.
 */
export function parseDeploymentIds(body: unknown): string[] {
  const arr = Array.isArray(body) ? body : (asRecord(body)?.deployments ?? null);
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const raw of arr) {
    const d = asRecord(raw);
    if (!d) continue;
    const id = str(d.uid) ?? str(d.id);
    if (id) out.push(id);
  }
  return out;
}

/** `GET /v10/projects` returns `{ projects: [...], pagination: {...} }`. A bare
 *  array is accepted too so an envelope change degrades to "we read it". */
export function parseProjectList(body: unknown): VercelProject[] {
  const arr = Array.isArray(body) ? body : (asRecord(body)?.projects ?? null);
  if (!Array.isArray(arr)) return [];
  const out: VercelProject[] = [];
  for (const raw of arr) {
    const p = parseProject(raw);
    if (p) out.push(p);
  }
  return out;
}
