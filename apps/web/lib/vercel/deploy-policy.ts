// The production auto-deploy safety decision. PURE — no fetch, no server-only.
//
// ── The problem, stated once ───────────────────────────────────────────────
// Linking a GitHub repo to a Vercel project turns on push-to-deploy. Vercel then
// deploys EVERY push to the project's production branch, to production, with no
// approval step. DevPilot's agents push constantly and the auto-land pipeline
// squash-merges completed tickets into the integration branch on its own. So a
// naive "Link" click hands every agent a live production deploy button that
// bypasses every gate DevPilot could ever build — including the human-only deploy
// gate PR 4 adds.
//
// A link flow that leaves this at Vercel's default is worse than no link flow at
// all, because it ARMS something the operator does not know is armed.
//
// ── What the plan assumed, and what is actually possible ───────────────────
// The build plan (§9) said: "when DevPilot creates a Vercel project it should set
// the Vercel production branch to a branch agents do not auto-land into".
//
// THAT IS NOT POSSIBLE. `link.productionBranch` is READ-ONLY in Vercel's public
// REST API. Verified against the official OpenAPI document (openapi.vercel.sh):
// it appears 108 times, exclusively in RESPONSE schemas. Neither
// `POST /v11/projects` nor `PATCH /v9/projects/{idOrName}` accepts it in a
// request body, and there is no link/branch endpoint that does. Writing code
// that "sets the production branch" would silently no-op, which is the exact
// failure mode this module exists to prevent, one level up.
//
// ── What IS possible, and why it is strictly better ────────────────────────
// `PATCH /v9/projects/{idOrName}` accepts `deploymentPolicy.gitSources`: a list
// of rules, each `{enabled, environments[], sources[]}`. A rule of
//
//     { enabled: false,
//       environments: [{ type: "system", target: "production" }],
//       sources:      [{ provider: "github", org, repo }] }
//
// disables git-triggered deployments into the PRODUCTION environment for that
// repo, while leaving preview deploys working.
//
// This is stronger than choosing a branch, in the one way that matters: it does
// not depend on WHICH branch agents push to. Branch selection is a guess about
// future agent behaviour (auto-land targets move, operators change the
// integration branch, a human merges to main); the gate is a statement about the
// production environment itself. It also survives the operator later pointing
// auto-land somewhere new.
//
// ── The honesty requirement, which is the real design constraint ───────────
// `deploymentPolicy` is present in Vercel's OpenAPI spec but has no prose
// documentation, and this PR was written WITHOUT a Vercel account to test
// against. So the code must never ASSERT that the gate worked.
//
// Everything below is built around that. `interpretProductionAutoDeploy` has
// THREE outcomes, not two, and the third is load-bearing:
//
//   "gated"   — Vercel's own response shows a rule disabling git → production.
//   "armed"   — Vercel's response shows no such rule. Pushes deploy.
//   "unknown" — Vercel did not report the field at all, or we could not ask.
//
// `unknown` is treated as ARMED everywhere it is rendered or acted on
// (`shouldWarnProductionArmed`). An unverified gate is not a gate. If
// `deploymentPolicy` turns out to be unsupported on the operator's plan, the
// PATCH will not read back and the operator sees "DevPilot could not confirm" —
// not a green tick over an armed production environment.

/** Vercel's git provider vocabulary, narrowed to what we send. */
export type VercelGitProvider = "github";

/** One `deploymentPolicy.gitSources` rule, in Vercel's shape. */
export type VercelGitSourceRule = {
  enabled: boolean;
  environments: { type: "system"; target: "production" | "preview" }[];
  sources: { provider: VercelGitProvider; org: string; repo: string }[];
};

/**
 * Whether git pushes deploy this project to production.
 *
 * Three states on purpose — see the header. Collapsing `unknown` into either of
 * the other two is the one change that must not be made: into `gated` it claims
 * a safety property we never verified, and into `armed` it cries wolf on a
 * transient network blip.
 */
export type ProductionAutoDeploy = "gated" | "armed" | "unknown";

/** The operator's recorded intent, mirrored in `projects.vercel_prod_deploy_mode`.
 *  NOT an authority on the live state — Vercel is. This is what was ASKED for,
 *  kept so that intent diverging from reality is detectable instead of silent. */
export type ProdDeployMode = "devpilot_gated" | "git_auto";

export function isProdDeployMode(v: unknown): v is ProdDeployMode {
  return v === "devpilot_gated" || v === "git_auto";
}

/**
 * Build the `deploymentPolicy` patch body that gates (or un-gates) git-triggered
 * production deploys for one repo.
 *
 * Scoped to the specific `org/repo` rather than a blanket rule: a Vercel project
 * is linked to exactly one repo, and a narrower rule cannot accidentally govern
 * something we were not asked about.
 *
 * Note `enabled: true` is NOT simply "the default" — it is an explicit rule
 * saying production-from-git is permitted. That is deliberate: the operator
 * turning auto-deploy ON should produce a rule that is visible in Vercel's own
 * response, so `interpretProductionAutoDeploy` can read back a definite `armed`
 * rather than the ambiguous "no rule present" it would otherwise get.
 */
export function buildProductionGitPolicy(args: {
  org: string;
  repo: string;
  /** true = git pushes may deploy to production. false = DevPilot-gated. */
  enabled: boolean;
}): { deploymentPolicy: { gitSources: VercelGitSourceRule[] } } {
  return {
    deploymentPolicy: {
      gitSources: [
        {
          enabled: args.enabled,
          environments: [{ type: "system", target: "production" }],
          sources: [{ provider: "github", org: args.org, repo: args.repo }],
        },
      ],
    },
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Does this rule's `environments` list name the production environment? */
function rulesProduction(rule: Record<string, unknown>): boolean {
  const envs = rule.environments;
  if (!Array.isArray(envs)) return false;
  return envs.some((e) => asRecord(e)?.target === "production");
}

/**
 * Read the live production auto-deploy state out of a raw Vercel project object.
 *
 * TOTAL over `unknown`: this is a third party's response shape and it can change
 * without our deploy. Every failure to understand it lands on `unknown`, which
 * is rendered and acted on as armed — the safe direction. Never `gated`.
 */
export function interpretProductionAutoDeploy(project: unknown): ProductionAutoDeploy {
  const root = asRecord(project);
  if (!root) return "unknown";
  const policy = asRecord(root.deploymentPolicy);
  // The field being ABSENT is the "unknown" case that matters most in practice:
  // it is what an account or API version that does not support deploymentPolicy
  // returns, and it is exactly when we must not claim the gate is on.
  if (!policy) return "unknown";
  const rules = policy.gitSources;
  if (!Array.isArray(rules)) return "unknown";

  const production = rules.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
  const relevant = production.filter(rulesProduction);
  if (relevant.length === 0) {
    // The policy object exists and says nothing about production, so Vercel's
    // default applies: git pushes to the production branch deploy.
    return "armed";
  }
  // A single rule disabling production is enough to gate it. If rules disagree
  // we take the SAFE reading for display only when they all disable; any
  // enabling rule means something can still deploy.
  return relevant.every((r) => r.enabled === false) ? "gated" : "armed";
}

/**
 * Is production reachable by an unapproved push, as far as we can tell?
 *
 * The single predicate every warning surface reads, so "unknown counts as armed"
 * is stated once rather than re-derived (and eventually mis-derived) per call
 * site.
 */
export function shouldWarnProductionArmed(state: ProductionAutoDeploy): boolean {
  return state !== "gated";
}

// ── The operator-facing statement ───────────────────────────────────────────
// The acceptance criterion for this PR is that the card says, in plain language,
// what the production branch is and what that means. That sentence is built HERE
// rather than in JSX so it is unit-testable and so there is exactly one wording
// to review.

// ── Production branch ALIGNMENT ─────────────────────────────────────────────
// DevPilot's intended shape is: agents auto-land completed tickets into the
// integration branch ("dev"), and `main` is human-promoted from it. So the
// branch Vercel should be deploying production from is normally `dev`, not
// `main` — Vercel's own default of the repo's default branch is wrong for this
// workflow.
//
// DevPilot CANNOT apply that. `link.productionBranch` is read-only over the REST
// API (see the module header). What it can do — and what these rules exist for —
// is hold the intended value, compare it against the LIVE value on every render,
// and say loudly and specifically when they disagree. A setting we cannot write
// is not a reason to stay silent about it; it is a reason to make the manual
// step explicit and checkable rather than leaving Vercel's default in place with
// nobody looking.

export type BranchAlignment = "aligned" | "misaligned" | "unknown" | "unset";

export type BranchAlignmentReport = {
  status: BranchAlignment;
  /** The branch Vercel is actually deploying production from, when known. */
  liveBranch: string | null;
  /** The branch the operator declared it should be. */
  desiredBranch: string | null;
  /** One line stating the situation. Always present. */
  summary: string;
  /** The manual steps, present only when there is something to do. Manual
   *  because there is no API for it — stating that outright is part of the
   *  remedy, so the operator does not go hunting for a DevPilot button. */
  manualSteps: string[];
};

/**
 * Compare the live production branch against the declared one.
 *
 * `unknown` (we could not read Vercel) is deliberately NOT folded into
 * `misaligned`: telling an operator to go fix a setting that may already be
 * correct, on the strength of a network blip, is how a warning banner becomes
 * something people learn to dismiss. It is also not folded into `aligned`, for
 * the obvious reason. It gets its own wording.
 */
export function decideBranchAlignment(args: {
  desiredBranch: string | null;
  liveBranch: string | null;
  /** True when `liveBranch` came from the stored snapshot, not a fresh read. */
  branchIsStale: boolean;
}): BranchAlignmentReport {
  const desired = args.desiredBranch?.trim() || null;
  const live = args.liveBranch?.trim() || null;

  if (!desired) {
    return {
      status: "unset",
      liveBranch: live,
      desiredBranch: null,
      summary: live
        ? `Vercel deploys production from "${live}". DevPilot has no expected branch recorded for this project, so it cannot tell you whether that is right.`
        : "No production branch is recorded, and DevPilot has no expected value to compare against.",
      manualSteps: [],
    };
  }

  if (args.branchIsStale || live === null) {
    return {
      status: "unknown",
      liveBranch: live,
      desiredBranch: desired,
      summary: `DevPilot could not read the current production branch from Vercel, so it cannot confirm it is "${desired}". Check it on Vercel before relying on it.`,
      manualSteps: [
        "Open the project on Vercel → Settings → Git.",
        `Confirm "Production Branch" is set to "${desired}".`,
      ],
    };
  }

  if (live === desired) {
    return {
      status: "aligned",
      liveBranch: live,
      desiredBranch: desired,
      summary: `Vercel deploys production from "${live}", which is what this project expects.`,
      manualSteps: [],
    };
  }

  return {
    status: "misaligned",
    liveBranch: live,
    desiredBranch: desired,
    summary: `Vercel is deploying production from "${live}", but this project expects "${desired}". Production is tracking the wrong branch.`,
    manualSteps: [
      "Open the project on Vercel → Settings → Git.",
      `Change "Production Branch" from "${live}" to "${desired}" and save.`,
      "Reload this page — DevPilot re-reads the value from Vercel and this warning will clear.",
      "This step is manual because Vercel's REST API exposes the production branch as read-only; no token can change it.",
    ],
  };
}

export type ProductionBranchFacts = {
  state: ProductionAutoDeploy;
  /** Vercel's live `link.productionBranch`, or null when unknown/sourceless. */
  productionBranch: string | null;
  /** True when `productionBranch` came from our stored snapshot rather than a
   *  fresh read — the value is then explicitly labelled unconfirmed. */
  branchIsStale: boolean;
  /** The project's integration branch, if auto-land is configured. */
  integrationBranch: string | null;
  /** Whether auto-land is actually armed. An integration branch with auto-land
   *  OFF does not merge anything on its own, so it is not an agent path to the
   *  production branch. */
  autoLandEnabled: boolean;
  /** The project's default branch — what a human promotion merges into. */
  defaultBranch: string;
  /** Did the operator explicitly choose to leave git → production auto-deploy
   *  ON for this project (`vercel_prod_deploy_mode === "git_auto"`)?
   *
   *  This is what separates "a consequence you chose" from "a consequence
   *  nobody looked at". DevPilot's intended shape has production tracking the
   *  integration branch, so agent-landed work deploying itself is a legitimate
   *  configuration — it is only alarming when it was not chosen. The wording is
   *  equally explicit either way; only the tone changes, because an alarm that
   *  fires on the intended configuration is an alarm people switch off. */
  intended: boolean;
};

export type ProductionStatement = {
  /** How loudly to render it. */
  tone: "ok" | "warn" | "danger";
  /** One line naming the branch and the consequence. Always present. */
  headline: string;
  /** What reaches that branch, and how. Empty when there is nothing to add. */
  detail: string[];
};

/**
 * The plain-language production-branch statement.
 *
 * Rules, in priority order:
 *   1. Gated → say so, and still NAME the branch. The branch matters even when
 *      gated, because the gate is the only thing standing between that branch
 *      and production; if it is ever removed, that is what goes live.
 *   2. Armed AND the production branch is one auto-land merges into → the worst
 *      case, and the one the operator is least likely to have reasoned about:
 *      every completed agent ticket deploys to production by itself. "danger".
 *   3. Armed otherwise → still automatic, still no approval, but reached only by
 *      a human merge/promotion. "warn".
 *   4. Unknown → we could not confirm; say that, and say to assume armed.
 */
export function describeProductionBranch(facts: ProductionBranchFacts): ProductionStatement {
  const branch = facts.productionBranch;
  const named = branch ? `"${branch}"` : "its production branch";
  const staleNote = facts.branchIsStale
    ? " (last known value — DevPilot could not re-read it from Vercel just now)"
    : "";

  // Does agent activity land on the production branch WITHOUT a human acting?
  // Auto-land is the only path that does: it squash-merges completed tickets
  // into the integration branch on its own. A human merging a PR into the
  // default branch is a human approval, which is a different (acceptable) thing.
  const autoLandReachesProduction =
    facts.autoLandEnabled &&
    facts.integrationBranch !== null &&
    branch !== null &&
    facts.integrationBranch === branch;

  if (facts.state === "unknown") {
    return {
      tone: "warn",
      headline: `DevPilot could not confirm with Vercel whether pushes to ${named} deploy to production${staleNote}. Assume they do.`,
      detail: [
        "An unverified gate is not a gate. Until DevPilot can read the setting back from Vercel, treat this project as though every push to the production branch goes live automatically.",
        "Open the project on Vercel and check Settings → Git to see the real state.",
      ],
    };
  }

  if (facts.state === "gated") {
    const detail = [
      `DevPilot asked Vercel to disable git-triggered production deploys for this repo, and Vercel confirmed it. Preview deployments still build normally.`,
      `${named[0] === '"' ? `Branch ${named}` : "The production branch"} is still Vercel's production branch${staleNote} — if this gate is ever turned off, pushes to it go live with no approval.`,
    ];
    if (autoLandReachesProduction) {
      detail.push(
        `That matters here: auto-land squash-merges every completed agent ticket into ${named}, so turning the gate off would give agents an unapproved path to production.`,
      );
    }
    return {
      tone: "ok",
      headline: `Pushes to ${named} do NOT deploy to production. Production deploys happen only when you trigger them from DevPilot.`,
      detail,
    };
  }

  // Armed.
  const detail: string[] = [];
  if (autoLandReachesProduction) {
    detail.push(
      `Auto-land squash-merges every completed agent ticket into ${named}. So every ticket your agents finish deploys itself to production, with no human approval anywhere in the path.`,
    );
    detail.push(
      facts.intended
        ? "You chose this: production tracks the integration branch, and the human gate is the separate promotion into the default branch. Stated here so it stays a decision rather than a surprise."
        : "Nobody chose this — it is Vercel's default behaviour showing through. If you did not intend it, turn on the DevPilot gate below.",
    );
  } else {
    detail.push(
      `Agents push \`devpilot/*\` ticket branches${
        facts.integrationBranch ? ` and auto-land into "${facts.integrationBranch}"` : ""
      }, not ${named}, so no agent reaches production on its own today.`,
    );
    detail.push(
      `Anything that lands on ${named} — a merged pull request, a promotion from DevPilot, a manual push — deploys to production immediately and without review.`,
    );
    if (branch === null) {
      detail.push(
        "Vercel did not report a production branch for this project. If it is not linked to a git repo, pushes cannot deploy it at all.",
      );
    }
  }

  return {
    // `danger` is reserved for the unchosen case. See `intended` above.
    tone: autoLandReachesProduction && !facts.intended ? "danger" : "warn",
    headline: `Every push to ${named} deploys to production automatically, without further approval${staleNote}.`,
    detail,
  };
}
