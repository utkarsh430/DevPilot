// Pick a Runner instance for a given policy. Phase 0 returns a freshly
// constructed runner per call — these are cheap, stateless wrappers. M5 swaps
// the local-cc branch to a runner that talks to the worker pool via Redis.

import { ApiRunner } from "@/lib/runners/api";
import type { Runner, RunnerKind } from "@/lib/runners/types";

export function pickRunner(policy: RunnerKind): Runner {
  switch (policy) {
    case "api":
      return new ApiRunner();
    case "local-cc":
      // M5 implements LocalCCRunner. Until then, refuse explicitly so a
      // mis-configured agent fails loud instead of silently downgrading.
      throw new Error("local-cc runner not yet implemented (lands in M5)");
    default: {
      const exhaustive: never = policy;
      throw new Error(`unknown runner policy: ${String(exhaustive)}`);
    }
  }
}
