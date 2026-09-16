// The pure deploy rules: state classification, the production gate, the poll
// schedule, and the comment body.
//
// This suite carries most of the confidence for PR 4, because the feature
// shipped without a live Vercel project to test against. What it proves is that
// every state Vercel can report maps to the right decision, and that the two
// security properties (production cannot be reached without an exact
// confirmation; no environment-variable name reaches a ticket comment) hold.

import { describe, expect, it } from "vitest";
import {
  classifyDeployState,
  decideProductionDeployGate,
  deployPhaseLabel,
  deployPhaseTone,
  formatDeployComment,
  isDeployTarget,
  MAX_DEPLOY_POLLS,
  pollDelaySeconds,
  type DeployOutcomeFacts,
} from "@/lib/vercel/deploy-state";

describe("classifyDeployState", () => {
  it("treats every documented in-flight state as pending and non-terminal", () => {
    for (const s of ["QUEUED", "INITIALIZING", "BUILDING", "DEPLOYING", "ANALYZING", "UPLOADING"]) {
      const c = classifyDeployState(s);
      expect(c, s).toEqual({ phase: "pending", terminal: false, succeeded: false });
    }
  });

  it("READY is the ONLY state that counts as success", () => {
    expect(classifyDeployState("READY")).toEqual({
      phase: "ready",
      terminal: true,
      succeeded: true,
    });
    // Everything else, terminal or not, must not report success — a false
    // success writes `vercel_production_url` for a build that may have failed.
    for (const s of ["QUEUED", "BUILDING", "ERROR", "CANCELED", "BLOCKED", "WAT", ""]) {
      expect(classifyDeployState(s).succeeded, s).toBe(false);
    }
  });

  it("ERROR is terminal and unsuccessful", () => {
    expect(classifyDeployState("ERROR")).toEqual({
      phase: "error",
      terminal: true,
      succeeded: false,
    });
  });

  it("both spellings of cancelled, and BLOCKED, are terminal", () => {
    for (const s of ["CANCELED", "CANCELLED", "BLOCKED"]) {
      const c = classifyDeployState(s);
      expect(c.phase, s).toBe("canceled");
      // Load-bearing: a non-terminal BLOCKED would poll to the ceiling every
      // time, for a build that will never move.
      expect(c.terminal, s).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(classifyDeployState("ready").phase).toBe("ready");
    expect(classifyDeployState("  Error ").phase).toBe("error");
  });

  it("an UNRECOGNISED state is unknown and NON-terminal, never guessed into ready", () => {
    // Vercel owns this vocabulary and can extend it without our deploy. Keeping
    // polling is the safe direction; guessing success is not.
    for (const s of ["SOME_NEW_STATE", "", null, undefined]) {
      const c = classifyDeployState(s);
      expect(c.phase, String(s)).toBe("unknown");
      expect(c.terminal, String(s)).toBe(false);
      expect(c.succeeded, String(s)).toBe(false);
    }
  });
});

describe("isDeployTarget", () => {
  it("admits only the two targets this feature offers", () => {
    expect(isDeployTarget("production")).toBe(true);
    expect(isDeployTarget("preview")).toBe(true);
    for (const v of ["staging", "PRODUCTION", "", null, undefined, 1, {}]) {
      expect(isDeployTarget(v), String(v)).toBe(false);
    }
  });
});

// ── The production gate ─────────────────────────────────────────────────────

const ALIGNED = {
  ref: "dev",
  confirmedRef: "dev",
  liveProductionBranch: "dev",
  desiredProductionBranch: "dev",
  branchIsStale: false,
};

describe("decideProductionDeployGate", () => {
  it("allows a confirmed deploy of the aligned production branch, with no warnings", () => {
    const d = decideProductionDeployGate(ALIGNED);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.warnings).toEqual([]);
  });

  it("REFUSES when the confirmation does not match the ref exactly", () => {
    // Note `"dev "` is deliberately absent: it TRIMS to a match, which the next
    // test asserts is intended. Casing and prefixes are the real near-misses.
    for (const confirmedRef of ["", "de", "DEV", "devv", "main", "yes"]) {
      const d = decideProductionDeployGate({ ...ALIGNED, confirmedRef });
      expect(d.ok, JSON.stringify(confirmedRef)).toBe(false);
      if (!d.ok) expect(d.code).toBe("ref_not_confirmed");
    }
  });

  it("accepts a confirmation with surrounding whitespace, since the ref is trimmed too", () => {
    const d = decideProductionDeployGate({ ...ALIGNED, confirmedRef: "  dev  " });
    expect(d.ok).toBe(true);
  });

  it("REFUSES a blank ref before anything else", () => {
    const d = decideProductionDeployGate({ ...ALIGNED, ref: "   ", confirmedRef: "   " });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("blank_ref");
  });

  it("WARNS but PROCEEDS when the live production branch differs from the expected one", () => {
    // The brief's "do not quietly proceed as though it were fine". Refusing
    // would be wrong — an explicit ref deploy is the escape hatch a
    // misconfigured project needs — but it must not read as all-clear.
    const d = decideProductionDeployGate({
      ...ALIGNED,
      liveProductionBranch: "main",
      desiredProductionBranch: "dev",
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.warnings.length).toBeGreaterThan(0);
      expect(d.warnings.join(" ")).toContain("main");
      expect(d.warnings.join(" ")).toContain("dev");
    }
  });

  it("WARNS when the live production branch could not be read at all", () => {
    const d = decideProductionDeployGate({ ...ALIGNED, liveProductionBranch: null });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.warnings.join(" ")).toMatch(/could not confirm/i);
  });

  it("WARNS on a STALE branch read even when the stored value happens to match", () => {
    // A stale read that agrees with the expectation is not evidence: the stored
    // snapshot is what it agrees with, and it could be arbitrarily old.
    const d = decideProductionDeployGate({ ...ALIGNED, branchIsStale: true });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.warnings.length).toBeGreaterThan(0);
  });

  it("WARNS when deploying a ref that is not the production branch", () => {
    const d = decideProductionDeployGate({
      ref: "hotfix",
      confirmedRef: "hotfix",
      liveProductionBranch: "dev",
      desiredProductionBranch: "dev",
      branchIsStale: false,
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.warnings.join(" ")).toMatch(/next push to the production branch/i);
  });
});

// ── Poll schedule ───────────────────────────────────────────────────────────

describe("pollDelaySeconds", () => {
  it("starts fast and backs off monotonically", () => {
    let prev = 0;
    for (let i = 1; i <= MAX_DEPLOY_POLLS; i++) {
      const d = pollDelaySeconds(i);
      expect(d).toBeGreaterThan(0);
      expect(d, `attempt ${i}`).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it("the full schedule covers a realistic build without being unbounded", () => {
    let total = 0;
    for (let i = 1; i <= MAX_DEPLOY_POLLS; i++) total += pollDelaySeconds(i);
    // Comfortably past a small Next.js build, and guaranteed to terminate.
    expect(total).toBeGreaterThan(20 * 60);
    expect(total).toBeLessThan(60 * 60);
  });
});

// ── The comment ─────────────────────────────────────────────────────────────

const BASE: DeployOutcomeFacts = {
  target: "preview",
  phase: "ready",
  deploymentId: "dpl_abc",
  url: "https://x.vercel.app",
  inspectorUrl: "https://vercel.com/acme/x/dpl_abc",
  ref: "dev",
  commitSha: "0123456789abcdef0123",
  errorMessage: null,
  timedOut: false,
};

describe("formatDeployComment", () => {
  it("names the deployment, URL, branch, commit and build log on success", () => {
    const body = formatDeployComment(BASE);
    expect(body).toContain("dpl_abc");
    expect(body).toContain("https://x.vercel.app");
    expect(body).toContain("dev");
    expect(body).toContain("0123456789ab");
    expect(body).toContain("https://vercel.com/acme/x/dpl_abc");
    expect(body).toMatch(/succeeded/i);
  });

  it("a FAILED deploy points at the build log — the whole point of the failure surface", () => {
    const body = formatDeployComment({ ...BASE, phase: "error", errorMessage: "Build exceeded" });
    expect(body).toMatch(/FAILED/);
    expect(body).toContain("https://vercel.com/acme/x/dpl_abc");
    expect(body).toContain("start here");
    expect(body).toContain("Build exceeded");
  });

  it("a failure with NO inspector url says so instead of silently omitting it", () => {
    // "Deploy failed" with no route to the log is the dead end this avoids.
    const body = formatDeployComment({ ...BASE, phase: "error", inspectorUrl: null });
    expect(body).toMatch(/build log/i);
    expect(body).toMatch(/Vercel dashboard/i);
  });

  it("distinguishes cancelled and timed-out from failed", () => {
    expect(formatDeployComment({ ...BASE, phase: "canceled" })).toMatch(/canceled/i);
    const timed = formatDeployComment({ ...BASE, phase: "pending", timedOut: true });
    expect(timed).toMatch(/still building/i);
    // A build we stopped watching is NOT a failed build, and must not say so.
    expect(timed).not.toMatch(/FAILED/);
  });

  it("labels the target, so a production deploy is never mistaken for a preview", () => {
    expect(formatDeployComment({ ...BASE, target: "production" })).toContain("Production");
    expect(formatDeployComment({ ...BASE, target: "preview" })).toContain("Preview");
  });

  it("SECURITY: carries nothing from the env push — not values, not key names", () => {
    // Every agent working the ticket reads this comment. The natural "helpful"
    // implementation lists what it pushed; the plan (§8) calls that out
    // specifically, and this asserts the function has no channel for it. The
    // facts type has no env field at all, so this test is really pinning that
    // property against a later well-intentioned edit.
    const body = formatDeployComment({
      ...BASE,
      target: "production",
      errorMessage: "Missing environment variable",
    });
    for (const leak of ["DATABASE_URL", "STRIPE_SECRET_KEY", "sk_live_", "ANTHROPIC_API_KEY"]) {
      expect(body, leak).not.toContain(leak);
    }
    expect(Object.keys(BASE)).not.toContain("envKeys");
  });

  it("renders an unrecognised terminal state honestly rather than as success", () => {
    const body = formatDeployComment({ ...BASE, phase: "unknown" });
    expect(body).toMatch(/does not recognise/i);
    expect(body).not.toMatch(/succeeded/i);
  });
});

describe("phase presentation", () => {
  it("gives every phase a label and a tone, with unknown never reading as ok", () => {
    for (const p of ["pending", "ready", "error", "canceled", "unknown"] as const) {
      expect(deployPhaseLabel(p).length).toBeGreaterThan(0);
      expect(["ok", "warn", "danger", "muted"]).toContain(deployPhaseTone(p));
    }
    expect(deployPhaseTone("ready")).toBe("ok");
    expect(deployPhaseTone("error")).toBe("danger");
    expect(deployPhaseTone("unknown")).not.toBe("ok");
  });
});
