// Guards on the scoreboard's project-scope model control.
//
// Two properties, both of which would be invisible in the UI if they broke:
//
//  1. The model string is NEVER trusted. It reaches `claude -p --model <x>` as a
//     subprocess argv, so anything outside the offered ladder AND the
//     ALLOWED_CLAUDE_MODELS allowlist must be refused rather than stored.
//
//  2. The write is service-role, so RLS is off and the co-located
//     `.eq("tenant_id", …)` is the entire boundary. A cross-tenant write would
//     succeed silently and repoint another workspace's project at a different
//     model. The fake below ACTUALLY APPLIES `.eq` — a filter-ignoring fake would
//     let the boundary test pass with the predicate deleted, which is the exact
//     vacuous-test trap AGENTS.md calls out.

import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Row = Record<string, unknown>;

const db: { projects: Row[] } = { projects: [] };

// `server-only` throws on import outside an RSC; stubbing it lets the REAL
// validateProviderConfig run rather than a mock of the thing under test.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "user-1" }),
  requireTenantId: async () => TENANT,
}));

function builder() {
  let rows = [...db.projects];
  const filters: Array<[string, unknown]> = [];
  const self: Record<string, unknown> = {};
  self.select = () => self;
  self.eq = (col: string, val: unknown) => {
    filters.push([col, val]);
    rows = rows.filter((r) => r[col] === val);
    return self;
  };
  self.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
  self.update = (patch: Row) => {
    // Deferred: the filters are applied by the chained .eq calls above, so the
    // patch lands only on rows that survived them — exactly like PostgREST.
    self.then = (resolve: (v: { data: null; error: null }) => unknown) => {
      for (const r of rows) Object.assign(r, patch);
      writes.push({ filters: [...filters], patch, matched: rows.length });
      return resolve({ data: null, error: null });
    };
    return self;
  };
  return self;
}

const writes: Array<{ filters: Array<[string, unknown]>; patch: Row; matched: number }> = [];

vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({ from: () => builder() }),
}));

const { setProjectClaudeModelAction } = await import("@/lib/metrics/model-actions");

const project = (id: string, tenantId: string, over: Row = {}): Row => ({
  id,
  tenant_id: tenantId,
  name: `Project ${id}`,
  llm_provider: null,
  llm_base_url: null,
  llm_model: null,
  ...over,
});

beforeEach(() => {
  writes.length = 0;
  db.projects = [project("p-mine", TENANT), project("p-theirs", FOREIGN_TENANT)];
});

describe("model validation — never accept a free-text model", () => {
  it("accepts each rung of the offered ladder", async () => {
    for (const model of ["haiku", "sonnet", "opus"]) {
      const result = await setProjectClaudeModelAction({ projectId: "p-mine", model });
      expect(result).toEqual({ ok: true });
    }
    expect(db.projects[0]!.llm_model).toBe("opus");
    // Pinning a model must also pin the provider, or `selectProvider` resolves
    // model = null and the pin silently never takes effect.
    expect(db.projects[0]!.llm_provider).toBe("anthropic");
  });

  it("refuses a model id that is not offered, and writes nothing", async () => {
    for (const model of [
      "gpt-4o", // another vendor
      "claude-opus-4-7", // allowlisted but not on the offered ladder
      "opus; rm -rf /", // argv injection shape
      "OPUS", // case games
      "  opus  x", // whitespace games
      "../../etc/passwd",
    ]) {
      const result = await setProjectClaudeModelAction({ projectId: "p-mine", model });
      expect(result.ok).toBe(false);
    }
    expect(writes).toEqual([]);
    expect(db.projects[0]!.llm_model).toBeNull();
  });

  it("clears to account default by clearing BOTH provider and model", async () => {
    await setProjectClaudeModelAction({ projectId: "p-mine", model: "opus" });
    const result = await setProjectClaudeModelAction({ projectId: "p-mine", model: "" });
    expect(result).toEqual({ ok: true });
    expect(db.projects[0]!.llm_model).toBeNull();
    // Leaving the provider pinned to anthropic would quietly override a tenant
    // that had selected an OpenAI-compatible default.
    expect(db.projects[0]!.llm_provider).toBeNull();
  });

  it("refuses a project on a custom OpenAI-compatible endpoint", async () => {
    db.projects = [
      project("p-mine", TENANT, {
        llm_provider: "openai_compatible",
        llm_base_url: "https://llm.example.com/v1",
        llm_model: "llama3.1:70b",
      }),
    ];
    const result = await setProjectClaudeModelAction({ projectId: "p-mine", model: "opus" });
    expect(result.ok).toBe(false);
    expect(writes).toEqual([]);
    expect(db.projects[0]!.llm_model).toBe("llama3.1:70b");
  });
});

describe("tenant scoping — the co-located .eq is the whole boundary", () => {
  it("refuses a project belonging to another tenant", async () => {
    const result = await setProjectClaudeModelAction({ projectId: "p-theirs", model: "opus" });
    expect(result).toEqual({ ok: false, error: "Project not found in this workspace." });
    expect(writes).toEqual([]);
    // The foreign row is untouched — the point of the whole test.
    expect(db.projects[1]!.llm_model).toBeNull();
    expect(db.projects[1]!.llm_provider).toBeNull();
  });

  it("carries a tenant_id predicate on the write itself, not only on the read", async () => {
    await setProjectClaudeModelAction({ projectId: "p-mine", model: "sonnet" });
    expect(writes).toHaveLength(1);
    const cols = writes[0]!.filters.map(([c]) => c);
    expect(cols).toContain("tenant_id");
    expect(cols).toContain("id");
    expect(writes[0]!.matched).toBe(1);
  });

  it("the fixture is a real attack: the foreign project genuinely exists", async () => {
    // Proves the refusal above comes from the predicate, not an empty table.
    expect(db.projects.some((p) => p.id === "p-theirs")).toBe(true);
  });
});
