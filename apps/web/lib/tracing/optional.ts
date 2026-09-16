// Tracing is OPTIONAL; the run is not. The marker-free half of
// `langfuse.ts` (which reaches `server-only` through the platform-secrets
// resolver and so cannot load under Vitest - exactly the gap this defect
// lived in).
//
// "The trace is the product" is a principle about what counts as DONE, not a
// licence to refuse to run. Every agent run used to start with
// `langfuseForTenant(...).trace(...)`, and the env getters behind it THROW on
// a blank key - so on a local install with no Langfuse account every run died
// at its first step with `uncaught-exception:Missing required env var:
// LANGFUSE_PUBLIC_KEY`, the ticket sat in progress, and the board said
// nothing (measured on the first ticket a fresh install ever filed). With no
// keys the client is the SDK's own disabled mode (`enabled: false`: every
// trace/span/generation call is a no-op, nothing is sent), announced ONCE.
// Spend is still recorded - that lives in `runs`/`run_steps`, not in the
// trace - and the Run Inspector already hides its trace links when
// `LANGFUSE_PROJECT_ID` is blank.

import { Langfuse } from "langfuse";

export type TracingKeys = { publicKey: string; secretKey: string };

export type TracingDecision =
  | { enabled: true }
  | { enabled: false; reason: "no-keys" | "partial-keys" };

export function decideTracing(keys: TracingKeys): TracingDecision {
  const pub = keys.publicKey.trim().length > 0;
  const sec = keys.secretKey.trim().length > 0;
  if (pub && sec) return { enabled: true };
  return { enabled: false, reason: pub || sec ? "partial-keys" : "no-keys" };
}

export const TRACING_DISABLED_NOTICE =
  "[tracing] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set — spans are not recorded (runs still execute and spend is still metered). Add the keys in Settings → Setup to enable tracing.";

let disabled: Langfuse | null = null;
let announced = false;

/** The SDK in its own no-op mode. Placeholder keys satisfy the constructor;
 *  `enabled: false` makes every call a no-op and sends nothing anywhere. One
 *  instance, one warning per process. */
export function disabledLangfuse(warn: (message: string) => void = console.warn): Langfuse {
  if (!announced) {
    announced = true;
    warn(TRACING_DISABLED_NOTICE);
  }
  if (!disabled) {
    disabled = new Langfuse({ publicKey: "disabled", secretKey: "disabled", enabled: false });
  }
  return disabled;
}
