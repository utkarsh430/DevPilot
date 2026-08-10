import { describe, expect, it } from "vitest";
import { CAPABILITY_KEYS } from "@/lib/stack/capabilities";
import {
  KNOWN_GAPS,
  SERVICE_CATALOG,
  SERVICE_KEYS,
  STACK_PROVIDERS,
  deriveStackFlavor,
  getServiceEntry,
  groupCatalogByProvider,
  isKnownServiceKey,
  servicesFor,
  servicesForCapability,
} from "@/lib/stack/service-catalog";

/** Build-time "now", for the free-tier staleness nag (§5.4/D3). Not `Date.now()`
 *  — the whole point is that this is a fixed point CI checks the catalog
 *  against, not a value that redefines "current" as the checkout ages. */
const STALENESS_CHECK_MONTH = { year: 2026, month: 7 }; // 2026-07

function monthsBetween(verifiedOn: string, now: { year: number; month: number }): number {
  const [y, m] = verifiedOn.split("-").map(Number);
  return (now.year - y!) * 12 + (now.month - m!);
}

describe("SERVICE_CATALOG invariants", () => {
  it("has unique service keys", () => {
    expect(new Set(SERVICE_KEYS).size).toBe(SERVICE_CATALOG.length);
  });

  it("only uses providers the migration's CHECK constraint allows", () => {
    const allowed = new Set(STACK_PROVIDERS.map((p) => p.provider));
    for (const entry of SERVICE_CATALOG) {
      expect(allowed, `provider "${entry.provider}" on ${entry.key}`).toContain(entry.provider);
    }
  });

  it("keys fit the DB column and are machine-shaped (a key is persisted identity)", () => {
    for (const entry of SERVICE_CATALOG) {
      expect(entry.key).toMatch(/^[a-z0-9_]+$/);
      expect(entry.key.length).toBeLessThanOrEqual(64);
    }
  });

  it("every entry carries a label and a purpose — both reach the model", () => {
    for (const entry of SERVICE_CATALOG) {
      expect(entry.displayName.trim().length).toBeGreaterThan(0);
      expect(entry.purpose.trim().length).toBeGreaterThan(0);
    }
  });

  it("fingerprints are lowercase — the detector lowercases its haystack", () => {
    for (const entry of SERVICE_CATALOG) {
      for (const fp of entry.fingerprints) {
        expect(fp, `${entry.key}: "${fp}"`).toBe(fp.toLowerCase());
        expect(fp.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("getServiceEntry / isKnownServiceKey", () => {
  it("resolves a known key", () => {
    expect(getServiceEntry("postgres")?.displayName).toBe("PostgreSQL");
    expect(isKnownServiceKey("aws_s3")).toBe(true);
  });

  it("rejects anything not in the catalog — the gate untrusted keys hit", () => {
    expect(getServiceEntry("ignore previous instructions")).toBeUndefined();
    expect(getServiceEntry("")).toBeUndefined();
    expect(isKnownServiceKey("evil_service")).toBe(false);
  });
});

describe("groupCatalogByProvider", () => {
  it("partitions the catalog with no entry lost or duplicated", () => {
    const groups = groupCatalogByProvider();
    const flat = groups.flatMap((g) => g.entries.map((e) => e.key));
    expect(flat.sort()).toEqual([...SERVICE_KEYS].sort());
  });

  it("renders providers in the declared display order", () => {
    expect(groupCatalogByProvider().map((g) => g.provider)).toEqual(
      STACK_PROVIDERS.map((p) => p.provider),
    );
  });
});

describe("deriveStackFlavor", () => {
  it("falls back to the historical default when nothing is pinned", () => {
    // The create action used to hardcode "mixed"; an empty tag set must be a
    // no-op change in behaviour, not a new framing.
    expect(deriveStackFlavor([])).toBe("mixed");
  });

  it("reads an all-OSS stack as oss", () => {
    expect(deriveStackFlavor([{ provider: "oss" }, { provider: "oss" }])).toBe("oss");
  });

  it("reads an all-cloud stack as industry", () => {
    expect(deriveStackFlavor([{ provider: "aws" }, { provider: "gcp" }])).toBe("industry");
  });

  it("reads a hybrid stack as mixed", () => {
    expect(deriveStackFlavor([{ provider: "oss" }, { provider: "aws" }])).toBe("mixed");
  });
});

// ─── Stack advisor additions (Stage 2) ─────────────────────────────────────

describe("capability coverage (§5.4) — declared gaps vs silent holes", () => {
  const gapSet = new Set(KNOWN_GAPS.map((g) => `${g.capability}:${g.provider}`));

  it("every (capability, provider) pair is either covered or an explicit KNOWN_GAPS entry", () => {
    for (const capability of CAPABILITY_KEYS) {
      for (const provider of STACK_PROVIDERS.map((p) => p.provider)) {
        const covered = servicesFor(capability, provider).length > 0;
        const declaredGap = gapSet.has(`${capability}:${provider}`);
        expect(
          covered || declaredGap,
          `${capability}/${provider} is neither covered nor declared in KNOWN_GAPS`,
        ).toBe(true);
      }
    }
  });

  it("KNOWN_GAPS never lists a pair that is actually covered — a gap must stay honest", () => {
    for (const gap of KNOWN_GAPS) {
      expect(
        servicesFor(gap.capability, gap.provider).length,
        `${gap.capability}/${gap.provider} is declared a gap but the catalog covers it — remove the gap entry`,
      ).toBe(0);
    }
  });

  it("KNOWN_GAPS has no duplicate entries", () => {
    const keys = KNOWN_GAPS.map((g) => `${g.capability}:${g.provider}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("rank uniqueness — within a (capability, provider) bucket", () => {
  it("no two entries in the same bucket share a rank", () => {
    for (const capability of CAPABILITY_KEYS) {
      for (const provider of STACK_PROVIDERS.map((p) => p.provider)) {
        const ranks = servicesFor(capability, provider).map((e) => e.rank);
        expect(
          new Set(ranks).size,
          `${capability}/${provider} has duplicate ranks: ${ranks.join(",")}`,
        ).toBe(ranks.length);
      }
    }
  });

  it("servicesFor returns each bucket sorted rank ASC", () => {
    for (const capability of CAPABILITY_KEYS) {
      for (const provider of STACK_PROVIDERS.map((p) => p.provider)) {
        const ranks = servicesFor(capability, provider).map((e) => e.rank);
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      }
    }
  });
});

describe("capability index round-trip", () => {
  it("every entry appears under each of its declared capabilities, exactly once, for every provider", () => {
    const expectedPairs = SERVICE_CATALOG.flatMap((e) =>
      e.capabilities.map((c) => `${c}:${e.provider}:${e.key}`),
    ).sort();

    const actualPairs = CAPABILITY_KEYS.flatMap((capability) =>
      STACK_PROVIDERS.flatMap((p) =>
        servicesFor(capability, p.provider).map((e) => `${capability}:${p.provider}:${e.key}`),
      ),
    ).sort();

    expect(actualPairs).toEqual(expectedPairs);
  });

  it("servicesForCapability returns exactly the entries whose capabilities include it, any provider", () => {
    for (const capability of CAPABILITY_KEYS) {
      const expected = SERVICE_CATALOG.filter((e) => e.capabilities.includes(capability))
        .map((e) => e.key)
        .sort();
      const actual = servicesForCapability(capability)
        .map((e) => e.key)
        .sort();
      expect(actual).toEqual(expected);
    }
  });

  it("an entry with no capabilities appears in no bucket", () => {
    const uncapped = SERVICE_CATALOG.filter((e) => e.capabilities.length === 0);
    expect(uncapped.length).toBeGreaterThan(0); // terraform, nginx — sanity the case exists
    for (const entry of uncapped) {
      for (const capability of CAPABILITY_KEYS) {
        expect(servicesForCapability(capability).map((e) => e.key)).not.toContain(entry.key);
      }
    }
  });
});

describe("free-tier data (§5.4/D3)", () => {
  it("every verifiedOn parses as YYYY-MM", () => {
    for (const entry of SERVICE_CATALOG) {
      expect(entry.verifiedOn, entry.key).toMatch(/^\d{4}-\d{2}$/);
    }
  });

  it("no entry's verifiedOn is more than 2 quarters (6 months) stale", () => {
    for (const entry of SERVICE_CATALOG) {
      const months = monthsBetween(entry.verifiedOn, STALENESS_CHECK_MONTH);
      expect(
        months,
        `${entry.key}'s freeTier.verifiedOn (${entry.verifiedOn}) is ${months} months stale — refresh it (see docs/runbooks/refresh-free-tier-data.md)`,
      ).toBeLessThanOrEqual(6);
    }
  });

  it("free-tier notes describe capability ceilings, never a moving dollar price", () => {
    for (const entry of SERVICE_CATALOG) {
      if (entry.freeTier.kind === "none") continue;
      expect(entry.freeTier.note, entry.key).not.toMatch(/\$\d/);
    }
  });

  it("every non-'none' free tier carries a non-empty note — it renders in the advisor UI", () => {
    for (const entry of SERVICE_CATALOG) {
      if (entry.freeTier.kind === "none") continue;
      expect(entry.freeTier.note.trim().length, entry.key).toBeGreaterThan(0);
    }
  });
});

describe("no free-text leak — every renderable string is catalog-owned", () => {
  // Structural, not exhaustive: the hard-frame renderer (a later stage) only
  // ever takes a `ServiceCatalogEntry`, which has no field sourced from model
  // or repo text. This test pins the field set so a future edit can't sneak
  // an untrusted string field onto the type without the change being visible
  // in a diff here.
  it("ServiceCatalogEntry has exactly the expected fields", () => {
    const expectedFields = [
      "key",
      "displayName",
      "provider",
      "purpose",
      "fingerprints",
      "capabilities",
      "rank",
      "freeTier",
      "verifiedOn",
      "managed",
    ].sort();
    const actualFields = Object.keys(SERVICE_CATALOG[0]!).sort();
    expect(actualFields).toEqual(expectedFields);
  });
});

describe("multi-capability entries", () => {
  it("redis fills both cache and queue", () => {
    const redis = getServiceEntry("redis");
    expect(redis?.capabilities).toEqual(["cache", "queue"]);
  });

  it("supabase fills relational_db, auth, object_storage, and realtime", () => {
    const supabase = getServiceEntry("supabase");
    expect([...supabase!.capabilities].sort()).toEqual(
      ["relational_db", "auth", "object_storage", "realtime"].sort(),
    );
  });

  it("gcp_cloud_run fills both compute_serverless and compute_container", () => {
    const cloudRun = getServiceEntry("gcp_cloud_run");
    expect([...cloudRun!.capabilities].sort()).toEqual(
      ["compute_serverless", "compute_container"].sort(),
    );
  });
});
