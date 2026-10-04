// The pure rules for rolling production back, and for undoing that.
//
// No fetch, no DB, no `server-only` — total functions over plain data, which is
// what lets every refusal below be asserted by a test that never touches a
// network. The IO lives in `rollback.server.ts` and `rollback-write.ts`.
//
// ── Rollback and promote are TWO mechanisms, and conflating them ships bugs ──
// Sources: `data/devpilot-vercel-rollback-check-r2/report.md` (Vercel's OpenAPI
// document, the published docs, and the Vercel CLI source), plus the plan at
// `data/devpilot-vercel-deploy-plan-v1/report.md` §7.
//
//   ROLLBACK (`POST /v1/projects/{id}/rollback/{id}`) points production at a
//     deployment that HAS served production before. Vercel declares a `402` on
//     it and the Hobby plan permits exactly ONE step back.
//
//   PROMOTE (`POST /v10/projects/{id}/promote/{id}`) points production at a
//     deployment that has NOT been promoted before. No `402`, no documented plan
//     gate — and Vercel's own docs name it as the way to UNDO a rollback, which
//     is the only thing DevPilot uses it for.
//
// They target DISJOINT sets. Promote is therefore not a Hobby loophole for deep
// rollback: the older production deployments you would want are exactly the ones
// it refuses. "Already promoted" is consequently an ineligibility on the PROMOTE
// path only — for the ROLLBACK path it is not merely allowed, it is what Vercel's
// docs prescribe ("If you want to use a previously promoted deployment, you must
// do a rollback to it"). Refusing it on both paths would leave the operator with
// no control at all for the most common target.
//
// ── The rule this file exists to enforce: refuse UP FRONT ───────────────────
// Every state that cannot work is decided here, from DevPilot's own ledger,
// before any request is made — and each one is rendered with its REASON rather
// than silently omitted from the list. A target that vanishes without
// explanation reads as a DevPilot bug; a target that is present and explains
// itself is a working product telling the truth about a constraint.
//
// The one thing deliberately NOT pre-refused is the plan gate itself. DevPilot
// does not know which Vercel plan the account is on (no reliable read exposes
// it), so asserting "you are on Hobby" would be a guess presented as fact.
// Instead: the one-step target is offered live, deeper targets are rendered
// DISABLED with the constraint stated, and a real `402` is classified as
// `plan_required` at the response layer. That is honest in both directions —
// the operator sees exactly what upgrading would buy, and if the limit turns out
// not to bind the REST API, only a label needs changing.

import { classifyDeployState } from "@/lib/vercel/deploy-state";
import type { DeploymentRecord } from "@/lib/vercel/deploy-write";

// ── Vercel's alias-remap job ────────────────────────────────────────────────

/**
 * `lastAliasRequest.jobStatus`.
 *
 * `skipped` is a real Vercel value and is neither success nor failure — it must
 * not be rendered as either. `unknown` is ours, for a value Vercel adds later:
 * treated as "still resolving" rather than guessed into a terminal state, for
 * the same reason `classifyDeployState` treats an unrecognised `readyState` as
 * non-terminal.
 */
export type AliasJobStatus =
  | "pending"
  | "in-progress"
  | "succeeded"
  | "failed"
  | "skipped"
  | "unknown";

/** Which entry point wrote the job. Both write the same record. */
export type AliasJobType = "rollback" | "promote" | "unknown";

export type AliasRequest = {
  type: AliasJobType;
  jobStatus: AliasJobStatus;
  /** The deployment production was pointed AWAY from. This is the undo target. */
  fromDeploymentId: string | null;
  /** The deployment production was pointed AT. */
  toDeploymentId: string | null;
  /** Epoch ms, per Vercel. */
  requestedAt: number | null;
};

const JOB_STATUSES: readonly AliasJobStatus[] = [
  "pending",
  "in-progress",
  "succeeded",
  "failed",
  "skipped",
];

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Read `lastAliasRequest` off a raw Vercel project response.
 *
 * Deliberately reads the RAW body rather than a narrowed field on
 * `VercelProject`, exactly as `interpretProductionAutoDeploy` does and for the
 * same reason: this is the single record that answers "is production rolled
 * back, and did the remap actually finish", and a parse layer between us and it
 * would turn an upstream shape change into a confident `null` — which here means
 * "production is fine", the wrong way to be wrong.
 */
export function interpretLastAliasRequest(raw: unknown): AliasRequest | null {
  const root = record(raw);
  if (!root) return null;
  const j = record(root.lastAliasRequest);
  if (!j) return null;

  const rawType = text(j.type);
  const rawStatus = text(j.jobStatus);
  const requestedAt =
    typeof j.requestedAt === "number" && Number.isFinite(j.requestedAt) ? j.requestedAt : null;

  return {
    type: rawType === "rollback" || rawType === "promote" ? rawType : "unknown",
    jobStatus: JOB_STATUSES.find((s) => s === rawStatus) ?? "unknown",
    fromDeploymentId: text(j.fromDeploymentId),
    toDeploymentId: text(j.toDeploymentId),
    requestedAt,
  };
}

/** Is the remap still resolving? A second alias job must not be started on top
 *  of one in flight — Vercel holds a single `lastAliasRequest` per project, so a
 *  concurrent request would overwrite the record we are watching. */
export function isAliasJobInFlight(job: AliasRequest | null): boolean {
  if (!job) return false;
  return job.jobStatus === "pending" || job.jobStatus === "in-progress";
}

/**
 * Is production currently sitting on a rollback?
 *
 * `unknown` and `skipped` count. This drives a WARNING banner, and the cost of
 * the two errors is wildly asymmetric: a spurious banner is noise, while a
 * missing one means auto-deploy is paused and nobody knows — the failure that
 * presents days later as "DevPilot stopped deploying".
 */
export function isRolledBack(job: AliasRequest | null): boolean {
  if (!job) return false;
  if (job.type !== "rollback") return false;
  return job.jobStatus !== "failed";
}

// ── The rolled-back banner ──────────────────────────────────────────────────

export type RollbackBanner = {
  tone: "warn" | "muted";
  headline: string;
  detail: string[];
  /** The deployment to promote in order to undo. Null when Vercel did not say. */
  undoDeploymentId: string | null;
};

/**
 * The persistent state to render while production is rolled back.
 *
 * ⚠️ This is the highest-value thing in this PR, and it is NOT a toast.
 *
 * After a rollback Vercel turns OFF auto-assignment of production domains, so
 * pushes to the production branch stop going live. In DevPilot that is severe and
 * completely silent: auto-land keeps squash-merging completed agent tickets into
 * the integration branch, production tracks that branch, and none of it deploys.
 * There is no error anywhere. It presents, days later, as "DevPilot's deploys
 * just stopped working". A transient notification cannot carry that; a permanent
 * banner with the undo control on it can.
 */
export function describeRollbackState(job: AliasRequest | null): RollbackBanner | null {
  if (!isRolledBack(job) || !job) return null;

  const detail: string[] = [
    "Vercel turns OFF auto-assignment of production domains after a rollback. Until you undo it, " +
      "pushes to the production branch will NOT go live — including every completed agent ticket " +
      "auto-land merges into it. Nothing will report an error; the deploys simply stop.",
    "Undoing restores normal deployment behaviour. DevPilot does that by promoting the deployment " +
      "production was rolled away from, which is what Vercel's own documentation prescribes.",
  ];

  if (isAliasJobInFlight(job)) {
    return {
      tone: "warn",
      headline: "A rollback is in progress. Vercel is repointing the production domains.",
      detail,
      undoDeploymentId: job.fromDeploymentId,
    };
  }
  if (job.jobStatus === "skipped") {
    // Neither success nor failure, and Vercel does not say which aliases moved.
    return {
      tone: "warn",
      headline:
        "Vercel reported the rollback as SKIPPED, which is neither success nor failure. " +
        "DevPilot cannot tell you what production is currently serving.",
      detail: [
        "Check the deployment on the Vercel dashboard before relying on either state.",
        ...detail,
      ],
      undoDeploymentId: job.fromDeploymentId,
    };
  }
  if (job.jobStatus === "unknown") {
    return {
      tone: "warn",
      headline:
        "Production was rolled back, but Vercel reported a job status DevPilot does not recognise.",
      detail: [
        "Treat the rollback as applied until you have checked the Vercel dashboard.",
        ...detail,
      ],
      undoDeploymentId: job.fromDeploymentId,
    };
  }
  return {
    tone: "warn",
    headline: "Production is rolled back, so auto-deploy is PAUSED.",
    detail,
    undoDeploymentId: job.fromDeploymentId,
  };
}

// ── The three warnings a rollback confirm must carry ────────────────────────

/**
 * Verbatim from Vercel's documentation (plan §7, r2 §5). Each is a live footgun
 * that a rollback does NOT undo, and each is invisible until it bites.
 *
 * They are constants rather than JSX because a warning composed in a component
 * is a warning that cannot be tested, and these are the operator's only notice.
 */
export const ROLLBACK_WARNINGS: readonly string[] = [
  "Environment variables do NOT roll back. Vercel keeps the variables currently in project " +
    "settings — including anything DevPilot has pushed since this deployment was built — and rolls " +
    "back only the build.",
  "Cron jobs revert to the state of the rolled-back deployment.",
  "Custom aliases are not carried over: the rolled-back deployment does not include them, because " +
    "they are not part of the project's domain settings.",
  "Auto-assignment of production domains is turned OFF until you undo the rollback. Pushes to the " +
    "production branch — including auto-landed agent tickets — will stop going live.",
];

// ── Target eligibility ──────────────────────────────────────────────────────

export type RollbackIneligibility =
  | "not_production"
  | "build_failed"
  | "still_building"
  | "canceled"
  | "state_unknown"
  | "never_live"
  | "currently_live"
  | "already_promoted"
  | "plan_gated";

export type TargetEligibility =
  | { eligible: true; note: string | null }
  | { eligible: false; reason: RollbackIneligibility; message: string };

export type RollbackTarget = {
  record: DeploymentRecord;
  eligibility: TargetEligibility;
  /** True for the single one-step target — the immediately previous production
   *  deployment, which is the only one reachable on the Hobby plan. */
  isPreviousProduction: boolean;
  /** True for the deployment currently serving production. */
  isLive: boolean;
};

/** Operator-facing wording per refusal. Kept beside the decision so a new
 *  ineligibility cannot ship without one. */
export function describeIneligibility(reason: RollbackIneligibility): string {
  switch (reason) {
    case "not_production":
      return "Preview deployment — never aliased to a production domain, so it is not a rollback candidate. Vercel would have to rebuild it against production settings, which is a deploy, not a rollback.";
    case "build_failed":
      return "This build FAILED. There is nothing serveable to roll back to.";
    case "still_building":
      return "This build has not finished. Wait for it to reach Ready.";
    case "canceled":
      return "This build was canceled or blocked before it finished, so it never produced anything to serve.";
    case "state_unknown":
      return "DevPilot does not recognise the state Vercel reports for this build, so it will not offer it as a target.";
    case "never_live":
      return "This deployment has never served production, so it is not eligible for Instant Rollback.";
    case "currently_live":
      return "This is what production is serving right now.";
    case "already_promoted":
      return "Vercel refuses to promote a deployment that has already been promoted. Roll back to it instead.";
    case "plan_gated":
      return "Rolling back more than one step requires the Pro plan. On Hobby, Vercel permits rolling back only to the immediately previous production deployment.";
  }
}

/** The build-state half of eligibility, shared by both paths. */
function classifyBuildState(row: DeploymentRecord): RollbackIneligibility | null {
  if (row.target !== "production") return "not_production";
  const cls = classifyDeployState(row.readyState);
  if (cls.phase === "error") return "build_failed";
  if (cls.phase === "pending") return "still_building";
  if (cls.phase === "canceled") return "canceled";
  if (cls.phase !== "ready") return "state_unknown";
  return null;
}

export type PlanRollbackArgs = {
  /** DevPilot's own ledger, any order. */
  records: readonly DeploymentRecord[];
  /** Vercel's live alias job, when it could be read. Used to identify what is
   *  serving production right now — a rollback moves production without
   *  producing a new deployment, so the newest row is NOT reliably the live one. */
  aliasJob: AliasRequest | null;
};

export type RollbackPlan = {
  targets: RollbackTarget[];
  /** The one-step target, if there is one. This is the "Revert to previous"
   *  button's subject and the only target reachable on Hobby. */
  previousProduction: DeploymentRecord | null;
  /** What production is serving now, as best DevPilot can tell. */
  live: DeploymentRecord | null;
};

/**
 * Order the project's deployments into rollback targets.
 *
 * Ordering is by `became_production_at` DESC — when each deployment began
 * serving production — not by creation time. Those differ whenever a deployment
 * is promoted or rolled back, and "what was live before this" is a question
 * about serving order, not build order. Rows that never served production sort
 * last and are refused with `never_live`.
 *
 * The live deployment is identified from Vercel's alias job when available
 * (`toDeploymentId`), because a rollback repoints production WITHOUT creating a
 * deployment — so after one, the most-recently-live row in DevPilot's ledger is
 * not what is being served. Falling back to the newest row is right only when no
 * alias job has ever run.
 */
export function planRollbackTargets(args: PlanRollbackArgs): RollbackPlan {
  const ordered = [...args.records].sort(compareByProductionRecency);

  const liveId = resolveLiveDeploymentId(ordered, args.aliasJob);
  const live = ordered.find((r) => r.vercelDeploymentId === liveId) ?? null;

  // The one-step target: the most recently live deployment that is not the live
  // one and is otherwise serviceable. Everything past it is plan-gated.
  const previous =
    ordered.find(
      (r) =>
        r.vercelDeploymentId !== liveId && classifyBuildState(r) === null && r.becameProductionAt,
    ) ?? null;

  const targets: RollbackTarget[] = ordered.map((row) => {
    const isLive = row.vercelDeploymentId === liveId;
    const isPrevious = previous !== null && row.vercelDeploymentId === previous.vercelDeploymentId;
    return {
      record: row,
      isLive,
      isPreviousProduction: isPrevious,
      eligibility: classifyRollbackTarget({ row, isLive, isPrevious }),
    };
  });

  return { targets, previousProduction: previous, live };
}

/**
 * Decide one row's rollback eligibility.
 *
 * Order matters: the most specific and most informative reason wins. A failed
 * build reported as "plan gated" would send the operator to a pricing page over
 * a deployment that could never have been a target at any price.
 */
export function classifyRollbackTarget(args: {
  row: DeploymentRecord;
  isLive: boolean;
  isPrevious: boolean;
}): TargetEligibility {
  const { row, isLive, isPrevious } = args;

  const build = classifyBuildState(row);
  if (build) return { eligible: false, reason: build, message: describeIneligibility(build) };

  if (isLive) {
    return {
      eligible: false,
      reason: "currently_live",
      message: describeIneligibility("currently_live"),
    };
  }
  if (!row.becameProductionAt) {
    return { eligible: false, reason: "never_live", message: describeIneligibility("never_live") };
  }
  if (!isPrevious) {
    // NOT a hard refusal in DevPilot's own reasoning — Vercel enforces it, and
    // only for Hobby. Rendered as a disabled row with the reason stated, so the
    // operator can see what a Pro plan would buy rather than wondering why their
    // deployment history has holes in it.
    return { eligible: false, reason: "plan_gated", message: describeIneligibility("plan_gated") };
  }

  // Note, not a refusal: a previously-promoted deployment IS a valid rollback
  // target — Vercel's docs say so explicitly. It is only the PROMOTE path that
  // refuses it. Surfaced so the row does not look mysteriously different from
  // its neighbours.
  return {
    eligible: true,
    note: row.promotedAt
      ? "DevPilot previously promoted this deployment. That is fine for a rollback — Vercel only refuses to PROMOTE an already-promoted deployment."
      : null,
  };
}

/**
 * Decide whether a deployment may be PROMOTED (the undo path).
 *
 * Different rules from rollback, because it is a different endpoint targeting a
 * different set:
 *
 *   • A non-production target is REFUSED outright rather than rebuilt. Vercel's
 *     CLI silently switches to `POST /v13/deployments` here and rebuilds a
 *     preview against production environment variables. That is a deploy wearing
 *     the word "undo", and it would breach exactly the preview/production
 *     boundary this feature is built around.
 *   • Already-promoted is a WARNING rather than a refusal. Vercel documents
 *     promote as THE way to undo a rollback, and the deployment being undone to
 *     has by definition served production — so a blanket local refusal would
 *     block the documented happy path. Vercel's own `409` is the authority, and
 *     the caller maps it to a message steering to rollback. (The `409` mapping
 *     is documented-but-unconfirmed; see the PR body.)
 */
export function classifyPromoteTarget(row: DeploymentRecord): TargetEligibility {
  const build = classifyBuildState(row);
  if (build) return { eligible: false, reason: build, message: describeIneligibility(build) };
  return {
    eligible: true,
    note: row.promotedAt
      ? "DevPilot has promoted this deployment before. Vercel may refuse to promote it again; if it does, roll back to it instead."
      : null,
  };
}

// ── The type-to-confirm gate ────────────────────────────────────────────────

export type RollbackGateFacts = {
  /** The deployment id the operator asked to roll back to. */
  deploymentId: string;
  /** What they typed into the confirm field. */
  confirmedId: string;
  /** The eligibility DevPilot computed for it, server-side. */
  eligibility: TargetEligibility;
  /** True when a rollback/promote is already resolving on this project. */
  aliasJobInFlight: boolean;
};

export type RollbackGateDecision =
  | { ok: true }
  | { ok: false; code: RollbackGateRefusal; message: string };

export type RollbackGateRefusal =
  | "blank_deployment"
  | "not_confirmed"
  | "ineligible"
  | "job_in_flight";

/**
 * Decide whether a rollback may proceed.
 *
 * The type-to-confirm is `deployProductionAction`'s precedent applied to a
 * strictly larger consequence: a production deploy ships something new, while a
 * rollback changes what live users are served RIGHT NOW, immediately, with no
 * build in between. The operator types the DEPLOYMENT ID, not a checkbox and not
 * a fixed word — so the thing confirmed is the thing that goes live. A checkbox
 * confirms a label, and a label can end up describing a different row than the
 * request carries.
 *
 * The eligibility re-check is not redundant with the UI: the browser sends a
 * deployment id, and this action is a browser-reachable endpoint. The server
 * re-derives eligibility from its own ledger, so a forged POST naming a failed
 * build, a preview, or the live deployment is refused with the same reason the
 * disabled row showed.
 */
export function decideRollbackGate(facts: RollbackGateFacts): RollbackGateDecision {
  const id = facts.deploymentId.trim();
  if (id.length === 0) {
    return { ok: false, code: "blank_deployment", message: "Pick a deployment to roll back to." };
  }
  if (facts.aliasJobInFlight) {
    return {
      ok: false,
      code: "job_in_flight",
      message:
        "Vercel is already repointing this project's production domains. Wait for that to finish — " +
        "starting a second rollback now would overwrite the record DevPilot is watching.",
    };
  }
  if (!facts.eligibility.eligible) {
    return { ok: false, code: "ineligible", message: facts.eligibility.message };
  }
  if (facts.confirmedId.trim() !== id) {
    return {
      ok: false,
      code: "not_confirmed",
      message:
        `Type "${id}" to confirm you are pointing production at it. ` +
        "This changes what live users are served immediately, with no build and no review step.",
    };
  }
  return { ok: true };
}

// ── Reporting the outcome ───────────────────────────────────────────────────

/** Vercel accepted the request. `queued` distinguishes a `202` — the promotion
 *  is waiting behind an active rolling release and production has NOT moved. */
export type AliasRequestOutcome = { accepted: true; queued: boolean };

/**
 * What to tell the operator after Vercel accepts a rollback or a promote.
 *
 * A `201` is ACCEPTED, not APPLIED — the alias remap is asynchronous and
 * per-alias, and it can partially fail. Saying "rolled back" on a `201` would be
 * the same class of lie as reporting a `202` as success, so the wording commits
 * only to what is known.
 */
export function describeAliasOutcome(args: {
  kind: "rollback" | "promote";
  outcome: AliasRequestOutcome;
}): string {
  const verb = args.kind === "rollback" ? "Rollback" : "Undo";
  if (args.outcome.queued) {
    return (
      `${verb} is QUEUED behind an active rolling release and has not taken effect yet. ` +
      "Production is still serving what it was serving before. Vercel will apply it when the " +
      "rolling release completes."
    );
  }
  return (
    `${verb} accepted. Vercel is repointing the production domains now — this is asynchronous and ` +
    "per-domain, so refresh in a moment to see the result Vercel reports."
  );
}

// ── Ordering helpers ────────────────────────────────────────────────────────

function productionRecency(row: DeploymentRecord): number {
  const t = Date.parse(row.becameProductionAt ?? "");
  if (!Number.isNaN(t)) return t;
  // Never served production: sorts below everything that has, regardless of how
  // recently it was built. `never_live` refuses it anyway; this only keeps the
  // list readable.
  return Number.NEGATIVE_INFINITY;
}

function compareByProductionRecency(a: DeploymentRecord, b: DeploymentRecord): number {
  // Compared, never SUBTRACTED: `never served production` is -Infinity, and
  // `-Infinity - -Infinity` is NaN, which makes a comparator silently
  // inconsistent and the resulting order implementation-defined.
  const pa = productionRecency(a);
  const pb = productionRecency(b);
  if (pa !== pb) return pb > pa ? 1 : -1;

  // Stable tiebreak so the list does not reshuffle between renders.
  const ca = Date.parse(a.createdAt ?? "");
  const cb = Date.parse(b.createdAt ?? "");
  const na = Number.isNaN(ca) ? 0 : ca;
  const nb = Number.isNaN(cb) ? 0 : cb;
  if (na !== nb) return nb - na;
  return a.vercelDeploymentId.localeCompare(b.vercelDeploymentId);
}

/**
 * Which deployment is serving production right now.
 *
 * Vercel's alias job is authoritative when it succeeded — a rollback repoints
 * production without building anything, so DevPilot's "most recently became
 * production" row is stale the moment one runs. An in-flight or failed job is
 * NOT used: production is either mid-move or never moved, and in both cases the
 * ledger's own answer is the better one.
 */
export function resolveLiveDeploymentId(
  ordered: readonly DeploymentRecord[],
  job: AliasRequest | null,
): string | null {
  if (job && job.jobStatus === "succeeded" && job.toDeploymentId) {
    return job.toDeploymentId;
  }
  const first = ordered.find((r) => r.target === "production" && r.becameProductionAt);
  return first?.vercelDeploymentId ?? null;
}
