// The GitHub 404 a fresh local install used to bounce to, as a test: with no
// OAuth App configured, GoTrue sends the browser to GitHub with the literal
// `client_id=env(...)`. The app must say so before the click, not after.

import { describe, expect, it } from "vitest";
import {
  GITHUB_SETUP_COMMAND,
  decideGithubProviderReadiness,
  githubProviderReadinessFromEnv,
  isLoopbackSupabaseUrl,
} from "@/lib/github/provider-readiness";

describe("decideGithubProviderReadiness", () => {
  it("a local Supabase with no client id is NOT ready, and says what to do", () => {
    const r = decideGithubProviderReadiness({
      supabaseUrl: "http://127.0.0.1:54321",
      githubOauthClientId: "",
    });
    expect(r.ready).toBe(false);
    if (r.ready) throw new Error("unreachable");
    expect(r.callbackUrl).toBe("http://127.0.0.1:54321/auth/v1/callback");
    expect(r.command).toBe(GITHUB_SETUP_COMMAND);
    expect(r.command).toContain("--github-client-id");
  });

  it("a local Supabase WITH a client id is ready (the control for the rule above)", () => {
    expect(
      decideGithubProviderReadiness({
        supabaseUrl: "http://127.0.0.1:54321",
        githubOauthClientId: "Iv1.abc",
      }).ready,
    ).toBe(true);
    expect(
      decideGithubProviderReadiness({
        supabaseUrl: "http://localhost:54321/",
        githubOauthClientId: "  ",
      }).ready,
    ).toBe(false);
  });

  it("a hosted Supabase is always ready - the provider lives in its dashboard", () => {
    expect(
      decideGithubProviderReadiness({
        supabaseUrl: "https://abcdefgh.supabase.co",
        githubOauthClientId: "",
      }).ready,
    ).toBe(true);
  });

  it("fails open on an unparseable or lookalike URL", () => {
    expect(decideGithubProviderReadiness({ supabaseUrl: "", githubOauthClientId: "" }).ready).toBe(
      true,
    );
    expect(isLoopbackSupabaseUrl("https://127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackSupabaseUrl("http://localhost:54321")).toBe(true);
    expect(isLoopbackSupabaseUrl("not a url")).toBe(false);
  });

  it("githubProviderReadinessFromEnv reads the two variables", () => {
    expect(
      githubProviderReadinessFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }).ready,
    ).toBe(false);
    expect(
      githubProviderReadinessFromEnv({
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        GITHUB_OAUTH_CLIENT_ID: "x",
      }).ready,
    ).toBe(true);
  });
});
