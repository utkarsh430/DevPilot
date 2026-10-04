import "server-only";

// The live view of a project's Vercel link, assembled for the DeploymentCard.
//
// ── Why this reads Vercel on every render instead of trusting the DB ───────
// `projects.vercel_production_branch` is a SNAPSHOT taken at link time, and
// `link.productionBranch` is read-only in Vercel's API — the operator can change
// it in the Vercel dashboard at any moment and DevPilot gets no webhook. Whether
// git pushes deploy to production is likewise Vercel's state, not ours.
//
// The acceptance criterion for this feature is that the card tells the operator
// the truth about what is armed. A mirror rendered as fact fails that criterion
// the first time the two disagree — and the direction of that failure is the bad
// one: a stored "gated" shown for a project that is actually armed. So the live
// read is the primary source and the stored snapshot is only ever a labelled
// fallback.
//
// Never throws. A Vercel outage must degrade the card to "could not confirm —
// assume production is armed", not 500 the project page.

import { resolveVercelConfig } from "@/lib/vercel/api.server";
import { getVercelProject } from "@/lib/vercel/api";
import { VercelApiError } from "@/lib/vercel/errors";
import {
  interpretProductionAutoDeploy,
  type ProdDeployMode,
  type ProductionAutoDeploy,
} from "@/lib/vercel/deploy-policy";
import { interpretLastAliasRequest, type AliasRequest } from "@/lib/vercel/rollback-state";
import type { ProjectRecord } from "@/lib/projects/load";

export type VercelLinkStatus = {
  linked: boolean;
  vercelProjectId: string | null;
  vercelProjectName: string | null;
  /** Where to go to see the truth on Vercel's side.
   *
   *  Deliberately the generic dashboard, not a guessed deep link: a project URL
   *  is `vercel.com/<scope-slug>/<project>` and we do not reliably hold the
   *  scope slug (a personal token's scope is a username, a team's is a team
   *  slug, and fetching either is an extra call per render). A deep link that
   *  404s is worse than a correct generic one, because the operator reads the
   *  404 as "DevPilot lost the project". */
  dashboardUrl: string;
  /** Live production auto-deploy state. `unknown` is treated as armed. */
  state: ProductionAutoDeploy;
  /** Live production branch, or the stored snapshot when the read failed. */
  productionBranch: string | null;
  /** True when `productionBranch` is the stored snapshot, not a fresh read. */
  branchIsStale: boolean;
  /** What the operator asked for, for divergence detection. */
  recordedMode: ProdDeployMode | null;
  /** Operator-facing reason the live read failed, already scrubbed. */
  error: string | null;
  /**
   * Vercel's last alias-remap job — the record BOTH rollback and promote write
   * into. Null when there has never been one, or when the live read failed.
   *
   * Read here rather than by a second loader because it comes off the SAME
   * project response this function already fetches, and the project page renders
   * on every navigation: a dedicated fetch would double the Vercel round trips
   * per render to re-read a field already in hand.
   *
   * Null is genuinely ambiguous — "no rollback has ever run" and "we could not
   * read it" are both null — so the rolled-back banner is rendered only from a
   * POSITIVE reading, and `error` above is what tells the operator the live view
   * is unavailable.
   */
  aliasJob: AliasRequest | null;
};

const VERCEL_DASHBOARD_URL = "https://vercel.com/dashboard";

const UNLINKED: VercelLinkStatus = {
  linked: false,
  vercelProjectId: null,
  vercelProjectName: null,
  dashboardUrl: VERCEL_DASHBOARD_URL,
  state: "unknown",
  productionBranch: null,
  branchIsStale: false,
  recordedMode: null,
  error: null,
  aliasJob: null,
};

export async function loadVercelLinkStatus(
  tenantId: string | null,
  project: Pick<
    ProjectRecord,
    "vercelProjectId" | "vercelProjectName" | "vercelProductionBranch" | "vercelProdDeployMode"
  >,
): Promise<VercelLinkStatus> {
  if (!project.vercelProjectId) return UNLINKED;

  const base: VercelLinkStatus = {
    linked: true,
    vercelProjectId: project.vercelProjectId,
    vercelProjectName: project.vercelProjectName,
    dashboardUrl: VERCEL_DASHBOARD_URL,
    // Start from `unknown`, not from the stored mode. The stored value is intent;
    // starting from it would mean a failed read renders the operator's WISH as
    // the observed state, which is precisely the lie this module exists to
    // prevent.
    state: "unknown",
    productionBranch: project.vercelProductionBranch,
    branchIsStale: true,
    recordedMode: project.vercelProdDeployMode,
    error: null,
    aliasJob: null,
  };

  try {
    const config = await resolveVercelConfig(tenantId);
    const token = (config.token ?? "").trim();
    if (token.length === 0) {
      return {
        ...base,
        error: "No Vercel token is configured, so the live state could not be read.",
      };
    }
    const live = await getVercelProject(project.vercelProjectId, {
      credential: { token, teamId: config.teamId },
      fetchImpl: (url, init) => fetch(url, init),
      // Tighter than the client's 15s default because this sits on a PAGE
      // RENDER. Degrading to "could not confirm" after 5s is strictly better
      // than holding the whole project page for fifteen: the fallback is
      // labelled, actionable, and treated as armed, so a timeout loses accuracy
      // but never safety.
      timeoutMs: 5_000,
    });
    return {
      ...base,
      vercelProjectName: live.name ?? project.vercelProjectName,
      state: interpretProductionAutoDeploy(live.raw),
      productionBranch: live.link?.productionBranch ?? null,
      branchIsStale: false,
      aliasJob: interpretLastAliasRequest(live.raw),
    };
  } catch (err) {
    const message =
      err instanceof VercelApiError
        ? err.message
        : "Could not read this project's state from Vercel.";
    return { ...base, error: message };
  }
}
