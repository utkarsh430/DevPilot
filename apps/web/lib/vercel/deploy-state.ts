// The pure rules for triggering, classifying and reporting a Vercel deployment.
//
// No fetch, no DB, no `server-only` — everything here is a total function over
// plain data, which is what lets the safety decisions below be asserted by tests
// that never touch a network. The IO lives in `deploy.server.ts`; the durable
// polling loop lives in `lib/engine/vercel-deploy-poller.ts`.
//
// ── The one safety property this module carries ────────────────────────────
// Preview and production are different decisions with different consequences,
// and this codebase's precedent (the SME safety gate, `lib/board/safety-gate.ts`)
// is that such a boundary is expressed as an ABSENCE OF CAPABILITY rather than a
// flag someone can pass. So:
//
//   • `DeployTarget` is a two-value union, and the production path is gated by
//     `decideProductionDeployGate` — which every production trigger must clear.
//   • Nothing in this PR exposes a deploy to an agent. There is no MCP tool, no
//     entry in `DEVPILOT_BOARD_TOOLS`, and no engine path that reaches the deploy
//     action. Agent preview deploys are a deliberate later phase; the way to
//     keep "preview only" true in the meantime is for the capability not to
//     exist, not for a prompt to promise it.
//
// The gate is therefore about the HUMAN production path only: a human can
// legitimately deploy to production, and the job here is to make sure they are
// not doing it while DevPilot is showing them a warning they have not read.

/** What DevPilot can ask Vercel to build. Deliberately two values: `staging` and
 *  Vercel's other targets are not things this feature offers, and a wider union
 *  would be a wider blast radius for no gain. */
export type DeployTarget = "production" | "preview";

export function isDeployTarget(v: unknown): v is DeployTarget {
  return v === "production" || v === "preview";
}

// ── Deployment state ────────────────────────────────────────────────────────

/**
 * Vercel's `readyState` vocabulary, normalised into the four outcomes DevPilot
 * actually branches on.
 *
 * `unknown` is a first-class member and is treated as NON-TERMINAL. Vercel owns
 * this vocabulary and can add to it without our deploy; a value we do not
 * recognise must keep the poller polling (and the row readable) rather than
 * being guessed into `ready` — reporting an unrecognised state as a successful
 * deploy would write a production URL for a build that may have failed.
 */
export type DeployPhase = "pending" | "ready" | "error" | "canceled" | "unknown";

/** The states Vercel documents for `GET /v13/deployments/{id}`. Stored verbatim
 *  in `project_deployments.ready_state`; normalised here for branching. */
const PENDING_STATES = new Set([
  "QUEUED",
  "INITIALIZING",
  "BUILDING",
  "DEPLOYING",
  "ANALYZING",
  "UPLOADING",
]);

export type DeployClassification = {
  phase: DeployPhase;
  /** True when no further poll can change the answer. */
  terminal: boolean;
  /** True only for a build that finished successfully. */
  succeeded: boolean;
};

/**
 * Classify a raw `readyState`.
 *
 * Case-insensitive because Vercel has returned both `READY` and `ready` across
 * API versions, and a casing change silently reclassifying every deployment as
 * `unknown` would stall every poller at once.
 */
export function classifyDeployState(readyState: string | null | undefined): DeployClassification {
  const s = (readyState ?? "").trim().toUpperCase();
  if (s.length === 0) {
    return { phase: "unknown", terminal: false, succeeded: false };
  }
  if (s === "READY") return { phase: "ready", terminal: true, succeeded: true };
  if (s === "ERROR") return { phase: "error", terminal: true, succeeded: false };
  // Vercel has used both spellings. `BLOCKED` is terminal-but-not-an-error in
  // Vercel's docs; it is grouped with cancellation because the operator's next
  // move is the same (nothing built, look at the dashboard) and, critically,
  // because leaving it non-terminal would poll it to the ceiling every time.
  if (s === "CANCELED" || s === "CANCELLED" || s === "BLOCKED") {
    return { phase: "canceled", terminal: true, succeeded: false };
  }
  if (PENDING_STATES.has(s)) return { phase: "pending", terminal: false, succeeded: false };
  return { phase: "unknown", terminal: false, succeeded: false };
}

// ── The production gate ─────────────────────────────────────────────────────

/**
 * Everything the production gate reasons about. All of it is already computed
 * elsewhere (`decideBranchAlignment`, `interpretProductionAutoDeploy`,
 * `loadVercelLinkStatus`) — this type exists so the DECISION is in one tested
 * place rather than assembled in a server action.
 */
export type ProductionGateFacts = {
  /** The git ref the operator asked to deploy. */
  ref: string;
  /** The ref they typed into the confirm field. */
  confirmedRef: string;
  /** Vercel's live production branch, or null when it could not be read. */
  liveProductionBranch: string | null;
  /** The branch this project expects production to track. */
  desiredProductionBranch: string | null;
  /** True when `liveProductionBranch` is a stored snapshot, not a fresh read. */
  branchIsStale: boolean;
};

export type ProductionGateDecision =
  | { ok: true; warnings: string[] }
  | { ok: false; code: ProductionGateRefusal; message: string };

export type ProductionGateRefusal = "ref_not_confirmed" | "blank_ref";

/**
 * Decide whether a human's production deploy may proceed.
 *
 * Two distinct jobs, and they are deliberately not collapsed:
 *
 *   REFUSE when the operator has not confirmed the exact ref. This is the
 *   `discardAndRestartFromDevAction` type-to-confirm precedent. It exists so a
 *   production deploy cannot be a misclick, and so the thing confirmed is the
 *   thing that actually ships — the ref, not a checkbox whose label might be
 *   describing a different branch than the one in the request.
 *
 *   WARN, but proceed, when DevPilot's production surface is in a state the
 *   operator has already been warned about (PR 2's branch-alignment surface:
 *   the live production branch differs from the expected one, or could not be
 *   read at all). This is the brief's "do not quietly proceed as though it were
 *   fine". Refusing outright would be wrong — deploying a specific ref to
 *   production is exactly the escape hatch an operator needs WHEN the automatic
 *   surface is misconfigured — but proceeding silently would hide the
 *   misconfiguration behind a green result. So the deploy happens and the
 *   warning is returned for the caller to surface alongside it.
 *
 * Note what is NOT here: the auto-deploy `armed`/`gated` state. That governs
 * whether GIT PUSHES deploy on their own; it says nothing about whether this
 * explicit, human-triggered, confirmed deploy should run, and folding it in
 * would refuse the deploy button precisely on the projects that need it most.
 */
export function decideProductionDeployGate(facts: ProductionGateFacts): ProductionGateDecision {
  const ref = facts.ref.trim();
  if (ref.length === 0) {
    return { ok: false, code: "blank_ref", message: "Pick a branch or commit to deploy." };
  }
  if (facts.confirmedRef.trim() !== ref) {
    return {
      ok: false,
      code: "ref_not_confirmed",
      message:
        `Type "${ref}" to confirm you are deploying it to production. ` +
        "Production deploys are live immediately and are not reviewed.",
    };
  }

  const warnings: string[] = [];
  const live = (facts.liveProductionBranch ?? "").trim();
  const desired = (facts.desiredProductionBranch ?? "").trim();

  if (live.length === 0 || facts.branchIsStale) {
    warnings.push(
      "DevPilot could not confirm which branch Vercel currently deploys production from, " +
        "so it cannot tell you whether this project's production settings are what you expect. " +
        "The deploy below still ships the ref you confirmed.",
    );
  } else if (desired.length > 0 && live !== desired) {
    warnings.push(
      `Vercel's production branch is "${live}", but this project expects "${desired}". ` +
        "That mismatch was already flagged on this card and is unresolved. " +
        `This deploy ships "${ref}" to production regardless of either setting.`,
    );
  }

  if (live.length > 0 && ref !== live) {
    warnings.push(
      `You are deploying "${ref}", which is not Vercel's production branch ("${live}"). ` +
        "It will go live now, but the next push to the production branch will replace it.",
    );
  }

  return { ok: true, warnings };
}

// ── Polling schedule ────────────────────────────────────────────────────────

/**
 * How long to wait before poll number `attempt` (1-based), in seconds.
 *
 * Shape: fast at the start (a trivial Next.js build can be READY inside 30s and
 * an operator watching the card should not wait a minute to be told), then
 * backing off, because most of a real build is spent in the middle where a tight
 * poll buys nothing and just spends Vercel rate-limit budget.
 *
 * Bounded by `MAX_DEPLOY_POLLS`: the schedule below sums to roughly 30 minutes,
 * which is well past Vercel's own 45-minute build ceiling for the small projects
 * this feature targets while still guaranteeing the Inngest run terminates. A
 * deploy still building at the cap is recorded as such and left for the operator
 * — NOT recorded as failed, which would be a lie about a build that may yet
 * succeed.
 */
export const MAX_DEPLOY_POLLS = 40;

export function pollDelaySeconds(attempt: number): number {
  if (attempt <= 1) return 5;
  if (attempt <= 3) return 10;
  if (attempt <= 8) return 20;
  if (attempt <= 16) return 45;
  return 60;
}

// ── Reporting ───────────────────────────────────────────────────────────────

export type DeployOutcomeFacts = {
  target: DeployTarget;
  phase: DeployPhase;
  /** Vercel's deployment id (`dpl_…`). */
  deploymentId: string;
  /** The deployed URL, when there is one. */
  url: string | null;
  /** Vercel's build-log deep link. */
  inspectorUrl: string | null;
  ref: string | null;
  commitSha: string | null;
  /** Already bounded and scrubbed by the caller. */
  errorMessage: string | null;
  /** True when the poll ceiling was hit before a terminal state. */
  timedOut: boolean;
};

/** Short, stable label for a badge. */
export function deployPhaseLabel(phase: DeployPhase): string {
  switch (phase) {
    case "ready":
      return "Ready";
    case "error":
      return "Failed";
    case "canceled":
      return "Canceled";
    case "pending":
      return "Building";
    default:
      return "Unknown";
  }
}

export function deployPhaseTone(phase: DeployPhase): "ok" | "warn" | "danger" | "muted" {
  switch (phase) {
    case "ready":
      return "ok";
    case "error":
      return "danger";
    case "canceled":
      return "warn";
    case "pending":
      return "muted";
    default:
      return "warn";
  }
}

/**
 * The ticket comment body for a finished deploy.
 *
 * ⚠️ SECURITY: this string is written to a ticket thread, which every agent
 * working that ticket reads. It carries the deployment id, the URL, the SHA and
 * the build-log link — and NOTHING from the env push. Not the values (obviously)
 * and not the key names either: which variables a project holds is not
 * information a deploy notification needs to carry, and the natural "helpful"
 * implementation that lists what it pushed is precisely the leak the plan (§8)
 * calls out. There is a test asserting no env key reaches this function's
 * output, because the failure mode is a well-intentioned later edit.
 *
 * `errorMessage` is Vercel's text and is UNTRUSTED third-party content. The
 * caller bounds and scrubs it; it is rendered as a plain quoted line rather than
 * interpolated into instructions.
 */
export function formatDeployComment(facts: DeployOutcomeFacts): string {
  const targetWord = facts.target === "production" ? "Production" : "Preview";
  const lines: string[] = [];

  if (facts.timedOut) {
    lines.push(
      `⏳ ${targetWord} deploy is still building after ${MAX_DEPLOY_POLLS} checks. DevPilot stopped watching it; it may still finish.`,
    );
  } else if (facts.phase === "ready") {
    lines.push(`✅ ${targetWord} deploy succeeded.`);
  } else if (facts.phase === "error") {
    lines.push(`❌ ${targetWord} deploy FAILED to build.`);
  } else if (facts.phase === "canceled") {
    lines.push(`🚫 ${targetWord} deploy was canceled before it finished.`);
  } else {
    lines.push(`❔ ${targetWord} deploy ended in a state DevPilot does not recognise.`);
  }

  lines.push("");
  if (facts.url) lines.push(`- URL: ${facts.url}`);
  if (facts.ref) lines.push(`- Branch: \`${facts.ref}\``);
  if (facts.commitSha) lines.push(`- Commit: \`${facts.commitSha.slice(0, 12)}\``);
  lines.push(`- Deployment: \`${facts.deploymentId}\``);

  // The build log is the single most useful thing on a failure, so it is a
  // first-class line rather than a footnote.
  if (facts.inspectorUrl) {
    lines.push(
      `- Build log: ${facts.inspectorUrl}${facts.phase === "error" ? "  ← start here" : ""}`,
    );
  } else if (facts.phase === "error") {
    lines.push(
      "- Build log: not available from Vercel for this deployment — open it from the Vercel dashboard.",
    );
  }

  if (facts.errorMessage) {
    lines.push("");
    lines.push(`> ${facts.errorMessage}`);
  }

  return lines.join("\n");
}

/** Author id for the deploy comment. A distinct author so it is filterable and
 *  so it can never be mistaken for a verdict by `ticket-reconciler.ts`, which
 *  string-matches `devpilot_move_ticket`. */
export const DEPLOY_COMMENT_AUTHOR = "devpilot_deploy";
