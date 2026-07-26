// Pure `deriveGithubTokenExpiresAt` — the write-path derivation at the heart of
// the "non-expiring token wrongly marked expired" bug (Fix Family A). The
// invariant it encodes: `expires_at` non-null ⟺ `refresh_token` non-null.

import { describe, it, expect } from "vitest";
import { deriveGithubTokenExpiresAt } from "@/lib/github/token-expiry";

const EXPIRES_AT = 1_800_000_000; // a fixed positive unix-seconds timestamp

describe("deriveGithubTokenExpiresAt", () => {
  it("stamps the ISO expiry when a refresh token AND a positive expires_at are present (Mode 2)", () => {
    const out = deriveGithubTokenExpiresAt({
      provider_refresh_token: "rtok",
      expires_at: EXPIRES_AT,
    });
    expect(out).toBe(new Date(EXPIRES_AT * 1000).toISOString());
  });

  it("returns null with NO refresh token even though expires_at > 0 (the core bug — Mode 1)", () => {
    // This is the exact case a default GitHub OAuth App produces: a live,
    // non-expiring token with no refresh token but a session TTL. Stamping the
    // TTL here is what marked the token expired ~1h after sign-in.
    expect(
      deriveGithubTokenExpiresAt({ provider_refresh_token: null, expires_at: EXPIRES_AT }),
    ).toBeNull();
  });

  it("returns null with no refresh token and no/zero expires_at", () => {
    expect(
      deriveGithubTokenExpiresAt({ provider_refresh_token: null, expires_at: null }),
    ).toBeNull();
    expect(deriveGithubTokenExpiresAt({ provider_refresh_token: null, expires_at: 0 })).toBeNull();
    expect(deriveGithubTokenExpiresAt({})).toBeNull();
  });

  it("returns null when a refresh token is present but expires_at is null/0 (no lower bound to stamp)", () => {
    expect(
      deriveGithubTokenExpiresAt({ provider_refresh_token: "rtok", expires_at: null }),
    ).toBeNull();
    expect(
      deriveGithubTokenExpiresAt({ provider_refresh_token: "rtok", expires_at: 0 }),
    ).toBeNull();
  });
});
