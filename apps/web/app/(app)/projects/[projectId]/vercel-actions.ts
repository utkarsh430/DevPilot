"use server";

// Server actions behind the DeploymentCard: link, create, unlink, change the
// production auto-deploy mode, push env vars, deploy, and roll back.
//
// Every export in a `"use server"` file is a browser-reachable endpoint, so the
// invariants below hold for all of them:
//
//   • The tenant id is derived from the SESSION, never taken from the caller.
//   • Every DB write carries a co-located `.eq("tenant_id", …)` (the writes live
//     in `lib/vercel/link-write.ts`, which exists so that predicate is testable).
//   • The gate is `isInstanceOperator`, matching the `operatorOnly` flag on the
//     three VERCEL_* catalog keys. Linking configures a production deploy target
//     using an instance-wide credential; a plain tenant member must not.
//   • The token never leaves `api.server.ts`. Nothing here returns it, logs it,
//     or puts it in a result — every message that reaches the UI has already
//     been through PR 1's `scrubSecrets`.
//   • No agent path. Linking is a human action; there is no MCP tool for it and
//     this file is not reachable from the runner.
//
// ── The one behaviour worth reading the code for ───────────────────────────
// Linking a repo to Vercel ARMS push-to-deploy: every push to the Vercel
// project's production branch goes live, with no approval. DevPilot's agents push
// constantly and auto-land merges on its own, so linking naively would hand
// every agent a production deploy button.
//
// So `mode` is a REQUIRED argument with no default anywhere in the stack — the
// UI makes the operator pick before the button enables, so neither outcome can
// be a side effect of clicking "Link". Whichever they pick is then VERIFIED by
// reading the project back from Vercel; when the read-back does not confirm it,
// the action returns `ok: true` with a populated `warning`. The link is real and
// must be recorded either way (an armed project DevPilot knows about can be shown
// and fixed; one it has lost track of cannot), but it never reports a gate it
// did not observe.
//
// The production BRANCH is a second, separate axis, and DevPilot cannot write it
// at all: `link.productionBranch` is read-only in Vercel's REST API. So the
// operator's expected branch is recorded and compared against the live value,
// and a mismatch produces a warning naming the exact dashboard steps. A setting
// we cannot change is not a reason to leave it unmentioned.

import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { isInstanceOperator } from "@/lib/platform-secrets/operator";
import { supabaseService } from "@/lib/db/server";
import { loadProjectById } from "@/lib/projects/load";
import { resolveVercelConfig } from "@/lib/vercel/api.server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import {
  createVercelDeployment,
  createVercelProject,
  getVercelProject,
  listVercelProjects,
  listVercelRollbackCandidates,
  promoteVercelDeployment,
  rollbackVercelDeployment,
  setProductionGitAutoDeploy,
  type VercelClientOptions,
} from "@/lib/vercel/api";
import { runVercelPreflightForTenant } from "@/lib/vercel/api.server";
import { VercelApiError } from "@/lib/vercel/errors";
import {
  decideLinkGate,
  decideRepoMatch,
  deriveVercelProjectName,
  isValidVercelProjectName,
} from "@/lib/vercel/link";
import {
  decideBranchAlignment,
  isProdDeployMode,
  type ProdDeployMode,
} from "@/lib/vercel/deploy-policy";
import { decideProductionDeployGate, type DeployTarget } from "@/lib/vercel/deploy-state";
import { absoluteUrl } from "@/lib/vercel/deploy-poll";
import {
  listProjectDeployments,
  upsertDeploymentRecord,
  writeProductionUrl,
  type DeploymentRecord,
} from "@/lib/vercel/deploy-write";
import { listProductionDeployments, recordProductionPointer } from "@/lib/vercel/rollback-write";
import {
  classifyPromoteTarget,
  decideRollbackGate,
  describeAliasOutcome,
  describeRollbackState,
  isAliasJobInFlight,
  planRollbackTargets,
  ROLLBACK_WARNINGS,
  type RollbackBanner,
  type RollbackTarget,
} from "@/lib/vercel/rollback-state";
import { loadVercelLinkStatus } from "@/lib/vercel/link.server";
import {
  clearVercelLink,
  writeDesiredProductionBranch,
  writeProdDeployMode,
  writeVercelLink,
} from "@/lib/vercel/link-write";
import {
  buildEnvPushPlan,
  executeEnvPush,
  type EnvPushOutcome,
} from "@/lib/vercel/env-push.server";
import type { EnvPushPlan } from "@/lib/vercel/env-plan";
import { SECRET_KEY_RE } from "@/lib/board/secret-request-keys";
import type { ProjectRecord } from "@/lib/projects/load";

export type ActionResult<T = undefined> =
  | { ok: true; value: T; warning?: string }
  | { ok: false; error: string; href?: string };

/** Resolve the caller, the project, and the Vercel client in one place, with
 *  every gate applied. Returns a refusal rather than throwing so each action's
 *  happy path stays flat. */
async function authorize(projectId: string): Promise<
  | {
      ok: true;
      tenantId: string;
      userId: string;
      project: ProjectRecord;
      opts: VercelClientOptions;
    }
  | { ok: false; error: string; href?: string }
> {
  const user = await requireUser();
  const tenantId = await requireTenantId();
  if (!(await isInstanceOperator(user.id))) {
    return {
      ok: false,
      error: "Only an instance operator can change a project's Vercel deployment settings.",
    };
  }
  const project = await loadProjectById(projectId);
  if (!project) return { ok: false, error: "Project not found." };
  // `loadProjectById` is service-role and keyed on the id alone, so this
  // comparison is the tenant boundary for the READ. The writes carry their own
  // predicate; both are required.
  if (project.tenantId !== tenantId) {
    return { ok: false, error: "Project does not belong to your tenant." };
  }

  const config = await resolveVercelConfig(tenantId);
  const token = (config.token ?? "").trim();
  if (token.length === 0) {
    return {
      ok: false,
      error: "No Vercel token is configured for this instance.",
      href: "/settings/platform-secrets",
    };
  }
  return {
    ok: true,
    tenantId,
    userId: user.id,
    project,
    opts: {
      credential: { token, teamId: config.teamId },
      fetchImpl: (url, init) => fetch(url, init),
    },
  };
}

function errorMessage(err: unknown, fallback: string): string {
  // `VercelApiError.message` is already scrubbed and operator-facing.
  if (err instanceof VercelApiError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

// ── Read: the pick-list for "link an existing project" ──────────────────────

export type VercelProjectOption = {
  id: string;
  name: string | null;
  /** "owner/repo", or null for a sourceless Vercel project. */
  repo: string | null;
  productionBranch: string | null;
};

export async function listVercelProjectsAction(
  projectId: string,
): Promise<ActionResult<VercelProjectOption[]>> {
  const auth = await authorize(projectId);
  if (!auth.ok) return auth;
  try {
    const projects = await listVercelProjects(auth.opts, { limit: 100 });
    return {
      ok: true,
      value: projects.map((p) => ({
        id: p.id,
        name: p.name,
        repo: p.link?.org && p.link?.repo ? `${p.link.org}/${p.link.repo}` : null,
        productionBranch: p.link?.productionBranch ?? null,
      })),
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err, "Could not list Vercel projects.") };
  }
}

// ── Shared tail: apply the safety decision, verify it, record the link ──────

/**
 * Apply the operator's auto-deploy choice, verify it against Vercel, and persist
 * the link.
 *
 * The ordering matters. The gate is applied BEFORE the link is recorded, so a
 * failure to persist leaves the safer state on Vercel rather than an armed
 * project DevPilot has forgotten about. And the link IS recorded even when the
 * gate could not be confirmed — an armed project DevPilot knows about can be
 * shown, warned about and fixed from the card; one it has lost track of cannot.
 */
async function finalizeLink(args: {
  tenantId: string;
  userId: string;
  projectId: string;
  vercelProjectId: string;
  vercelProjectName: string | null;
  githubOwner: string;
  githubRepo: string;
  mode: ProdDeployMode;
  /** The branch the operator expects production to track. Recorded, not applied
   *  — Vercel's API has no write path for it (see deploy-policy.ts). */
  desiredBranch: string | null;
  opts: VercelClientOptions;
}): Promise<ActionResult<{ vercelProjectId: string }>> {
  const gate = await setProductionGitAutoDeploy(
    {
      projectId: args.vercelProjectId,
      org: args.githubOwner,
      repo: args.githubRepo,
      enabled: args.mode === "git_auto",
    },
    args.opts,
  );

  const productionBranch = gate.project?.link?.productionBranch ?? null;

  const write = await writeVercelLink(supabaseService(), args.tenantId, {
    projectId: args.projectId,
    vercelProjectId: args.vercelProjectId,
    vercelProjectName: args.vercelProjectName,
    productionBranch,
    prodDeployMode: args.mode,
    desiredProductionBranch: args.desiredBranch,
    linkedBy: args.userId,
    linkedAt: new Date().toISOString(),
  });
  if (!write.ok) {
    return { ok: false, error: `Linked on Vercel, but recording it failed: ${write.error}` };
  }

  revalidatePath(`/projects/${args.projectId}`);

  // The honesty branches. Two separate things can be wrong, and collapsing them
  // would hide one behind the other.
  const warnings: string[] = [];

  // (1) `applied` means "we re-read the project and Vercel reports the state we
  //     asked for" — NOT "the PATCH returned 200".
  if (args.mode === "devpilot_gated" && !gate.applied) {
    warnings.push(
      "DevPilot could NOT confirm that git pushes are blocked from deploying to production. " +
        `Treat ${productionBranch ? `"${productionBranch}"` : "the production branch"} as live: any push to it may deploy automatically. ` +
        "Check Settings → Git on the Vercel dashboard and disable production deployments there if you need that guarantee." +
        (gate.error ? ` (${gate.error.message})` : ""),
    );
  }

  // (2) The production branch itself. DevPilot cannot set it — it is read-only in
  //     Vercel's API — so when it does not already match, the operator has a
  //     manual step and must be told at the moment of linking rather than
  //     discovering it when the wrong branch goes live.
  const alignment = decideBranchAlignment({
    desiredBranch: args.desiredBranch,
    liveBranch: productionBranch,
    branchIsStale: gate.project === null,
  });
  if (alignment.status === "misaligned" || alignment.status === "unknown") {
    warnings.push(`${alignment.summary} ${alignment.manualSteps.join(" ")}`.trim());
  }

  return {
    ok: true,
    value: { vercelProjectId: args.vercelProjectId },
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}

/** The gate every link/create path runs, plus the repo fields both need. */
async function gateLink(
  auth: Extract<Awaited<ReturnType<typeof authorize>>, { ok: true }>,
): Promise<
  { ok: true; owner: string; repo: string } | { ok: false; error: string; href?: string }
> {
  const { project } = auth;
  // The preflight is the ONLY thing that can tell a missing Vercel-for-GitHub
  // App apart from a malformed request, and without it `POST /v11/projects`
  // fails with a 400 naming neither the account nor the fix.
  let preflight = null;
  try {
    preflight = await runVercelPreflightForTenant(project.tenantId);
  } catch {
    preflight = null;
  }
  const decision = decideLinkGate({
    preflight,
    hasRepo: Boolean(project.githubOwner && project.githubRepo),
    alreadyLinked: Boolean(project.vercelProjectId),
    isOperator: true, // already enforced in `authorize`
  });
  if (!decision.ok) {
    return { ok: false, error: decision.refusal.message, href: decision.refusal.href };
  }
  return { ok: true, owner: project.githubOwner!, repo: project.githubRepo! };
}

// ── Link an existing Vercel project ─────────────────────────────────────────

export async function linkVercelProjectAction(input: {
  projectId: string;
  vercelProjectId: string;
  mode: ProdDeployMode;
  /** Blank falls back to the project's integration branch — DevPilot's intended
   *  shape is production tracking the branch auto-land merges into, with the
   *  default branch human-promoted from it. */
  desiredBranch?: string;
}): Promise<ActionResult<{ vercelProjectId: string }>> {
  const auth = await authorize(input.projectId);
  if (!auth.ok) return auth;
  if (!isProdDeployMode(input.mode)) {
    return { ok: false, error: "Unknown production deploy mode." };
  }
  const gated = await gateLink(auth);
  if (!gated.ok) return gated;

  let vercelProject;
  try {
    vercelProject = await getVercelProject(input.vercelProjectId, auth.opts);
  } catch (err) {
    return { ok: false, error: errorMessage(err, "Could not read that Vercel project.") };
  }

  // Refusing a repo mismatch is the point: a Vercel project pointing at a
  // different repo would deploy someone else's code while DevPilot's UI
  // attributes it to this project. See `decideRepoMatch`.
  const match = decideRepoMatch({
    project: vercelProject,
    githubOwner: gated.owner,
    githubRepo: gated.repo,
  });
  if (match.kind === "mismatch") {
    return {
      ok: false,
      error:
        `That Vercel project is linked to "${match.linkedTo}", but this DevPilot project is ` +
        `"${gated.owner}/${gated.repo}". Linking them would deploy the wrong codebase. ` +
        "Pick the Vercel project for this repo, or create a new one.",
    };
  }

  return finalizeLink({
    tenantId: auth.tenantId,
    userId: auth.userId,
    projectId: input.projectId,
    vercelProjectId: vercelProject.id,
    vercelProjectName: vercelProject.name,
    githubOwner: gated.owner,
    githubRepo: gated.repo,
    mode: input.mode,
    desiredBranch: resolveDesiredBranch(auth.project, input.desiredBranch),
    opts: auth.opts,
  });
}

// ── Create a new Vercel project linked to this repo ─────────────────────────

export async function createVercelProjectAction(input: {
  projectId: string;
  /** Operator-chosen name; blank derives one from the DevPilot project name. */
  name: string;
  mode: ProdDeployMode;
  /** See `linkVercelProjectAction`. */
  desiredBranch?: string;
}): Promise<ActionResult<{ vercelProjectId: string }>> {
  const auth = await authorize(input.projectId);
  if (!auth.ok) return auth;
  if (!isProdDeployMode(input.mode)) {
    return { ok: false, error: "Unknown production deploy mode." };
  }
  const gated = await gateLink(auth);
  if (!gated.ok) return gated;

  const typed = input.name.trim();
  const name = typed.length > 0 ? typed : (deriveVercelProjectName(auth.project.name) ?? "");
  if (!isValidVercelProjectName(name)) {
    return {
      ok: false,
      error:
        "Vercel project names must be 1-100 characters of lowercase letters, digits, `.`, `_` or `-`, and cannot contain `---`.",
    };
  }

  let created;
  try {
    created = await createVercelProject({ name, repo: `${gated.owner}/${gated.repo}` }, auth.opts);
  } catch (err) {
    if (err instanceof VercelApiError && err.kind === "git_integration_missing") {
      return {
        ok: false,
        error:
          "Vercel refused to link the repository because the Vercel for GitHub App is not installed on that GitHub account. " +
          'Install it (choose "All repositories"), then try again.',
        href: "https://github.com/apps/vercel/installations/new",
      };
    }
    return { ok: false, error: errorMessage(err, "Could not create the Vercel project.") };
  }

  return finalizeLink({
    tenantId: auth.tenantId,
    userId: auth.userId,
    projectId: input.projectId,
    vercelProjectId: created.id,
    vercelProjectName: created.name,
    githubOwner: gated.owner,
    githubRepo: gated.repo,
    mode: input.mode,
    desiredBranch: resolveDesiredBranch(auth.project, input.desiredBranch),
    opts: auth.opts,
  });
}

// ── Change the production auto-deploy mode on an already-linked project ─────

export async function setVercelDeployModeAction(input: {
  projectId: string;
  mode: ProdDeployMode;
}): Promise<ActionResult<{ mode: ProdDeployMode }>> {
  const auth = await authorize(input.projectId);
  if (!auth.ok) return auth;
  if (!isProdDeployMode(input.mode)) {
    return { ok: false, error: "Unknown production deploy mode." };
  }
  const { project } = auth;
  if (!project.vercelProjectId) {
    return { ok: false, error: "This project isn't linked to Vercel yet." };
  }
  if (!project.githubOwner || !project.githubRepo) {
    return {
      ok: false,
      error:
        "This project has no GitHub repo recorded, so DevPilot cannot scope the deploy rule to it.",
    };
  }

  const gate = await setProductionGitAutoDeploy(
    {
      projectId: project.vercelProjectId,
      org: project.githubOwner,
      repo: project.githubRepo,
      enabled: input.mode === "git_auto",
    },
    auth.opts,
  );

  // Record the INTENT even when the gate did not confirm — the card compares
  // intent against the live state and surfaces the divergence, which it cannot
  // do if the intent was never written.
  const write = await writeProdDeployMode(supabaseService(), auth.tenantId, project.id, input.mode);
  if (!write.ok) return { ok: false, error: `Could not record the change: ${write.error}` };

  revalidatePath(`/projects/${project.id}`);

  if (input.mode === "devpilot_gated" && !gate.applied) {
    return {
      ok: true,
      value: { mode: input.mode },
      warning:
        "DevPilot asked Vercel to stop deploying git pushes to production, but could not confirm it took effect. " +
        "Assume production is still armed until you have checked Settings → Git on the Vercel dashboard." +
        (gate.error ? ` (${gate.error.message})` : ""),
    };
  }
  if (input.mode === "git_auto" && !gate.applied) {
    return {
      ok: true,
      value: { mode: input.mode },
      warning:
        "DevPilot could not confirm the change with Vercel. Production auto-deploy may not be enabled yet.",
    };
  }
  return { ok: true, value: { mode: input.mode } };
}

// ── Unlink ──────────────────────────────────────────────────────────────────

/**
 * Forget the link. DevPilot does NOT delete the Vercel project or change
 * anything on Vercel's side — an accidental unlink must not be able to destroy a
 * live deployment, and the operator can always relink.
 *
 * Note what this therefore does not do: if the project was left armed,
 * unlinking does not disarm it. The confirm copy says so.
 */
export async function unlinkVercelProjectAction(input: {
  projectId: string;
}): Promise<ActionResult> {
  const auth = await authorize(input.projectId);
  if (!auth.ok) return auth;
  const res = await clearVercelLink(supabaseService(), auth.tenantId, auth.project.id);
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath(`/projects/${auth.project.id}`);
  return { ok: true, value: undefined };
}

// ── PR 3: environment variables ─────────────────────────────────────────────
//
// Two actions, and the separation between them is the human checkpoint.
// `planVercelEnvPushAction` performs NO write and is what the dialog renders;
// `pushVercelEnvAction` writes, and it re-derives the plan server-side rather
// than trusting the one the browser was shown. So the confirmation is a real
// gate on a real decision, and a forged POST straight to the push action still
// only pushes what the server would independently have chosen.

export type EnvPushPlanView = {
  plan: EnvPushPlan;
  /** True when Vercel's current variables could not be read; the plan is then
   *  built blind and reads as "create everything". */
  remoteReadFailed: boolean;
  remoteError: string | null;
};

export async function planVercelEnvPushAction(input: {
  projectId: string;
  /** Foreign keys the operator has ticked to overwrite. */
  overrides?: string[];
}): Promise<ActionResult<EnvPushPlanView>> {
  const auth = await authorize(input.projectId);
  if (!auth.ok) return auth;
  if (!auth.project.vercelProjectId) {
    return { ok: false, error: "This project isn't linked to Vercel yet." };
  }

  const built = await buildEnvPushPlan({
    tenantId: auth.tenantId,
    projectId: auth.project.id,
    vercelProjectId: auth.project.vercelProjectId,
    overrides: sanitizeOverrides(input.overrides),
    opts: auth.opts,
  });
  if (!built.ok) return { ok: false, error: built.error };

  return {
    ok: true,
    value: {
      plan: built.plan,
      remoteReadFailed: built.remoteReadFailed,
      remoteError: built.remoteReadFailed ? built.remoteError : null,
    },
  };
}

/**
 * Write the plan to Vercel.
 *
 * Returns key NAMES only. No value crosses this boundary in either direction —
 * the values are read from the vault inside `executeEnvPush` and handed to the
 * request body without ever entering a result, a log line, or an error string.
 */
export async function pushVercelEnvAction(input: {
  projectId: string;
  overrides?: string[];
}): Promise<ActionResult<EnvPushOutcome>> {
  const auth = await authorize(input.projectId);
  if (!auth.ok) return auth;
  if (!auth.project.vercelProjectId) {
    return { ok: false, error: "This project isn't linked to Vercel yet." };
  }

  const res = await executeEnvPush({
    tenantId: auth.tenantId,
    projectId: auth.project.id,
    vercelProjectId: auth.project.vercelProjectId,
    overrides: sanitizeOverrides(input.overrides),
    opts: auth.opts,
  });
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath(`/projects/${auth.project.id}`);

  const { pushed, failed } = res.outcome;
  if (failed.length > 0) {
    return {
      ok: true,
      value: res.outcome,
      warning:
        `${failed.length} variable${failed.length === 1 ? "" : "s"} could not be pushed: ` +
        failed.map((f) => `${f.key} (${f.error})`).join("; ") +
        (pushed.length > 0
          ? ` ${pushed.length} did land — pushing again is safe and will only retry the rest.`
          : ""),
    };
  }
  return { ok: true, value: res.outcome };
}

// ── PR 4: trigger a deploy ──────────────────────────────────────────────────
//
// ── The safety boundary, and why it is shaped as an absence ────────────────
// Preview deploys are cheap and reversible. A production deploy is publishing:
// externally visible, live immediately, and not reviewable after the fact.
// AGENTS.md principle 6 already names "publish" as a dangerous action requiring
// a human approval gate, and this repo's precedent for such a boundary (the SME
// safety gate) is that it is expressed as an ABSENCE OF CAPABILITY rather than a
// flag.
//
// So, concretely, in this PR:
//
//   • There is NO agent-facing surface at all. No MCP tool, nothing added to
//     `DEVPILOT_BOARD_TOOLS`, no engine path that reaches this file. Agents
//     cannot deploy anything, preview included. Agent preview deploys are a
//     deliberate later phase; until then "agents get preview only" is true
//     because the capability does not exist, not because a prompt says so.
//   • Production and preview are SEPARATE ACTIONS, not one action with a flag.
//     `deployPreviewAction` cannot target production — it hardcodes the target
//     and the argument is absent from its input type, so no caller (or forged
//     POST) can redirect it. That is the `devpilot_create_ticket` forced-`backlog`
//     shape, applied to the same problem.
//   • The production action requires the operator to type the exact ref, and it
//     refuses rather than defaulting. A misclick cannot ship to production.
//   • When PR 2's production surface is showing a warning the operator has not
//     resolved (the live production branch differs from the expected one, or
//     could not be read), the deploy proceeds — an explicit ref deploy is
//     exactly the escape hatch a misconfigured project needs — but it returns
//     the warning alongside the result, so it never reads as "all fine".

export type DeployTriggerResult = {
  vercelDeploymentId: string;
  target: DeployTarget;
  inspectorUrl: string | null;
  url: string | null;
  /** The live branch Vercel reports as production, for the confirm copy. */
  ref: string;
};

/**
 * The shared tail: create the deployment, record it, and hand it to the durable
 * poller.
 *
 * The record is written HERE rather than being left to the first poll, because
 * the first poll is seconds away and in that window the operator's card would
 * show nothing at all — a deploy button that appears to do nothing is
 * indistinguishable from one that failed. The row is written with Vercel's own
 * initial state, so a build that never starts is still visible with a working
 * build-log link.
 */
async function startDeployment(args: {
  tenantId: string;
  userId: string;
  project: ProjectRecord;
  ref: string;
  target: DeployTarget;
  ticketId: string | null;
  opts: VercelClientOptions;
}): Promise<ActionResult<DeployTriggerResult>> {
  const { project } = args;
  if (!project.vercelProjectId) {
    return { ok: false, error: "This project isn't linked to Vercel yet." };
  }
  if (!project.githubOwner || !project.githubRepo) {
    return {
      ok: false,
      error: "This project has no GitHub repo recorded, so there is nothing for Vercel to build.",
    };
  }

  let deployment;
  try {
    deployment = await createVercelDeployment(
      {
        name: project.vercelProjectName ?? project.vercelProjectId,
        projectId: project.vercelProjectId,
        org: project.githubOwner,
        repo: project.githubRepo,
        ref: args.ref,
        target: args.target,
      },
      args.opts,
    );
  } catch (err) {
    if (err instanceof VercelApiError && err.kind === "not_found") {
      return {
        ok: false,
        error:
          `Vercel could not find "${args.ref}" on ${project.githubOwner}/${project.githubRepo}. ` +
          "Check the branch exists and has been pushed.",
      };
    }
    return { ok: false, error: errorMessage(err, "Could not start the deploy.") };
  }

  const url = absoluteUrl(deployment.url);
  const now = new Date().toISOString();

  // Best-effort: a failed ledger write must not make a RUNNING deploy look like
  // it never started. The poller upserts the same row on its first pass, so the
  // record self-heals; the warning tells the operator why the card is empty in
  // the meantime.
  const recorded = await upsertDeploymentRecord(supabaseService(), args.tenantId, {
    projectId: project.id,
    vercelDeploymentId: deployment.id,
    target: args.target,
    readyState: deployment.readyState ?? "QUEUED",
    url,
    inspectorUrl: deployment.inspectorUrl,
    errorMessage: null,
    branch: deployment.branch ?? args.ref,
    commitSha: deployment.commitSha,
    ticketId: args.ticketId,
    triggeredBy: args.userId,
    // Always "human": this file has no agent path. See the header.
    triggerSource: "human",
    readyAt: null,
    // A brand-new deployment has not become production, whatever its target —
    // it has not built yet. The poller stamps this when it reaches READY.
    becameProductionAt: null,
    polledAt: now,
  });

  // Hand off to the durable poller. Best-effort by the same logic as the
  // `ticket/suggest-deps.requested` emit: the deploy is already running on
  // Vercel, and a failed emit must not turn a live deploy into an error the
  // operator reads as "it did not happen".
  let watching = true;
  try {
    await sendEventBounded({
      name: "vercel/deploy.requested",
      data: {
        tenantId: args.tenantId,
        projectId: project.id,
        ticketId: args.ticketId,
        vercelDeploymentId: deployment.id,
        target: args.target,
        triggeredBy: args.userId,
        triggerSource: "human",
      },
    });
  } catch {
    watching = false;
  }

  revalidatePath(`/projects/${project.id}`);

  const warnings: string[] = [];
  if (!recorded.ok) {
    warnings.push(
      `The deploy started but DevPilot could not record it (${recorded.error}); it may not appear in the list below until the first status check.`,
    );
  }
  if (!watching) {
    warnings.push(
      "The deploy started, but DevPilot could not schedule the status watcher, so it will not update this card or comment on the ticket. Check the build log directly.",
    );
  }

  return {
    ok: true,
    value: {
      vercelDeploymentId: deployment.id,
      target: args.target,
      inspectorUrl: deployment.inspectorUrl,
      url,
      ref: args.ref,
    },
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}

/**
 * Deploy a PREVIEW.
 *
 * `target` is not an argument. It is hardcoded below and absent from the input
 * type, so there is no value any caller can pass that makes this ship to
 * production — the boundary is structural, not a validated flag.
 */
export async function deployPreviewAction(input: {
  projectId: string;
  ref?: string;
  ticketId?: string | null;
}): Promise<ActionResult<DeployTriggerResult>> {
  const auth = await authorize(input.projectId);
  if (!auth.ok) return auth;

  const ref = resolveDeployRef(auth.project, input.ref);
  if (!ref) return { ok: false, error: "Pick a branch to deploy." };
  if (!BRANCH_NAME_RE.test(ref)) {
    return { ok: false, error: "Branch name must be ASCII letters/digits/`.`/`_`/`/`/`-`." };
  }

  return startDeployment({
    tenantId: auth.tenantId,
    userId: auth.userId,
    project: auth.project,
    ref,
    target: "preview",
    ticketId: await resolveTicketId(auth.tenantId, auth.project.id, input.ticketId),
    opts: auth.opts,
  });
}

/**
 * Deploy to PRODUCTION.
 *
 * A separate action with a separate confirmation, deliberately not the preview
 * action with a flag: the requirement is that production cannot be reached by a
 * misclick on the preview control, and two actions is the only version of that
 * which survives a later refactor.
 *
 * `confirmRef` must equal `ref` exactly. The thing confirmed is therefore the
 * thing that ships — a checkbox would confirm a LABEL, which a later edit could
 * leave describing a different branch than the request carries.
 */
export async function deployProductionAction(input: {
  projectId: string;
  ref?: string;
  confirmRef: string;
  ticketId?: string | null;
}): Promise<ActionResult<DeployTriggerResult>> {
  const auth = await authorize(input.projectId);
  if (!auth.ok) return auth;
  // Checked BEFORE the gate: an unlinked project has no live production branch
  // to read, so the gate would otherwise emit a "could not confirm which branch
  // Vercel deploys production from" warning for a project that simply is not
  // connected — technically true and completely unhelpful.
  if (!auth.project.vercelProjectId) {
    return { ok: false, error: "This project isn't linked to Vercel yet." };
  }

  const ref = resolveDeployRef(auth.project, input.ref);
  if (!ref) return { ok: false, error: "Pick a branch to deploy to production." };
  if (!BRANCH_NAME_RE.test(ref)) {
    return { ok: false, error: "Branch name must be ASCII letters/digits/`.`/`_`/`/`/`-`." };
  }

  // The live read is what the gate reasons about — the stored branch snapshot is
  // display-only and could be arbitrarily stale (see link.server.ts).
  const status = await loadVercelLinkStatus(auth.tenantId, auth.project);
  const gate = decideProductionDeployGate({
    ref,
    confirmedRef: input.confirmRef ?? "",
    liveProductionBranch: status.productionBranch,
    desiredProductionBranch: auth.project.vercelProductionBranchDesired,
    branchIsStale: status.branchIsStale,
  });
  if (!gate.ok) return { ok: false, error: gate.message };

  const started = await startDeployment({
    tenantId: auth.tenantId,
    userId: auth.userId,
    project: auth.project,
    ref,
    target: "production",
    ticketId: await resolveTicketId(auth.tenantId, auth.project.id, input.ticketId),
    opts: auth.opts,
  });
  if (!started.ok) return started;

  // Carry the gate's warnings through. They are not a reason to refuse — an
  // explicit ref deploy is what an operator needs precisely WHEN the automatic
  // surface is misconfigured — but the result must not read as "all fine" while
  // the card is showing an unresolved warning.
  const all = [...gate.warnings, ...(started.warning ? [started.warning] : [])];
  return all.length > 0 ? { ...started, warning: all.join(" ") } : started;
}

/** The card's list of recent deployments. Read-only. */
export async function listProjectDeploymentsAction(
  projectId: string,
): Promise<ActionResult<DeploymentRecord[]>> {
  // Deliberately NOT `authorize`. This is a read of DevPilot's OWN ledger and
  // touches Vercel not at all, so gating it on a resolvable Vercel token would
  // make the deploy history — including why the last deploy failed — vanish the
  // moment the operator disconnects Vercel, which is one of the times they most
  // need to look at it. The gates that matter are still here: operator role,
  // session-derived tenant, and the project's tenant checked before the read.
  const user = await requireUser();
  const tenantId = await requireTenantId();
  if (!(await isInstanceOperator(user.id))) {
    return { ok: false, error: "Only an instance operator can view deployment history." };
  }
  const project = await loadProjectById(projectId);
  if (!project) return { ok: false, error: "Project not found." };
  if (project.tenantId !== tenantId) {
    return { ok: false, error: "Project does not belong to your tenant." };
  }
  const rows = await listProjectDeployments(supabaseService(), tenantId, project.id, 10);
  return { ok: true, value: rows };
}

// ── PR 5: rollback and undo ─────────────────────────────────────────────────
//
// Same boundary as the deploy actions above, and for a strictly larger
// consequence: a rollback changes what live users are served RIGHT NOW, with no
// build in between.
//
//   • NO agent-facing surface. No MCP tool, nothing in `DEVPILOT_BOARD_TOOLS`, no
//     engine path, no runner change. "Agents get preview only" stays true
//     because the capability does not exist, not because a prompt says so.
//   • Rollback and undo are SEPARATE actions driving SEPARATE Vercel endpoints
//     with different eligibility and different plan gates — not one action with
//     a direction flag. See `lib/vercel/rollback-state.ts`.
//   • The type-to-confirm is re-checked SERVER-SIDE, and so is eligibility: the
//     browser supplies a deployment id, so a forged POST naming a failed build,
//     a preview, or the live deployment is refused with the same reason the
//     disabled row showed.

export type RollbackTargetsView = {
  targets: RollbackTarget[];
  previousProductionId: string | null;
  liveDeploymentId: string | null;
  rolledBack: RollbackBanner | null;
  aliasJobInFlight: boolean;
  /** The three documented rollback footguns, for the confirm dialog. */
  warnings: readonly string[];
  /**
   * Vercel's own `rollbackCandidate` set, when it could be read.
   *
   * `null` means the cross-check failed — rendered as "unconfirmed", never as
   * "ineligible". Vercel owns the eligibility rule and DevPilot's ledger is a
   * local view of it; disagreement is worth showing, but a failed read must not
   * remove the operator's only rollback control.
   */
  vercelCandidateIds: string[] | null;
};

/** The rollback inventory. Read-only; touches DevPilot's ledger plus one Vercel
 *  cross-check. */
export async function loadRollbackTargetsAction(
  projectId: string,
): Promise<ActionResult<RollbackTargetsView>> {
  const auth = await authorize(projectId);
  if (!auth.ok) return auth;
  if (!auth.project.vercelProjectId) {
    return { ok: false, error: "This project isn't linked to Vercel yet." };
  }

  const status = await loadVercelLinkStatus(auth.tenantId, auth.project);
  const records = await listProductionDeployments(
    supabaseService(),
    auth.tenantId,
    auth.project.id,
    20,
  );
  const plan = planRollbackTargets({ records, aliasJob: status.aliasJob });

  return {
    ok: true,
    value: {
      targets: plan.targets,
      previousProductionId: plan.previousProduction?.vercelDeploymentId ?? null,
      liveDeploymentId: plan.live?.vercelDeploymentId ?? null,
      rolledBack: describeRollbackState(status.aliasJob),
      aliasJobInFlight: isAliasJobInFlight(status.aliasJob),
      warnings: ROLLBACK_WARNINGS,
      vercelCandidateIds: await listVercelRollbackCandidates(
        auth.project.vercelProjectId,
        auth.opts,
      ),
    },
  };
}

/**
 * Roll production back to a previous deployment.
 *
 * Drives `POST /v1/projects/{id}/rollback/{id}` — Instant Rollback — which is
 * NOT the promote endpoint. Vercel declares a `402` on this one and not on
 * promote, and on the Hobby plan it reaches exactly one step back.
 */
export async function rollbackDeploymentAction(input: {
  projectId: string;
  deploymentId: string;
  /** Must equal `deploymentId` exactly. See `decideRollbackGate`. */
  confirmDeploymentId: string;
}): Promise<ActionResult<{ deploymentId: string; queued: boolean }>> {
  const auth = await authorize(input.projectId);
  if (!auth.ok) return auth;
  if (!auth.project.vercelProjectId) {
    return { ok: false, error: "This project isn't linked to Vercel yet." };
  }

  const deploymentId = (input.deploymentId ?? "").trim();
  const status = await loadVercelLinkStatus(auth.tenantId, auth.project);
  const records = await listProductionDeployments(
    supabaseService(),
    auth.tenantId,
    auth.project.id,
    20,
  );
  const plan = planRollbackTargets({ records, aliasJob: status.aliasJob });

  // Eligibility is re-derived from the SERVER's own ledger. The browser sent
  // only an id; everything the decision rests on is recomputed here.
  const target = plan.targets.find((t) => t.record.vercelDeploymentId === deploymentId);
  if (!target) {
    return {
      ok: false,
      error:
        "DevPilot has no record of that deployment for this project, so it will not point production at it.",
    };
  }

  const gate = decideRollbackGate({
    deploymentId,
    confirmedId: input.confirmDeploymentId ?? "",
    eligibility: target.eligibility,
    aliasJobInFlight: isAliasJobInFlight(status.aliasJob),
  });
  if (!gate.ok) return { ok: false, error: gate.message };

  try {
    await rollbackVercelDeployment(
      { projectId: auth.project.vercelProjectId, deploymentId },
      auth.opts,
    );
  } catch (err) {
    return { ok: false, error: describeAliasFailure(err, "rollback") };
  }

  const warning = await recordProductionPointerChange({
    tenantId: auth.tenantId,
    projectId: auth.project.id,
    record: target.record,
    // NOT a promotion. `promoted_at` records that Vercel would refuse to promote
    // this deployment again; a rollback creates no such state.
    promotedBy: null,
  });

  revalidatePath(`/projects/${auth.project.id}`);
  return {
    ok: true,
    value: { deploymentId, queued: false },
    warning: [
      describeAliasOutcome({ kind: "rollback", outcome: { accepted: true, queued: false } }),
      ...warning,
    ].join(" "),
  };
}

/**
 * Undo a rollback.
 *
 * Drives `POST /v10/projects/{id}/promote/{id}` — a different endpoint with
 * different eligibility — because that is what Vercel's own documentation
 * prescribes for undoing, and because promoting is also what restores
 * auto-assignment of production domains. Without this, a rolled-back project
 * stops deploying and there is no control to fix it.
 *
 * The target is the deployment production was rolled AWAY from, taken from
 * Vercel's own `lastAliasRequest.fromDeploymentId` rather than guessed from the
 * ledger — Vercel is the authority on what it moved away from.
 */
export async function undoRollbackAction(input: {
  projectId: string;
  confirmDeploymentId: string;
}): Promise<ActionResult<{ deploymentId: string; queued: boolean }>> {
  const auth = await authorize(input.projectId);
  if (!auth.ok) return auth;
  if (!auth.project.vercelProjectId) {
    return { ok: false, error: "This project isn't linked to Vercel yet." };
  }

  const status = await loadVercelLinkStatus(auth.tenantId, auth.project);
  const banner = describeRollbackState(status.aliasJob);
  if (!banner) {
    return {
      ok: false,
      error:
        "Vercel does not report this project as rolled back, so there is nothing to undo. " +
        "If you believe it is, check the project on the Vercel dashboard — DevPilot may not have been able to read the live state.",
    };
  }
  if (isAliasJobInFlight(status.aliasJob)) {
    return {
      ok: false,
      error:
        "Vercel is still repointing this project's production domains. Wait for that to finish before undoing.",
    };
  }
  const deploymentId = banner.undoDeploymentId;
  if (!deploymentId) {
    return {
      ok: false,
      error:
        "Vercel did not report which deployment production was rolled away from, so DevPilot cannot undo it automatically. " +
        "Promote the deployment you want from the Vercel dashboard — that also restores automatic production deploys.",
    };
  }
  if (input.confirmDeploymentId.trim() !== deploymentId) {
    return {
      ok: false,
      error: `Type "${deploymentId}" to confirm you are pointing production back at it.`,
    };
  }

  // DevPilot may not hold a ledger row for the deployment Vercel rolled away from
  // (it could predate the link, or have been created by a git push). That is not
  // a reason to refuse the undo — Vercel is the authority on what is promotable.
  // When we DO hold one, its build state is checked, because promoting a failed
  // or preview build is refused up front rather than discovered at runtime.
  const records = await listProductionDeployments(
    supabaseService(),
    auth.tenantId,
    auth.project.id,
    20,
  );
  const known = records.find((r) => r.vercelDeploymentId === deploymentId) ?? null;
  if (known) {
    const eligibility = classifyPromoteTarget(known);
    if (!eligibility.eligible) return { ok: false, error: eligibility.message };
  }

  let queued = false;
  try {
    const res = await promoteVercelDeployment(
      { projectId: auth.project.vercelProjectId, deploymentId },
      auth.opts,
    );
    queued = res.queued;
  } catch (err) {
    return { ok: false, error: describeAliasFailure(err, "promote") };
  }

  const warning: string[] = [];
  if (!queued && known) {
    // A `202` means production has NOT moved, so nothing about the live pointer
    // is true yet and recording it would make the ledger claim a state that does
    // not exist.
    warning.push(
      ...(await recordProductionPointerChange({
        tenantId: auth.tenantId,
        projectId: auth.project.id,
        record: known,
        promotedBy: auth.userId,
      })),
    );
  }

  revalidatePath(`/projects/${auth.project.id}`);
  return {
    ok: true,
    value: { deploymentId, queued },
    warning: [
      describeAliasOutcome({ kind: "promote", outcome: { accepted: true, queued } }),
      ...warning,
    ].join(" "),
  };
}

/**
 * Record that a deployment is now what production points at.
 *
 * Best-effort by the same logic as the deploy ledger write: Vercel has ALREADY
 * repointed production, and a failed DB write must not be reported as a failed
 * rollback — that would invite the operator to click again and start a second
 * alias job. Returns warning lines rather than throwing.
 */
async function recordProductionPointerChange(args: {
  tenantId: string;
  projectId: string;
  record: DeploymentRecord;
  /** Non-null only on the promote path — see `recordProductionPointer`. */
  promotedBy: string | null;
}): Promise<string[]> {
  const now = new Date().toISOString();
  const warnings: string[] = [];

  const res = await recordProductionPointer(supabaseService(), args.tenantId, {
    vercelDeploymentId: args.record.vercelDeploymentId,
    becameProductionAt: now,
    ...(args.promotedBy !== null ? { promotedAt: now, promotedBy: args.promotedBy } : {}),
  });
  if (!res.ok) {
    warnings.push(
      `Vercel accepted the change, but DevPilot could not record it (${res.error}), so this list may show the wrong deployment as live until the next deploy.`,
    );
  }

  // The production-URL consequence. A rollback repoints the production domain at
  // a different build, so the stored URL must follow the deployment now serving
  // it — same write, and the same reasoning, as PR 4's production deploy path.
  if (args.record.url) {
    const url = await writeProductionUrl(
      supabaseService(),
      args.tenantId,
      args.projectId,
      args.record.url,
    );
    if (!url.ok) {
      warnings.push(`DevPilot could not update the recorded production URL (${url.error}).`);
    }
  }
  return warnings;
}

/**
 * Turn a failed rollback/promote into an operator-actionable message.
 *
 * Two kinds get specific treatment because the generic wording sends the
 * operator to the wrong place:
 *
 *   `plan_required` (402) — Vercel declares this on ROLLBACK only. It means the
 *     plan permits one step, NOT that anything is broken. Reported as a
 *     permissions or credential failure it would send someone to rotate a
 *     perfectly good token.
 *   `conflict` (409) — on the PROMOTE path this is Vercel refusing to promote an
 *     already-promoted deployment, and its remedy is the opposite control: roll
 *     back to it instead. (The 409 mapping is documented behaviour whose status
 *     code Vercel does not publish, so the wording names the likely cause rather
 *     than asserting it.)
 */
function describeAliasFailure(err: unknown, kind: "rollback" | "promote"): string {
  if (err instanceof VercelApiError) {
    if (err.kind === "plan_required") return err.message;
    if (err.kind === "conflict" && kind === "promote") {
      return (
        "Vercel refused to promote that deployment. The usual cause is that it has already been " +
        "promoted once — Vercel does not allow that twice, and directs you to roll back to it " +
        `instead. (${err.message})`
      );
    }
    return err.message;
  }
  return err instanceof Error
    ? err.message
    : kind === "rollback"
      ? "Could not roll back."
      : "Could not undo the rollback.";
}

/**
 * Which ref to build. Defaults to the integration branch for the same reason the
 * expected production branch does: that is where auto-land puts completed work.
 */
function resolveDeployRef(project: ProjectRecord, typed: string | undefined): string | null {
  const t = (typed ?? "").trim();
  if (t.length > 0) return t;
  return project.integrationBranch ?? project.defaultBranch ?? null;
}

/**
 * Validate a caller-supplied ticket id before it is stamped on a deployment row.
 *
 * The id comes from the browser and lands in a column with an
 * `assert_tenant_matches_parent` trigger, so a foreign id would be REFUSED at
 * the DB and fail the whole insert — which would make a running deploy look like
 * it never started. Checking it here turns that into "no ticket attached", which
 * is a normal state. The co-located `.eq("tenant_id", …)` is what makes the
 * check a tenant boundary and not just an existence test.
 */
async function resolveTicketId(
  tenantId: string,
  projectId: string,
  raw: string | null | undefined,
): Promise<string | null> {
  const id = (raw ?? "").trim();
  if (id.length === 0) return null;
  const { data } = await supabaseService()
    .from("tickets")
    .select("id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .maybeSingle();
  return data?.id ? String(data.id) : null;
}

/** Overrides arrive from the browser. Bound and shape-check them: the pure
 *  planner already refuses to invent a push from an unknown name, so this is
 *  defence in depth rather than the boundary, but an unbounded array from a
 *  browser-reachable action has no reason to exist. */
function sanitizeOverrides(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((k) => typeof k === "string" && SECRET_KEY_RE.test(k)).slice(0, 200);
}

/**
 * The branch production is expected to track.
 *
 * Defaults to the INTEGRATION branch, not the default branch: DevPilot's shape is
 * that auto-land merges completed tickets into the integration branch and the
 * default branch is human-promoted from it, so the deployed app should follow
 * the integration branch. Falls back to the default branch for a project with no
 * integration branch configured, where it is the only branch that exists.
 */
function resolveDesiredBranch(project: ProjectRecord, typed: string | undefined): string | null {
  const t = (typed ?? "").trim();
  if (t.length > 0) return t;
  return project.integrationBranch ?? project.defaultBranch ?? null;
}

// Same constraint set as `setIntegrationBranchAction` — ASCII git-safe.
const BRANCH_NAME_RE = /^[a-zA-Z0-9._/-]{1,200}$/;

/**
 * Record which branch production is EXPECTED to deploy from.
 *
 * This deliberately does not call Vercel: there is nothing to call. Vercel's
 * REST API exposes `link.productionBranch` read-only, so the operator changes it
 * in the dashboard and DevPilot's job is to hold the expected value and warn
 * while the two disagree. The action says so in its result rather than implying
 * a change was pushed.
 */
export async function setDesiredProductionBranchAction(input: {
  projectId: string;
  branch: string | null;
}): Promise<ActionResult<{ branch: string | null }>> {
  const auth = await authorize(input.projectId);
  if (!auth.ok) return auth;

  const trimmed = input.branch?.trim() ?? "";
  const next = trimmed.length === 0 ? null : trimmed;
  if (next !== null && !BRANCH_NAME_RE.test(next)) {
    return {
      ok: false,
      error: "Branch name must be ASCII letters/digits/`.`/`_`/`/`/`-` (max 200 chars).",
    };
  }

  const res = await writeDesiredProductionBranch(
    supabaseService(),
    auth.tenantId,
    auth.project.id,
    next,
  );
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath(`/projects/${auth.project.id}`);
  return { ok: true, value: { branch: next } };
}
