import { describe, expect, it } from "vitest";
import type { ServiceCatalogEntry } from "@/lib/stack/service-catalog";
import {
  checkCoherence,
  committedCloud,
  planStackSelection,
  rankCapability,
  reasons,
} from "@/lib/stack/rank";

// ─── Synthetic test fixtures ────────────────────────────────────────────────
//
// Pure ranking logic is exercised entirely against injectable catalogs here —
// the real SERVICE_CATALOG (Stage 2) has no vector_db entries at all yet
// (that curation is Stage 6), so the D8 pgvector/Pinecone affinity and the
// multi-cloud coherence rules can only be proven with fixtures shaped like
// the design doc's §5.3 slice.

function entry(overrides: Partial<ServiceCatalogEntry> & Pick<ServiceCatalogEntry, "key">) {
  const base: ServiceCatalogEntry = {
    key: overrides.key,
    displayName: overrides.key,
    provider: "oss",
    purpose: "test fixture",
    fingerprints: [],
    capabilities: [],
    rank: 0,
    freeTier: { kind: "none" },
    verifiedOn: "2026-07",
    managed: false,
  };
  return { ...base, ...overrides };
}

// §5.3's vector_db slice, verbatim in shape.
const VECTOR_DB_CATALOG: ServiceCatalogEntry[] = [
  entry({
    key: "aws_opensearch_vector",
    displayName: "Amazon OpenSearch Serverless (vector)",
    provider: "aws",
    rank: 0,
    capabilities: ["vector_db"],
    freeTier: { kind: "none" },
    managed: true,
  }),
  entry({
    key: "aws_aurora_pgvector",
    displayName: "Aurora PostgreSQL + pgvector",
    provider: "aws",
    rank: 1,
    capabilities: ["vector_db"],
    freeTier: { kind: "none" },
    managed: true,
  }),
  entry({
    key: "azure_ai_search",
    displayName: "Azure AI Search (vector)",
    provider: "azure",
    rank: 0,
    capabilities: ["vector_db"],
    freeTier: { kind: "limited_free", note: "Free tier: 1 index, 50 MB, no SLA" },
    managed: true,
  }),
  entry({
    key: "gcp_vertex_vector_search",
    displayName: "Vertex AI Vector Search",
    provider: "gcp",
    rank: 0,
    capabilities: ["vector_db"],
    freeTier: { kind: "trial_credits", note: "Covered by the new-account trial credit" },
    managed: true,
  }),
  entry({
    key: "pgvector",
    displayName: "PostgreSQL + pgvector",
    provider: "oss",
    rank: 0,
    capabilities: ["vector_db"],
    freeTier: {
      kind: "free_forever",
      note: "Self-hosted; an extension on a Postgres you already run",
    },
    managed: false,
  }),
  entry({
    key: "pinecone",
    displayName: "Pinecone",
    provider: "oss",
    rank: 1,
    capabilities: ["vector_db"],
    freeTier: { kind: "limited_free", note: "Starter: 1 index, ~100k vectors, free indefinitely" },
    managed: true,
  }),
  entry({
    key: "weaviate",
    displayName: "Weaviate",
    provider: "oss",
    rank: 2,
    capabilities: ["vector_db"],
    freeTier: { kind: "free_forever", note: "Self-host free; Weaviate Cloud has a 14-day sandbox" },
    managed: false,
  }),
  entry({
    key: "qdrant",
    displayName: "Qdrant",
    provider: "oss",
    rank: 3,
    capabilities: ["vector_db"],
    freeTier: {
      kind: "free_forever",
      note: "Self-host free; Qdrant Cloud has a 1 GB free cluster",
    },
    managed: false,
  }),
];

// A relational_db slice, for native-first / D8 combined tests.
const RELATIONAL_DB_CATALOG: ServiceCatalogEntry[] = [
  entry({
    key: "aws_rds_postgres",
    displayName: "Amazon RDS (Postgres)",
    provider: "aws",
    rank: 0,
    capabilities: ["relational_db"],
    freeTier: { kind: "limited_free", note: "12-month free tier" },
    managed: true,
  }),
  entry({
    key: "postgres",
    displayName: "PostgreSQL",
    provider: "oss",
    rank: 0,
    capabilities: ["relational_db"],
    freeTier: { kind: "free_forever", note: "Self-hosted" },
    managed: false,
  }),
  entry({
    key: "mysql",
    displayName: "MySQL",
    provider: "oss",
    rank: 1,
    capabilities: ["relational_db"],
    freeTier: { kind: "free_forever", note: "Self-hosted" },
    managed: false,
  }),
];

const FULL_CATALOG: ServiceCatalogEntry[] = [...VECTOR_DB_CATALOG, ...RELATIONAL_DB_CATALOG];

// A minimal single-capability, two-entry catalog for the no-padding test.
const SPARSE_CATALOG: ServiceCatalogEntry[] = [
  entry({ key: "a", provider: "aws", rank: 0, capabilities: ["cache"] }),
  entry({ key: "b", provider: "oss", rank: 0, capabilities: ["cache"] }),
];

// ─── committedCloud ─────────────────────────────────────────────────────────

describe("committedCloud", () => {
  it("resolves the three cloud ecosystems", () => {
    expect(committedCloud("aws")).toBe("aws");
    expect(committedCloud("azure")).toBe("azure");
    expect(committedCloud("gcp")).toBe("gcp");
  });

  it("is null for oss, mixed, and unset", () => {
    expect(committedCloud("oss")).toBeNull();
    expect(committedCloud("mixed")).toBeNull();
    expect(committedCloud("unset")).toBeNull();
  });
});

// ─── rankCapability: native-first, oss-always-present, weighting ───────────

describe("rankCapability — native-first", () => {
  it("ecosystem:'aws' puts the aws-native service in slot 1 (recommended)", () => {
    const options = rankCapability({
      capability: "vector_db",
      ecosystem: "aws",
      catalog: VECTOR_DB_CATALOG,
    });
    expect(options[0]!.service.provider).toBe("aws");
    expect(options[0]!.isRecommended).toBe(true);
  });

  it("holds for every capability that has a native option in the committed cloud", () => {
    for (const cloud of ["aws", "azure", "gcp"] as const) {
      const options = rankCapability({
        capability: "vector_db",
        ecosystem: cloud,
        catalog: VECTOR_DB_CATALOG,
      });
      expect(options[0]!.service.provider, cloud).toBe(cloud);
    }
  });

  it("ecosystem:'oss' puts an oss service in slot 1, always", () => {
    const options = rankCapability({
      capability: "vector_db",
      ecosystem: "oss",
      catalog: VECTOR_DB_CATALOG,
    });
    expect(options[0]!.service.provider).toBe("oss");
    expect(options[0]!.isRecommended).toBe(true);
  });
});

describe("rankCapability — oss slot reservation", () => {
  it("an oss alternative is always present alongside the native cloud pick", () => {
    for (const cloud of ["aws", "azure", "gcp"] as const) {
      const options = rankCapability({
        capability: "vector_db",
        ecosystem: cloud,
        catalog: VECTOR_DB_CATALOG,
      });
      expect(
        options.some((o) => o.service.provider === "oss"),
        cloud,
      ).toBe(true);
    }
  });

  it("holds across every (capability, ecosystem) pair when the catalog has an oss entry", () => {
    for (const ecosystem of ["aws", "azure", "gcp", "oss", "mixed", "unset"] as const) {
      const options = rankCapability({
        capability: "vector_db",
        ecosystem,
        catalog: VECTOR_DB_CATALOG,
      });
      expect(
        options.some((o) => o.service.provider === "oss"),
        ecosystem,
      ).toBe(true);
    }
  });

  it("never pads — a capability with 2 services returns 2 options, not 3 with a duplicate", () => {
    const options = rankCapability({
      capability: "cache",
      ecosystem: "aws",
      catalog: SPARSE_CATALOG,
    });
    expect(options).toHaveLength(2);
    expect(new Set(options.map((o) => o.service.key)).size).toBe(2);
  });

  it("an empty catalog for a capability returns no options, and never throws", () => {
    expect(
      rankCapability({ capability: "vector_db", ecosystem: "aws", catalog: RELATIONAL_DB_CATALOG }),
    ).toEqual([]);
  });
});

describe("rankCapability — free-tier weighting", () => {
  it("breaks a near-tie toward the free-forever option", () => {
    const catalog: ServiceCatalogEntry[] = [
      entry({
        key: "tied_none",
        provider: "oss",
        rank: 0,
        capabilities: ["cache"],
        freeTier: { kind: "none" },
      }),
      entry({
        key: "tied_free",
        provider: "oss",
        rank: 0,
        capabilities: ["cache"],
        freeTier: { kind: "free_forever", note: "always free" },
      }),
    ];
    const options = rankCapability({ capability: "cache", ecosystem: "oss", catalog });
    expect(options[0]!.service.key).toBe("tied_free");
  });
});

describe("rankCapability — stability", () => {
  it("same inputs produce byte-identical output", () => {
    const run = () =>
      JSON.stringify(
        rankCapability({ capability: "vector_db", ecosystem: "aws", catalog: VECTOR_DB_CATALOG }),
      );
    expect(run()).toEqual(run());
  });

  it("ties break on service key ascending", () => {
    const catalog: ServiceCatalogEntry[] = [
      entry({ key: "zzz", provider: "oss", rank: 0, capabilities: ["cache"] }),
      entry({ key: "aaa", provider: "oss", rank: 0, capabilities: ["cache"] }),
    ];
    const options = rankCapability({ capability: "cache", ecosystem: "oss", catalog });
    // Both score identically; the recommended slot must deterministically be "aaa".
    expect(options[0]!.service.key).toBe("aaa");
  });
});

// ─── D8: the vector_db <-> relational_db affinity ──────────────────────────

describe("rankCapability — D8 pgvector/Pinecone affinity", () => {
  it("recommends pgvector for the oss slot when the project already has Postgres", () => {
    const options = rankCapability({
      capability: "vector_db",
      ecosystem: "oss",
      catalog: FULL_CATALOG,
      currentSelections: [{ capability: "relational_db", serviceKey: "postgres" }],
    });
    const ossOptions = options.filter((o) => o.service.provider === "oss");
    expect(ossOptions[0]!.service.key).toBe("pgvector");
  });

  it("recommends the standalone vector SaaS (Pinecone) when there is no Postgres yet", () => {
    const options = rankCapability({
      capability: "vector_db",
      ecosystem: "oss",
      catalog: FULL_CATALOG,
      currentSelections: [],
    });
    const ossOptions = options.filter((o) => o.service.provider === "oss");
    expect(ossOptions[0]!.service.key).toBe("pinecone");
  });

  it("does not fire for a non-Postgres relational_db pick", () => {
    const options = rankCapability({
      capability: "vector_db",
      ecosystem: "oss",
      catalog: FULL_CATALOG,
      currentSelections: [{ capability: "relational_db", serviceKey: "mysql" }],
    });
    const ossOptions = options.filter((o) => o.service.provider === "oss");
    expect(ossOptions[0]!.service.key).toBe("pinecone");
  });

  it("never overtakes the committed cloud's native pick", () => {
    // Even with the affinity firing in aws-flavored full force, the
    // recommended slot stays the native aws service.
    const options = rankCapability({
      capability: "vector_db",
      ecosystem: "aws",
      catalog: FULL_CATALOG,
      currentSelections: [{ capability: "relational_db", serviceKey: "postgres" }],
    });
    expect(options[0]!.service.provider).toBe("aws");
  });

  it("planStackSelection threads its own relational_db pick forward into vector_db's ranking", () => {
    const plans = planStackSelection({
      capabilities: ["relational_db", "vector_db"],
      ecosystem: "oss",
      catalog: FULL_CATALOG,
    });
    const relational = plans.find((p) => p.capability.key === "relational_db")!;
    const vector = plans.find((p) => p.capability.key === "vector_db")!;
    expect(relational.preselectedKey).toBe("postgres");
    expect(vector.preselectedKey).toBe("pgvector");
  });
});

// ─── planStackSelection ─────────────────────────────────────────────────────

describe("planStackSelection", () => {
  it("returns capability-catalog order regardless of input order", () => {
    const plans = planStackSelection({
      capabilities: ["vector_db", "relational_db"],
      ecosystem: "aws",
      catalog: FULL_CATALOG,
    });
    expect(plans.map((p) => p.capability.key)).toEqual(["relational_db", "vector_db"]);
  });

  it("one plan row per requested capability, each with a single preselected service", () => {
    const plans = planStackSelection({
      capabilities: ["relational_db", "vector_db"],
      ecosystem: "aws",
      catalog: FULL_CATALOG,
    });
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan.preselectedKey).toBe(plan.options[0]!.service.key);
    }
  });

  it("a capability with zero catalog services yields an empty plan row, not a throw", () => {
    const plans = planStackSelection({
      capabilities: ["vector_db"],
      ecosystem: "aws",
      catalog: RELATIONAL_DB_CATALOG,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.options).toEqual([]);
    expect(plans[0]!.preselectedKey).toBe("");
  });

  it("drops unknown capability keys via toCapabilityEntries, never throws", () => {
    const plans = planStackSelection({
      capabilities: ["relational_db", "not_a_real_capability" as never],
      ecosystem: "aws",
      catalog: FULL_CATALOG,
    });
    expect(plans.map((p) => p.capability.key)).toEqual(["relational_db"]);
  });
});

// ─── checkCoherence — soft, never a block (D2) ─────────────────────────────

describe("checkCoherence", () => {
  it("a same-cloud stack under a committed ecosystem yields no warnings", () => {
    const warnings = checkCoherence({
      ecosystem: "aws",
      selections: [
        { capability: "vector_db", serviceKey: "aws_opensearch_vector" },
        { capability: "relational_db", serviceKey: "aws_rds_postgres" },
      ],
      catalog: FULL_CATALOG,
    });
    expect(warnings).toEqual([]);
  });

  it("an oss pick under a committed ecosystem yields no warnings (oss is always in contention)", () => {
    const warnings = checkCoherence({
      ecosystem: "aws",
      selections: [{ capability: "vector_db", serviceKey: "pgvector" }],
      catalog: FULL_CATALOG,
    });
    expect(warnings).toEqual([]);
  });

  it("a foreign-cloud pick under a committed ecosystem yields exactly one cross_cloud warning", () => {
    const warnings = checkCoherence({
      ecosystem: "aws",
      selections: [
        { capability: "vector_db", serviceKey: "azure_ai_search" },
        { capability: "relational_db", serviceKey: "postgres" }, // oss, doesn't add a warning
      ],
      catalog: FULL_CATALOG,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe("cross_cloud");
    expect(warnings[0]!.serviceKey).toBe("azure_ai_search");
  });

  it("picks spanning 3 clouds with no committed ecosystem yield second_cloud warnings", () => {
    const warnings = checkCoherence({
      ecosystem: "mixed",
      selections: [
        { capability: "vector_db", serviceKey: "aws_opensearch_vector" },
        { capability: "vector_db", serviceKey: "azure_ai_search" },
        { capability: "vector_db", serviceKey: "gcp_vertex_vector_search" },
      ],
      catalog: FULL_CATALOG,
    });
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) {
      expect(w.kind).toBe("second_cloud");
    }
  });

  it("a single-cloud stack with no committed ecosystem yields no warnings", () => {
    const warnings = checkCoherence({
      ecosystem: "unset",
      selections: [
        { capability: "vector_db", serviceKey: "aws_opensearch_vector" },
        { capability: "relational_db", serviceKey: "aws_rds_postgres" },
      ],
      catalog: FULL_CATALOG,
    });
    expect(warnings).toEqual([]);
  });

  it("never blocks — the return type carries no rejecting/invalid variant", () => {
    // Structural guarantee: the function always returns an array, for any
    // input, including a stale service key it can't resolve.
    const warnings = checkCoherence({
      ecosystem: "aws",
      selections: [{ capability: "vector_db", serviceKey: "not_a_real_service" }],
      catalog: FULL_CATALOG,
    });
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings).toEqual([]);
  });
});

// ─── reasons() ──────────────────────────────────────────────────────────────

describe("reasons", () => {
  it("is catalog-derived only — never echoes anything not on ServiceCatalogEntry", () => {
    const service = VECTOR_DB_CATALOG.find((e) => e.key === "pgvector")!;
    const lines = reasons({ service, ecosystem: "aws", crossCloud: true });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(typeof line).toBe("string");
    }
  });

  it("mentions the free-tier note when one exists", () => {
    const service = VECTOR_DB_CATALOG.find((e) => e.key === "pinecone")!;
    const lines = reasons({ service, ecosystem: "aws", crossCloud: false });
    expect(lines.join(" ")).toContain(
      service.freeTier.kind === "limited_free" ? service.freeTier.note : "",
    );
  });
});
