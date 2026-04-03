// B2 — the empty-delivery refusal, and the one property that makes it safe.
//
// The whole feature turns on distinguishing two facts that look identical in a
// verification record:
//
//   • "this role does not produce code"  → allow (a PM, designer, techwriter…)
//   • "this role produced no code"       → refuse (the eight prod rejects:
//     "branch is empty vs origin/main", "workspace branch has zero commits",
//     "claimed commit … does not exist", "No implementation delivered")
//
// Getting the first wrong wedges ~48 roles, which is far worse than the hole
// being closed — so it is asserted here directly, not inferred.

import { describe, it, expect } from "vitest";
import { decideQaGate, pickCohortRefusal, type VerificationRecord } from "@/lib/board/qa-gate";
import { isCodeProducingRole, CODE_PRODUCING_ROLES } from "@/lib/roles/code-producing";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function record(over: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    command: "pnpm test",
    exitCode: 0,
    headSha: HEAD,
    baseSha: BASE,
    pushed: true,
    outputTail: "",
    commitsAhead: 3,
    ...over,
  };
}

function gate(over: { codeProducing: boolean; verification: VerificationRecord | null }) {
  return decideQaGate({ enabled: true, from: "in_progress", to: "in_review", ...over });
}

describe("empty delivery — the refusal", () => {
  it("REFUSES a code-producing role whose branch adds no commits", () => {
    const d = gate({ codeProducing: true, verification: record({ commitsAhead: 0 }) });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.code).toBe("empty_delivery");
      expect(d.reason).toContain("no commits");
    }
  });

  it("refuses even when the check itself PASSED — a green test suite over an empty branch is still an empty delivery", () => {
    const d = gate({
      codeProducing: true,
      verification: record({ commitsAhead: 0, exitCode: 0 }),
    });
    expect(d.allow).toBe(false);
  });

  it("allows a code-producing role that did deliver commits", () => {
    const d = gate({ codeProducing: true, verification: record({ commitsAhead: 1 }) });
    expect(d).toEqual({ allow: true, skipped: null });
  });
});

describe("empty delivery — the ~48 non-code roles are untouched", () => {
  it("ALLOWS a non-code role with zero commits (the whole point of the role axis)", () => {
    const d = gate({ codeProducing: false, verification: record({ commitsAhead: 0 }) });
    expect(d).toEqual({ allow: true, skipped: null });
  });

  it("allows a non-code role that also produced no commit THIS run", () => {
    const d = gate({
      codeProducing: false,
      verification: record({ commitsAhead: 0, baseSha: HEAD, headSha: HEAD }),
    });
    expect(d.allow).toBe(true);
  });

  it("the identical record refuses for a code role and allows for a non-code one", () => {
    // The control that makes the two cases above non-vacuous: same evidence,
    // opposite outcomes, and the ONLY difference is the role property.
    const v = record({ commitsAhead: 0 });
    expect(gate({ codeProducing: true, verification: v }).allow).toBe(false);
    expect(gate({ codeProducing: false, verification: v }).allow).toBe(true);
  });
});

describe("empty delivery — fail-open on anything we cannot measure", () => {
  it("allows when commits_ahead is null (pre-B2 row / git failure), even for a code role", () => {
    const d = gate({ codeProducing: true, verification: record({ commitsAhead: null }) });
    expect(d).toEqual({ allow: true, skipped: null });
  });

  it("never refuses when there is no record at all", () => {
    expect(gate({ codeProducing: true, verification: null })).toEqual({
      allow: true,
      skipped: "no-verification-record",
    });
  });

  it("a no-commit RUN is still allowed for a code role when the BRANCH has work (the QA-reject retry)", () => {
    // A retry starts from the ticket branch tip, so base === head even though
    // the ticket's earlier work is real. Refusing here would break fix-and-retry.
    const d = gate({
      codeProducing: true,
      verification: record({ baseSha: HEAD, headSha: HEAD, commitsAhead: 4 }),
    });
    expect(d).toEqual({ allow: true, skipped: "no-commit" });
  });

  it("labels an unmeasurable code-role no-commit as delivery-indeterminate, not no-commit", () => {
    const d = gate({
      codeProducing: true,
      verification: record({ baseSha: HEAD, headSha: HEAD, commitsAhead: null }),
    });
    expect(d).toEqual({ allow: true, skipped: "delivery-indeterminate" });
  });
});

describe("empty delivery — precedence over the failing-check block", () => {
  it("reports empty_delivery (not verification_failed) when the branch is empty AND the check failed", () => {
    const d = gate({
      codeProducing: true,
      verification: record({ commitsAhead: 0, exitCode: 1 }),
    });
    expect(d.allow).toBe(false);
    // "You delivered nothing" is the actionable message; "your tests failed"
    // over an empty branch would send the agent chasing the wrong thing.
    if (!d.allow) expect(d.code).toBe("empty_delivery");
  });
});

describe("isCodeProducingRole", () => {
  it("is false for null/undefined — an unresolvable role never refuses", () => {
    expect(isCodeProducingRole(null)).toBe(false);
    expect(isCodeProducingRole(undefined)).toBe(false);
  });

  it("is false for the non-code producer roles the gate must not wedge", () => {
    for (const role of [
      "product_manager",
      "designer",
      "techwriter",
      "ux_researcher",
      "business_analyst",
      "marketing_manager",
      "devops",
      "sre",
    ]) {
      expect(isCodeProducingRole(role)).toBe(false);
    }
  });

  it("is true for the implementation roles the prod evidence implicates", () => {
    for (const role of [
      "engineer",
      "backend_engineer",
      "frontend_engineer",
      "fullstack_engineer",
      "project_scaffolder",
    ]) {
      expect(isCodeProducingRole(role)).toBe(true);
    }
  });

  it("is false for an unknown / custom JD-synthesized role (default-permissive)", () => {
    expect(isCodeProducingRole("acme_custom_specialist")).toBe(false);
  });

  it("never claims a non-producer reviewer role produces code", () => {
    for (const role of ["qa", "verifier", "release_engineer", "pm", "triage"]) {
      expect(CODE_PRODUCING_ROLES.has(role)).toBe(false);
    }
  });
});

describe("pickCohortRefusal — a cohort is only as shippable as its worst sibling", () => {
  const pass = { allow: true, skipped: null } as const;

  it("returns null when every sibling allows", () => {
    expect(pickCohortRefusal([pass, pass])).toBeNull();
  });

  it("returns the refusal even when it is NOT the deciding (last) sibling", () => {
    // The bug: the aggregator gated only on whichever sibling won the fan-in
    // claim, so a failing engineer beside a clean reviewer was invisible.
    const bad = gate({ codeProducing: true, verification: record({ exitCode: 1 }) });
    const refusal = pickCohortRefusal([bad, pass, pass]);
    expect(refusal?.code).toBe("verification_failed");
  });

  it("is deterministic: first refusal in sibling order wins", () => {
    const empty = gate({ codeProducing: true, verification: record({ commitsAhead: 0 }) });
    const failed = gate({ codeProducing: true, verification: record({ exitCode: 1 }) });
    expect(pickCohortRefusal([empty, failed])?.code).toBe("empty_delivery");
    expect(pickCohortRefusal([failed, empty])?.code).toBe("verification_failed");
  });

  it("an empty cohort allows (nothing to refuse on)", () => {
    expect(pickCohortRefusal([])).toBeNull();
  });
});
