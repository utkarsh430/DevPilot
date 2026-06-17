import { describe, expect, it } from "vitest";
import { interpretInngestServeProbe } from "@/lib/health/inngest-probe";

describe("interpretInngestServeProbe", () => {
  it("a 2xx is ok in any mode", () => {
    expect(
      interpretInngestServeProbe({
        status: 200,
        ok: true,
        signingKeyConfigured: false,
        latencyMs: 3,
      }).state,
    ).toBe("ok");
  });

  it("an unsigned 401 is ok ONLY when a signing key is configured (cloud / self-hosted mode)", () => {
    const withKey = interpretInngestServeProbe({
      status: 401,
      ok: false,
      signingKeyConfigured: true,
      latencyMs: 5,
    });
    expect(withKey.state).toBe("ok");
    expect(withKey.detail).toContain("unsigned");
    // CONTROL: the same 401 with no key is a real problem.
    expect(
      interpretInngestServeProbe({
        status: 401,
        ok: false,
        signingKeyConfigured: false,
        latencyMs: 5,
      }).state,
    ).toBe("degraded");
  });

  it("anything else non-2xx is degraded and names the status", () => {
    const v = interpretInngestServeProbe({
      status: 500,
      ok: false,
      signingKeyConfigured: true,
      latencyMs: 5,
    });
    expect(v).toEqual({ state: "degraded", detail: "HTTP 500" });
  });
});
