// One poll of a running deployment, driven end-to-end with a fake Supabase
// client and a stubbed Vercel read.
//
// This is where the state MACHINE is proven: queued → building → ready / error /
// cancelled, plus the two ways a poll ends without a verdict (a transient read
// failure, and the ceiling). No test here touches the network.
//
// Three properties are load-bearing and each is paired with the case that would
// break it:
//
//   • The ledger row is written on EVERY poll, before anything else, so the card
//     is never blank while a build runs and a failure always has a build-log link.
//   • `vercel_production_url` is stamped ONLY for production + READY. Anything
//     else advertising a URL as "live" is a lie about what is serving traffic.
//   • The ticket is commented ONCE, on the terminal poll — not per poll.

import { describe, expect, it, vi } from "vitest";
import { absoluteUrl, pollDeploymentOnce, type PollArgs } from "@/lib/vercel/deploy-poll";
import type { VercelDeployment } from "@/lib/vercel/types";

// ── Fakes ───────────────────────────────────────────────────────────────────

/** The body of the one comment that was posted. Fails loudly if none was — an
 *  assertion on a missing comment must not silently read as an empty string. */
function commentBody(fn: { mock: { calls: [CommentArgs][] } }): string {
  const call = fn.mock.calls[0];
  if (!call) throw new Error("expected a comment to have been posted, but none was");
  return call[0].body;
}

/** The row written by the one poll under test. Fails loudly when none was —
 *  asserting on a missing upsert must not silently pass. */
function upserted(captured: Captured): Record<string, unknown> {
  const row = captured.upserts[0];
  if (!row) throw new Error("expected a deployment record to have been written, but none was");
  return row;
}

/** The one project update. Same reasoning. */
function projectUpdate(captured: Captured) {
  const upd = captured.projectUpdates[0];
  if (!upd) throw new Error("expected a project update, but none was made");
  return upd;
}

type Captured = {
  upserts: Record<string, unknown>[];
  projectUpdates: { patch: Record<string, unknown>; filters: [string, unknown][] }[];
};

function fakeDb(): { client: never; captured: Captured } {
  const captured: Captured = { upserts: [], projectUpdates: [] };
  const from = (table: string) => {
    if (table === "project_deployments") {
      return {
        upsert(row: Record<string, unknown>) {
          captured.upserts.push(row);
          return Promise.resolve({ error: null });
        },
      };
    }
    const filters: [string, unknown][] = [];
    const b = {
      update(patch: Record<string, unknown>) {
        captured.projectUpdates.push({ patch, filters });
        return b;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return b;
      },
      then(resolve: (v: { error: null }) => void) {
        resolve({ error: null });
      },
    };
    return b;
  };
  return { client: { from } as never, captured };
}

const DEPLOYMENT = (over: Partial<VercelDeployment> = {}): VercelDeployment => ({
  id: "dpl_abc",
  url: "x-abc.vercel.app",
  readyState: "BUILDING",
  target: "production",
  inspectorUrl: "https://vercel.com/acme/x/dpl_abc",
  errorMessage: null,
  commitSha: "0123456789abcdef",
  branch: "dev",
  readyAt: null,
  ...over,
});

const ARGS: PollArgs = {
  tenantId: "t_ours",
  projectId: "p_ours",
  ticketId: "tk_1",
  vercelDeploymentId: "dpl_abc",
  target: "production",
  triggeredBy: "u_1",
  triggerSource: "human",
  attempt: 1,
  isFinalAttempt: false,
};

type CommentArgs = { ticketId: string; tenantId: string; body: string };

function deps(deployment: VercelDeployment | Error, over: Record<string, unknown> = {}) {
  const { client, captured } = fakeDb();
  const postComment = vi.fn(async (_args: CommentArgs) => {});
  return {
    captured,
    postComment,
    deps: {
      db: client,
      fetchDeployment: async () => {
        if (deployment instanceof Error) throw deployment;
        return deployment;
      },
      postComment,
      now: () => "2026-07-18T12:00:00.000Z",
      secrets: ["vercel_token_supersecret_value"],
      ...over,
    },
  };
}

// ── In-flight states ────────────────────────────────────────────────────────

describe("pollDeploymentOnce — in-flight", () => {
  it.each(["QUEUED", "INITIALIZING", "BUILDING"])(
    "%s: records the row, does not comment, does not stamp production",
    async (state) => {
      const t = deps(DEPLOYMENT({ readyState: state }));
      const out = await pollDeploymentOnce(t.deps, ARGS);

      expect(out).toMatchObject({ ok: true, phase: "pending", terminal: false, commented: false });
      expect(t.captured.upserts).toHaveLength(1);
      expect(upserted(t.captured)).toMatchObject({
        ready_state: state,
        tenant_id: "t_ours",
        project_id: "p_ours",
        // The build-log link is present from the FIRST poll, so a build that
        // fails immediately is still diagnosable.
        inspector_url: "https://vercel.com/acme/x/dpl_abc",
      });
      expect(upserted(t.captured).became_production_at).toBeNull();
      expect(t.captured.projectUpdates).toHaveLength(0);
      expect(t.postComment).not.toHaveBeenCalled();
    },
  );
});

// ── Terminal states ─────────────────────────────────────────────────────────

describe("pollDeploymentOnce — READY", () => {
  it("production: stamps became_production_at, writes the project URL, comments once", async () => {
    const t = deps(DEPLOYMENT({ readyState: "READY", readyAt: 1_800_000_000_000 }));
    const out = await pollDeploymentOnce(t.deps, ARGS);

    expect(out).toMatchObject({
      ok: true,
      phase: "ready",
      terminal: true,
      commented: true,
      productionUrlWritten: true,
    });
    expect(upserted(t.captured).became_production_at).toBe(
      new Date(1_800_000_000_000).toISOString(),
    );
    // The URL is absolutised — Vercel returns a bare hostname, and a relative
    // href would send the operator to a 404 inside DevPilot.
    expect(upserted(t.captured).url).toBe("https://x-abc.vercel.app");

    const upd = projectUpdate(t.captured);
    expect(upd.patch).toEqual({ vercel_production_url: "https://x-abc.vercel.app" });
    // The tenant predicate on the project write is the boundary; deploy-write's
    // own suite proves it filters, this proves the poller supplies it.
    expect(upd.filters).toContainEqual(["tenant_id", "t_ours"]);
    expect(upd.filters).toContainEqual(["id", "p_ours"]);
  });

  it("PREVIEW ready: never stamps the project's production URL", async () => {
    // A preview URL is per-deployment. Writing it here would make the card
    // advertise a throwaway build as the live site.
    const t = deps(DEPLOYMENT({ readyState: "READY" }));
    const out = await pollDeploymentOnce(t.deps, { ...ARGS, target: "preview" });

    expect(out).toMatchObject({ ok: true, terminal: true, productionUrlWritten: false });
    expect(t.captured.projectUpdates).toHaveLength(0);
    expect(upserted(t.captured).became_production_at).toBeNull();
  });
});

describe("pollDeploymentOnce — ERROR", () => {
  it("records the failure with its build log and comments, but stamps no URL", async () => {
    const t = deps(
      DEPLOYMENT({ readyState: "ERROR", errorMessage: 'Command "pnpm build" exited with 1' }),
    );
    const out = await pollDeploymentOnce(t.deps, ARGS);

    expect(out).toMatchObject({ ok: true, phase: "error", terminal: true, commented: true });
    expect(upserted(t.captured)).toMatchObject({
      ready_state: "ERROR",
      error_message: 'Command "pnpm build" exited with 1',
      inspector_url: "https://vercel.com/acme/x/dpl_abc",
    });
    // A failed production build never served production.
    expect(upserted(t.captured).became_production_at).toBeNull();
    expect(t.captured.projectUpdates).toHaveLength(0);

    const body = commentBody(t.postComment);
    expect(body).toContain("https://vercel.com/acme/x/dpl_abc");
    expect(body).toContain("pnpm build");
  });

  it("SECURITY: scrubs the token out of Vercel's error text before it reaches the ticket", async () => {
    // A build error can echo request context back, and this string lands in a
    // thread every agent on the ticket reads.
    const t = deps(
      DEPLOYMENT({
        readyState: "ERROR",
        errorMessage: "auth failed for vercel_token_supersecret_value",
      }),
    );
    await pollDeploymentOnce(t.deps, ARGS);

    expect(upserted(t.captured).error_message).not.toContain("vercel_token_supersecret_value");
    const body = commentBody(t.postComment);
    expect(body).not.toContain("vercel_token_supersecret_value");
    expect(body).toContain("[redacted]");
  });

  it("bounds a pathological error body", async () => {
    const t = deps(DEPLOYMENT({ readyState: "ERROR", errorMessage: "x".repeat(10_000) }));
    await pollDeploymentOnce(t.deps, ARGS);
    expect(String(upserted(t.captured).error_message).length).toBeLessThanOrEqual(401);
  });
});

describe("pollDeploymentOnce — CANCELED", () => {
  it("is terminal, comments, and is not reported as a failure", async () => {
    const t = deps(DEPLOYMENT({ readyState: "CANCELED" }));
    const out = await pollDeploymentOnce(t.deps, ARGS);

    expect(out).toMatchObject({ ok: true, phase: "canceled", terminal: true, commented: true });
    expect(t.captured.projectUpdates).toHaveLength(0);
    const body = commentBody(t.postComment);
    expect(body).toMatch(/canceled/i);
    expect(body).not.toMatch(/FAILED/);
  });
});

// ── The two ways a poll ends without a verdict ──────────────────────────────

describe("pollDeploymentOnce — no verdict", () => {
  it("a transient read failure records NOTHING and is not a failed deploy", async () => {
    // The critical property: a network blip must never be written as ERROR.
    // That would fire a failure comment and, worse, leave a permanent record
    // saying a healthy build failed.
    const t = deps(new Error("socket hang up"));
    const out = await pollDeploymentOnce(t.deps, ARGS);

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/^read-failed:/);
    expect(t.captured.upserts).toHaveLength(0);
    expect(t.postComment).not.toHaveBeenCalled();
  });

  it("the FINAL attempt on a still-building deploy comments that we stopped watching", async () => {
    const t = deps(DEPLOYMENT({ readyState: "BUILDING" }));
    const out = await pollDeploymentOnce(t.deps, { ...ARGS, isFinalAttempt: true });

    expect(out).toMatchObject({ ok: true, phase: "pending", terminal: false, commented: true });
    const body = commentBody(t.postComment);
    expect(body).toMatch(/still building/i);
    // Still not a failure — the build may yet succeed.
    expect(body).not.toMatch(/FAILED/);
    // And still no production URL for a build that never finished.
    expect(t.captured.projectUpdates).toHaveLength(0);
  });

  it("an UNRECOGNISED state keeps polling rather than being guessed into ready", async () => {
    const t = deps(DEPLOYMENT({ readyState: "SOME_FUTURE_STATE" }));
    const out = await pollDeploymentOnce(t.deps, ARGS);

    expect(out).toMatchObject({ ok: true, phase: "unknown", terminal: false, commented: false });
    // Stored VERBATIM so the operator sees what Vercel actually said.
    expect(upserted(t.captured).ready_state).toBe("SOME_FUTURE_STATE");
    expect(t.captured.projectUpdates).toHaveLength(0);
  });
});

// ── Best-effort tails ───────────────────────────────────────────────────────

describe("pollDeploymentOnce — degradation", () => {
  it("a failed comment does not make a successful deploy look failed", async () => {
    const t = deps(DEPLOYMENT({ readyState: "READY" }), {
      postComment: vi.fn(async (_args: CommentArgs) => {
        throw new Error("comments table unavailable");
      }),
    });
    const out = await pollDeploymentOnce(t.deps, ARGS);

    expect(out).toMatchObject({ ok: true, phase: "ready", terminal: true, commented: false });
    // The record and the production URL still landed.
    expect(t.captured.upserts).toHaveLength(1);
    expect(t.captured.projectUpdates).toHaveLength(1);
  });

  it("a ticket-less deploy records normally and comments on nothing", async () => {
    const t = deps(DEPLOYMENT({ readyState: "READY" }));
    const out = await pollDeploymentOnce(t.deps, { ...ARGS, ticketId: null });

    expect(out).toMatchObject({ ok: true, terminal: true, commented: false });
    expect(upserted(t.captured).ticket_id).toBeNull();
    expect(t.postComment).not.toHaveBeenCalled();
  });
});

describe("absoluteUrl", () => {
  it("prefixes a bare Vercel hostname and leaves an absolute URL alone", () => {
    expect(absoluteUrl("x.vercel.app")).toBe("https://x.vercel.app");
    expect(absoluteUrl("https://x.vercel.app")).toBe("https://x.vercel.app");
    expect(absoluteUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(absoluteUrl(null)).toBeNull();
    expect(absoluteUrl("  ")).toBeNull();
  });
});
