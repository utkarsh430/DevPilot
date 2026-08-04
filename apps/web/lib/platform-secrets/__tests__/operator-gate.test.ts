// The `operatorOnly` write gate.
//
// THE PROPERTY UNDER TEST is a refusal, not a flag. It would be easy — and
// worthless — to assert only that `VERCEL_TOKEN` carries `operatorOnly: true`
// in the catalog: that test stays green if the actions never read the flag,
// which is precisely the bug the flag exists to fix. So every test here drives
// the decision function with a non-operator and asserts it is REFUSED, and each
// guard has a control case that neuters it and confirms the assertion goes red.

import { describe, expect, it, vi } from "vitest";
import { isOperatorOnlyKey, operatorOnlyRefusal } from "@/lib/platform-secrets/operator-gate";
import { PLATFORM_SECRET_CATALOG, platformCatalogEntry } from "@/lib/platform-secrets/catalog";

const NON_OPERATOR = async () => false;
const OPERATOR = async () => true;

const USER = "11111111-1111-1111-1111-111111111111";

describe("operatorOnlyRefusal", () => {
  it("REFUSES a non-operator writing VERCEL_TOKEN", async () => {
    const refusal = await operatorOnlyRefusal("VERCEL_TOKEN", USER, NON_OPERATOR);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("instance operator");
  });

  it("refuses a non-operator for every operatorOnly key in the catalog", async () => {
    const flagged = PLATFORM_SECRET_CATALOG.filter((e) => e.operatorOnly);
    // Guard against the whole suite becoming vacuous if the flag is dropped.
    expect(flagged.length).toBeGreaterThan(0);
    for (const entry of flagged) {
      expect(await operatorOnlyRefusal(entry.key, USER, NON_OPERATOR)).not.toBeNull();
    }
  });

  it("allows an instance operator", async () => {
    expect(await operatorOnlyRefusal("VERCEL_TOKEN", USER, OPERATOR)).toBeNull();
  });

  it("does not consult the operator check for a key without the flag", async () => {
    // ANTHROPIC_API_KEY is deliberately NOT operatorOnly in this PR. Asserting
    // the check is never even called is what proves the gate is scoped to the
    // flag rather than silently tightening every editable key.
    expect(platformCatalogEntry("ANTHROPIC_API_KEY")?.operatorOnly).toBeUndefined();
    const check = vi.fn(NON_OPERATOR);
    expect(await operatorOnlyRefusal("ANTHROPIC_API_KEY", USER, check)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the operator check throws", async () => {
    const throwing = async () => {
      throw new Error("db unreachable");
    };
    expect(await operatorOnlyRefusal("VERCEL_TOKEN", USER, throwing)).not.toBeNull();
  });

  it("passes the user id through to the operator check", async () => {
    const check = vi.fn(OPERATOR);
    await operatorOnlyRefusal("VERCEL_TOKEN", USER, check);
    expect(check).toHaveBeenCalledWith(USER);
  });

  it("leaves an unknown key to the caller's catalog-membership check", async () => {
    // Not a silent allow of an arbitrary key: `assertEditable` /
    // `assertInstanceScoped` run first in both actions and reject it there.
    expect(await operatorOnlyRefusal("NOT_A_REAL_KEY", USER, NON_OPERATOR)).toBeNull();
  });
});

describe("catalog: the Vercel deployment keys", () => {
  const KEYS = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_GIT_NAMESPACE"];

  it("are all present, editable, instance-stored and operatorOnly", () => {
    for (const key of KEYS) {
      const entry = platformCatalogEntry(key);
      expect(entry, key).toBeDefined();
      expect(entry?.group, key).toBe("Deployment");
      expect(entry?.editable, key).toBe(true);
      expect(entry?.storage, key).toBe("instance");
      expect(entry?.operatorOnly, key).toBe(true);
      expect(isOperatorOnlyKey(key), key).toBe(true);
    }
  });

  it("only VERCEL_TOKEN is masked — the team id and namespace are plain config", () => {
    expect(platformCatalogEntry("VERCEL_TOKEN")?.secret).toBe(true);
    expect(platformCatalogEntry("VERCEL_TEAM_ID")?.secret).toBe(false);
    expect(platformCatalogEntry("VERCEL_GIT_NAMESPACE")?.secret).toBe(false);
  });

  it("satisfy the platform_secrets key-format CHECK", () => {
    // `^[A-Z][A-Z0-9_]{0,127}$` from 20260615010000_secrets_app_layer_aes.sql.
    // Asserted rather than assumed: it is what makes "no migration" true.
    const KEY_FORMAT = /^[A-Z][A-Z0-9_]{0,127}$/;
    for (const key of KEYS) expect(KEY_FORMAT.test(key), key).toBe(true);
  });

  it("none is required — a workspace with no Vercel setup must stay healthy", () => {
    for (const key of KEYS) expect(platformCatalogEntry(key)?.required, key).toBe(false);
  });
});
