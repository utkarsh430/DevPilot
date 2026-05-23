// `persistGithubTokenFromSession` Mode-1 correctness: a default GitHub OAuth App
// (provider_token set, provider_refresh_token null, a session TTL in
// expires_at) must be stored with `expires_at: null` and `refresh_token: null`
// — never the bogus session-TTL expiry that broke every GitHub op ~1h later.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  upsert: vi.fn(async (_payload: Record<string, unknown>, _opts?: unknown) => ({
    error: null as { message: string } | null,
  })),
}));

vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({ from: () => ({ upsert: h.upsert }) }),
}));
vi.mock("@/lib/secrets/crypto", () => ({
  encryptSecret: () => ({ ciphertext: "ct", iv: "iv" }),
  toBytea: (v: string) => v,
  decryptColumns: () => "tok",
}));

import { persistGithubTokenFromSession } from "@/lib/github/oauth";

beforeEach(() => {
  h.upsert.mockClear();
  h.upsert.mockResolvedValue({ error: null });
  vi.unstubAllGlobals();
  // The GitHub /user profile fetch — the only network call before the upsert.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 42, login: "octocat" }), {
          status: 200,
          headers: { "x-oauth-scopes": "repo, read:user" },
        }),
    ),
  );
});

describe("persistGithubTokenFromSession", () => {
  it("Mode 1: stores expires_at null and refresh_token null despite a session TTL", async () => {
    await persistGithubTokenFromSession({
      user: { id: "u1" },
      provider_token: "ptok",
      provider_refresh_token: null,
      expires_at: Math.floor(Date.now() / 1000) + 3600, // GoTrue session TTL
    });

    expect(h.upsert).toHaveBeenCalledTimes(1);
    const payload = h.upsert.mock.calls[0]![0] as unknown as {
      expires_at: string | null;
      refresh_token: string | null;
    };
    expect(payload.expires_at).toBeNull();
    expect(payload.refresh_token).toBeNull();
  });
});
