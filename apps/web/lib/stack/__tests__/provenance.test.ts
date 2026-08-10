import { describe, expect, it } from "vitest";
import {
  buildStackProvenance,
  ecosystemLabel,
  matchStackChips,
  savedStackServiceNames,
  type StackProvenanceInput,
} from "@/lib/stack/provenance";
import type { CapabilityKey } from "@/lib/stack/capabilities";

// Real catalog keys keep the display-name derivation honest.
const POSTGRES = "postgres"; // "PostgreSQL"
const REDIS = "redis"; // "Redis"
const S3 = "aws_s3"; // "S3" family display name

describe("ecosystemLabel", () => {
  it("names committed ecosystems and hides `unset`", () => {
    expect(ecosystemLabel("aws")).toBe("AWS");
    expect(ecosystemLabel("gcp")).toBe("GCP");
    expect(ecosystemLabel("oss")).toBe("OSS (self-hosted)");
    // unset must be null so callers omit the ecosystem clause entirely.
    expect(ecosystemLabel("unset")).toBeNull();
  });
});

describe("savedStackServiceNames", () => {
  it("lists included-capability services (plan order) then extras, by display name", () => {
    const names = savedStackServiceNames({
      plans: [{ capability: { key: "relational_db" as CapabilityKey } }],
      selectedByCapability: new Map<CapabilityKey, string>([
        ["relational_db" as CapabilityKey, POSTGRES],
      ]),
      extraServiceKeys: [REDIS],
    });
    expect(names).toEqual(["PostgreSQL", "Redis"]);
  });

  it("skips capabilities with no selection and never throws on unknown keys", () => {
    const names = savedStackServiceNames({
      plans: [
        { capability: { key: "relational_db" as CapabilityKey } },
        { capability: { key: "vector_db" as CapabilityKey } },
      ],
      selectedByCapability: new Map<CapabilityKey, string>([
        ["relational_db" as CapabilityKey, POSTGRES],
      ]),
      extraServiceKeys: ["not_a_real_service_key"],
    });
    // vector_db has no selection (skipped); the bogus extra falls back to its key.
    expect(names).toEqual(["PostgreSQL", "not_a_real_service_key"]);
  });

  it("returns an empty list for an empty stack", () => {
    expect(
      savedStackServiceNames({
        plans: [],
        selectedByCapability: new Map(),
        extraServiceKeys: [],
      }),
    ).toEqual([]);
  });
});

describe("buildStackProvenance", () => {
  const base: StackProvenanceInput = {
    loaded: true,
    status: "accepted",
    ecosystem: "aws",
    plans: [{ capability: { key: "relational_db" as CapabilityKey } }],
    selectedByCapability: new Map<CapabilityKey, string>([
      ["relational_db" as CapabilityKey, POSTGRES],
    ]),
    extraServiceKeys: [S3],
  };

  it("surfaces services + ecosystem when accepted", () => {
    const p = buildStackProvenance(base);
    expect(p.loaded).toBe(true);
    expect(p.accepted).toBe(true);
    expect(p.ecosystemLabel).toBe("AWS");
    expect(p.serviceNames[0]).toBe("PostgreSQL");
    expect(p.serviceNames.length).toBe(2);
  });

  it("treats a merely-suggested (`ready`) stack as NOT pinned — no service names", () => {
    const p = buildStackProvenance({ ...base, status: "ready" });
    expect(p.accepted).toBe(false);
    // Nothing is persisted until Save, so `ready` drives no frame → no services.
    expect(p.serviceNames).toEqual([]);
  });

  it("reports skipped / unrun as not accepted", () => {
    expect(buildStackProvenance({ ...base, status: "skipped" }).accepted).toBe(false);
    expect(buildStackProvenance({ ...base, status: "unrun" }).accepted).toBe(false);
  });

  it("propagates the not-yet-loaded flag so callers can avoid a flash", () => {
    expect(buildStackProvenance({ ...base, loaded: false }).loaded).toBe(false);
  });
});

describe("matchStackChips", () => {
  const stack = ["PostgreSQL", "Redis", "S3", "Supabase Auth"];

  it("matches service names case-insensitively as substrings of ticket text", () => {
    const { visible, overflow } = matchStackChips({
      text: "Wire up postgresql migrations and a redis cache",
      serviceNames: stack,
    });
    expect(visible).toEqual(["PostgreSQL", "Redis"]);
    expect(overflow).toBe(0);
  });

  it("returns nothing when the ticket text mentions no saved service", () => {
    expect(matchStackChips({ text: "Refactor the onboarding copy", serviceNames: stack })).toEqual({
      visible: [],
      overflow: 0,
    });
  });

  it("caps the visible chips and reports overflow", () => {
    const { visible, overflow } = matchStackChips({
      text: "Uses PostgreSQL, Redis, S3 and Supabase Auth together",
      serviceNames: stack,
      max: 3,
    });
    expect(visible).toEqual(["PostgreSQL", "Redis", "S3"]);
    expect(overflow).toBe(1);
  });

  it("is defensive: empty/missing text or an empty stack never throws", () => {
    expect(matchStackChips({ text: "", serviceNames: stack })).toEqual({
      visible: [],
      overflow: 0,
    });
    expect(matchStackChips({ text: null, serviceNames: stack })).toEqual({
      visible: [],
      overflow: 0,
    });
    expect(matchStackChips({ text: undefined, serviceNames: stack })).toEqual({
      visible: [],
      overflow: 0,
    });
    expect(matchStackChips({ text: "PostgreSQL", serviceNames: [] })).toEqual({
      visible: [],
      overflow: 0,
    });
  });

  it("de-dupes repeated mentions of the same service", () => {
    const { visible } = matchStackChips({
      text: "postgresql here, PostgreSQL there, POSTGRESQL everywhere",
      serviceNames: stack,
    });
    expect(visible).toEqual(["PostgreSQL"]);
  });
});
