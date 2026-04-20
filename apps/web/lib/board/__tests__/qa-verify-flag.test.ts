// B2 — the recording-coverage fix: enabling the GATE implies enabling RECORDING.
//
// This is the fix for the headline prod failure. `ENGINEER_QA_GATE_ENABLED` is
// read by the engine and `ENGINEER_QA_VERIFY_ENABLED` was read by the runner's
// own host env, so "gate enforcing, runner recording nothing" was a silently
// valid configuration across two processes — and it is the one prod was in.
// `decideQaGate` fails open on an absent record, so the gate allowed all 20
// failing-build hand-offs it existed to stop.
//
// The one configuration that must no longer be expressible is
// enforce-without-recording. Shadow mode (record, don't enforce) must survive.

import { describe, it, expect } from "vitest";
import { decideQaVerifyEnabled } from "@/lib/board/qa-verify-flag";

const on = (verifyFlag: string | undefined, gateFlag: string | undefined) =>
  decideQaVerifyEnabled({ verifyFlag, gateFlag });

describe("decideQaVerifyEnabled", () => {
  it("THE FIX: gate on, verify unset → records anyway", () => {
    expect(on(undefined, "1")).toBe(true);
  });

  it("gate on, verify explicitly off → still records (a gate needs evidence)", () => {
    expect(on("0", "true")).toBe(true);
  });

  it("preserves shadow mode: verify on, gate off → records without enforcing", () => {
    expect(on("1", undefined)).toBe(true);
  });

  it("both on → records", () => {
    expect(on("1", "1")).toBe(true);
  });

  it("both off/unset → inert, exactly as before (the default)", () => {
    expect(on(undefined, undefined)).toBe(false);
    expect(on("0", "0")).toBe(false);
    expect(on("false", "no")).toBe(false);
    expect(on("", "")).toBe(false);
  });

  it("accepts the same spellings as isEngineerQaGateEnabled, on either flag", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "Yes"]) {
      expect(on(v, undefined)).toBe(true);
      expect(on(undefined, v)).toBe(true);
    }
  });

  it("does not treat an arbitrary truthy-looking string as on", () => {
    expect(on("enabled", "on")).toBe(false);
  });
});
