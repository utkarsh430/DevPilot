// The reconciliation table, exhaustively.
//
// The four interesting cases the brief names are each a named describe block:
// missing, present-and-equal, present-and-different, and unknown-new-name. On
// top of those sit the two properties that make the repo-derived list safe to
// consume at all — a declared name with no vault value can never be pushed, and
// an override can never manufacture one.

import { describe, expect, it } from "vitest";
import {
  DEVPILOT_ENV_COMMENT,
  ENV_PUSH_TARGETS,
  isDevPilotManaged,
  planEnvPush,
  type RemoteEnvVar,
} from "@/lib/vercel/env-plan";

function remote(over: Partial<RemoteEnvVar> & { key: string }): RemoteEnvVar {
  return {
    id: `env_${over.key}`,
    targets: ["production", "preview"],
    managedByDevPilot: false,
    valueMatchesVault: null,
    ...over,
  };
}

const DECLARED = (keys: string[], required = true) => keys.map((key) => ({ key, required }));

describe("planEnvPush — missing on Vercel", () => {
  it("pushes a declared+held key that Vercel does not have", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["DATABASE_URL"]),
      vaultKeys: ["DATABASE_URL"],
      remote: [],
    });
    expect(plan.push).toEqual([
      { key: "DATABASE_URL", required: true, reason: "create", targets: [...ENV_PUSH_TARGETS] },
    ]);
    expect(plan.ask).toEqual([]);
    expect(plan.leave).toEqual([]);
    expect(plan.empty).toBe(false);
  });

  it("asks for a declared key with no vault value, and never pushes it", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["STRIPE_SECRET_KEY"]),
      vaultKeys: [],
      remote: [],
    });
    expect(plan.push).toEqual([]);
    expect(plan.ask.map((a) => a.key)).toEqual(["STRIPE_SECRET_KEY"]);
    expect(plan.empty).toBe(true);
  });
});

describe("planEnvPush — present and equal", () => {
  it("leaves a foreign variable alone when the value provably matches", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["PUBLIC_URL"]),
      vaultKeys: ["PUBLIC_URL"],
      remote: [remote({ key: "PUBLIC_URL", valueMatchesVault: true })],
    });
    expect(plan.push).toEqual([]);
    expect(plan.leave).toEqual([{ key: "PUBLIC_URL", reason: "identical", overridable: false }]);
  });

  it("an identical variable is NOT overridable — there is nothing to overwrite", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["PUBLIC_URL"]),
      vaultKeys: ["PUBLIC_URL"],
      remote: [remote({ key: "PUBLIC_URL", valueMatchesVault: true })],
      overrides: ["PUBLIC_URL"],
    });
    // Even with the key explicitly ticked it stays in `leave`: an override
    // promotes a CONFLICT, not a no-op.
    expect(plan.push).toEqual([]);
    expect(plan.leave[0]?.reason).toBe("identical");
  });
});

describe("planEnvPush — present and different", () => {
  it("leaves a foreign variable whose value differs, and marks it overridable", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["API_BASE_URL"]),
      vaultKeys: ["API_BASE_URL"],
      remote: [remote({ key: "API_BASE_URL", valueMatchesVault: false })],
    });
    expect(plan.push).toEqual([]);
    expect(plan.leave).toEqual([
      { key: "API_BASE_URL", reason: "foreign_differs", overridable: true },
    ]);
  });

  it("pushes it once the operator explicitly overrides", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["API_BASE_URL"]),
      vaultKeys: ["API_BASE_URL"],
      remote: [remote({ key: "API_BASE_URL", valueMatchesVault: false })],
      overrides: ["API_BASE_URL"],
    });
    expect(plan.leave).toEqual([]);
    expect(plan.push[0]).toMatchObject({ key: "API_BASE_URL", reason: "operator_override" });
  });

  it("treats 'could not compare' as a conflict, never as equal", () => {
    // This is the normal case: `sensitive` variables are unreadable, so
    // `valueMatchesVault` is null for almost everything a real account holds.
    const plan = planEnvPush({
      catalog: DECLARED(["SESSION_SECRET"]),
      vaultKeys: ["SESSION_SECRET"],
      remote: [remote({ key: "SESSION_SECRET", valueMatchesVault: null })],
    });
    expect(plan.push).toEqual([]);
    expect(plan.leave).toEqual([
      { key: "SESSION_SECRET", reason: "foreign_unreadable", overridable: true },
    ]);
  });

  it("re-pushes a DEVPILOT-managed variable without asking — it is ours", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["SESSION_SECRET"]),
      vaultKeys: ["SESSION_SECRET"],
      remote: [remote({ key: "SESSION_SECRET", managedByDevPilot: true })],
    });
    expect(plan.leave).toEqual([]);
    expect(plan.push[0]).toMatchObject({ key: "SESSION_SECRET", reason: "update_managed" });
  });

  it("flags a managed variable missing a target so the push repairs it", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["SESSION_SECRET"]),
      vaultKeys: ["SESSION_SECRET"],
      remote: [remote({ key: "SESSION_SECRET", managedByDevPilot: true, targets: ["preview"] })],
    });
    expect(plan.push[0]).toMatchObject({ reason: "extend_targets" });
    expect(plan.push[0]?.targets).toEqual([...ENV_PUSH_TARGETS]);
  });
});

describe("planEnvPush — an unknown new name (the untrusted-input case)", () => {
  it("marks a name DevPilot has never seen as firstSeen", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["DATABASE_URL", "EXFIL_WEBHOOK_URL"]),
      vaultKeys: ["DATABASE_URL"],
      remote: [remote({ key: "DATABASE_URL", managedByDevPilot: true })],
    });
    const asked = plan.ask.find((a) => a.key === "EXFIL_WEBHOOK_URL");
    expect(asked?.firstSeen).toBe(true);
  });

  it("a name already present on Vercel is NOT firstSeen", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["LEGACY_KEY"]),
      vaultKeys: [],
      remote: [remote({ key: "LEGACY_KEY" })],
    });
    expect(plan.ask[0]?.firstSeen).toBe(false);
  });

  it("sorts first-seen names to the top of the ask list", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["AAA_KNOWN", "ZZZ_BRAND_NEW"]),
      vaultKeys: [],
      remote: [remote({ key: "AAA_KNOWN" })],
    });
    // Alphabetically AAA_KNOWN would come first; being first-seen wins, so the
    // surprising name cannot be buried under familiar ones.
    expect(plan.ask.map((a) => a.key)).toEqual(["ZZZ_BRAND_NEW", "AAA_KNOWN"]);
  });

  it("an edited .env.example can never cause a value to be pushed", () => {
    // The core security property: a name the repo invented has no vault value,
    // so it lands in `ask` — where a human must type something — and NEVER in
    // `push`, no matter what else is going on.
    const plan = planEnvPush({
      catalog: DECLARED(["ATTACKER_ADDED_KEY"]),
      vaultKeys: ["DATABASE_URL", "SESSION_SECRET"],
      remote: [],
      overrides: ["ATTACKER_ADDED_KEY"],
    });
    expect(plan.push).toEqual([]);
    expect(plan.ask.map((a) => a.key)).toEqual(["ATTACKER_ADDED_KEY"]);
  });

  it("an override for a key that is not declared-and-held pushes nothing", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["DATABASE_URL"]),
      vaultKeys: ["DATABASE_URL", "RUNNER_ONLY_TOKEN"],
      remote: [],
      overrides: ["RUNNER_ONLY_TOKEN", "TOTALLY_UNKNOWN"],
    });
    expect(plan.push.map((p) => p.key)).toEqual(["DATABASE_URL"]);
  });

  it("drops a catalog entry whose name is not a legal env key", () => {
    const plan = planEnvPush({
      catalog: [
        { key: "GOOD_KEY", required: true },
        { key: "bad-key; rm -rf /", required: true },
        { key: "", required: true },
      ],
      vaultKeys: ["GOOD_KEY", "bad-key; rm -rf /"],
      remote: [],
    });
    expect(plan.push.map((p) => p.key)).toEqual(["GOOD_KEY"]);
    expect(plan.ask).toEqual([]);
    // The illegal name is not declared, so it falls out as an undeclared vault
    // key rather than vanishing silently.
    expect(plan.extra).toContain("bad-key; rm -rf /");
  });
});

describe("planEnvPush — undeclared vault keys", () => {
  it("never pushes a held key the repo does not declare", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["DATABASE_URL"]),
      vaultKeys: ["DATABASE_URL", "DEVPILOT_RUNNER_KEY", "ANTHROPIC_API_KEY"],
      remote: [],
    });
    expect(plan.push.map((p) => p.key)).toEqual(["DATABASE_URL"]);
    expect(plan.extra).toEqual(["ANTHROPIC_API_KEY", "DEVPILOT_RUNNER_KEY"]);
  });
});

describe("planEnvPush — shape guarantees", () => {
  it("puts every declared key in exactly one bucket", () => {
    const catalog = [
      { key: "A_CREATE", required: true },
      { key: "B_ASK", required: false },
      { key: "C_LEAVE", required: true },
      { key: "D_MANAGED", required: true },
    ];
    const plan = planEnvPush({
      catalog,
      vaultKeys: ["A_CREATE", "C_LEAVE", "D_MANAGED"],
      remote: [remote({ key: "C_LEAVE" }), remote({ key: "D_MANAGED", managedByDevPilot: true })],
    });
    const seen = [
      ...plan.push.map((p) => p.key),
      ...plan.ask.map((a) => a.key),
      ...plan.leave.map((l) => l.key),
    ];
    expect(seen.sort()).toEqual(["A_CREATE", "B_ASK", "C_LEAVE", "D_MANAGED"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("collapses a duplicated .env.example line, keeping the stricter required", () => {
    const plan = planEnvPush({
      catalog: [
        { key: "DUPE", required: false },
        { key: "DUPE", required: true },
      ],
      vaultKeys: ["DUPE"],
      remote: [],
    });
    expect(plan.push).toHaveLength(1);
    expect(plan.push[0]?.required).toBe(true);
  });

  it("carries no field capable of holding a secret value", () => {
    const plan = planEnvPush({
      catalog: DECLARED(["DATABASE_URL"]),
      vaultKeys: ["DATABASE_URL"],
      remote: [],
    });
    // If a `value` ever appears anywhere in the serialised plan, the plan has
    // become a leak vector: it is returned to the browser and rendered.
    expect(JSON.stringify(plan)).not.toMatch(/"value"/);
  });
});

describe("isDevPilotManaged", () => {
  it("recognises the marker we write", () => {
    expect(isDevPilotManaged(DEVPILOT_ENV_COMMENT)).toBe(true);
    expect(isDevPilotManaged(`${DEVPILOT_ENV_COMMENT} — pushed 2026-07-18`)).toBe(true);
    expect(isDevPilotManaged("managed by devpilot")).toBe(true);
  });

  it("treats an absent or foreign comment as NOT ours", () => {
    // The fail direction that matters: an unrecognised comment must read as
    // foreign (leave it alone), never as ours (overwrite it).
    expect(isDevPilotManaged(null)).toBe(false);
    expect(isDevPilotManaged(undefined)).toBe(false);
    expect(isDevPilotManaged("")).toBe(false);
    expect(isDevPilotManaged("set by ops on 2026-01-01")).toBe(false);
    expect(isDevPilotManaged("not managed by devpilot")).toBe(false);
  });
});
