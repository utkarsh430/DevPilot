// Sign-in-does-not-break regression: a throw from
// `persistGithubTokenFromSession` must NOT fail the login. The user is already
// authenticated by exchangeCodeForSession; the callback swallows the persist
// error and redirects to /settings/github-integration so they can retry.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  persist: vi.fn(async () => {}),
}));

vi.mock("@/lib/db/server", () => ({
  supabaseServer: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({
        data: {
          session: {
            provider_token: "ptok",
            provider_refresh_token: null,
            expires_at: 1_800_000_000,
            user: { id: "u1" },
          },
        },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/github/oauth", () => ({
  persistGithubTokenFromSession: h.persist,
}));

import { GET } from "@/app/auth/callback/route";

function req(): NextRequest {
  return new Request("http://localhost/auth/callback?code=abc123") as unknown as NextRequest;
}

beforeEach(() => {
  h.persist.mockReset();
});

describe("auth/callback GET", () => {
  it("still signs in (redirects, no throw) when persistGithubTokenFromSession throws", async () => {
    h.persist.mockRejectedValueOnce(new Error("upsert exploded"));

    const res = await GET(req());

    expect(res.status).toBe(307); // NextResponse.redirect
    expect(res.headers.get("location")).toContain("/settings/github-integration");
    // The persist path was exercised (and its throw absorbed) — login did not fail.
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("redirects to the next target on the happy path", async () => {
    h.persist.mockResolvedValueOnce(undefined);

    const res = await GET(req());

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/board");
  });
});
