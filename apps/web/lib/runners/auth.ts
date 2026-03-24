// Verify a request from the local Claude Code worker carries the registration
// secret. This is the engine's only auth check on runner traffic for Phase 0 —
// production-grade per-runner JWTs are a later concern.

import { env } from "@/lib/env";
import { RUNNER_KEY_HEADER, readRunnerHeader } from "@/lib/runners/headers";

export function checkRunnerAuth(request: Request): { ok: true } | { ok: false; reason: string } {
  // Dual-accept: `x-devpilot-runner-key`, falling back to the pre-rename
  // `x-ace-runner-key` so a not-yet-rebuilt runner still authenticates. See
  // lib/runners/headers.ts.
  const header = readRunnerHeader(request, RUNNER_KEY_HEADER);
  if (!header) return { ok: false, reason: `missing ${RUNNER_KEY_HEADER} header` };
  if (header !== env.DEVPILOT_RUNNER_REGISTRATION_KEY) {
    return { ok: false, reason: "bad registration key" };
  }
  return { ok: true };
}
