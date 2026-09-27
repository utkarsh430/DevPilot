// The pure rollback rules.
//
// Every assertion here is a REFUSAL or a piece of stated truth, not a
// convenience. The feature ships without a live Vercel account to try it
// against, so these tests are the only thing standing between the design in
// `data/devpilot-vercel-rollback-check-r2/report.md` and a control that quietly
// does the wrong thing to production.
//
// The two properties worth naming up front, because they are the ones a
// well-intentioned later edit would break:
//
//   • An ineligible target is never silently omitted. Every refusal carries a
//     reason, and the reason is the SPECIFIC one — a failed build must not
//     report as "requires Pro", because that sends the operator to a pricing
//     page over a deployment that could never have been a target at any price.
//   • Already-promoted refuses on the PROMOTE path and NOT on the rollback path.
//     Vercel's docs are explicit that a previously-promoted deployment is what
//     you roll back to. Refusing it on both paths would leave the operator with
//     no control at all for the most common target.

import { describe, expect, it } from "vitest";
import type { DeploymentRecord } from "@/lib/vercel/deploy-write";
import {
  classifyPromoteTarget,
  classifyRollbackTarget,
  decideRollbackGate,
  describeAliasOutcome,
  describeRollbackState,
  interpretLastAliasRequest,
  isAliasJobInFlight,
  isRolledBack,
  planRollbackTargets,
  resolveLiveDeploymentId,
  ROLLBACK_WARNINGS,
  type AliasRequest,
} from "@/lib/vercel/rollback-state";

function rec(over: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    id: over.vercelDeploymentId ?? "row",
    vercelDeploymentId: "dpl_1",
    target: "production",
    readyState: "READY",
    url: "https://a.vercel.app",
    inspectorUrl: null,
    errorMessage: null,
    branch: "dev",
    commitSha: "abc1234",
    ticketId: null,
    triggerSource: "human",
    createdAt: "2026-07-01T00:00:00.000Z",
    readyAt: "2026-07-01T00:05:00.000Z",
    becameProductionAt: "2026-07-01T00:05:00.000Z",
    promotedAt: null,
    ...over,
  };
}

// ── lastAliasRequest ────────────────────────────────────────────────────────

describe("interpretLastAliasRequest", () => {
  it("reads the job off the raw project body", () => {
    const job = interpretLastAliasRequest({
      lastAliasRequest: {
        type: "rollback",
        jobStatus: "succeeded",
        fromDeploymentId: "dpl_old",
        toDeploymentId: "dpl_new",
        requestedAt: 1_700_000_000_000,
      },
    });
    expect(job).toEqual({
      type: "rollback",
      jobStatus: "succeeded",
      fromDeploymentId: "dpl_old",
      toDeploymentId: "dpl_new",
      requestedAt: 1_700_000_000_000,
    });
  });

  it("is total over junk", () => {
    for (const junk of [null, undefined, 42, "x", [], {}, { lastAliasRequest: null }]) {
      expect(interpretLastAliasRequest(junk), JSON.stringify(junk)).toBeNull();
    }
  });

  it("degrades an unrecognised status to `unknown`, never to a terminal one", () => {
    // Vercel owns this vocabulary. Guessing a new value into `succeeded` would
    // make DevPilot report a remap as applied when it may not be.
    const job = interpretLastAliasRequest({
      lastAliasRequest: { type: "rollback", jobStatus: "reticulating" },
    });
    expect(job?.jobStatus).toBe("unknown");
  });

  it("keeps `skipped` as its own status — it is neither success nor failure", () => {
    const job = interpretLastAliasRequest({
      lastAliasRequest: { type: "promote", jobStatus: "skipped" },
    });
    expect(job?.jobStatus).toBe("skipped");
  });
});

describe("isRolledBack", () => {
  const job = (over: Partial<AliasRequest>): AliasRequest => ({
    type: "rollback",
    jobStatus: "succeeded",
    fromDeploymentId: "dpl_old",
    toDeploymentId: "dpl_new",
    requestedAt: null,
    ...over,
  });

  it("is true for every non-failed rollback, including in-flight and unknown", () => {
    // Asymmetric on purpose: a spurious banner is noise, a MISSING one means
    // auto-deploy is paused and nobody knows.
    for (const s of ["succeeded", "pending", "in-progress", "skipped", "unknown"] as const) {
      expect(isRolledBack(job({ jobStatus: s })), s).toBe(true);
    }
  });

  it("is false for a FAILED rollback — production never moved", () => {
    expect(isRolledBack(job({ jobStatus: "failed" }))).toBe(false);
  });

  it("is false for a promote job and for no job at all", () => {
    expect(isRolledBack(job({ type: "promote" }))).toBe(false);
    expect(isRolledBack(null)).toBe(false);
  });

  it("in-flight covers exactly pending and in-progress", () => {
    expect(isAliasJobInFlight(job({ jobStatus: "pending" }))).toBe(true);
    expect(isAliasJobInFlight(job({ jobStatus: "in-progress" }))).toBe(true);
    expect(isAliasJobInFlight(job({ jobStatus: "succeeded" }))).toBe(false);
    expect(isAliasJobInFlight(null)).toBe(false);
  });
});

describe("describeRollbackState", () => {
  const rolledBack: AliasRequest = {
    type: "rollback",
    jobStatus: "succeeded",
    fromDeploymentId: "dpl_was_live",
    toDeploymentId: "dpl_now_live",
    requestedAt: null,
  };

  it("is null when nothing is rolled back", () => {
    expect(describeRollbackState(null)).toBeNull();
    expect(describeRollbackState({ ...rolledBack, type: "promote" })).toBeNull();
  });

  it("names the auto-deploy pause — the whole reason this banner is persistent", () => {
    // Without this sentence a rollback presents days later as "DevPilot's deploys
    // silently stopped working", with agent tickets landing and never shipping.
    const banner = describeRollbackState(rolledBack);
    const text = [banner?.headline, ...(banner?.detail ?? [])].join(" ");
    expect(text).toMatch(/auto-deploy is PAUSED|will NOT go live/i);
    expect(text).toMatch(/agent ticket/i);
  });

  it("offers the deployment production was rolled AWAY from as the undo target", () => {
    expect(describeRollbackState(rolledBack)?.undoDeploymentId).toBe("dpl_was_live");
  });

  it("does not report a `skipped` job as a completed rollback", () => {
    const banner = describeRollbackState({ ...rolledBack, jobStatus: "skipped" });
    expect(banner?.headline).toMatch(/SKIPPED/);
    expect(banner?.headline).toMatch(/neither success nor failure/);
  });
});

describe("ROLLBACK_WARNINGS", () => {
  it("carries all four documented footguns", () => {
    // Each is something a rollback does NOT undo, and each is invisible until it
    // bites. They live as constants precisely so this test can exist.
    const all = ROLLBACK_WARNINGS.join(" ").toLowerCase();
    expect(all).toContain("environment variables");
    expect(all).toContain("cron job");
    expect(all).toContain("custom alias");
    expect(all).toMatch(/auto-assignment|stop going live/);
  });
});

// ── Eligibility ─────────────────────────────────────────────────────────────

describe("classifyRollbackTarget", () => {
  const base = { isLive: false, isPrevious: true };

  it("accepts a ready, previously-live, non-current production deployment", () => {
    const e = classifyRollbackTarget({ row: rec(), ...base });
    expect(e.eligible).toBe(true);
  });

  it("refuses a PREVIEW deployment, and says why", () => {
    const e = classifyRollbackTarget({ row: rec({ target: "preview" }), ...base });
    expect(e).toMatchObject({ eligible: false, reason: "not_production" });
    expect(e.eligible === false && e.message).toMatch(/never aliased to a production domain/i);
  });

  it("refuses a FAILED build with the build reason, not the plan reason", () => {
    // The specific-reason property. Reporting this as `plan_gated` would send
    // the operator to a pricing page over a build that could never be a target.
    const e = classifyRollbackTarget({
      row: rec({ readyState: "ERROR" }),
      isLive: false,
      isPrevious: false,
    });
    expect(e).toMatchObject({ eligible: false, reason: "build_failed" });
  });

  it("refuses an unfinished build", () => {
    for (const s of ["QUEUED", "BUILDING", "INITIALIZING", "DEPLOYING"]) {
      expect(classifyRollbackTarget({ row: rec({ readyState: s }), ...base }), s).toMatchObject({
        eligible: false,
        reason: "still_building",
      });
    }
  });

  it("refuses a canceled or blocked build", () => {
    for (const s of ["CANCELED", "CANCELLED", "BLOCKED"]) {
      expect(classifyRollbackTarget({ row: rec({ readyState: s }), ...base }), s).toMatchObject({
        eligible: false,
        reason: "canceled",
      });
    }
  });

  it("refuses a state Vercel invented after this shipped", () => {
    expect(
      classifyRollbackTarget({ row: rec({ readyState: "TELEPORTING" }), ...base }),
    ).toMatchObject({ eligible: false, reason: "state_unknown" });
  });

  it("refuses one that has never served production", () => {
    expect(
      classifyRollbackTarget({ row: rec({ becameProductionAt: null }), ...base }),
    ).toMatchObject({ eligible: false, reason: "never_live" });
  });

  it("refuses the deployment production is serving right now", () => {
    expect(classifyRollbackTarget({ row: rec(), isLive: true, isPrevious: false })).toMatchObject({
      eligible: false,
      reason: "currently_live",
    });
  });

  it("gates anything beyond one step, and states the Pro requirement", () => {
    const e = classifyRollbackTarget({ row: rec(), isLive: false, isPrevious: false });
    expect(e).toMatchObject({ eligible: false, reason: "plan_gated" });
    expect(e.eligible === false && e.message).toMatch(/Pro plan/);
  });

  it("ALLOWS an already-promoted deployment — Vercel's docs say to roll back to it", () => {
    // The half of this that is easy to get wrong. Promote refuses these;
    // rollback is the control Vercel points you at instead.
    const e = classifyRollbackTarget({ row: rec({ promotedAt: "2026-07-02T00:00:00Z" }), ...base });
    expect(e.eligible).toBe(true);
    expect(e.eligible === true && e.note).toMatch(/only refuses to PROMOTE/);
  });
});

describe("classifyPromoteTarget", () => {
  it("REFUSES a non-production deployment rather than rebuilding it", () => {
    // Vercel's CLI silently switches to POST /v13/deployments here and rebuilds
    // a preview against production env vars. DevPilot must never do that: it
    // would breach the preview/production boundary while wearing the word
    // "undo".
    expect(classifyPromoteTarget(rec({ target: "preview" }))).toMatchObject({
      eligible: false,
      reason: "not_production",
    });
  });

  it("refuses a failed build", () => {
    expect(classifyPromoteTarget(rec({ readyState: "ERROR" }))).toMatchObject({
      eligible: false,
      reason: "build_failed",
    });
  });

  it("WARNS about an already-promoted deployment but does not refuse it", () => {
    // Vercel documents promote as THE way to undo a rollback, and the target of
    // an undo has by definition served production. A local refusal would block
    // the documented happy path; Vercel's own 409 is the authority.
    const e = classifyPromoteTarget(rec({ promotedAt: "2026-07-02T00:00:00Z" }));
    expect(e.eligible).toBe(true);
    expect(e.eligible === true && e.note).toMatch(/may refuse/i);
  });
});

// ── Ordering and the live pointer ───────────────────────────────────────────

describe("planRollbackTargets", () => {
  const older = rec({
    vercelDeploymentId: "dpl_older",
    becameProductionAt: "2026-07-01T00:00:00.000Z",
  });
  const previous = rec({
    vercelDeploymentId: "dpl_previous",
    becameProductionAt: "2026-07-02T00:00:00.000Z",
  });
  const live = rec({
    vercelDeploymentId: "dpl_live",
    becameProductionAt: "2026-07-03T00:00:00.000Z",
  });

  it("orders by when each began serving production, newest first", () => {
    const plan = planRollbackTargets({ records: [older, live, previous], aliasJob: null });
    expect(plan.targets.map((t) => t.record.vercelDeploymentId)).toEqual([
      "dpl_live",
      "dpl_previous",
      "dpl_older",
    ]);
  });

  it("picks the live one and the single one-step target", () => {
    const plan = planRollbackTargets({ records: [older, live, previous], aliasJob: null });
    expect(plan.live?.vercelDeploymentId).toBe("dpl_live");
    expect(plan.previousProduction?.vercelDeploymentId).toBe("dpl_previous");
    // Exactly one eligible target on a plan DevPilot cannot confirm is Pro.
    expect(plan.targets.filter((t) => t.eligibility.eligible)).toHaveLength(1);
  });

  it("trusts Vercel's alias job over the ledger for what is LIVE", () => {
    // A rollback repoints production WITHOUT building anything, so the
    // most-recently-live ledger row is stale the moment one runs. Getting this
    // wrong offers the live deployment as a rollback target and hides the real
    // previous one.
    const plan = planRollbackTargets({
      records: [older, live, previous],
      aliasJob: {
        type: "rollback",
        jobStatus: "succeeded",
        fromDeploymentId: "dpl_live",
        toDeploymentId: "dpl_previous",
        requestedAt: null,
      },
    });
    expect(plan.live?.vercelDeploymentId).toBe("dpl_previous");
    expect(plan.previousProduction?.vercelDeploymentId).toBe("dpl_live");
  });

  it("ignores an in-flight or failed alias job when deciding what is live", () => {
    for (const jobStatus of ["pending", "failed"] as const) {
      const plan = planRollbackTargets({
        records: [older, live, previous],
        aliasJob: {
          type: "rollback",
          jobStatus,
          fromDeploymentId: "dpl_live",
          toDeploymentId: "dpl_previous",
          requestedAt: null,
        },
      });
      expect(plan.live?.vercelDeploymentId, jobStatus).toBe("dpl_live");
    }
  });

  it("skips an unusable build when choosing the one-step target", () => {
    const broken = rec({
      vercelDeploymentId: "dpl_broken",
      readyState: "ERROR",
      becameProductionAt: "2026-07-02T12:00:00.000Z",
    });
    const plan = planRollbackTargets({ records: [live, broken, previous], aliasJob: null });
    expect(plan.previousProduction?.vercelDeploymentId).toBe("dpl_previous");
  });

  it("still lists never-live rows, refused rather than dropped", () => {
    const neverLive = rec({ vercelDeploymentId: "dpl_never", becameProductionAt: null });
    const plan = planRollbackTargets({ records: [live, neverLive], aliasJob: null });
    expect(plan.targets.map((t) => t.record.vercelDeploymentId)).toContain("dpl_never");
    expect(
      plan.targets.find((t) => t.record.vercelDeploymentId === "dpl_never")?.eligibility,
    ).toMatchObject({ eligible: false, reason: "never_live" });
  });

  it("is a consistent comparator when several rows never served production", () => {
    // -Infinity minus -Infinity is NaN, which makes a subtracting comparator
    // silently inconsistent and the resulting order implementation-defined.
    const a = rec({ vercelDeploymentId: "dpl_a", becameProductionAt: null });
    const b = rec({ vercelDeploymentId: "dpl_b", becameProductionAt: null });
    const plan = planRollbackTargets({ records: [b, a, live], aliasJob: null });
    expect(plan.targets[0]?.record.vercelDeploymentId).toBe("dpl_live");
    expect(plan.targets).toHaveLength(3);
  });

  it("handles an empty ledger", () => {
    const plan = planRollbackTargets({ records: [], aliasJob: null });
    expect(plan).toMatchObject({ targets: [], previousProduction: null, live: null });
  });
});

describe("resolveLiveDeploymentId", () => {
  it("returns null when nothing has ever served production", () => {
    expect(resolveLiveDeploymentId([rec({ becameProductionAt: null })], null)).toBeNull();
  });
});

// ── The gate ────────────────────────────────────────────────────────────────

describe("decideRollbackGate", () => {
  const eligible = { eligible: true, note: null } as const;

  it("refuses without the typed deployment id", () => {
    const d = decideRollbackGate({
      deploymentId: "dpl_1",
      confirmedId: "",
      eligibility: eligible,
      aliasJobInFlight: false,
    });
    expect(d).toMatchObject({ ok: false, code: "not_confirmed" });
  });

  it("refuses a near-miss — the confirmation must be EXACT", () => {
    expect(
      decideRollbackGate({
        deploymentId: "dpl_abc",
        confirmedId: "dpl_ab",
        eligibility: eligible,
        aliasJobInFlight: false,
      }),
    ).toMatchObject({ ok: false, code: "not_confirmed" });
  });

  it("accepts the exact id, ignoring surrounding whitespace", () => {
    expect(
      decideRollbackGate({
        deploymentId: "dpl_abc",
        confirmedId: "  dpl_abc  ",
        eligibility: eligible,
        aliasJobInFlight: false,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses an ineligible target EVEN when correctly confirmed", () => {
    // The server re-derives eligibility from its own ledger, so a forged POST
    // naming a failed build is refused with the reason the disabled row showed.
    const d = decideRollbackGate({
      deploymentId: "dpl_1",
      confirmedId: "dpl_1",
      eligibility: { eligible: false, reason: "build_failed", message: "This build FAILED." },
      aliasJobInFlight: false,
    });
    expect(d).toMatchObject({ ok: false, code: "ineligible" });
    expect(d.ok === false && d.message).toContain("FAILED");
  });

  it("refuses while an alias job is already in flight, before confirmation is even read", () => {
    // Vercel holds ONE `lastAliasRequest` per project, so a second request
    // overwrites the record DevPilot is watching.
    const d = decideRollbackGate({
      deploymentId: "dpl_1",
      confirmedId: "dpl_1",
      eligibility: eligible,
      aliasJobInFlight: true,
    });
    expect(d).toMatchObject({ ok: false, code: "job_in_flight" });
  });

  it("refuses a blank deployment id", () => {
    expect(
      decideRollbackGate({
        deploymentId: "   ",
        confirmedId: "   ",
        eligibility: eligible,
        aliasJobInFlight: false,
      }),
    ).toMatchObject({ ok: false, code: "blank_deployment" });
  });
});

describe("describeAliasOutcome", () => {
  it("does NOT claim a queued promotion took effect", () => {
    // The documented "silently no-ops" case: a 202 means production has not
    // moved, and a client treating every 2xx as done reports success for a
    // promotion that has not happened.
    const s = describeAliasOutcome({ kind: "promote", outcome: { accepted: true, queued: true } });
    expect(s).toMatch(/QUEUED/);
    expect(s).toMatch(/has not taken effect|still serving/i);
  });

  it("says 'accepted', not 'done', for a 201 — the remap is asynchronous", () => {
    const s = describeAliasOutcome({
      kind: "rollback",
      outcome: { accepted: true, queued: false },
    });
    expect(s).toMatch(/accepted/i);
    expect(s).toMatch(/asynchronous|repointing/i);
  });
});
