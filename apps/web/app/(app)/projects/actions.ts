"use server";

// Phase 2 / M5a–M5b — Project lifecycle server actions.
//
// Three flows:
//   1. createProjectFromExistingRepoAction — operator pastes a github.com URL;
//      we validate via GET /repos/{owner}/{repo} using their OAuth token, then
//      insert a `projects` row that the engine will pick up next time a ticket
//      lands against it.
//   2. createProjectWithNewRepoAction — operator names a project + describes
//      it in prose; we create the repo via POST /user/repos (private, no
//      auto_init — A3's role wants an unborn branch), insert the project row,
//      file a `project_scaffolder` ticket, and emit the dispatch event so the
//      runner picks it up.
//   3. deleteProjectAction — hard delete; tickets FK has SET NULL so existing
//      tickets stay around as orphans (project_id becomes null = legacy path).
//
// Plus setActiveProjectAction — writes the cookie that backs the topbar
// switcher's active-project state.
//
// CLAUDE.md compliance:
//   • Every entry guards with requireUser() + requireTenantId().
//   • GitHub token is fetched server-side only and never crosses the action
//     boundary (we never return it to the client).
//   • Zod-parsed inputs reject malformed shapes before we touch the DB or
//     GitHub.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTenantId, requireUser } from "@/lib/auth";
import { isTicketBranch } from "@/lib/git/ticket-branch";
import { supabaseService } from "@/lib/db/server";
import { getCurrentProjectIdFromCookie, setCurrentProjectIdCookie } from "@/lib/projects/current";
import { getGithubAccessToken } from "@/lib/github/oauth";
import { DEFAULT_TEAM_TIER, TEAM_TIERS, type TeamTier } from "@/lib/team-tiers/tiers";
import { DEFAULT_PROJECT_TYPE, PROJECT_TYPES, type ProjectType } from "@/lib/projects/project-type";
import {
  GithubApiError,
  createRepoForAuthenticatedUser,
  getRepo,
  getRepoById,
  getBranchSha,
  seedRepoMainBranch,
  ensureBranchFromBranch,
  setRepoDefaultBranch,
} from "@/lib/github/client";
import { resolveConnectIntegrationBranch } from "@/lib/integration/connect-integration-branch";

// 2026-06-08 hotfix — sanitize whatever value GitHub (or anything else)
// hands us for `default_branch` before stamping the projects row.
// `devpilot/<slug>` (and the pre-rename `ace/<slug>`, which existing repos still
// carry — see lib/git/ticket-branch.ts, both halves are load-bearing)
// is the per-ticket branch namespace owned by the runner; if a repo's
// default branch is set to one of those (typically because the scaffolder
// pushed the first commit on a ticket branch and the repo was empty so
// GitHub adopted it as default), pushing any later ticket's branch into it
// blows up the rebase pipeline. Fall back to "main" with a console warning
// so the operator can investigate on github.com.
function sanitizeDefaultBranch(raw: string | null | undefined, context: string): string {
  const value = (raw ?? "").trim();
  if (value.length === 0) return "main";
  if (isTicketBranch(value)) {
    console.warn(
      `[projects] ${context}: refusing to use \`${value}\` as default_branch (devpilot/* is the per-ticket namespace). Falling back to "main".`,
    );
    return "main";
  }
  return value;
}
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { SERVICE_KEYS } from "@/lib/stack/service-catalog";
import {
  insertProjectStackTags,
  persistStackSelection,
  toStackTags,
} from "@/lib/stack/persist.server";
import { planDetectedStackSelection } from "@/lib/stack/import-bridge";
import {
  DEFAULT_ECOSYSTEM,
  ECOSYSTEM_CHOICES,
  deriveStackFlavorFromEcosystem,
  type EcosystemChoice,
} from "@/lib/stack/rank";
import type { StackTagInput } from "@/lib/plan/types";
import { SCAFFOLDER_ROLE_SLUG, decideScaffolderSeed } from "@/lib/plan/scaffolder";
import { scanRepoForStackTags } from "@/lib/stack/detect-stack-tags.server";
import { LlmProviderFormSchema, type LlmProviderFormInput } from "@/lib/llm/provider-form";
import { validateProviderConfig, type ProviderColumns } from "@/lib/llm/project-provider.server";
import { PROJECT_LLM_API_KEY, PROJECT_VAULT_REF } from "@/lib/llm/credential-ref";
import { setProjectSecret } from "@/lib/projects/secrets";
import { extractUploadText } from "@/lib/projects/doc-extract.server";
import { distillProjectSeed } from "@/lib/projects/extract-seed.server";
import { SEED_INSTRUCTIONS_MAX } from "@/lib/projects/extract-seed";

// ─── WI-12: LLM provider on create ─────────────────────────────────────────
//
// Two halves, because the credential can't be written until the project row
// exists (the vault is keyed by project id):
//
//   validateProviderColumns() — BEFORE the insert. Runs the same SSRF-checked
//     validator the settings card uses, so a base URL that would be refused at
//     call time is refused here too and the row never lands.
//   persistProviderCredential() — AFTER the insert. Puts the key in the encrypted
//     per-project vault and stamps the row with an opaque REF to it. The key
//     itself never touches the projects row.

const NO_PROVIDER: ProviderColumns = {
  llm_provider: null,
  llm_base_url: null,
  llm_model: null,
};

async function validateProviderColumns(
  llm: Partial<LlmProviderFormInput> | undefined,
): Promise<{ ok: true; columns: ProviderColumns } | { ok: false; error: string }> {
  if (!llm || !llm.provider) return { ok: true, columns: NO_PROVIDER };
  return validateProviderConfig({
    provider: llm.provider,
    baseUrl: llm.baseUrl ?? null,
    model: llm.model ?? null,
  });
}

/** Best-effort: the project is already created and usable, so a vault failure
 *  here (a missing SECRETS_ENCRYPTION_KEY, say) must not roll the project back.
 *  Without the ref the provider simply falls through to the instance-scoped key,
 *  and the operator can re-enter it on the project's settings card — where the
 *  failure IS surfaced. */
async function persistProviderCredential(
  projectId: string,
  llm: Partial<LlmProviderFormInput> | undefined,
  userId: string,
): Promise<void> {
  const key = (llm?.apiKey ?? "").trim();
  if (!llm?.provider || key.length === 0) return;
  try {
    await setProjectSecret({ projectId, secretKey: PROJECT_LLM_API_KEY, value: key, userId });
    await supabaseService()
      .from("projects")
      .update({ llm_credential_ref: PROJECT_VAULT_REF })
      .eq("id", projectId);
  } catch (err) {
    console.warn(
      `[projects] couldn't store the LLM provider key for project ${projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ─── input schemas ─────────────────────────────────────────────────────────

const NAME_MIN = 1;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 4_000;
const REPO_URL_MAX = 400;

const TEAM_TIER_ENUM = TEAM_TIERS as readonly TeamTier[] as [TeamTier, ...TeamTier[]];

const PROJECT_TYPE_ENUM = PROJECT_TYPES as readonly ProjectType[] as [
  ProjectType,
  ...ProjectType[],
];
const ECOSYSTEM_ENUM = ECOSYSTEM_CHOICES as readonly EcosystemChoice[] as [
  EcosystemChoice,
  ...EcosystemChoice[],
];
// WI-15 — the project's committed stack. `serviceKey` is validated against the
// static catalog by `toStackTags` (unknown keys are dropped, and the LABEL that
// eventually reaches a prompt is always the catalog's, never the client's), so
// the schema only has to bound the shape. `source` is provenance for the UI; it
// never changes how a tag renders. The cap is the catalog size — a client that
// posts more than that is malformed by construction.
const StackTagsSchema = z
  .array(
    z.object({
      serviceKey: z.string().min(1).max(64),
      source: z.enum(["detected", "manual"]),
    }),
  )
  .max(SERVICE_KEYS.length)
  .optional();

const NameSchema = z
  .string()
  .trim()
  .min(NAME_MIN, "Name is required")
  .max(NAME_MAX, `Name must be ≤ ${NAME_MAX} characters`);

/** WI-12 — optional per-project LLM provider, on both create forms. Omitted (the
 *  default, and what the forms send unless the operator opens the advanced
 *  section) = the project inherits the workspace provider and nothing changes.
 *  The shape gate is the shared schema; the SSRF gate is `validateProviderConfig`,
 *  which every write path — including these two — runs before the row lands. */
const LlmSchema = LlmProviderFormSchema.partial().optional();

const ConnectExistingSchema = z.object({
  name: NameSchema,
  repoUrl: z
    .string()
    .trim()
    .min(1, "Repo URL is required")
    .max(REPO_URL_MAX, "Repo URL is implausibly long"),
  /** Operator-chosen team-tier default. Drives roster + ticket count on every
   * plan run against this project. */
  teamTier: z.enum(TEAM_TIER_ENUM).optional(),
  /** WI-11 — target platform. Steers the dev/preview command and plan mode.
   * Optional: absent means the caller asserted nothing, which maps to the
   * 'other' default (no steering). */
  projectType: z.enum(PROJECT_TYPE_ENUM).optional(),
  /** Stack advisor - the ecosystem the operator committed to. Optional:
   * absent means no commitment asserted, which maps to the 'unset' default
   * (no ranker steering). */
  stackEcosystem: z.enum(ECOSYSTEM_ENUM).optional(),
  /** WI-14 follow-up - arm agent ticket-filing for this project at creation
   *  time. The DB column default stays FALSE, so an existing project is never
   *  changed underneath its owner; this is the operator's own visible,
   *  pre-ticked choice on the create form, and unticking it is what "off"
   *  means. Absent = false, so any caller that never learned about this field
   *  keeps the pre-existing behaviour byte-for-byte. */
  agentTicketCreation: z.boolean().optional(),
  /** WI-15 — the committed stack the operator confirmed in the picker. */
  stackTags: StackTagsSchema,
  llm: LlmSchema,
});

const CreateNewSchema = z.object({
  name: NameSchema,
  description: z
    .string()
    .trim()
    .min(1, "Description is required so the scaffolder knows what to build")
    .max(DESCRIPTION_MAX, `Description must be ≤ ${DESCRIPTION_MAX} characters`),
  private: z.boolean().optional(),
  // Phase 2.5++ — when true (default for the UI), spin up a planning_session
  // alongside the scaffolder ticket so the user can plan the feature backlog
  // while the scaffolder seeds the repo in parallel.
  generatePlan: z.boolean().optional(),
  /** Optional distilled detail from an uploaded document (spec/PRD). When
   *  present AND `generatePlan` is on, it is appended to the plan opener as a
   *  richer first user message. The operator reviews/edits it before submit, so
   *  it is trusted-by-review here; it was Zod-bounded + fenced at distill time. */
  instructions: z.string().trim().max(SEED_INSTRUCTIONS_MAX).optional(),
  /** Operator-chosen team-tier default for this project. */
  teamTier: z.enum(TEAM_TIER_ENUM).optional(),
  /** WI-11 — target platform. Steers the dev/preview command and plan mode. */
  projectType: z.enum(PROJECT_TYPE_ENUM).optional(),
  /** Stack advisor - the ecosystem the operator committed to. */
  stackEcosystem: z.enum(ECOSYSTEM_ENUM).optional(),
  /** WI-14 follow-up - arm agent ticket-filing for this project at creation
   *  time. The DB column default stays FALSE, so an existing project is never
   *  changed underneath its owner; this is the operator's own visible,
   *  pre-ticked choice on the create form, and unticking it is what "off"
   *  means. Absent = false, so any caller that never learned about this field
   *  keeps the pre-existing behaviour byte-for-byte. */
  agentTicketCreation: z.boolean().optional(),
  /** WI-15 — the committed stack the operator ticked in the picker. */
  stackTags: StackTagsSchema,
  llm: LlmSchema,
});

const DetectStackSchema = z.object({
  repoUrl: z
    .string()
    .trim()
    .min(1, "Repo URL is required")
    .max(REPO_URL_MAX, "Repo URL is implausibly long"),
  llm: LlmSchema,
});

const DeleteSchema = z.object({
  projectId: z.string().uuid("projectId must be a uuid"),
});

const SetActiveSchema = z.object({
  projectId: z.string().uuid("projectId must be a uuid").nullable(),
});

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Parse a github.com URL into `{ owner, repo }`. Accepts:
 *   - https://github.com/foo/bar
 *   - https://github.com/foo/bar.git
 *   - git@github.com:foo/bar.git
 *   - foo/bar (operator typed a shorthand)
 * Returns null when the input doesn't look like a github repo reference.
 */
function parseRepoUrl(input: string): { owner: string; repo: string } | null {
  const raw = input.trim();
  if (raw.length === 0) return null;

  // SSH form: git@github.com:owner/repo(.git)?
  const ssh = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };

  // HTTPS form: https://github.com/owner/repo(.git)?
  const https = raw.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (https) return { owner: https[1]!, repo: https[2]! };

  // Bare owner/repo shorthand
  const shorthand = raw.match(
    /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?$/,
  );
  if (shorthand) return { owner: shorthand[1]!, repo: shorthand[2]! };

  return null;
}

/**
 * Canonical https URL we store in `projects.repo_url`. The runner appends the
 * `x-access-token` auth at clone time; we never persist the token in the URL
 * here.
 */
function canonicalRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Map a GitHub API failure into a user-readable error string. We never leak
 * the raw GitHub diagnostic verbatim — only the status-class + a short hint.
 */
function githubErrorMessage(err: unknown, context: "lookup" | "create"): string {
  if (err instanceof GithubApiError) {
    if (err.status === 404 && context === "lookup") {
      return "Repo not found — check the URL, or confirm the OAuth scopes include access to this repo.";
    }
    if (err.status === 401 || err.status === 403) {
      return "GitHub rejected the request — your token may have expired or lacks the required scopes. Reconnect in Settings → GitHub integration.";
    }
    if (err.status === 422 && context === "create") {
      // 422 on POST /user/repos: top-level `message` is a generic "Repository
      // creation failed."; the actionable reason lives in `errors[]` (e.g.
      // "name already exists on this account", "description control
      // characters are not allowed", …). Prefer that.
      const first = err.githubErrors?.[0];
      if (first?.message) {
        const field = first.field ? `${first.field}: ` : "";
        return `GitHub rejected the new repo — ${field}${first.message}.`;
      }
      return (
        err.githubMessage ?? "GitHub rejected the new repo — likely the name is already taken."
      );
    }
    if (err.status === 0) return "GitHub request timed out. Try again.";
    return `GitHub returned ${err.status}. ${err.githubMessage ?? "Try again."}`;
  }
  if (err instanceof Error) return err.message;
  return "Unknown GitHub error";
}

/**
 * GitHub's repo description is a single-line field that rejects control
 * characters (newlines, tabs, etc.) with a 422. Most operators paste a
 * multi-line blurb from a doc, so flatten whitespace + strip controls
 * server-side instead of bouncing them back to the form to clean it up
 * by hand. Also truncates to GitHub's 350-char ceiling (we use 240 as a
 * conservative cap to leave headroom for emoji + ellipsis if added later).
 */
function sanitizeGithubDescription(raw: string): string {
  return raw
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

// ─── 1. connect existing repo ──────────────────────────────────────────────

export type CreateProjectResult = { ok: true; projectId: string } | { ok: false; error: string };

/**
 * Validate that the operator has access to `repoUrl` via their GitHub OAuth
 * token, then insert a `projects` row. The runner will pick the new project
 * up the next time a ticket is filed against it (project_id set via the
 * topbar switcher / explicit ticket-create form).
 */
export async function createProjectFromExistingRepoAction(input: {
  name: string;
  repoUrl: string;
  teamTier?: TeamTier;
  projectType?: ProjectType;
  stackEcosystem?: EcosystemChoice;
  stackTags?: StackTagInput[];
  llm?: LlmProviderFormInput;
  /** Arm `devpilot_create_ticket` for the new project. Absent = false. */
  agentTicketCreation?: boolean;
}): Promise<CreateProjectResult> {
  const user = await requireUser();
  const tenantId = await requireTenantId();

  const parsed = ConnectExistingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }

  const parts = parseRepoUrl(parsed.data.repoUrl);
  if (!parts) {
    return {
      ok: false,
      error: "Couldn't parse that as a github.com repo URL. Try https://github.com/owner/repo.",
    };
  }

  // Fetch the user's GitHub token. If they haven't connected, we can't
  // verify the repo exists for them — bail with a clear pointer to settings.
  const token = await getGithubAccessToken(user.id);
  if (!token) {
    return {
      ok: false,
      error: "GitHub not connected. Connect at Settings → GitHub integration first.",
    };
  }

  // Verify the repo exists AND that this user has access. getRepo returns
  // null on 404 (which here means "operator can't see this repo with these
  // scopes" — treat it the same as "doesn't exist" for the operator).
  let repo;
  try {
    repo = await getRepo({ token }, parts.owner, parts.repo);
  } catch (err) {
    return { ok: false, error: githubErrorMessage(err, "lookup") };
  }
  if (!repo) {
    return {
      ok: false,
      error: `We couldn't find ${parts.owner}/${parts.repo}. Either it doesn't exist or your OAuth scopes don't grant access.`,
    };
  }

  // GitHub returns the authoritative casing in `full_name` (owner/repo) — use
  // that rather than the operator's typed-in casing so the persisted URL is
  // canonical. Falls back to the parsed owner if `full_name` somehow lacks a
  // slash (defensive — shouldn't happen on a valid repo response).
  const slashIdx = repo.full_name.indexOf("/");
  const githubOwner = slashIdx > 0 ? repo.full_name.slice(0, slashIdx) : parts.owner;
  const githubRepo = repo.name;

  // WI-12 — validate the optional LLM provider BEFORE the insert, so an
  // SSRF-failing base URL fails the create rather than landing a project with a
  // config we'd refuse to use.
  const llm = await validateProviderColumns(parsed.data.llm);
  if (!llm.ok) return { ok: false, error: llm.error };

  const defaultBranch = sanitizeDefaultBranch(repo.default_branch, "connect existing repo");

  // WI-4 (connect-existing) — arm the shared-integration-branch + auto-land
  // pipeline for the connected repo too, WITHOUT hijacking a branch the operator
  // already uses. Resolve an integration branch (pure decision in
  // `resolveConnectIntegrationBranch`): adopt `dev` if the repo has none, else
  // use `devpilot-integration` — either way created off the default branch. Only
  // arm auto-land once the branch provably exists on the remote; the land worker
  // opens PRs into it, so pointing at a missing branch would wedge every landing.
  // Best-effort: a GitHub failure here degrades to legacy direct-to-default
  // routing (integration_branch NULL, auto-land off) rather than failing the
  // whole create — the operator can arm it by hand from the Branch routing card.
  let integrationBranch: string | null = null;
  let autoLandEnabled = false;
  try {
    const devSha = await getBranchSha(
      { token },
      { owner: githubOwner, repo: githubRepo, branch: "dev" },
    );
    const plan = resolveConnectIntegrationBranch({
      devExists: devSha !== null,
      defaultBranch,
    });
    // Defensive: never store an integration branch equal to the production
    // branch (setIntegrationBranchAction rejects that; promotion would be a
    // no-op self-merge). Leaves the project on legacy routing in that edge case.
    if (plan.branch !== defaultBranch) {
      await ensureBranchFromBranch(
        { token },
        {
          owner: githubOwner,
          repo: githubRepo,
          sourceBranch: plan.sourceBranch,
          newBranch: plan.branch,
        },
      );
      integrationBranch = plan.branch;
      autoLandEnabled = true;
    }
  } catch (err) {
    console.warn(
      `[projects] connect-existing: couldn't resolve/seed an integration branch on ${githubOwner}/${githubRepo}; leaving auto-land off (operator can arm it later):`,
      err instanceof Error ? err.message : err,
    );
    integrationBranch = null;
    autoLandEnabled = false;
  }

  // Insert. Service role bypasses RLS — we authoritatively set tenant_id /
  // created_by from the verified caller context above.
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("projects")
    .insert({
      tenant_id: tenantId,
      name: parsed.data.name,
      description: null,
      repo_url: canonicalRepoUrl(githubOwner, githubRepo),
      github_repo_id: repo.id,
      github_owner: githubOwner,
      github_repo: githubRepo,
      default_branch: defaultBranch,
      team_tier: parsed.data.teamTier ?? DEFAULT_TEAM_TIER,
      project_type: parsed.data.projectType ?? DEFAULT_PROJECT_TYPE,
      stack_ecosystem: parsed.data.stackEcosystem ?? DEFAULT_ECOSYSTEM,
      ...llm.columns,
      // WI-4 — shared integration branch + auto-land, resolved above. NULL/false
      // when GitHub couldn't be reached to seed the branch (legacy routing).
      integration_branch: integrationBranch,
      auto_land_enabled: autoLandEnabled,
      // WI-14 follow-up - the operator's own visible choice on the create form
      // (pre-ticked, untickable), not a changed DB default. The column default
      // stays FALSE so no existing project is armed underneath its owner, and
      // an omitted field is read as false so a non-UI caller behaves exactly as
      // it did before this option existed.
      agent_ticket_creation: parsed.data.agentTicketCreation === true,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "insert failed" };
  }
  await persistProviderCredential(data.id as string, parsed.data.llm, user.id);

  // WI-15 — persist the committed stack. `tenant_id` is the verified caller's
  // (the service role above bypasses RLS, so this is the only thing standing
  // between a form post and a cross-tenant row); `toStackTags` drops any key
  // that isn't in the static catalog and re-derives every label from it, so
  // nothing the client typed can reach a prompt. Best-effort by design: the
  // project already exists, and a failed tag insert must not fail the create.
  //
  // Stage 8 (import → advisor bridge). This is the ONE moment a detected
  // service may become a durable advisor row: the operator has just CONFIRMED
  // the pre-ticked set by submitting this form. Detection is still a
  // suggestion, not a decision — nothing was written while they were looking at
  // the picker, and unticking a wrong guess there is what keeps it out of here.
  //
  // Detected services that fill a capability slot become capability-keyed rows
  // (`source: "detected"`), so the stack advisor — which self-loads the
  // project's saved selection — opens pre-filled on this import, and
  // `runStackAdvisorAction` feeds them to the ranker as `currentSelections`.
  // Everything else (manually-ticked services, zero-capability services like
  // Terraform, and the loser of a same-capability tiebreak) stays in the
  // `capability IS NULL` extras partition, exactly as before.
  const submittedTags = parsed.data.stackTags ?? [];
  const bridge = planDetectedStackSelection(
    submittedTags.filter((t) => t.source === "detected").map((t) => t.serviceKey),
  );
  const extraTags = toStackTags([
    ...submittedTags.filter((t) => t.source !== "detected"),
    ...bridge.extraServiceKeys.map((serviceKey) => ({
      serviceKey,
      source: "detected" as const,
    })),
  ]);
  await insertProjectStackTags({
    tenantId,
    projectId: data.id as string,
    tags: extraTags,
  });
  await persistStackSelection({
    tenantId,
    projectId: data.id as string,
    selections: bridge.selections,
    source: "detected",
  });

  // Auto-activate so the topbar switcher and the board immediately reflect
  // the new project. Without this the operator has to click into the
  // switcher and pick it manually after every create.
  await setCurrentProjectIdCookie(data.id as string);

  revalidatePath("/projects");
  revalidatePath("/board");
  return { ok: true, projectId: data.id as string };
}

// ─── 1b. document upload → project seed (create-new form only) ──────────────

export type ExtractProjectSeedActionResult =
  | {
      ok: true;
      name: string;
      description: string;
      instructions: string;
      /** True when the LLM distill couldn't run (no runner / timeout / bad
       *  reply) and we fell back to the raw extracted text as the description.
       *  The UI shows a gentler "we couldn't fully distill it" note. */
      degraded: boolean;
    }
  | { ok: false; error: string };

/**
 * Parse an uploaded spec/PRD/notes document (md/txt inline, PDF + docx via
 * pinned server-side extractors) and distill it into a `{name, description,
 * instructions}` seed the create-new form pre-fills. Parse-and-discard: the
 * file is never persisted (no Supabase Storage).
 *
 * `ok:false` is a HARD reject of an unusable FILE (unknown type / oversized /
 * empty / unreadable). A failing DISTILL never returns `ok:false` — it degrades
 * to the raw text as the description (`degraded:true`), so a downed runner can't
 * block the create. The operator reviews/edits every field before submitting,
 * which is the trust control for this attacker-influenced content.
 */
export async function extractProjectSeedAction(
  formData: FormData,
): Promise<ExtractProjectSeedActionResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: "No file was uploaded." };
  }

  const extracted = await extractUploadText(file);
  if (!extracted.ok) return { ok: false, error: extracted.error };

  const { seed, degraded } = await distillProjectSeed({ tenantId, docText: extracted.text });
  return {
    ok: true,
    name: seed.name,
    description: seed.description,
    instructions: seed.instructions,
    degraded,
  };
}

// ─── 2. create new repo + auto-scaffold ────────────────────────────────────

export type CreateProjectWithNewRepoResult =
  | {
      ok: true;
      projectId: string;
      /** The scaffolder ticket filed + dispatched inline for this genuinely-new,
       *  empty repo — set on both planning modes (the empty repo needs a
       *  skeleton regardless). Undefined only if the ticket insert itself failed,
       *  which returns `ok: false` instead. */
      scaffoldTicketId?: string;
      /** Set when `generatePlan: true` and the session insert succeeded. */
      planSessionId?: string;
    }
  | { ok: false; error: string };

/**
 * Create a fresh GitHub repo under the authenticated user's account, insert
 * the project row, file a `project_scaffolder` ticket, and emit the dispatch
 * event so the runner pulls the scaffolder immediately. The scaffolder commits
 * locally; the user reviews and pushes in `/changes` (M5c).
 */
export async function createProjectWithNewRepoAction(input: {
  name: string;
  description: string;
  private?: boolean;
  generatePlan?: boolean;
  instructions?: string;
  teamTier?: TeamTier;
  projectType?: ProjectType;
  stackEcosystem?: EcosystemChoice;
  stackTags?: StackTagInput[];
  llm?: LlmProviderFormInput;
  /** Arm `devpilot_create_ticket` for the new project. Absent = false. */
  agentTicketCreation?: boolean;
}): Promise<CreateProjectWithNewRepoResult> {
  const user = await requireUser();
  const tenantId = await requireTenantId();

  const parsed = CreateNewSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }

  // WI-12 — validate the LLM provider BEFORE we create a GitHub repo. This action
  // has real side effects on the operator's account; a base URL we're going to
  // refuse should fail the request while it's still cheap to fail.
  const llm = await validateProviderColumns(parsed.data.llm);
  if (!llm.ok) return { ok: false, error: llm.error };

  const token = await getGithubAccessToken(user.id);
  if (!token) {
    return {
      ok: false,
      error: "GitHub not connected. Connect at Settings → GitHub integration first.",
    };
  }

  // GitHub doesn't accept spaces / most punctuation in repo names. Coerce
  // the operator-supplied name into a slug rather than rejecting outright —
  // they can always rename on GitHub later. The DISPLAY name (saved in the
  // projects row) stays human-readable.
  const repoName =
    parsed.data.name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "devpilot-project";

  // Create the repo. `auto_init: false` is important — A3's scaffolder role
  // wants an empty unborn branch so the first commit it produces is the seed
  // (rather than a fight with GitHub's default README).
  let createdRepo;
  try {
    createdRepo = await createRepoForAuthenticatedUser(
      { token },
      {
        name: repoName,
        description: sanitizeGithubDescription(parsed.data.description),
        private: parsed.data.private ?? true,
        auto_init: false,
      },
    );
  } catch (err) {
    // Log the full GitHub response so the operator (and us) can see the
    // actual reason — the user-facing string only carries the generic top
    // level message, which on 422 is just "Repository creation failed."
    if (err instanceof GithubApiError) {
      console.error("[projects/create] createRepoForAuthenticatedUser failed:", {
        status: err.status,
        message: err.githubMessage,
        docs: err.documentationUrl,
        errors: err.githubErrors,
        repoName,
        private: parsed.data.private ?? true,
      });
    } else {
      console.error("[projects/create] non-github error:", err);
    }
    return { ok: false, error: githubErrorMessage(err, "create") };
  }

  // 2026-06-08 hotfix — immediately seed `main` so the empty repo gets a
  // stable trunk BEFORE the scaffolder ticket lands its first commit on
  // devpilot/<slug>. Without this seed, the scaffolder's push creates devpilot/<slug>
  // as the only branch and GitHub auto-promotes it to default — leaving
  // every subsequent ticket pushing into a per-ticket branch as its
  // integration target. The PUT /contents/README.md call creates `main`
  // with a single README commit; the PATCH ensures default_branch=main
  // even on GitHub accounts whose default branch name preference isn't
  // "main".
  //
  // Both calls are best-effort: a failure here logs a warning but doesn't
  // fail the project create. Worst case is the operator hits the missing-
  // main branch error on first push and seeds main themselves — recoverable.
  const ownerLoginFromCreate = createdRepo.full_name.split("/")[0]!;
  try {
    await seedRepoMainBranch(
      { token },
      {
        owner: ownerLoginFromCreate,
        repo: repoName,
        branch: "main",
        displayName: parsed.data.name,
      },
    );
    await setRepoDefaultBranch(
      { token },
      { owner: ownerLoginFromCreate, repo: repoName, branch: "main" },
    );
  } catch (err) {
    console.warn(
      `[projects/create] failed to seed main branch on ${ownerLoginFromCreate}/${repoName}; operator will need to create it manually on github.com:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Seed the integration branch (`dev`) off `main` so the runner's
  // `git clone --branch dev` doesn't fail on the first dispatch. Without
  // this, every new project would dead-end its first engineer ticket with
  // `fatal: Remote branch dev not found in upstream origin` — exactly the
  // cert-radar failure we hit. Idempotent: if `dev` already exists from a
  // retry, ensureBranchFromBranch returns created=false without error.
  //
  // WI-4 — `devReady` is what makes the dev seed RELIABLE rather than
  // fire-and-forget: we ARM auto-land (below) only when `dev` provably exists
  // on the remote. The land worker opens squash-merge PRs whose base is `dev`,
  // so arming against a `dev` that failed to seed would wedge every landing.
  // On failure the project is still created with integration_branch='dev' (so
  // ticket branches root there and the runner's local-seed fallback recovers),
  // but auto_land_enabled stays false → the half-configured banner on the
  // Branch routing card tells the operator to arm it once `dev` exists.
  let devReady = false;
  try {
    await ensureBranchFromBranch(
      { token },
      {
        owner: ownerLoginFromCreate,
        repo: repoName,
        sourceBranch: "main",
        newBranch: "dev",
      },
    );
    devReady = true;
  } catch (err) {
    // Soft failure — the project + main are already on GitHub. The first
    // dispatch will surface the missing-dev error if it really didn't get
    // created; the operator can create dev manually or clear
    // integration_branch.
    console.warn(
      `[projects/create] failed to seed dev branch on ${ownerLoginFromCreate}/${repoName}; auto-land will stay off until dev exists:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Insert the project row.
  const supabase = supabaseService();
  const ownerLogin = createdRepo.full_name.split("/")[0]!;
  const { data: projectRow, error: projectErr } = await supabase
    .from("projects")
    .insert({
      tenant_id: tenantId,
      name: parsed.data.name,
      description: parsed.data.description,
      repo_url: canonicalRepoUrl(ownerLogin, repoName),
      github_repo_id: createdRepo.id,
      github_owner: ownerLogin,
      github_repo: repoName,
      default_branch: sanitizeDefaultBranch(createdRepo.default_branch, "create new repo"),
      team_tier: parsed.data.teamTier ?? DEFAULT_TEAM_TIER,
      project_type: parsed.data.projectType ?? DEFAULT_PROJECT_TYPE,
      stack_ecosystem: parsed.data.stackEcosystem ?? DEFAULT_ECOSYSTEM,
      ...llm.columns,
      // Default to the dev integration branch we just seeded above. Ticket
      // branches will be cut from origin/dev and squash-merged back into it by
      // the land worker; the operator promotes dev → main as a separate step.
      // The BranchRoutingCard lets the operator change or clear this later.
      integration_branch: "dev",
      // WI-4 — arm auto-land by DEFAULT for the new-repo flow (owner decision),
      // but only when the `dev` seed above actually landed on the remote. A
      // failed seed leaves this false → the project is visibly half-configured
      // (banner) instead of silently trying to land into a branch that isn't
      // there.
      auto_land_enabled: devReady,
      // WI-14 follow-up - the operator's own visible choice on the create form
      // (pre-ticked, untickable), not a changed DB default. The column default
      // stays FALSE so no existing project is armed underneath its owner, and
      // an omitted field is read as false so a non-UI caller behaves exactly as
      // it did before this option existed.
      agent_ticket_creation: parsed.data.agentTicketCreation === true,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (projectErr || !projectRow) {
    return { ok: false, error: projectErr?.message ?? "project insert failed" };
  }
  const projectId = projectRow.id as string;
  await persistProviderCredential(projectId, parsed.data.llm, user.id);

  // WI-15 — same contract as the connect-existing path above: tenant_id from
  // the verified caller, keys and labels re-derived from the static catalog.
  // On this flow every tag is `manual` (the repo is created empty — `auto_init:
  // false` — so there is nothing to detect yet).
  const stackTags = toStackTags(parsed.data.stackTags ?? []);
  await insertProjectStackTags({ tenantId, projectId, tags: stackTags });

  // Scaffolder seed. This flow creates a genuinely-EMPTY repo (`auto_init:
  // false`), so it is the ONE place that must guarantee a scaffold ticket — the
  // repo has no skeleton otherwise. It is also the ONLY place that may ever
  // INSERT one.
  //
  // This used to be DEFERRED to planConsolidatorFn when `generatePlan=true`, on
  // the theory that the scaffolder should wait for the plan. That deferral was
  // the bug (Part D): the consolidator fired its scaffolder on EVERY successful
  // plan build — including existing/connect-existing projects that need no
  // scaffold — and BEFORE the plan was committed, injecting a redundant
  // scaffolder that duplicated the plan's own scaffold work. The guarantee now
  // lives here, where "genuinely new + empty" is actually known; the
  // consolidator no longer files a scaffolder at all.
  //
  // The plan-informed scaffolder does NOT re-open that door: the row below stays
  // the single creator, and plan mode only changes the STATE it is born in.
  //
  //   • no plan → `ready` + dispatch now. Byte-for-byte the old behaviour;
  //     there is no plan to wait for.
  //   • plan    → HELD at `backlog`, undispatched. `commitPlanAction` RELEASES
  //     this same row with the plan's context (and roots the committed backlog
  //     on it); the delayed `scaffolderFallbackFn` releases it with base context
  //     if the plan is never committed, so the empty-repo guarantee holds either
  //     way. Neither path inserts.
  //
  // `requested_role: project_scaffolder` matches the slug A3 registers in the
  // materializer. tickets has no created_by column today; identity is implicit
  // from the tenant + the request session.
  let planSessionId: string | undefined;
  const seed = decideScaffolderSeed({ generatePlan: parsed.data.generatePlan === true });

  const { data: ticketRow, error: ticketErr } = await supabase
    .from("tickets")
    .insert({
      tenant_id: tenantId,
      project_id: projectId,
      title: `Scaffold project: ${parsed.data.name}`,
      description: parsed.data.description,
      status: seed.status,
      requested_role: SCAFFOLDER_ROLE_SLUG,
      // The durable identity of a held instance. Everything downstream keys on
      // THIS, not on "a scaffolder sitting in backlog": it is the release's
      // atomic claim, it is what the `→ ready` gate refuses on, and clearing it
      // at release is what stops the sleeping TTL fallback from ever picking the
      // row up a second time.
      plan_hold: seed.planHold,
    })
    .select("id")
    .single();
  if (ticketErr || !ticketRow) {
    // The repo + project are created; surface a partial-success error so the
    // operator can manually file the ticket from the board if they want.
    return {
      ok: false,
      error: `Project created but scaffold ticket failed: ${ticketErr?.message ?? "unknown"}. File a project_scaffolder ticket from the board to retry.`,
    };
  }
  const scaffoldTicketId = ticketRow.id as string;

  // Emit the dispatch event. The engine picks up "ready" tickets via this
  // hook rather than polling — matches the existing pattern in
  // `lib/board/transitions.ts`.
  if (seed.dispatchNow) {
    try {
      await sendEventBounded({
        name: "ticket/dispatch-needed",
        data: { ticketId: scaffoldTicketId, tenantId },
      });
    } catch (err) {
      // The ticket is already "ready" in the DB; a missed dispatch event means
      // the next state transition (or the stale-run reaper) will pick it up.
      // Don't fail the action over a flaky inngest send.
      console.warn(
        `[createProjectWithNewRepoAction] inngest.send failed for ticket ${scaffoldTicketId}: ${String(err)}`,
      );
    }
  }

  // Arm the abandonment fallback for a HELD scaffolder. This is what keeps the
  // empty-repo guarantee true when the operator opens a plan and never commits
  // it: after a TTL, `scaffolderFallbackFn` releases the still-held row with
  // base context. Idempotent by construction - it claims on the still-held
  // state, so it is a no-op once `commitPlanAction` has released the row.
  //
  // Best-effort send, but the failure is NOT silent: with the event lost the
  // ticket simply sits in `backlog` where the operator can see it and move it
  // to Ready themselves. That is a visible, recoverable state, not a wedge -
  // the same posture as the dispatch send above, and the reason a flaky Inngest
  // must not fail a create whose repo already exists on GitHub.
  if (seed.scheduleFallback) {
    try {
      await sendEventBounded({
        name: "project/scaffolder-held",
        data: { ticketId: scaffoldTicketId, tenantId, projectId },
      });
    } catch (err) {
      console.warn(
        `[createProjectWithNewRepoAction] scaffolder-held send failed for ticket ${scaffoldTicketId}: ${String(err)}. ` +
          "The scaffolder stays in Backlog until the plan is committed or an operator moves it.",
      );
    }
  }

  if (parsed.data.generatePlan) {
    // Spin up a planning_session so the user can refine the backlog with the
    // lead agent while the scaffolder seeds the repo in parallel. Failure here
    // is soft — the project + scaffolder are already created; we just don't
    // carry forward a planSessionId, and the operator can start a plan manually
    // from the project page.
    try {
      const { startPlanSessionAction } = await import("@/app/(app)/plan/actions");
      // Seed the session's soft flavor FROM the ecosystem commitment (falling
      // back to the hard tags) rather than pinning it to "mixed" (WI-15,
      // extended by the stack advisor). The tags/ecosystem are authoritative
      // in the prompt, so a hardcoded flavor here would be a second, weaker
      // framing that can silently contradict them - an all-OSS project being
      // told "no strict preference" on every panel run. With no ecosystem
      // committed and no tags picked, `deriveStackFlavorFromEcosystem` returns
      // "mixed", which is exactly the previous behaviour.
      // When a document seeded the create, the distilled detail arrives as
      // `instructions` and enriches the plan opener as a richer FIRST user
      // message — startPlanSessionAction and the planner prompts stay untouched;
      // the doc detail is just more of what the operator would have typed. Cap
      // the composed opener to the plan action's 65,536-char ceiling so the Zod
      // bound never bounces the whole create.
      const instructions = parsed.data.instructions?.trim() ?? "";
      const opener = instructions
        ? `${parsed.data.description}\n\n## Detail from uploaded document\n${instructions}`
        : parsed.data.description;
      const planRes = await startPlanSessionAction({
        projectId,
        stackFlavor: deriveStackFlavorFromEcosystem(
          parsed.data.stackEcosystem ?? DEFAULT_ECOSYSTEM,
          stackTags,
        ),
        stackPreferences: "",
        openingMessage: opener.slice(0, 65_536),
      });
      if (planRes.ok) {
        planSessionId = planRes.sessionId;
      } else {
        console.warn(
          `[createProjectWithNewRepoAction] plan session start failed for project ${projectId}: ${planRes.error}`,
        );
      }
    } catch (err) {
      console.warn(
        `[createProjectWithNewRepoAction] plan session start threw for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Auto-activate so the next render of /board (or /changes) is scoped to
  // the freshly-created project — the scaffold ticket about to be picked up
  // will be visible right away.
  await setCurrentProjectIdCookie(projectId);

  revalidatePath("/projects");
  revalidatePath("/board");
  return {
    ok: true,
    projectId,
    ...(scaffoldTicketId ? { scaffoldTicketId } : {}),
    ...(planSessionId ? { planSessionId } : {}),
  };
}

// ─── 2b. detect the stack of a repo the operator is about to connect ───────

export type DetectStackTagsResult =
  | { ok: true; serviceKeys: string[] }
  | { ok: false; error: string };

/**
 * Fingerprint a repo's manifests (package.json, lockfiles, Dockerfile,
 * terraform) against the static service catalog so the create form can PRE-TICK
 * the operator's stack instead of making them hand-pick from a 30-entry grid.
 *
 * This is a read-only convenience with no side effects — it persists nothing.
 * The operator's confirmation in the picker is what turns a detection into a
 * saved tag, which is the control that keeps ATTACKER-CONTROLLED repo content
 * from auto-trusting itself into the top of a plan prompt (see the threat model
 * in lib/stack/detect-stack-tags.ts).
 *
 * We return only catalog KEYS. No string read from the repo crosses this
 * boundary — the client renders labels from its own copy of the catalog.
 * Failure is soft everywhere: an unparseable URL, a repo the token can't see,
 * or a GitHub outage yields an empty/error result and the operator just picks
 * their stack by hand.
 */
export async function detectStackTagsAction(input: {
  repoUrl: string;
}): Promise<DetectStackTagsResult> {
  const user = await requireUser();
  // Not used for a write, but this action reads a private repo through the
  // caller's token — keep it behind the same tenant guard as every other entry
  // point rather than leaving an authenticated-but-unscoped hole.
  await requireTenantId();

  const parsed = DetectStackSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const parts = parseRepoUrl(parsed.data.repoUrl);
  if (!parts) return { ok: false, error: "Not a github.com repo URL." };

  const token = await getGithubAccessToken(user.id);
  if (!token) return { ok: false, error: "GitHub not connected." };

  let repo;
  try {
    repo = await getRepo({ token }, parts.owner, parts.repo);
  } catch {
    return { ok: false, error: "Couldn't reach GitHub to scan the repo." };
  }
  if (!repo) return { ok: false, error: "Repo not found with your token's scopes." };

  const slashIdx = repo.full_name.indexOf("/");
  const entries = await scanRepoForStackTags({
    owner: slashIdx > 0 ? repo.full_name.slice(0, slashIdx) : parts.owner,
    repo: repo.name,
    branch: sanitizeDefaultBranch(repo.default_branch, "detect stack tags"),
    token,
  });
  return { ok: true, serviceKeys: entries.map((e) => e.key) };
}

// ─── 3. delete project ─────────────────────────────────────────────────────

export type DeleteProjectResult = { ok: true } | { ok: false; error: string };

/**
 * Hard-delete a project. The `tickets.project_id` FK uses ON DELETE SET NULL,
 * so existing tickets remain visible (they fall through to the legacy
 * ENGINEER_REPO_URL path). The GitHub repo itself is NOT deleted — that's the
 * user's call on github.com.
 */
export async function deleteProjectAction(input: {
  projectId: string;
}): Promise<DeleteProjectResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = DeleteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }

  const supabase = supabaseService();
  const { data: project, error: lookupErr } = await supabase
    .from("projects")
    .select("id, tenant_id")
    .eq("id", parsed.data.projectId)
    .maybeSingle();
  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!project) return { ok: false, error: "project not found" };
  if (project.tenant_id !== tenantId) return { ok: false, error: "forbidden" };

  const { error: delErr } = await supabase
    .from("projects")
    .delete()
    .eq("id", parsed.data.projectId);
  if (delErr) return { ok: false, error: delErr.message };

  // If the operator was viewing this project, clear the cookie too. Read via
  // the shared getter so the cookie name (and its legacy read-through) has one
  // owner in lib/projects/current.ts, not a second literal that can drift.
  const active = await getCurrentProjectIdFromCookie();
  if (active === parsed.data.projectId) {
    await setCurrentProjectIdCookie(null);
  }

  // Broad revalidation: deleting a project changes the layout-level switcher
  // list and — when it was the active one — the active-project context the
  // whole authenticated shell renders under. Mirror setActiveProjectAction's
  // layout-wide refresh so every surface (switcher, board, lists) drops it.
  revalidatePath("/", "layout");
  return { ok: true };
}

// ─── 4. set active project cookie ──────────────────────────────────────────

export type SetActiveProjectResult = { ok: true } | { ok: false; error: string };

/**
 * Persist the operator's active-project choice into a cookie the sidebar
 * switcher and project-aware pages (`/board`, `/changes`, `/runs`) read on
 * every server render. `null` clears the cookie — the next render then falls
 * back to the tenant's most-recent project (project-first; no "All projects").
 */
export async function setActiveProjectAction(input: {
  projectId: string | null;
}): Promise<SetActiveProjectResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = SetActiveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }

  // If a non-null projectId is set, verify it belongs to the caller's tenant
  // before we write the cookie. Otherwise a malicious POST could pin the
  // switcher to a foreign project; the downstream pages would still RLS-block
  // the data, but the UI would render confusingly.
  if (parsed.data.projectId) {
    const supabase = supabaseService();
    const { data: project, error } = await supabase
      .from("projects")
      .select("id, tenant_id")
      .eq("id", parsed.data.projectId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!project) return { ok: false, error: "project not found" };
    if (project.tenant_id !== tenantId) return { ok: false, error: "forbidden" };
  }

  await setCurrentProjectIdCookie(parsed.data.projectId);
  // Re-scope every project-aware surface to the new cookie in one shot. Without
  // this the client Router Cache can serve a sibling tab (/runs, /changes, …)
  // rendered under the PREVIOUS project — the intermittent "stale context"
  // after a switch. Broad on purpose: the active project touches the entire
  // authenticated shell (tabs, board, lists, detail pages).
  revalidatePath("/", "layout");
  return { ok: true };
}

// ===========================================================================
// renameProjectAction — change the LOCAL display label only.
//
// The "name" column is the operator's chosen label for the project, kept
// separate from the GitHub repo's `full_name`. Renaming here doesn't touch
// the GitHub repo or any of the github_* columns — purely cosmetic on the
// DevPilot side. Project switcher + cards + detail header all re-read this on
// the next render (server components + router.refresh() in the caller).

const RenameSchema = z.object({
  projectId: z.string().uuid("projectId must be a uuid"),
  name: NameSchema,
});

export type RenameProjectResult = { ok: true } | { ok: false; error: string };

export async function renameProjectAction(
  input: z.infer<typeof RenameSchema>,
): Promise<RenameProjectResult> {
  const parsed = RenameSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();

  const service = supabaseService();
  // Race-guarded UPDATE: tenant_id filter doubles as the ownership gate so
  // a stale projectId from another tenant just no-ops.
  const { data, error } = await service
    .from("projects")
    .update({ name: parsed.data.name })
    .eq("id", parsed.data.projectId)
    .eq("tenant_id", tenantId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "project not found" };
  }
  return { ok: true };
}

// ===========================================================================
// updateProjectTeamTierAction — change the project's default tier.
//
// The tier drives roster + ticket-count caps on every planning session that
// inherits from the project (the per-session override lives on
// planning_sessions.team_tier). Race-guarded on tenant_id so a stale projectId
// from another tenant just no-ops.

const UpdateTeamTierSchema = z.object({
  projectId: z.string().uuid("projectId must be a uuid"),
  teamTier: z.enum(TEAM_TIER_ENUM),
});

export type UpdateProjectTeamTierResult = { ok: true } | { ok: false; error: string };

export async function updateProjectTeamTierAction(
  input: z.infer<typeof UpdateTeamTierSchema>,
): Promise<UpdateProjectTeamTierResult> {
  const parsed = UpdateTeamTierSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();

  const service = supabaseService();
  const { data, error } = await service
    .from("projects")
    .update({ team_tier: parsed.data.teamTier })
    .eq("id", parsed.data.projectId)
    .eq("tenant_id", tenantId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "project not found" };
  }
  revalidatePath(`/projects/${parsed.data.projectId}`);
  return { ok: true };
}

// ===========================================================================
// refreshProjectFromGithubAction — re-read GitHub metadata and update the
// stored mirror.
//
// Looks up the project, queries GitHub for the current state, and writes
// repo_url + github_owner + github_repo + default_branch back into the row.
// Prefers `GET /repositories/{id}` (canonical, survives renames + owner
// transfers); falls back to `GET /repos/{owner}/{repo}` when the row was
// created before github_repo_id was stamped. GitHub returns 301 redirects
// on renames so even the fallback path catches a renamed repo, but the
// id-based lookup is the safer primary.
//
// Returns the new tuple + a `changed: boolean` so the client can toast
// usefully ("nothing to update" vs "updated utkarsh430/old → utkarsh430/new").

const RefreshSchema = z.object({
  projectId: z.string().uuid("projectId must be a uuid"),
});

export type RefreshProjectResult =
  | {
      ok: true;
      value: {
        changed: boolean;
        before: {
          repoUrl: string | null;
          githubOwner: string | null;
          githubRepo: string | null;
          defaultBranch: string | null;
        };
        after: {
          repoUrl: string;
          githubOwner: string;
          githubRepo: string;
          defaultBranch: string;
        };
      };
    }
  // `code: "repo_gone"` is set when GitHub no longer has the repo (deleted,
  // made private, or moved out of token reach). The client uses it to offer
  // removing the now-orphaned project instead of showing a dead-end error.
  | { ok: false; error: string; code?: "repo_gone" };

export async function refreshProjectFromGithubAction(
  input: z.infer<typeof RefreshSchema>,
): Promise<RefreshProjectResult> {
  const parsed = RefreshSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  const user = await requireUser();
  const tenantId = await requireTenantId();

  const service = supabaseService();
  const { data: row, error: lookupErr } = await service
    .from("projects")
    .select("id, tenant_id, repo_url, github_repo_id, github_owner, github_repo, default_branch")
    .eq("id", parsed.data.projectId)
    .maybeSingle();
  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!row) return { ok: false, error: "project not found" };
  if (row.tenant_id !== tenantId) return { ok: false, error: "forbidden" };

  // GitHub access token tied to the operator. We deliberately use the
  // caller's token rather than a service token because rate limits apply
  // per-user and the project's "real" owner may be a different account
  // (e.g. a personal repo connected to a workspace by a teammate).
  const token = await getGithubAccessToken(user.id);
  if (!token) {
    return {
      ok: false,
      error: "GitHub account not connected — open Settings → GitHub to authorise.",
    };
  }
  const auth = { token } as const;

  // Canonical lookup by stable numeric id when we have one; fall back to
  // owner/repo (GitHub follows 301 redirects internally so this still works
  // after a rename, but a transfer to a new owner could miss).
  let repo: Awaited<ReturnType<typeof getRepo>> = null;
  try {
    if (typeof row.github_repo_id === "number") {
      repo = await getRepoById(auth, row.github_repo_id);
    }
    if (!repo && row.github_owner && row.github_repo) {
      repo = await getRepo(auth, row.github_owner, row.github_repo);
    }
  } catch (err) {
    if (err instanceof GithubApiError) {
      return { ok: false, error: `GitHub API: ${err.message}` };
    }
    throw err;
  }
  if (!repo) {
    return {
      ok: false,
      error:
        "Couldn't find this repo on GitHub anymore — it may have been deleted, made private, or moved out of reach of your token.",
      code: "repo_gone",
    };
  }

  // `full_name` is the authoritative owner/repo pair. Derive the rest from it.
  const slashIdx = repo.full_name.indexOf("/");
  if (slashIdx < 1) {
    return {
      ok: false,
      error: `GitHub returned an unexpected full_name: ${repo.full_name}`,
    };
  }
  const nextOwner = repo.full_name.slice(0, slashIdx);
  const nextRepo = repo.full_name.slice(slashIdx + 1);
  const nextRepoUrl = canonicalRepoUrl(nextOwner, nextRepo);
  const nextBranch = sanitizeDefaultBranch(repo.default_branch, "refresh from github");

  const changed =
    row.repo_url !== nextRepoUrl ||
    row.github_owner !== nextOwner ||
    row.github_repo !== nextRepo ||
    row.default_branch !== nextBranch;

  if (changed) {
    const { error: updErr } = await service
      .from("projects")
      .update({
        repo_url: nextRepoUrl,
        github_repo_id: repo.id, // backfill for projects created before this column was populated
        github_owner: nextOwner,
        github_repo: nextRepo,
        default_branch: nextBranch,
      })
      .eq("id", parsed.data.projectId)
      .eq("tenant_id", tenantId);
    if (updErr) return { ok: false, error: updErr.message };
  }

  revalidatePath(`/projects/${parsed.data.projectId}`);
  revalidatePath("/projects");
  return {
    ok: true,
    value: {
      changed,
      before: {
        repoUrl: row.repo_url ?? null,
        githubOwner: row.github_owner ?? null,
        githubRepo: row.github_repo ?? null,
        defaultBranch: row.default_branch ?? null,
      },
      after: {
        repoUrl: nextRepoUrl,
        githubOwner: nextOwner,
        githubRepo: nextRepo,
        defaultBranch: nextBranch,
      },
    },
  };
}
