// Runner↔engine HTTP header names, and the transitional dual-accept read.
//
// The DevPilot rename moved these from `x-ace-*` to `x-devpilot-*`. SENDERS (the
// runner: engine-client, config-client, dev-server-loop, verification-hook, and
// the MCP relay) send the NEW name only. READERS accept EITHER, because the web
// app and the runner are separate processes that an operator restarts
// separately: a rebuilt engine talking to a not-yet-rebuilt runner would
// otherwise 401 every call with "missing header" — which reads as a bad
// registration key, not as version skew.
//
// TRANSITIONAL. The legacy half is deleted in the final rename batch, once no
// pre-rename runner can still be running.

export const RUNNER_KEY_HEADER = "x-devpilot-runner-key";
export const RUNNER_TENANT_HEADER = "x-devpilot-runner-tenant";
export const ATTACH_DEV_BYPASS_HEADER = "x-devpilot-attach-dev-bypass";

const LEGACY: Record<string, string> = {
  [RUNNER_KEY_HEADER]: "x-ace-runner-key",
  [RUNNER_TENANT_HEADER]: "x-ace-runner-tenant",
  [ATTACH_DEV_BYPASS_HEADER]: "x-ace-attach-dev-bypass",
};

/** Read a runner header, falling back to its pre-rename `x-ace-*` name. */
export function readRunnerHeader(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  if (value !== null) return value;
  const legacy = LEGACY[name];
  return legacy ? request.headers.get(legacy) : null;
}

/** The header names a sender should emit. Exported so the runner-side clients
 *  and the acceptance scripts never hand-spell them. */
export const RUNNER_HEADERS = {
  key: RUNNER_KEY_HEADER,
  tenant: RUNNER_TENANT_HEADER,
} as const;
