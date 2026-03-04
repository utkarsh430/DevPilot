// The transitional ACE_* -> DEVPILOT_* env alias.
//
// The failure this guards against is silent, not loud: an operator's un-migrated
// `.env.local` still says `ACE_RUNNER_REGISTRATION_KEY`, the code now reads
// `DEVPILOT_RUNNER_REGISTRATION_KEY`, and nothing crashes — every runner→engine
// call just 401s.

import { describe, it, expect } from "vitest";
import { applyLegacyEnvAliases, type EnvLike } from "@/lib/env/legacy-alias";

describe("applyLegacyEnvAliases", () => {
  it("mirrors a legacy ACE_* var onto its DEVPILOT_* name", () => {
    const env: EnvLike = { ACE_RUNNER_REGISTRATION_KEY: "secret" };
    applyLegacyEnvAliases(env);
    expect(env.DEVPILOT_RUNNER_REGISTRATION_KEY).toBe("secret");
    // The legacy name is left in place — the shim mirrors, it does not move.
    expect(env.ACE_RUNNER_REGISTRATION_KEY).toBe("secret");
  });

  it("never overrides an explicitly-set new name", () => {
    const env: EnvLike = { ACE_QA_MAX_RETRIES: "9", DEVPILOT_QA_MAX_RETRIES: "3" };
    applyLegacyEnvAliases(env);
    expect(env.DEVPILOT_QA_MAX_RETRIES).toBe("3");
  });

  it("covers the dynamically-named per-data-source vars a fixed table would miss", () => {
    const env: EnvLike = { ACE_DATA_SOURCE_ABC_URL: "postgres://x" };
    applyLegacyEnvAliases(env);
    expect(env.DEVPILOT_DATA_SOURCE_ABC_URL).toBe("postgres://x");
  });

  it("ignores unrelated and blank vars", () => {
    const env: EnvLike = { PATH: "/bin", ACE_BLANK: "" };
    expect(applyLegacyEnvAliases(env)).toEqual([]);
    expect(env.DEVPILOT_BLANK).toBeUndefined();
  });

  it("is idempotent", () => {
    const env: EnvLike = { ACE_MAX_FAN_OUT: "5" };
    applyLegacyEnvAliases(env);
    expect(applyLegacyEnvAliases(env)).toEqual([]);
    expect(env.DEVPILOT_MAX_FAN_OUT).toBe("5");
  });
});
