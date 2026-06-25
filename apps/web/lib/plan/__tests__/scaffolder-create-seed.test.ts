// Caller-side coverage for the ONE place a scaffolder ticket is ever created.
//
// The pure decision is proven in scaffolder.test.ts; what is pinned here is the
// create action's WIRING to it, because that is what a refactor actually breaks:
//
//   • A no-plan create is UNCHANGED - one row at `ready`, dispatched now. Every
//     project shipped to date took this path.
//   • A plan create files the SAME single row HELD at `backlog`, dispatches
//     NOTHING, and arms the abandonment fallback.
//   • Neither path files a second scaffolder (the #79 invariant, from the
//     caller's side; the structural guard is scaffolder-single-creator.test.ts).
//
// Everything the action imports is mocked - this says nothing about GitHub, the
// LLM provider, or the stack catalog, only about the seed.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  sends: [] as Array<{ name: string; data: Record<string, unknown> }>,
  ticketInserts: [] as Record<string, unknown>[],
  startPlanSession: vi.fn(async () => ({ ok: true as const, sessionId: "sess-1" })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "u1" }),
  requireTenantId: async () => "tn",
}));
vi.mock("@/lib/engine/inngest", () => ({
  inngest: {
    send: async (evt: { name: string; data: Record<string, unknown> }) => {
      h.sends.push(evt);
    },
  },
}));
vi.mock("@/lib/github/oauth", () => ({ getGithubAccessToken: async () => "gh-token" }));
vi.mock("@/lib/github/client", () => ({
  GithubApiError: class extends Error {},
  createRepoForAuthenticatedUser: async () => ({
    id: 42,
    full_name: "octocat/todo",
    default_branch: "main",
  }),
  getRepo: async () => ({}),
  getRepoById: async () => ({}),
  getBranchSha: async () => "sha",
  seedRepoMainBranch: async () => {},
  ensureBranchFromBranch: async () => ({ created: true }),
  setRepoDefaultBranch: async () => {},
}));
vi.mock("@/lib/integration/connect-integration-branch", () => ({
  resolveConnectIntegrationBranch: async () => "dev",
}));
vi.mock("@/lib/stack/persist.server", () => ({
  insertProjectStackTags: async () => true,
  persistStackSelection: async () => true,
  toStackTags: () => [],
}));
vi.mock("@/lib/stack/import-bridge", () => ({ planDetectedStackSelection: () => [] }));
vi.mock("@/lib/stack/detect-stack-tags.server", () => ({ scanRepoForStackTags: async () => [] }));
vi.mock("@/lib/llm/project-provider.server", () => ({ validateProviderConfig: async () => ({}) }));
vi.mock("@/lib/projects/secrets", () => ({ setProjectSecret: async () => {} }));
vi.mock("@/lib/projects/doc-extract.server", () => ({ extractUploadText: async () => ({}) }));
vi.mock("@/lib/projects/extract-seed.server", () => ({ distillProjectSeed: async () => ({}) }));
vi.mock("@/lib/projects/current", () => ({
  getCurrentProjectIdFromCookie: async () => null,
  setCurrentProjectIdCookie: async () => {},
}));
vi.mock("@/app/(app)/plan/actions", () => ({ startPlanSessionAction: h.startPlanSession }));
vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        if (table === "tickets") h.ticketInserts.push(row);
        return {
          select: () => ({
            single: async () => ({
              data: { id: table === "tickets" ? "tk-1" : "proj-1" },
              error: null,
            }),
          }),
        };
      },
    }),
  }),
}));

import { createProjectWithNewRepoAction } from "@/app/(app)/projects/actions";

const INPUT = { name: "Todo", description: "A todo app for tracking chores" };

beforeEach(() => {
  vi.clearAllMocks();
  h.sends = [];
  h.ticketInserts = [];
});

function dispatches() {
  return h.sends.filter((e) => e.name === "ticket/dispatch-needed");
}

describe("createProjectWithNewRepoAction - the scaffolder seed", () => {
  it("no plan: files ONE scaffolder at `ready` and dispatches it immediately", async () => {
    const res = await createProjectWithNewRepoAction(INPUT);

    expect(res.ok).toBe(true);
    expect(h.ticketInserts).toHaveLength(1);
    expect(h.ticketInserts[0]).toMatchObject({
      status: "ready",
      requested_role: "project_scaffolder",
      project_id: "proj-1",
      tenant_id: "tn",
    });
    expect(dispatches()).toEqual([
      { name: "ticket/dispatch-needed", data: { ticketId: "tk-1", tenantId: "tn" } },
    ]);
    // Nothing to wait for → no hold, so no fallback.
    expect(h.sends.some((e) => e.name === "project/scaffolder-held")).toBe(false);
  });

  it("plan: files the SAME single scaffolder HELD at `backlog` and dispatches nothing", async () => {
    const res = await createProjectWithNewRepoAction({ ...INPUT, generatePlan: true });

    expect(res.ok).toBe(true);
    expect(h.ticketInserts).toHaveLength(1);
    expect(h.ticketInserts[0]).toMatchObject({
      status: "backlog",
      requested_role: "project_scaffolder",
    });
    // The whole point: the plan discussion decides this ticket's content, so it
    // must not run before the plan is committed.
    expect(dispatches()).toEqual([]);
  });

  it("plan: arms the abandonment fallback so an empty repo can't stay empty", async () => {
    await createProjectWithNewRepoAction({ ...INPUT, generatePlan: true });
    expect(h.sends.filter((e) => e.name === "project/scaffolder-held")).toEqual([
      {
        name: "project/scaffolder-held",
        data: { ticketId: "tk-1", tenantId: "tn", projectId: "proj-1" },
      },
    ]);
  });

  it("plan: still starts the planning session alongside the held ticket", async () => {
    const res = await createProjectWithNewRepoAction({ ...INPUT, generatePlan: true });
    expect(h.startPlanSession).toHaveBeenCalledTimes(1);
    expect(res.ok && res.planSessionId).toBe("sess-1");
  });
});
