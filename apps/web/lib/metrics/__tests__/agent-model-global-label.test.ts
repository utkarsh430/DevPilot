// Truthfulness of the model label once an AGENT-WIDE default exists.
//
// The defect this family of work exists to end is a control whose value silently
// does not reach `claude -p`: `role_config.modelTier` was rendered as a per-agent
// model badge while being a documented no-op. So an agent-wide default that IS
// in effect must show up on both screens, and one that is NOT in effect must
// render as not in effect.
//
// `resolveModelByRole` is the one resolver both `/agents` and `/scoreboard` read
// through, so asserting here is asserting for both.

import { describe, expect, it } from "vitest";
import { resolveModelByRole, type ProjectProviderInput } from "@/lib/metrics/agent-model";
import type { RoleModelRow } from "@/lib/llm/role-model";

const claudeProject: ProjectProviderInput = {
  id: "p1",
  name: "Todo App",
  provider: null,
  baseUrl: null,
  model: null,
  credentialRef: null,
};
const otherClaudeProject: ProjectProviderInput = { ...claudeProject, id: "p2", name: "cert-radar" };
const customEndpointProject: ProjectProviderInput = {
  id: "p3",
  name: "Japanese Website Revamp",
  provider: "openai_compatible",
  baseUrl: "https://llm.example.com/v1",
  model: "llama3.1:70b",
  credentialRef: null,
};

const GLOBAL_OPUS: RoleModelRow = {
  projectId: null,
  roleSlug: "engineer",
  provider: "anthropic",
  model: "opus",
};

function resolve(projects: ProjectProviderInput[], roleOverrides: RoleModelRow[]) {
  return resolveModelByRole({
    roles: [{ role: "engineer", projectIds: projects.map((p) => p.id) }],
    projects,
    tenantProvider: null,
    roleOverrides,
  }).engineer!;
}

describe("the label reflects the agent-wide default when no per-project row exists", () => {
  it("labels every inheriting project with the global's model", () => {
    const model = resolve([claudeProject, otherClaudeProject], [GLOBAL_OPUS]);
    expect(model.kind).toBe("resolved");
    expect(model.kind === "resolved" && model.label).toBe("Opus");
  });

  it("without a global, the label is the project layer's answer — unchanged", () => {
    const model = resolve([claudeProject, otherClaudeProject], []);
    expect(model.kind === "resolved" && model.label).toBe("Account default");
  });

  it("a per-project row wins, so a role split across both reads as Mixed", () => {
    const model = resolve(
      [claudeProject, otherClaudeProject],
      [
        GLOBAL_OPUS,
        { projectId: "p2", roleSlug: "engineer", provider: "anthropic", model: "haiku" },
      ],
    );
    expect(model.kind).toBe("mixed");
    expect(model.kind === "mixed" && model.labels).toEqual(["Haiku", "Opus"]);
  });

  it("a role that touched no project still shows its agent-wide default", () => {
    // The engine applies the global to a ticket-less run too, so the label must
    // agree rather than claiming the account default.
    const model = resolveModelByRole({
      roles: [{ role: "engineer", projectIds: [] }],
      projects: [],
      tenantProvider: null,
      roleOverrides: [GLOBAL_OPUS],
    }).engineer!;
    expect(model.kind === "resolved" && model.label).toBe("Opus");
  });
});

describe("a global that cannot run renders as NOT IN EFFECT", () => {
  it("names what actually runs on the custom endpoint and flags the inert global", () => {
    const model = resolve([customEndpointProject], [GLOBAL_OPUS]);
    expect(model.kind).toBe("resolved");
    const label = model.kind === "resolved" ? model.label : "";
    // Never asserts Opus as this agent's model on a project that cannot serve it.
    expect(label).toContain("opus not in effect");
    expect(label).toContain("llama3.1:70b");
  });
});
