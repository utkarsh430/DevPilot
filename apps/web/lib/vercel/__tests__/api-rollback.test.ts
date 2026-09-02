// The rollback/promote request shapes and their response handling.
//
// Two endpoints, not one — and the assertions that matter most are the ones
// that would still pass if someone "simplified" them into a single call:
//
//   • Rollback goes to `/v1/.../rollback/...`, promote to `/v10/.../promote/...`.
//     They target disjoint sets and carry different plan gates.
//   • A `402` from rollback classifies as `plan_required`, NOT as an auth or
//     permissions failure. Those look identical to an operator and send them to
//     opposite places — one to a pricing page, one to rotate a working token.
//   • A `202` from promote is QUEUED, not done. Production has not moved.
//
// No test here makes a network call: the fetch is injected, exactly as every
// other suite in this directory does it. That is deliberate rather than
// convenient — this PR shipped without a live Vercel account to try it against.

import { describe, expect, it } from "vitest";
import {
  buildVercelRequest,
  specListDeployments,
  specPromoteDeployment,
  specRollbackDeployment,
} from "@/lib/vercel/client";
import {
  listVercelRollbackCandidates,
  promoteVercelDeployment,
  rollbackVercelDeployment,
} from "@/lib/vercel/api";
import { VercelApiError } from "@/lib/vercel/errors";
import { parseDeploymentIds } from "@/lib/vercel/types";

const CRED = { token: "vercel_token_abcdefghijklmnop", teamId: null };
const TEAM_CRED = { token: "vercel_token_abcdefghijklmnop", teamId: "team_xyz" };

function jsonFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { impl, calls };
}

// ── Request shapes ──────────────────────────────────────────────────────────

describe("specRollbackDeployment", () => {
  it("uses the DOCUMENTED /v1 path, not the CLI's undocumented /v9", () => {
    const spec = specRollbackDeployment("prj_1", "dpl_1");
    expect(spec.path).toBe("/v1/projects/prj_1/rollback/dpl_1");
    expect(spec.path).not.toContain("/v9/");
    expect(spec.method).toBe("POST");
  });

  it("sends a body — Vercel rejects the request without one", () => {
    expect(specRollbackDeployment("prj_1", "dpl_1").body).toEqual({});
  });

  it("encodes path segments", () => {
    const spec = specRollbackDeployment("prj/1", "dpl 1");
    expect(spec.path).toBe("/v1/projects/prj%2F1/rollback/dpl%201");
  });

  it("declares team scope, so teamId threads centrally and no call site passes it", () => {
    const spec = specRollbackDeployment("prj_1", "dpl_1");
    expect(spec.scope).toBe("team");
    expect(buildVercelRequest(spec, TEAM_CRED).url).toContain("teamId=team_xyz");
    expect(buildVercelRequest(spec, CRED).url).not.toContain("teamId");
  });

  it("keeps the token out of the URL", () => {
    const built = buildVercelRequest(specRollbackDeployment("prj_1", "dpl_1"), CRED);
    expect(built.url).not.toContain(CRED.token);
    expect(built.headers.Authorization).toBe(`Bearer ${CRED.token}`);
  });
});

describe("specPromoteDeployment", () => {
  it("is a DIFFERENT endpoint from rollback", () => {
    const promote = specPromoteDeployment("prj_1", "dpl_1");
    expect(promote.path).toBe("/v10/projects/prj_1/promote/dpl_1");
    expect(promote.path).not.toBe(specRollbackDeployment("prj_1", "dpl_1").path);
  });

  it("NEVER carries a deployment-creation body — there is no rebuild fallback", () => {
    // Vercel's CLI, handed a non-production deployment, silently switches to
    // POST /v13/deployments and rebuilds it against production env vars. That is
    // a deploy wearing the word "promote", and it would breach the exact
    // preview/production boundary this feature is built around.
    const spec = specPromoteDeployment("prj_1", "dpl_1");
    expect(spec.body).toEqual({});
    const serialised = JSON.stringify(spec);
    expect(serialised).not.toContain("/v13/deployments");
    expect(serialised).not.toContain("gitSource");
    expect(serialised).not.toContain("target");
  });

  it("threads team scope", () => {
    expect(specPromoteDeployment("prj_1", "dpl_1").scope).toBe("team");
  });
});

describe("specListDeployments", () => {
  it("asks Vercel for its own rollback-candidate set rather than recomputing it", () => {
    const url = buildVercelRequest(
      specListDeployments({
        projectId: "prj_1",
        target: "production",
        state: "READY",
        rollbackCandidate: true,
      }),
      CRED,
    ).url;
    expect(url).toContain("projectId=prj_1");
    expect(url).toContain("target=production");
    expect(url).toContain("state=READY");
    expect(url).toContain("rollbackCandidate=true");
  });

  it("omits rollbackCandidate entirely when not narrowing", () => {
    const url = buildVercelRequest(specListDeployments({ projectId: "prj_1" }), CRED).url;
    expect(url).not.toContain("rollbackCandidate");
  });
});

// ── Response handling ───────────────────────────────────────────────────────

describe("rollbackVercelDeployment", () => {
  it("returns the accepted status on 201", async () => {
    const { impl, calls } = jsonFetch(201, {});
    const res = await rollbackVercelDeployment(
      { projectId: "prj_1", deploymentId: "dpl_1" },
      { credential: CRED, fetchImpl: impl },
    );
    expect(res.status).toBe(201);
    expect(calls[0]?.url).toContain("/v1/projects/prj_1/rollback/dpl_1");
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("classifies a 402 as `plan_required`, NOT as an auth failure", async () => {
    // The headline finding: Vercel declares 402 on rollback and not on promote,
    // and the Hobby plan permits exactly one step. A 402 read as 401/403 sends
    // the operator to rotate a perfectly good credential.
    const { impl } = jsonFetch(402, {
      error: {
        code: "payment_required",
        message: "To roll back further than the previous production deployment, upgrade to pro",
      },
    });
    const err = await rollbackVercelDeployment(
      { projectId: "prj_1", deploymentId: "dpl_old" },
      { credential: CRED, fetchImpl: impl },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(VercelApiError);
    expect((err as VercelApiError).kind).toBe("plan_required");
    expect((err as VercelApiError).status).toBe(402);
    // And the wording must not read as a credential or permissions problem.
    const msg = (err as VercelApiError).message;
    expect(msg).toMatch(/paid plan/i);
    expect(msg).toMatch(/credential is fine|not a permissions problem/i);
    expect(msg).not.toMatch(/mint a new one|revoked/i);
  });

  it("a 402 is plan_required EVEN when a team is configured", async () => {
    // Control against the 403 scope-mismatch reading leaking across: a
    // configured team must not turn a plan gate into "check VERCEL_TEAM_ID".
    const { impl } = jsonFetch(402, { error: { message: "upgrade to pro" } });
    const err = await rollbackVercelDeployment(
      { projectId: "prj_1", deploymentId: "dpl_old" },
      { credential: TEAM_CRED, fetchImpl: impl },
    ).catch((e) => e);
    expect((err as VercelApiError).kind).toBe("plan_required");
  });

  it("keeps the token out of the surfaced message when Vercel echoes it back", async () => {
    const { impl } = jsonFetch(402, {
      error: { message: `denied for token ${CRED.token}` },
    });
    const err = await rollbackVercelDeployment(
      { projectId: "prj_1", deploymentId: "dpl_old" },
      { credential: CRED, fetchImpl: impl },
    ).catch((e) => e);
    expect((err as VercelApiError).message).not.toContain(CRED.token);
    expect((err as VercelApiError).message).toContain("[redacted]");
  });
});

describe("promoteVercelDeployment", () => {
  it("reports a 201 as applied", async () => {
    const { impl, calls } = jsonFetch(201, {});
    const res = await promoteVercelDeployment(
      { projectId: "prj_1", deploymentId: "dpl_1" },
      { credential: CRED, fetchImpl: impl },
    );
    expect(res).toEqual({ status: 201, queued: false });
    expect(calls[0]?.url).toContain("/v10/projects/prj_1/promote/dpl_1");
  });

  it("reports a 202 as QUEUED — production has NOT moved", async () => {
    // The documented "silently no-ops" case: queued behind an active rolling
    // release. A client treating every 2xx as done reports success for a
    // promotion that has not happened.
    const { impl } = jsonFetch(202, {});
    const res = await promoteVercelDeployment(
      { projectId: "prj_1", deploymentId: "dpl_1" },
      { credential: CRED, fetchImpl: impl },
    );
    expect(res).toEqual({ status: 202, queued: true });
  });

  it("surfaces the already-promoted refusal as a conflict", async () => {
    // Vercel refuses to promote a deployment that has already been promoted and
    // directs you to roll back to it instead. The status code for that is
    // documented behaviour whose code Vercel does not publish; 409 is the
    // declared conflict code on this endpoint, and the caller's wording names
    // the likely cause rather than asserting it.
    const { impl } = jsonFetch(409, {
      error: { message: "This deployment has already been promoted" },
    });
    const err = await promoteVercelDeployment(
      { projectId: "prj_1", deploymentId: "dpl_1" },
      { credential: CRED, fetchImpl: impl },
    ).catch((e) => e);
    expect((err as VercelApiError).kind).toBe("conflict");
    expect((err as VercelApiError).status).toBe(409);
  });

  it("does NOT fall back to creating a deployment when Vercel refuses", async () => {
    // One request, ever. The CLI's rebuild fallback must not appear here.
    const { impl, calls } = jsonFetch(400, { error: { message: "not a production deployment" } });
    await promoteVercelDeployment(
      { projectId: "prj_1", deploymentId: "dpl_preview" },
      { credential: CRED, fetchImpl: impl },
    ).catch(() => undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).not.toContain("/v13/deployments");
  });
});

describe("listVercelRollbackCandidates", () => {
  it("returns Vercel's eligible ids", async () => {
    const { impl } = jsonFetch(200, { deployments: [{ uid: "dpl_a" }, { uid: "dpl_b" }] });
    await expect(
      listVercelRollbackCandidates("prj_1", { credential: CRED, fetchImpl: impl }),
    ).resolves.toEqual(["dpl_a", "dpl_b"]);
  });

  it("returns NULL on a failed read — unconfirmed, never 'no candidates'", async () => {
    // A failed cross-check must degrade to "we could not confirm this list",
    // not remove the operator's only rollback control.
    const { impl } = jsonFetch(500, {});
    await expect(
      listVercelRollbackCandidates("prj_1", { credential: CRED, fetchImpl: impl }),
    ).resolves.toBeNull();
  });
});

describe("parseDeploymentIds", () => {
  it("accepts both the enveloped and bare array shapes", () => {
    expect(parseDeploymentIds({ deployments: [{ uid: "a" }] })).toEqual(["a"]);
    expect(parseDeploymentIds([{ id: "b" }])).toEqual(["b"]);
  });

  it("is total over junk", () => {
    for (const junk of [null, undefined, 1, "x", {}, [null], [{}]]) {
      expect(parseDeploymentIds(junk), JSON.stringify(junk)).toEqual([]);
    }
  });
});
