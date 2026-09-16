// The production auto-deploy safety rules.
//
// These are the assertions the PR lives or dies on, so several are paired with a
// CONTROL case that neuters the guard and confirms the assertion goes red. A
// guard test that stays green when the guard is deleted is worth nothing, and
// the failure mode here is silent: a project reported as gated while every agent
// push goes live.

import { describe, expect, it } from "vitest";
import {
  buildProductionGitPolicy,
  decideBranchAlignment,
  describeProductionBranch,
  interpretProductionAutoDeploy,
  isProdDeployMode,
  shouldWarnProductionArmed,
  type ProductionBranchFacts,
} from "@/lib/vercel/deploy-policy";

const GATED_RULE = {
  enabled: false,
  environments: [{ type: "system", target: "production" }],
  sources: [{ provider: "github", org: "acme", repo: "app" }],
};

describe("buildProductionGitPolicy", () => {
  it("builds a production-scoped rule for exactly the named repo", () => {
    const body = buildProductionGitPolicy({ org: "acme", repo: "app", enabled: false });
    const rule = body.deploymentPolicy.gitSources[0]!;
    expect(rule.enabled).toBe(false);
    expect(rule.environments).toEqual([{ type: "system", target: "production" }]);
    expect(rule.sources).toEqual([{ provider: "github", org: "acme", repo: "app" }]);
  });

  it("never touches the preview environment", () => {
    // Preview deploys must keep working — gating them would take away the thing
    // that makes a linked repo useful, and was never the risk.
    const body = buildProductionGitPolicy({ org: "acme", repo: "app", enabled: false });
    const targets = body.deploymentPolicy.gitSources.flatMap((r) =>
      r.environments.map((e) => e.target),
    );
    expect(targets).not.toContain("preview");
  });

  it("emits an explicit enabling rule when auto-deploy is chosen", () => {
    // Not "no rule": an explicit rule is what lets the read-back report a
    // definite `armed` rather than the ambiguous absence of any policy.
    const body = buildProductionGitPolicy({ org: "acme", repo: "app", enabled: true });
    expect(body.deploymentPolicy.gitSources[0]!.enabled).toBe(true);
  });
});

describe("interpretProductionAutoDeploy", () => {
  it("reads a disabling production rule as gated", () => {
    expect(interpretProductionAutoDeploy({ deploymentPolicy: { gitSources: [GATED_RULE] } })).toBe(
      "gated",
    );
  });

  it("reads an enabling production rule as armed", () => {
    expect(
      interpretProductionAutoDeploy({
        deploymentPolicy: { gitSources: [{ ...GATED_RULE, enabled: true }] },
      }),
    ).toBe("armed");
  });

  it("reads a policy that says nothing about production as armed", () => {
    // Vercel's default applies, and its default is push-to-deploy.
    expect(
      interpretProductionAutoDeploy({
        deploymentPolicy: {
          gitSources: [
            {
              enabled: false,
              environments: [{ type: "system", target: "preview" }],
              sources: [{ provider: "github", org: "acme", repo: "app" }],
            },
          ],
        },
      }),
    ).toBe("armed");
  });

  it("reads an ABSENT deploymentPolicy as unknown, never gated", () => {
    // This is the case that decides whether this feature is honest. An account
    // or API version that does not support deploymentPolicy returns no such
    // field, and reporting that as "gated" would put a green tick over a live
    // production environment.
    expect(interpretProductionAutoDeploy({ id: "prj_1", name: "app" })).toBe("unknown");
  });

  it.each([
    ["null", null],
    ["a string", "nope"],
    ["an array", []],
    ["a policy with a non-array gitSources", { deploymentPolicy: { gitSources: "all" } }],
    ["a policy with junk rules", { deploymentPolicy: { gitSources: [1, "x", null] } }],
  ])("degrades %s to unknown rather than gated", (_label, body) => {
    expect(interpretProductionAutoDeploy(body)).not.toBe("gated");
  });

  it("does not report gated when ANY production rule still enables deploys", () => {
    expect(
      interpretProductionAutoDeploy({
        deploymentPolicy: { gitSources: [GATED_RULE, { ...GATED_RULE, enabled: true }] },
      }),
    ).toBe("armed");
  });
});

describe("shouldWarnProductionArmed", () => {
  it("treats unknown as armed", () => {
    expect(shouldWarnProductionArmed("unknown")).toBe(true);
    expect(shouldWarnProductionArmed("armed")).toBe(true);
  });

  it("CONTROL: only an observed gate silences the warning", () => {
    expect(shouldWarnProductionArmed("gated")).toBe(false);
  });
});

describe("isProdDeployMode", () => {
  it("accepts only the two modes", () => {
    expect(isProdDeployMode("devpilot_gated")).toBe(true);
    expect(isProdDeployMode("git_auto")).toBe(true);
    for (const bad of ["", "GIT_AUTO", "off", null, undefined, 1, {}]) {
      expect(isProdDeployMode(bad)).toBe(false);
    }
  });
});

// ── Branch alignment ────────────────────────────────────────────────────────

describe("decideBranchAlignment", () => {
  it("reports aligned when the live branch matches the expected one", () => {
    const r = decideBranchAlignment({
      desiredBranch: "dev",
      liveBranch: "dev",
      branchIsStale: false,
    });
    expect(r.status).toBe("aligned");
    expect(r.manualSteps).toEqual([]);
  });

  it("reports misaligned, names BOTH branches, and gives manual steps", () => {
    const r = decideBranchAlignment({
      desiredBranch: "dev",
      liveBranch: "main",
      branchIsStale: false,
    });
    expect(r.status).toBe("misaligned");
    expect(r.summary).toContain("main");
    expect(r.summary).toContain("dev");
    expect(r.manualSteps.length).toBeGreaterThan(0);
    // The steps must say WHY it is manual, or the operator hunts for a button
    // that cannot exist.
    expect(r.manualSteps.join(" ")).toMatch(/read-only/i);
  });

  it("does NOT report misaligned on a stale read", () => {
    // Sending someone to fix a setting that may already be correct, on the
    // strength of a network blip, is how a banner becomes noise.
    const r = decideBranchAlignment({
      desiredBranch: "dev",
      liveBranch: "main",
      branchIsStale: true,
    });
    expect(r.status).toBe("unknown");
  });

  it("does not claim alignment when nothing was read", () => {
    const r = decideBranchAlignment({
      desiredBranch: "dev",
      liveBranch: null,
      branchIsStale: false,
    });
    expect(r.status).toBe("unknown");
  });

  it("says so plainly when no expected branch is recorded", () => {
    const r = decideBranchAlignment({
      desiredBranch: null,
      liveBranch: "main",
      branchIsStale: false,
    });
    expect(r.status).toBe("unset");
    expect(r.manualSteps).toEqual([]);
  });
});

// ── The operator-facing statement ───────────────────────────────────────────

const BASE: ProductionBranchFacts = {
  state: "armed",
  productionBranch: "dev",
  branchIsStale: false,
  integrationBranch: "dev",
  autoLandEnabled: true,
  defaultBranch: "main",
  intended: false,
};

describe("describeProductionBranch", () => {
  it("names the branch and states the consequence when armed", () => {
    const s = describeProductionBranch({
      ...BASE,
      autoLandEnabled: false,
      integrationBranch: null,
    });
    expect(s.headline).toContain('"dev"');
    expect(s.headline).toMatch(/deploys to production automatically/i);
    expect(s.headline).toMatch(/without further approval/i);
  });

  it("spells out that completed agent tickets self-deploy when auto-land targets the production branch", () => {
    const s = describeProductionBranch(BASE);
    const all = [s.headline, ...s.detail].join(" ");
    expect(all).toMatch(/auto-land/i);
    expect(all).toMatch(/no human approval/i);
  });

  it("escalates to danger only when that configuration was NOT chosen", () => {
    expect(describeProductionBranch(BASE).tone).toBe("danger");
    // The captain's intended shape — production tracks dev on purpose — is
    // stated just as explicitly but is not an alarm. An alarm that fires on the
    // intended configuration is one people switch off.
    const chosen = describeProductionBranch({ ...BASE, intended: true });
    expect(chosen.tone).toBe("warn");
    expect([chosen.headline, ...chosen.detail].join(" ")).toMatch(/auto-land/i);
  });

  it("still names the branch when gated, because the gate is all that stands between them", () => {
    const s = describeProductionBranch({ ...BASE, state: "gated" });
    expect(s.tone).toBe("ok");
    expect(s.headline).toContain('"dev"');
    expect(s.headline).toMatch(/do NOT deploy to production/i);
  });

  it("tells the operator to assume armed when the state is unknown", () => {
    const s = describeProductionBranch({ ...BASE, state: "unknown" });
    expect(s.tone).not.toBe("ok");
    expect([s.headline, ...s.detail].join(" ")).toMatch(/assume/i);
  });

  it("labels a stale branch value rather than presenting it as current", () => {
    const s = describeProductionBranch({ ...BASE, branchIsStale: true });
    expect(s.headline).toMatch(/last known value/i);
  });

  it("does not claim agents reach production when auto-land is off", () => {
    const s = describeProductionBranch({ ...BASE, autoLandEnabled: false });
    const all = [s.headline, ...s.detail].join(" ");
    expect(all).toMatch(/no agent reaches production on its own/i);
    expect(s.tone).toBe("warn");
  });
});
