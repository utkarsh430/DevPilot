// The PR-3 env transport, driven by an INJECTED fetch. No test here touches the
// network — the operator has a Vercel account but no Integration and no linked
// project, so a live round-trip is not available and every wire assertion below
// is against the request shape we build, not against Vercel's response.
//
// Two of these assertions are the ones that would silently ruin the feature if
// they regressed, and neither produces a visible failure in normal use:
//
//   * `?upsert=true` missing → the FIRST push of every variable works and every
//     subsequent one 403s. A feature that breaks only on the second use.
//   * `type: "sensitive"` missing → everything keeps working, and the values
//     become readable back out of Vercel and printable in build logs.

import { describe, expect, it } from "vitest";
import {
  listVercelProjectEnv,
  pushVercelEnvVar,
  type FetchLike,
  type VercelClientOptions,
} from "@/lib/vercel/api";
import { DEVPILOT_ENV_COMMENT, ENV_PUSH_TARGETS } from "@/lib/vercel/env-plan";
import { VercelApiError } from "@/lib/vercel/errors";
import { parseEnvVars } from "@/lib/vercel/types";

const TOKEN = "vercel_test_token_abcdefghijklmnop";
const SECRET = "pg://user:hunter2@db.internal/app";

type Call = { url: string; method: string; body: unknown };

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    const next = responses.shift() ?? { status: 500, body: null };
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { impl, calls };
}

function opts(impl: FetchLike, teamId: string | null = null): VercelClientOptions {
  return { credential: { token: TOKEN, teamId }, fetchImpl: impl };
}

describe("listVercelProjectEnv", () => {
  it("hits the env endpoint and threads the team scope", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { envs: [] } }]);
    await listVercelProjectEnv("prj_1", opts(impl, "team_9"));
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v10/projects/prj_1/env");
    expect(url.searchParams.get("teamId")).toBe("team_9");
  });

  it("does NOT request decrypt — that would pull plaintext through the transport", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { envs: [] } }]);
    await listVercelProjectEnv("prj_1", opts(impl));
    expect(new URL(calls[0]!.url).searchParams.has("decrypt")).toBe(false);
  });

  it("surfaces a failure as a VercelApiError", async () => {
    const { impl } = fakeFetch([{ status: 403, body: { error: { message: "Not authorized" } } }]);
    await expect(listVercelProjectEnv("prj_1", opts(impl))).rejects.toBeInstanceOf(VercelApiError);
  });
});

describe("parseEnvVars", () => {
  it("reads the fields the reconciliation needs", () => {
    const parsed = parseEnvVars({
      envs: [
        {
          id: "env_1",
          key: "DATABASE_URL",
          type: "sensitive",
          target: ["production", "preview"],
          comment: DEVPILOT_ENV_COMMENT,
        },
      ],
    });
    expect(parsed).toEqual([
      {
        id: "env_1",
        key: "DATABASE_URL",
        type: "sensitive",
        target: ["production", "preview"],
        comment: DEVPILOT_ENV_COMMENT,
        value: null,
      },
    ]);
  });

  it("keeps `value` ONLY for a plain variable", () => {
    // Vercel has historically put an encrypted blob in this field for the other
    // types. Trusting it would make every comparison report "differs", turning
    // the whole leave-alone list into conflicts and teaching the operator to
    // tick every override box.
    const parsed = parseEnvVars([
      { id: "a", key: "PLAIN_ONE", type: "plain", target: ["production"], value: "visible" },
      { id: "b", key: "ENC_ONE", type: "encrypted", target: ["production"], value: "GIBBERISH" },
      { id: "c", key: "SENS_ONE", type: "sensitive", target: ["production"], value: "GIBBERISH" },
    ]);
    expect(parsed.map((e) => e.value)).toEqual(["visible", null, null]);
  });

  it("normalises a bare-string target and drops a keyless row", () => {
    const parsed = parseEnvVars({
      envs: [
        { id: "a", key: "K", type: "plain", target: "production" },
        { id: "b", type: "plain", target: ["production"] },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.target).toEqual(["production"]);
  });

  it("degrades to [] on a shape it does not recognise", () => {
    expect(parseEnvVars(null)).toEqual([]);
    expect(parseEnvVars({ nope: 1 })).toEqual([]);
    expect(parseEnvVars("string")).toEqual([]);
  });
});

describe("pushVercelEnvVar", () => {
  it("POSTs with upsert=true, type sensitive, and both targets", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { created: {} } }]);
    await pushVercelEnvVar(
      { projectId: "prj_1", key: "DATABASE_URL", value: SECRET, targets: ENV_PUSH_TARGETS },
      opts(impl, "team_9"),
    );
    const call = calls[0]!;
    const url = new URL(call.url);

    expect(call.method).toBe("POST");
    expect(url.pathname).toBe("/v10/projects/prj_1/env");
    // Without this, the second push of any variable 403s "already exists".
    expect(url.searchParams.get("upsert")).toBe("true");
    expect(url.searchParams.get("teamId")).toBe("team_9");
    expect(call.body).toEqual({
      key: "DATABASE_URL",
      value: SECRET,
      target: ["production", "preview"],
      // Non-readable once created, redacted from build logs. Only legal for
      // production/preview, which is exactly what ENV_PUSH_TARGETS pins.
      type: "sensitive",
      comment: DEVPILOT_ENV_COMMENT,
    });
  });

  it("writes the provenance marker every time", async () => {
    // The differing-value policy hangs off this comment: without it DevPilot
    // cannot tell its own variable from one an operator set in the dashboard,
    // and would have to treat all of them as foreign forever.
    const { impl, calls } = fakeFetch([{ status: 200, body: {} }]);
    await pushVercelEnvVar(
      { projectId: "p", key: "K", value: "v", targets: ENV_PUSH_TARGETS },
      opts(impl),
    );
    expect((calls[0]!.body as { comment?: string }).comment).toBe(DEVPILOT_ENV_COMMENT);
  });

  it("never puts the value in the URL", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: {} }]);
    await pushVercelEnvVar(
      { projectId: "p", key: "K", value: SECRET, targets: ENV_PUSH_TARGETS },
      opts(impl),
    );
    // The URL is the one part of a request this codebase considers safe to log.
    expect(calls[0]!.url).not.toContain("hunter2");
  });

  it("keeps the value out of a thrown error", async () => {
    // Vercel echoes request context on rejection often enough that this is not
    // hypothetical, and the error message reaches the operator's screen.
    const { impl } = fakeFetch([
      { status: 400, body: { error: { message: `bad value ${SECRET}` } } },
    ]);
    let caught: unknown;
    try {
      await pushVercelEnvVar(
        { projectId: "p", key: "K", value: SECRET, targets: ENV_PUSH_TARGETS },
        opts(impl),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VercelApiError);
    expect((caught as VercelApiError).message).not.toContain("hunter2");
  });

  it("never puts the token in an error message", async () => {
    const { impl } = fakeFetch([
      { status: 401, body: { error: { message: `token ${TOKEN} rejected` } } },
    ]);
    await expect(
      pushVercelEnvVar(
        { projectId: "p", key: "K", value: "v", targets: ENV_PUSH_TARGETS },
        opts(impl),
      ),
    ).rejects.toSatisfy((e: VercelApiError) => !e.message.includes(TOKEN));
  });
});

describe("ENV_PUSH_TARGETS", () => {
  it("is production + preview and excludes development", () => {
    // `type: "sensitive"` is only valid for production/preview. Adding
    // development would force a weaker type for a target the runner already
    // serves locally through .env.local.
    expect([...ENV_PUSH_TARGETS]).toEqual(["production", "preview"]);
  });
});
