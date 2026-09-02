// The PR-2 transport paths, driven by an INJECTED fetch. No test here touches
// the network.
//
// The centrepiece is `setProductionGitAutoDeploy`, and specifically that
// `applied` reflects the READ-BACK rather than the PATCH's status code. That
// distinction is the honesty mechanism of this whole PR: `deploymentPolicy` is
// in Vercel's OpenAPI spec but undocumented, this code was written without a
// Vercel account to test against, and a 200 that quietly ignores the field is a
// real possibility. If `applied` ever came from the PATCH, DevPilot would report
// a gate it never observed.

import { describe, expect, it } from "vitest";
import {
  createVercelProject,
  getVercelProject,
  listVercelProjects,
  setProductionGitAutoDeploy,
  type FetchLike,
  type VercelClientOptions,
} from "@/lib/vercel/api";
import { VercelApiError } from "@/lib/vercel/errors";

const TOKEN = "vercel_test_token_abcdefghijklmnop";

type Call = { url: string; method: string; body: unknown };

/** A fetch double that replays a queue of responses and records every call. */
function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    const next = responses.shift() ?? { status: 500, body: null };
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { impl, calls };
}

function opts(impl: FetchLike, teamId: string | null = null): VercelClientOptions {
  return { credential: { token: TOKEN, teamId }, fetchImpl: impl };
}

const GATED = {
  deploymentPolicy: {
    gitSources: [
      {
        enabled: false,
        environments: [{ type: "system", target: "production" }],
        sources: [{ provider: "github", org: "acme", repo: "app" }],
      },
    ],
  },
};

function projectBody(extra: Record<string, unknown> = {}) {
  return {
    id: "prj_1",
    name: "app",
    accountId: "acc_1",
    link: { type: "github", org: "acme", repo: "app", productionBranch: "main" },
    ...extra,
  };
}

describe("listVercelProjects", () => {
  it("reads the `{ projects: [...] }` envelope", async () => {
    const { impl } = fakeFetch([{ status: 200, body: { projects: [projectBody()] } }]);
    const out = await listVercelProjects(opts(impl));
    expect(out).toHaveLength(1);
    expect(out[0]!.link?.productionBranch).toBe("main");
  });

  it("threads teamId when one is configured", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { projects: [] } }]);
    await listVercelProjects(opts(impl, "team_abc"), { search: "x" });
    expect(calls[0]!.url).toContain("teamId=team_abc");
    expect(calls[0]!.url).toContain("search=x");
  });

  it("degrades an unexpected envelope to an empty list rather than throwing", async () => {
    const { impl } = fakeFetch([{ status: 200, body: { unexpected: true } }]);
    expect(await listVercelProjects(opts(impl))).toEqual([]);
  });
});

describe("createVercelProject", () => {
  it("sends the gitRepository link body and no productionBranch", async () => {
    // There is no productionBranch field to send — Vercel's API does not accept
    // one. Asserting its absence keeps a future "helpful" addition from silently
    // no-opping and creating the impression the branch was set.
    const { impl, calls } = fakeFetch([{ status: 200, body: projectBody() }]);
    await createVercelProject({ name: "app", repo: "acme/app" }, opts(impl));
    const body = calls[0]!.body as Record<string, unknown>;
    expect(calls[0]!.method).toBe("POST");
    expect(body.gitRepository).toEqual({ type: "github", repo: "acme/app" });
    expect(JSON.stringify(body)).not.toContain("productionBranch");
  });

  it("classifies the missing-GitHub-App 400 as git_integration_missing", async () => {
    // The real wire shape from vercel/vercel#7646 — the message names no
    // account, no install URL and no next step, which is why recognising it
    // matters.
    const { impl } = fakeFetch([
      {
        status: 400,
        body: {
          error: {
            code: "bad_request",
            message:
              "To link a GitHub repository, you need to install the GitHub integration first.",
          },
        },
      },
    ]);
    await expect(
      createVercelProject({ name: "app", repo: "acme/app" }, opts(impl)),
    ).rejects.toMatchObject({ kind: "git_integration_missing" });
  });

  it("never leaks the token into an error message", async () => {
    const { impl } = fakeFetch([
      { status: 401, body: { error: { message: `Bad token ${TOKEN}` } } },
    ]);
    const err = await createVercelProject({ name: "a", repo: "a/b" }, opts(impl)).catch((e) => e);
    expect(err).toBeInstanceOf(VercelApiError);
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

describe("getVercelProject", () => {
  it("throws malformed_response when Vercel returns no id", async () => {
    const { impl } = fakeFetch([{ status: 200, body: { name: "nope" } }]);
    await expect(getVercelProject("prj_1", opts(impl))).rejects.toMatchObject({
      kind: "malformed_response",
    });
  });
});

describe("setProductionGitAutoDeploy", () => {
  it("PATCHes a production-scoped rule then re-reads the project", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: projectBody(GATED) },
      { status: 200, body: projectBody(GATED) },
    ]);
    const res = await setProductionGitAutoDeploy(
      { projectId: "prj_1", org: "acme", repo: "app", enabled: false },
      opts(impl),
    );
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[1]!.method).toBe("GET");
    expect(res.applied).toBe(true);
    expect(res.state).toBe("gated");
  });

  it("reports applied:false when the read-back does not show the gate", async () => {
    // THE test. A 200 from the PATCH proves nothing; only the read-back does.
    const { impl } = fakeFetch([
      { status: 200, body: projectBody() }, // PATCH "succeeds"…
      { status: 200, body: projectBody() }, // …but the policy is absent.
    ]);
    const res = await setProductionGitAutoDeploy(
      { projectId: "prj_1", org: "acme", repo: "app", enabled: false },
      opts(impl),
    );
    expect(res.applied).toBe(false);
    expect(res.state).toBe("unknown");
  });

  it("still reads back after a failed PATCH, and reports the error", async () => {
    // A PATCH that errored may still have applied; only the read-back is
    // evidence either way.
    const { impl, calls } = fakeFetch([
      { status: 500, body: { error: { message: "boom" } } },
      { status: 200, body: projectBody(GATED) },
    ]);
    const res = await setProductionGitAutoDeploy(
      { projectId: "prj_1", org: "acme", repo: "app", enabled: false },
      opts(impl),
    );
    expect(calls).toHaveLength(2);
    expect(res.state).toBe("gated");
    expect(res.applied).toBe(true);
    expect(res.error).toBeInstanceOf(VercelApiError);
  });

  it("never throws, even when both calls fail", async () => {
    const { impl } = fakeFetch([
      { status: 500, body: null },
      { status: 500, body: null },
    ]);
    const res = await setProductionGitAutoDeploy(
      { projectId: "prj_1", org: "acme", repo: "app", enabled: false },
      opts(impl),
    );
    expect(res.applied).toBe(false);
    expect(res.state).toBe("unknown");
    expect(res.project).toBe(null);
  });

  it("reports applied only when the observed state matches what was ASKED for", async () => {
    // Enabling and observing "gated" is not success — it is the opposite of
    // what was requested, and reporting it as applied would tell the operator
    // production is live when it is not.
    const { impl } = fakeFetch([
      { status: 200, body: projectBody(GATED) },
      { status: 200, body: projectBody(GATED) },
    ]);
    const res = await setProductionGitAutoDeploy(
      { projectId: "prj_1", org: "acme", repo: "app", enabled: true },
      opts(impl),
    );
    expect(res.applied).toBe(false);
  });
});
