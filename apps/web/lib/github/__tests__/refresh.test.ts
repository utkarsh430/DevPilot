// `ensureFreshGithubToken` — proving the Mode-1 (non-expiring) branch is now
// REACHABLE for the rows the fix produces, while the Mode-2 refresh path and the
// genuinely-expired-no-refresh null path are unchanged.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { GithubAccessTokenRow } from "@/lib/github/types";

const h = vi.hoisted(() => ({
  row: null as GithubAccessTokenRow | null,
  upsert: vi.fn(async (_payload: Record<string, unknown>, _opts?: unknown) => ({
    error: null as { message: string } | null,
  })),
}));

vi.mock("@/lib/github/oauth", () => ({
  getGithubTokenRow: vi.fn(async () => h.row),
}));
vi.mock("@/lib/platform-secrets/resolver", () => ({
  resolvePlatformSecret: vi.fn(async (key: string) =>
    key === "GITHUB_OAUTH_CLIENT_ID" ? "cid" : "csecret",
  ),
}));
vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({ from: () => ({ upsert: h.upsert }) }),
}));
vi.mock("@/lib/secrets/crypto", () => ({
  encryptSecret: () => ({ ciphertext: "ct", iv: "iv" }),
  toBytea: (v: string) => v,
}));

import { ensureFreshGithubToken } from "@/lib/github/refresh";

const baseRow: GithubAccessTokenRow = {
  userId: "u1",
  accessToken: "tok",
  refreshToken: null,
  expiresAt: null,
  scopes: "repo",
  githubId: 42,
  githubLogin: "octocat",
};

beforeEach(() => {
  h.row = null;
  h.upsert.mockClear();
  h.upsert.mockResolvedValue({ error: null });
  vi.unstubAllGlobals();
});

describe("ensureFreshGithubToken", () => {
  it("Mode 1 (expiresAt null, no refresh token) returns the token as-is — the branch the fix makes reachable", async () => {
    h.row = { ...baseRow, expiresAt: null, refreshToken: null, accessToken: "tok" };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const out = await ensureFreshGithubToken("u1");

    expect(out).toBe("tok"); // identity — NOT null
    expect(fetchSpy).not.toHaveBeenCalled(); // no refresh attempted
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("past expiry + no refresh token still returns null (null-handling unchanged)", async () => {
    h.row = {
      ...baseRow,
      expiresAt: new Date(Date.now() - 60_000),
      refreshToken: null,
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const out = await ensureFreshGithubToken("u1");

    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Mode 2 (past expiry + refresh token) refreshes and persists the real expiry, not null", async () => {
    h.row = {
      ...baseRow,
      expiresAt: new Date(Date.now() - 60_000),
      refreshToken: "rtok",
    };
    const fetchSpy = vi.fn(
      async (_url: unknown, _init?: unknown) =>
        new Response(
          JSON.stringify({ access_token: "fresh-tok", expires_in: 28_800, scope: "repo" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const out = await ensureFreshGithubToken("u1");

    expect(out).toBe("fresh-tok");
    // The refresh endpoint was hit.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("github.com/login/oauth/access_token");
    // The persisted expiry is a real future ISO timestamp derived from
    // expires_in — never null for a genuinely-expiring token.
    expect(h.upsert).toHaveBeenCalledTimes(1);
    const payload = h.upsert.mock.calls[0]![0] as unknown as {
      expires_at: string | null;
      refresh_token: string;
    };
    expect(payload.expires_at).not.toBeNull();
    expect(Date.parse(payload.expires_at as string)).toBeGreaterThan(Date.now());
    expect(payload.refresh_token).toBe("rtok"); // no new refresh token returned → prior preserved
  });
});
