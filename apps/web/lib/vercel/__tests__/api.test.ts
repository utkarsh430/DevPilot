// The transport, driven end-to-end with an INJECTED fetch.
//
// NO TEST IN THIS FILE MAKES A NETWORK CALL. The fake below records every
// request it is handed, which is what lets us assert on the actual wire — the
// URL Vercel would have received, the header the token travelled in — rather
// than on the builder in isolation. That is the difference between "the builder
// threads teamId" and "the request that went out carried teamId".

import { describe, expect, it, vi } from "vitest";
import {
  getVercelGitNamespaces,
  getVercelTeam,
  getVercelUser,
  runVercelPreflight,
  vercelFetch,
  type FetchLike,
} from "@/lib/vercel/api";
import { specGitNamespaces, type VercelCredential } from "@/lib/vercel/client";
import { VercelApiError } from "@/lib/vercel/errors";

const TOKEN = "vercel_live_9f3aQxZ1mKpR7sTuVwXy";
const PERSONAL: VercelCredential = { token: TOKEN, teamId: null };
const TEAM: VercelCredential = { token: TOKEN, teamId: "team_abc123" };

type Recorded = { url: string; init: RequestInit };

/** Route by path substring. Anything unrouted is a test bug, so it fails loudly
 *  rather than silently 404-ing. */
function fakeFetch(routes: Record<string, { status: number; body: unknown }>) {
  const calls: Recorded[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const hit = Object.entries(routes).find(([path]) => url.includes(path));
    if (!hit) throw new Error(`unrouted request in test: ${url}`);
    const [, res] = hit;
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

const USER_OK = { "/v2/user": { status: 200, body: { user: { id: "u1", username: "bot" } } } };
const NS_OK = {
  "/v1/integrations/git-namespaces": {
    status: 200,
    body: [{ id: 1, slug: "acme", provider: "github", installationId: 42 }],
  },
};

describe("vercelFetch", () => {
  it("sends the token as a Bearer header and never in the URL", async () => {
    const { impl, calls } = fakeFetch(NS_OK);
    await vercelFetch(specGitNamespaces(), { credential: PERSONAL, fetchImpl: impl });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.url).not.toContain(TOKEN);
  });

  it("puts teamId on the wire for a team-scoped call", async () => {
    const { impl, calls } = fakeFetch(NS_OK);
    await vercelFetch(specGitNamespaces(), { credential: TEAM, fetchImpl: impl });
    expect(calls[0]!.url).toContain("teamId=team_abc123");
  });

  it("CONTROL: the personal credential produces no teamId on the wire", async () => {
    const { impl, calls } = fakeFetch(NS_OK);
    await vercelFetch(specGitNamespaces(), { credential: PERSONAL, fetchImpl: impl });
    expect(calls[0]!.url).not.toContain("teamId");
  });

  it("throws a classified VercelApiError on a non-2xx", async () => {
    const { impl } = fakeFetch({
      "/v1/integrations": {
        status: 403,
        body: { error: { code: "forbidden", message: "You do not have permission" } },
      },
    });
    await expect(
      vercelFetch(specGitNamespaces(), { credential: TEAM, fetchImpl: impl }),
    ).rejects.toMatchObject({ kind: "forbidden_scope" });
  });

  it("does not leak the token in a thrown error", async () => {
    const impl: FetchLike = async () => {
      throw new Error(`socket hang up while authenticating with ${TOKEN}`);
    };
    await expect(
      vercelFetch(specGitNamespaces(), { credential: PERSONAL, fetchImpl: impl }),
    ).rejects.toSatisfy((e: unknown) => !(e as Error).message.includes(TOKEN));
  });

  it("survives a non-JSON error body", async () => {
    const impl: FetchLike = async () => new Response("<html>502</html>", { status: 502 });
    await expect(
      vercelFetch(specGitNamespaces(), { credential: PERSONAL, fetchImpl: impl }),
    ).rejects.toMatchObject({ kind: "server_error", status: 502 });
  });

  it("aborts a hung request rather than hanging the settings page", async () => {
    const impl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(
      vercelFetch(specGitNamespaces(), {
        credential: PERSONAL,
        fetchImpl: impl,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ kind: "network" });
  });
});

describe("typed calls", () => {
  it("parses a user", async () => {
    const { impl } = fakeFetch(USER_OK);
    expect(await getVercelUser({ credential: PERSONAL, fetchImpl: impl })).toMatchObject({
      id: "u1",
      username: "bot",
    });
  });

  it("rejects a 200 with no identity rather than inventing one", async () => {
    const { impl } = fakeFetch({ "/v2/user": { status: 200, body: {} } });
    await expect(getVercelUser({ credential: PERSONAL, fetchImpl: impl })).rejects.toMatchObject({
      kind: "malformed_response",
    });
  });

  it("parses a team", async () => {
    const { impl } = fakeFetch({
      "/v2/teams": { status: 200, body: { id: "team_abc123", slug: "acme", name: "Acme" } },
    });
    expect(await getVercelTeam("team_abc123", { credential: TEAM, fetchImpl: impl })).toMatchObject(
      { name: "Acme" },
    );
  });

  it("returns [] — not an error — when Vercel sees no git namespaces", async () => {
    // Empty is the MEANING "App not installed", and the preflight depends on
    // being able to tell it apart from a failed call.
    const { impl } = fakeFetch({ "/v1/integrations": { status: 200, body: [] } });
    expect(await getVercelGitNamespaces({ credential: PERSONAL, fetchImpl: impl })).toEqual([]);
  });

  it("normalises a numeric namespace id and defaults absent flags to false", async () => {
    const { impl } = fakeFetch(NS_OK);
    const [first] = await getVercelGitNamespaces({ credential: PERSONAL, fetchImpl: impl });
    expect(first).toBeDefined();
    expect(first!.id).toBe("1");
    expect(first!.isAccessRestricted).toBe(false);
    expect(first!.requireReauth).toBe(false);
  });
});

describe("runVercelPreflight", () => {
  it("reports the missing token WITHOUT calling the API", async () => {
    const impl = vi.fn<FetchLike>();
    const report = await runVercelPreflight({
      config: { token: null, teamId: null, gitNamespace: null },
      fetchImpl: impl,
    });
    expect(impl).not.toHaveBeenCalled();
    expect(report.ready).toBe(false);
    expect(report.checks.find((c) => c.id === "token")?.detail).toContain("VERCEL_TOKEN");
  });

  it("reports a healthy personal setup as ready", async () => {
    const { impl } = fakeFetch({ ...USER_OK, ...NS_OK });
    const report = await runVercelPreflight({
      config: { token: TOKEN, teamId: null, gitNamespace: null },
      fetchImpl: impl,
    });
    expect(report.ready).toBe(true);
    expect(report.namespaceSlugs).toEqual(["acme"]);
  });

  it("reports a revoked token as a token problem, not a team-id problem", async () => {
    // REGRESSION, end to end: a personal-account credential must never be told
    // to check VERCEL_TEAM_ID, because it correctly has none.
    const { impl } = fakeFetch({
      "/v2/user": { status: 403, body: { error: { message: "Not authorized" } } },
    });
    const report = await runVercelPreflight({
      config: { token: TOKEN, teamId: null, gitNamespace: null },
      fetchImpl: impl,
    });
    const token = report.checks.find((c) => c.id === "token");
    expect(token?.level).toBe("error");
    expect(token?.detail).not.toContain("VERCEL_TEAM_ID");
  });

  it("stops after a dead token instead of firing doomed follow-up calls", async () => {
    const { impl, calls } = fakeFetch({
      "/v2/user": { status: 401, body: { error: { message: "Not authorized" } } },
    });
    const report = await runVercelPreflight({
      config: { token: TOKEN, teamId: "team_abc123", gitNamespace: null },
      fetchImpl: impl,
    });
    expect(calls).toHaveLength(1);
    expect(report.ready).toBe(false);
  });

  it("NEVER throws — a settings page must not 500 on a Vercel blip", async () => {
    const impl: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const report = await runVercelPreflight({
      config: { token: TOKEN, teamId: "team_abc123", gitNamespace: "acme" },
      fetchImpl: impl,
    });
    expect(report.ready).toBe(false);
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it("does not surface the token in ANY rendered check", async () => {
    const { impl } = fakeFetch({
      "/v2/user": { status: 400, body: { error: { message: `bad token ${TOKEN}` } } },
    });
    const report = await runVercelPreflight({
      config: { token: TOKEN, teamId: null, gitNamespace: null },
      fetchImpl: impl,
    });
    const rendered = JSON.stringify(report);
    expect(rendered).not.toContain(TOKEN);
  });

  it("treats a whitespace-only token as absent", async () => {
    const impl = vi.fn<FetchLike>();
    const report = await runVercelPreflight({
      config: { token: "   ", teamId: null, gitNamespace: null },
      fetchImpl: impl,
    });
    expect(impl).not.toHaveBeenCalled();
    expect(report.ready).toBe(false);
  });

  it("verifies a configured team via a second call", async () => {
    const { impl, calls } = fakeFetch({
      ...USER_OK,
      ...NS_OK,
      "/v2/teams": { status: 200, body: { id: "team_abc123", slug: "acme", name: "Acme" } },
    });
    const report = await runVercelPreflight({
      config: { token: TOKEN, teamId: "team_abc123", gitNamespace: "acme" },
      fetchImpl: impl,
    });
    expect(calls.map((c) => c.url).some((u) => u.includes("/v2/teams"))).toBe(true);
    expect(report.scope).toMatchObject({ kind: "team", name: "Acme" });
    expect(report.ready).toBe(true);
  });
});

describe("VercelApiError", () => {
  it("is a real Error subclass so instanceof and stack traces work", () => {
    const err = new VercelApiError({ kind: "network", path: "/v2/user", message: "x" });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("VercelApiError");
  });
});
