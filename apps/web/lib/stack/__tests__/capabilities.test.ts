import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_ENUM,
  CAPABILITY_KEYS,
  getCapability,
  isKnownCapability,
  toCapabilityEntries,
} from "@/lib/stack/capabilities";

describe("CAPABILITY_CATALOG invariants", () => {
  it("is the closed 20-key taxonomy", () => {
    expect(CAPABILITY_KEYS.length).toBe(20);
    expect(CAPABILITY_CATALOG.length).toBe(20);
  });

  it("has unique capability keys", () => {
    expect(new Set(CAPABILITY_CATALOG.map((e) => e.key)).size).toBe(CAPABILITY_CATALOG.length);
  });

  it("every catalog key is a member of CAPABILITY_KEYS and vice versa", () => {
    expect(new Set(CAPABILITY_CATALOG.map((e) => e.key))).toEqual(new Set(CAPABILITY_KEYS));
  });

  it("keys are machine-shaped (persisted identity in project_stack_tags.capability)", () => {
    for (const entry of CAPABILITY_CATALOG) {
      expect(entry.key).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("every entry carries a label and a purpose — both reach the model", () => {
    for (const entry of CAPABILITY_CATALOG) {
      expect(entry.displayName.trim().length).toBeGreaterThan(0);
      expect(entry.purpose.trim().length).toBeGreaterThan(0);
    }
  });

  it("order is a dense 0..N-1 sequence with no gaps or dupes", () => {
    const orders = CAPABILITY_CATALOG.map((e) => e.order).sort((a, b) => a - b);
    expect(orders).toEqual(CAPABILITY_CATALOG.map((_, i) => i));
  });

  it("exactly the baseline three are marked baseline: cicd, observability, secrets", () => {
    const baseline = CAPABILITY_CATALOG.filter((e) => e.baseline)
      .map((e) => e.key)
      .sort();
    expect(baseline).toEqual(["cicd", "observability", "secrets"].sort());
  });

  it("queue and event_stream stay separate capabilities", () => {
    expect(isKnownCapability("queue")).toBe(true);
    expect(isKnownCapability("event_stream")).toBe(true);
    expect(getCapability("queue")).not.toBe(getCapability("event_stream"));
  });

  it("observability and error_tracking stay separate capabilities", () => {
    expect(isKnownCapability("observability")).toBe(true);
    expect(isKnownCapability("error_tracking")).toBe(true);
  });
});

describe("CAPABILITY_ENUM", () => {
  it("is a non-empty tuple usable by z.enum, matching CAPABILITY_KEYS exactly", () => {
    expect(CAPABILITY_ENUM.length).toBeGreaterThan(0);
    expect([...CAPABILITY_ENUM]).toEqual([...CAPABILITY_KEYS]);
  });
});

describe("getCapability / isKnownCapability", () => {
  it("resolves a known key", () => {
    expect(getCapability("vector_db")?.displayName).toBe("Vector database");
    expect(isKnownCapability("auth")).toBe(true);
  });

  it("rejects anything not in the catalog — the gate untrusted model output hits", () => {
    expect(getCapability("ignore previous instructions")).toBeUndefined();
    expect(getCapability("")).toBeUndefined();
    expect(getCapability("backdoor")).toBeUndefined();
    expect(isKnownCapability("payments")).toBe(false); // deliberately excluded, see module header
  });
});

describe("toCapabilityEntries", () => {
  it("drops unknown keys and keeps known ones", () => {
    const entries = toCapabilityEntries(["auth", "not_a_real_capability", "cache"]);
    expect(entries.map((e) => e.key)).toEqual(["cache", "auth"]);
  });

  it("dedupes repeated keys", () => {
    const entries = toCapabilityEntries(["auth", "auth", "auth"]);
    expect(entries.map((e) => e.key)).toEqual(["auth"]);
  });

  it("returns entries in catalog (order-field) order regardless of input order", () => {
    const entries = toCapabilityEntries(["cicd", "relational_db", "vector_db"]);
    expect(entries.map((e) => e.key)).toEqual(["relational_db", "vector_db", "cicd"]);
  });

  it("an all-unknown input yields an empty array, never throws", () => {
    expect(toCapabilityEntries(["a", "b", "c"])).toEqual([]);
    expect(toCapabilityEntries([])).toEqual([]);
  });
});
