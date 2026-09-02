// The deployment request shapes and the deployment parser.
//
// The single most important assertion in this file is that a PREVIEW request
// carries no `target` key at all. That is what makes the preview path
// structurally incapable of reaching production: there is no value a caller can
// pass to flip it, and a future bug that drops the field degrades to preview
// rather than to production. Everything else here guards the parse boundary,
// where a third party's response shape meets our state machine.

import { describe, expect, it } from "vitest";
import { buildVercelRequest, specCreateDeployment, specGetDeployment } from "@/lib/vercel/client";
import { parseDeployment } from "@/lib/vercel/types";
import { createVercelDeployment, getVercelDeployment } from "@/lib/vercel/api";
import { VercelApiError } from "@/lib/vercel/errors";

const CRED = { token: "vercel_token_abcdefghijklmnop", teamId: null };
const TEAM_CRED = { token: "vercel_token_abcdefghijklmnop", teamId: "team_xyz" };

const ARGS = {
  name: "my-app",
  projectId: "prj_1",
  org: "acme",
  repo: "widget",
  ref: "dev",
} as const;

describe("specCreateDeployment", () => {
  it("PRODUCTION names the target explicitly", () => {
    const spec = specCreateDeployment({ ...ARGS, target: "production" });
    expect(spec.body).toMatchObject({ target: "production" });
  });

  it("PREVIEW omits `target` ENTIRELY — the boundary is structural, not a flag", () => {
    const spec = specCreateDeployment({ ...ARGS, target: "preview" });
    const body = spec.body as Record<string, unknown>;
    // Not `target: null`, not `target: "preview"` — absent. Vercel treats an
    // absent target as a preview, so a dropped field degrades the SAFE way.
    expect("target" in body).toBe(false);
    // And the serialised body genuinely contains no production token.
    expect(JSON.stringify(body)).not.toContain("production");
  });

  it("sends the git source and pins the deployment to the linked project", () => {
    const spec = specCreateDeployment({ ...ARGS, target: "preview" });
    expect(spec.body).toMatchObject({
      name: "my-app",
      // Without `project`, Vercel would create a NEW project from the name.
      project: "prj_1",
      gitSource: { type: "github", org: "acme", repo: "widget", ref: "dev" },
    });
    expect(spec.method).toBe("POST");
    expect(spec.path).toBe("/v13/deployments");
  });

  it("declares team scope, so teamId threads centrally and no call site passes it", () => {
    const spec = specCreateDeployment({ ...ARGS, target: "preview" });
    expect(spec.scope).toBe("team");
    expect(buildVercelRequest(spec, TEAM_CRED).url).toContain("teamId=team_xyz");
    // Control: with no team configured, no param is added.
    expect(buildVercelRequest(spec, CRED).url).not.toContain("teamId");
  });

  it("keeps the token out of the URL", () => {
    const built = buildVercelRequest(specCreateDeployment({ ...ARGS, target: "production" }), CRED);
    expect(built.url).not.toContain(CRED.token);
    expect(built.headers.Authorization).toBe(`Bearer ${CRED.token}`);
  });
});

describe("specGetDeployment", () => {
  it("is a scoped GET on the deployment id", () => {
    const spec = specGetDeployment("dpl_abc");
    expect(spec.path).toBe("/v13/deployments/dpl_abc");
    expect(spec.scope).toBe("team");
    expect(spec.method ?? "GET").toBe("GET");
  });

  it("encodes a hostile id rather than letting it escape the path", () => {
    expect(specGetDeployment("a/../../v2/user").path).toBe(
      "/v13/deployments/a%2F..%2F..%2Fv2%2Fuser",
    );
  });
});

describe("parseDeployment", () => {
  it("reads the fields the poller and the failure surface depend on", () => {
    const d = parseDeployment({
      id: "dpl_abc",
      url: "x-abc.vercel.app",
      readyState: "BUILDING",
      target: "production",
      inspectorUrl: "https://vercel.com/acme/x/dpl_abc",
      meta: { githubCommitSha: "0123456789abcdef", githubCommitRef: "dev" },
      ready: 1_800_000_000_000,
    });
    expect(d).toMatchObject({
      id: "dpl_abc",
      url: "x-abc.vercel.app",
      readyState: "BUILDING",
      target: "production",
      inspectorUrl: "https://vercel.com/acme/x/dpl_abc",
      commitSha: "0123456789abcdef",
      branch: "dev",
      readyAt: 1_800_000_000_000,
    });
  });

  it("accepts `status` as an alias for `readyState`", () => {
    // A version bump that renames the field must not stall every poller on an
    // "unknown" state.
    expect(parseDeployment({ id: "d", status: "READY" })?.readyState).toBe("READY");
  });

  it("keeps an UNRECOGNISED readyState verbatim rather than narrowing it away", () => {
    // `classifyDeployState` does the branching. A parser that narrowed to a
    // union would turn a new Vercel state into `null`, which is
    // indistinguishable from "we could not read it".
    expect(parseDeployment({ id: "d", readyState: "SOME_FUTURE_STATE" })?.readyState).toBe(
      "SOME_FUTURE_STATE",
    );
  });

  it("reads an error message from either shape", () => {
    expect(parseDeployment({ id: "d", errorMessage: "boom" })?.errorMessage).toBe("boom");
    expect(parseDeployment({ id: "d", error: { message: "boom2" } })?.errorMessage).toBe("boom2");
  });

  it("degrades to null fields rather than throwing on a stripped-down body", () => {
    const d = parseDeployment({ id: "d" });
    expect(d).toMatchObject({
      id: "d",
      url: null,
      readyState: null,
      inspectorUrl: null,
      commitSha: null,
      branch: null,
      readyAt: null,
    });
  });

  it("returns null when there is no id at all", () => {
    for (const body of [null, {}, [], "x", { id: "" }]) {
      expect(parseDeployment(body), JSON.stringify(body)).toBeNull();
    }
  });
});

// ── The API wrappers ────────────────────────────────────────────────────────

function fetchReturning(status: number, body: unknown) {
  return async () =>
    new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("createVercelDeployment", () => {
  it("returns the parsed deployment", async () => {
    const d = await createVercelDeployment(
      { ...ARGS, target: "preview" },
      { credential: CRED, fetchImpl: fetchReturning(200, { id: "dpl_1", readyState: "QUEUED" }) },
    );
    expect(d.id).toBe("dpl_1");
  });

  it("a 2xx with no id warns that a build MAY be running rather than implying nothing happened", async () => {
    // The operator's next move differs: check the dashboard, do not click deploy
    // again and start a second build.
    await expect(
      createVercelDeployment(
        { ...ARGS, target: "preview" },
        { credential: CRED, fetchImpl: fetchReturning(200, { ok: true }) },
      ),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(VercelApiError);
      expect((e as VercelApiError).kind).toBe("malformed_response");
      expect((e as VercelApiError).message).toMatch(/may already be running/i);
      return true;
    });
  });
});

describe("getVercelDeployment", () => {
  it("returns the parsed deployment", async () => {
    const d = await getVercelDeployment("dpl_1", {
      credential: CRED,
      fetchImpl: fetchReturning(200, { id: "dpl_1", readyState: "READY" }),
    });
    expect(d.readyState).toBe("READY");
  });

  it("surfaces a 404 as a classified error, not a silent null", async () => {
    await expect(
      getVercelDeployment("dpl_gone", {
        credential: CRED,
        fetchImpl: fetchReturning(404, { error: { message: "not found" } }),
      }),
    ).rejects.toBeInstanceOf(VercelApiError);
  });
});
