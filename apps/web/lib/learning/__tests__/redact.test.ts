import { describe, expect, it } from "vitest";
import { EVIDENCE_MAX_CHARS, redactEvidence } from "@/lib/learning/redact";

describe("redactEvidence", () => {
  it("returns '' for null/undefined", () => {
    expect(redactEvidence(null)).toBe("");
    expect(redactEvidence(undefined)).toBe("");
  });

  it("redacts an Anthropic key", () => {
    const out = redactEvidence("using ANTHROPIC key sk-ant-api03-abcDEF123456_-xyz now");
    expect(out).not.toContain("api03-abcDEF123456");
    expect(out).toContain("sk-ant-***");
  });

  it("redacts GitHub PATs and classic tokens", () => {
    expect(redactEvidence("token ghp_abcdefghij0123456789ABCDEFGHIJ")).toContain("ghp_***");
    expect(redactEvidence("github_pat_11ABCDEFG0123456789_abcdefg")).toContain("github_pat_***");
  });

  it("redacts credentials embedded in a URL but keeps the host", () => {
    const out = redactEvidence("clone https://alice:s3cr3tPass@github.com/org/repo.git");
    expect(out).not.toContain("s3cr3tPass");
    expect(out).toContain("https://alice:***@github.com/org/repo.git");
  });

  it("redacts NAME=value secret assignments", () => {
    const out = redactEvidence("SECRETS_ENCRYPTION_KEY=deadbeefcafef00d1234 exported");
    expect(out).not.toContain("deadbeefcafef00d1234");
    expect(out).toMatch(/SECRETS_ENCRYPTION_KEY=\*\*\*/);
  });

  it("redacts a Bearer/Authorization header value", () => {
    const out = redactEvidence("Authorization: Bearer abc.def.ghijklmnop");
    expect(out).not.toContain("ghijklmnop");
    expect(out).toContain("***");
  });

  it("redacts a JWT appearing bare in a log line", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4";
    const out = redactEvidence(`session ${jwt} expired`);
    expect(out).not.toContain("SflKxwRJSMeKKF2QT4");
    expect(out).toContain("eyJ***");
  });

  it("redacts an absolute home path but keeps the tail", () => {
    expect(redactEvidence("EACCES /Users/utkarsh430/github/devpilot/x.ts")).toBe(
      "EACCES /Users/<redacted>/github/devpilot/x.ts",
    );
    expect(redactEvidence("cd /home/deploy/app")).toBe("cd /home/<redacted>/app");
  });

  it("leaves benign output untouched", () => {
    const s = "Test suite failed: 3 of 40 tests failing in board/queries.test.ts";
    expect(redactEvidence(s)).toBe(s);
  });

  it("bounds the stored length", () => {
    const out = redactEvidence("x".repeat(EVIDENCE_MAX_CHARS + 500));
    expect(out.length).toBeLessThanOrEqual(EVIDENCE_MAX_CHARS + "…[truncated]".length);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });
});
