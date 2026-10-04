// Error classification and credential scrubbing.
//
// The error bodies below are the real wire shapes, not invented ones — in
// particular the 400 from vercel/vercel discussion #7646, which is the message
// an operator actually hits when the Vercel for GitHub App is missing. Testing
// against invented shapes would let the classifier pass while failing on the
// only response that matters.

import { describe, expect, it } from "vitest";
import {
  boundMessage,
  classifyVercelError,
  networkVercelError,
  scrubSecrets,
  VercelApiError,
} from "@/lib/vercel/errors";

const TOKEN = "vercel_live_9f3aQxZ1mKpR7sTuVwXy";

describe("scrubSecrets", () => {
  it("removes the exact token wherever it appears", () => {
    const out = scrubSecrets(`request failed for ${TOKEN} at /v2/user`, [TOKEN]);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("[redacted]");
  });

  it("removes every occurrence, not just the first", () => {
    const out = scrubSecrets(`${TOKEN} then ${TOKEN}`, [TOKEN]);
    expect(out).not.toContain(TOKEN);
  });

  it("redacts a Bearer header echoed back by the API", () => {
    const out = scrubSecrets("upstream said: Authorization: Bearer abc123def456", []);
    expect(out).not.toContain("abc123def456");
  });

  it("redacts credential-shaped values we were never handed", () => {
    // Defence in depth: the token may not be the only credential in a body.
    expect(scrubSecrets('{"token":"aaaaaaaaaaaaaaaa"}', [])).not.toContain("aaaaaaaaaaaaaaaa");
    expect(scrubSecrets("vcp_abcdefghijklmnop is scoped", [])).not.toContain("vcp_abcdefghij");
  });

  it("ignores short needles so ordinary prose is not shredded", () => {
    expect(scrubSecrets("the project is ready", ["is"])).toBe("the project is ready");
  });

  it("tolerates null and undefined needles", () => {
    expect(scrubSecrets("plain text", [null, undefined])).toBe("plain text");
  });
});

describe("boundMessage", () => {
  it("truncates an oversized body with an ellipsis", () => {
    const out = boundMessage("x".repeat(900), 100);
    expect(out.length).toBe(101);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a short message intact", () => {
    expect(boundMessage("  short  ")).toBe("short");
  });
});

describe("classifyVercelError", () => {
  it("recognises the GitHub-App-missing 400 by its real message", () => {
    const err = classifyVercelError({
      status: 400,
      body: {
        error: {
          code: "bad_request",
          message: "To link a GitHub repository, you need to install the GitHub integration first.",
        },
      },
      path: "/v11/projects",
    });
    expect(err.kind).toBe("git_integration_missing");
    expect(err.message).toContain("Vercel for GitHub App is not installed");
  });

  it("maps 401 to unauthorized with a mint-a-new-token remedy", () => {
    const err = classifyVercelError({
      status: 401,
      body: { error: { code: "forbidden", message: "Not authorized" } },
      path: "/v2/user",
    });
    expect(err.kind).toBe("unauthorized");
    expect(err.message).toContain("VERCEL_TOKEN");
  });

  it("maps a scope-mismatch 403 to forbidden_scope WHEN a team is configured", () => {
    // The distinction is the point: "fix your team id" and "mint a new token"
    // are different fixes, and the wrong one is a long dead end.
    const err = classifyVercelError({
      status: 403,
      body: {
        error: {
          code: "forbidden",
          message: "You do not have permission to access this resource.",
        },
      },
      path: "/v1/integrations/git-namespaces",
      teamConfigured: true,
    });
    expect(err.kind).toBe("forbidden_scope");
    expect(err.message).toContain("VERCEL_TEAM_ID");
  });

  it("does NOT blame VERCEL_TEAM_ID for a 403 when no team is configured", () => {
    // REGRESSION. Vercel returns `403 "Not authorized"` for a revoked token —
    // wording indistinguishable from a scope failure. Classifying on the
    // message alone told operators with a blank (correct) VERCEL_TEAM_ID to go
    // fix it. Caught by scripts/vercel-accept.mjs against the real API.
    const err = classifyVercelError({
      status: 403,
      body: { error: { code: "forbidden", message: "Not authorized" } },
      path: "/v2/user",
      teamConfigured: false,
    });
    expect(err.kind).toBe("unauthorized");
    expect(err.message).not.toContain("VERCEL_TEAM_ID");
    expect(err.message).toContain("VERCEL_TOKEN");
  });

  it("defaults to the conservative reading when teamConfigured is omitted", () => {
    const err = classifyVercelError({
      status: 403,
      body: { error: { message: "Not authorized" } },
      path: "/v2/user",
    });
    expect(err.kind).toBe("unauthorized");
  });

  it("classifies 404 / 409 / 429 / 5xx distinctly", () => {
    const at = (status: number) =>
      classifyVercelError({ status, body: null, path: "/v2/user" }).kind;
    expect(at(402)).toBe("plan_required");
    expect(at(404)).toBe("not_found");
    expect(at(409)).toBe("conflict");
    expect(at(429)).toBe("rate_limited");
    expect(at(503)).toBe("server_error");
  });

  it("402 reads as a PLAN gate, never as a credential or permissions failure", () => {
    // PR 1 had no endpoint that could return a 402; Instant Rollback does, and
    // Vercel declares it on rollback and not on promote. The distinction is the
    // whole point of the kind: a 402 and a 403 look identical to an operator
    // staring at a red banner, and the remedies are opposites — upgrade the
    // plan, versus rotate a credential that is working perfectly.
    const err = classifyVercelError({
      status: 402,
      body: {
        error: {
          message: "To roll back further than the previous production deployment, upgrade to pro",
        },
      },
      path: "/v1/projects/prj_1/rollback/dpl_1",
    });
    expect(err.kind).toBe("plan_required");
    expect(err.message).toMatch(/paid plan/i);
    expect(err.message).toMatch(/roll back one step/i);
    // The wrong-diagnosis guard: none of the credential remedies may appear.
    expect(err.message).not.toMatch(/mint a new|revoked|expired|VERCEL_TEAM_ID/i);
  });

  it("survives a non-JSON / null body without throwing", () => {
    const err = classifyVercelError({ status: 502, body: null, path: "/v2/user" });
    expect(err).toBeInstanceOf(VercelApiError);
    expect(err.status).toBe(502);
  });

  it("SCRUBS the token out of an echoed error message", () => {
    const err = classifyVercelError({
      status: 400,
      body: { error: { message: `Invalid request with token ${TOKEN}` } },
      path: "/v11/projects",
      secrets: [TOKEN],
    });
    expect(err.message).not.toContain(TOKEN);
  });

  it("records the PATH only — never the query string carrying teamId", () => {
    const err = classifyVercelError({ status: 500, body: null, path: "/v6/deployments" });
    expect(err.path).toBe("/v6/deployments");
    expect(err.path).not.toContain("?");
  });
});

describe("networkVercelError", () => {
  it("scrubs the token out of a thrown fetch error", () => {
    const err = networkVercelError({
      cause: new Error(`connect ECONNREFUSED while sending ${TOKEN}`),
      path: "/v2/user",
      secrets: [TOKEN],
    });
    expect(err.kind).toBe("network");
    expect(err.status).toBeNull();
    expect(err.message).not.toContain(TOKEN);
  });

  it("handles a non-Error throw", () => {
    const err = networkVercelError({ cause: "boom", path: "/v2/user" });
    expect(err.kind).toBe("network");
  });
});

// ── PR 3: integration_configuration_disabled ────────────────────────────────
// Newly REACHABLE with "Connect Vercel". PR 1 deliberately did not handle it
// because a pasted personal token can never produce it.

describe("integration_configuration_disabled", () => {
  it("classifies the documented code apart from a dead token", () => {
    const err = classifyVercelError({
      status: 403,
      body: { error: { code: "integration_configuration_disabled", message: "Not authorized" } },
      path: "/v2/user",
    });
    expect(err.kind).toBe("integration_disabled");
  });

  it("wins over the scope reading, which the same wording would otherwise match", () => {
    // A disabled configuration also matches the loose "not authorized"/"team"
    // wording `isScopeMismatch` looks for. Reporting it as a team-id problem is
    // exactly the wrong-diagnosis failure that classifier exists to avoid.
    const err = classifyVercelError({
      status: 403,
      body: {
        error: {
          code: "integration_configuration_disabled",
          message: "You do not have permission for this team",
        },
      },
      path: "/v9/projects",
      teamConfigured: true,
    });
    expect(err.kind).toBe("integration_disabled");
  });

  it("tells the operator to RE-ENABLE, not to reconnect or re-paste", () => {
    // Reconnecting cannot clear a disabled configuration — sending them round
    // that loop is worse than a generic message.
    const err = classifyVercelError({
      status: 403,
      body: { error: { code: "integration_configuration_disabled" } },
      path: "/v2/user",
    });
    expect(err.message).toContain("DISABLED");
    expect(err.message).toContain("Re-enable");
    expect(err.message).toContain("30 days");
    expect(err.message).toContain("reconnecting will not fix it");
  });

  it("still recognises it from the message when the code is absent", () => {
    const err = classifyVercelError({
      status: 403,
      body: { error: { message: "This integration configuration has been disabled" } },
      path: "/v2/user",
    });
    expect(err.kind).toBe("integration_disabled");
  });

  it("does NOT swallow an ordinary 403 — a dead token stays unauthorized", () => {
    const err = classifyVercelError({
      status: 403,
      body: { error: { message: "Not authorized" } },
      path: "/v2/user",
    });
    expect(err.kind).toBe("unauthorized");
  });
});
