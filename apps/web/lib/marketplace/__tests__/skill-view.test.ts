import { describe, expect, it } from "vitest";
import {
  canEditSkill,
  classifySkillOrigin,
  compareWithInstalled,
  describeBodySize,
  describeSkillReach,
  describeSkillTriggers,
} from "@/lib/marketplace/skill-view";
import type { SkillRow } from "@/lib/skills/types";

function row(patch: Partial<SkillRow> = {}): SkillRow {
  return {
    id: "s1",
    tenant_id: null,
    name: "skill",
    version: "1.0.0",
    manifest: {},
    body: "body",
    targets: [],
    triggers: [],
    installed_from_skill_id: null,
    created_at: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

describe("classifySkillOrigin", () => {
  it("calls a tenant_id-null row public", () => {
    expect(classifySkillOrigin(row({ tenant_id: null }))).toBe("public");
  });

  it("distinguishes an authored row from a clone — both are tenant-owned", () => {
    const authored = row({ tenant_id: "t1", installed_from_skill_id: null });
    const clone = row({ tenant_id: "t1", installed_from_skill_id: "public-1" });
    expect(classifySkillOrigin(authored)).toBe("authored");
    expect(classifySkillOrigin(clone)).toBe("installed");
    // The point of the function: a truthiness check on tenant_id cannot tell
    // these apart, and they used to render identically.
    expect(classifySkillOrigin(authored)).not.toBe(classifySkillOrigin(clone));
  });
});

describe("canEditSkill", () => {
  it("permits a row this tenant owns", () => {
    expect(canEditSkill(row({ tenant_id: "t1" }), "t1")).toBe(true);
  });

  it("refuses a public row even when a tenant is resolved", () => {
    // Public rows are read-only for everything but service_role; offering an
    // Edit affordance would point at a route that cannot succeed.
    expect(canEditSkill(row({ tenant_id: null }), "t1")).toBe(false);
  });

  it("refuses another tenant's row", () => {
    expect(canEditSkill(row({ tenant_id: "t2" }), "t1")).toBe(false);
  });

  it("refuses when no tenant is resolved, including the empty string", () => {
    expect(canEditSkill(row({ tenant_id: "t1" }), null)).toBe(false);
    expect(canEditSkill(row({ tenant_id: "t1" }), undefined)).toBe(false);
    // Guards the `=== null` choice: an empty tenant must not match an empty
    // tenant_id by string equality.
    expect(canEditSkill(row({ tenant_id: "" }), "")).toBe(false);
  });
});

describe("describeSkillReach", () => {
  it("reports EMPTY targets as every role, not as no roles", () => {
    // The load-bearing case. `keywordFilter` in lib/skills/select.ts reads an
    // empty targets array as "matches any role", so this is the widest-reaching
    // kind of skill in the catalog.
    expect(describeSkillReach([])).toEqual({ allRoles: true, roles: [] });
    expect(describeSkillReach(null)).toEqual({ allRoles: true, roles: [] });
    expect(describeSkillReach(undefined)).toEqual({ allRoles: true, roles: [] });
  });

  it("treats a list of only blanks as every role too", () => {
    expect(describeSkillReach(["", "   "]).allRoles).toBe(true);
  });

  it("dedupes and sorts explicit targets", () => {
    expect(describeSkillReach(["qa", "engineer", "qa"])).toEqual({
      allRoles: false,
      roles: ["engineer", "qa"],
    });
  });

  it("drops non-string entries rather than rendering them", () => {
    expect(describeSkillReach(["qa", 7, null])).toEqual({ allRoles: false, roles: ["qa"] });
  });
});

describe("describeSkillTriggers", () => {
  it("returns an empty list for absent triggers", () => {
    expect(describeSkillTriggers(null)).toEqual([]);
    expect(describeSkillTriggers([])).toEqual([]);
  });

  it("trims, dedupes and preserves author order", () => {
    expect(describeSkillTriggers([" deploy ", "vercel", "deploy", "", 3])).toEqual([
      "deploy",
      "vercel",
    ]);
  });
});

describe("compareWithInstalled", () => {
  it("reports not_installed when there is no tenant copy", () => {
    expect(compareWithInstalled("body", null)).toBe("not_installed");
    expect(compareWithInstalled("body", undefined)).toBe("not_installed");
  });

  it("reports identical when the bodies match", () => {
    expect(compareWithInstalled("body", row({ body: "body" }))).toBe("identical");
  });

  it("reports differs when the installed body has drifted", () => {
    // This is the case the "Installed" pill silently mis-stated: an operator
    // had no way to learn their copy no longer matched what they are reading.
    expect(compareWithInstalled("body v2", row({ body: "body v1" }))).toBe("differs");
  });

  it("compares on the body alone — a version bump with identical text is not drift", () => {
    expect(compareWithInstalled("same", row({ body: "same", version: "9.9.9" }))).toBe("identical");
  });
});

describe("describeBodySize", () => {
  it("counts characters and lines", () => {
    expect(describeBodySize("a\nb\nc")).toEqual({ chars: 5, lines: 3 });
  });

  it("reports zero for an empty body", () => {
    expect(describeBodySize("")).toEqual({ chars: 0, lines: 0 });
  });
});
