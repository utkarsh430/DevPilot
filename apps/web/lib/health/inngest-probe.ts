// How to read the in-process `GET /api/inngest` the health probe makes.
//
// In DEV-SERVER mode the SDK answers introspection to anyone. In CLOUD mode -
// which is also the local self-hosted server, `INNGEST_DEV=0` + a signing key
// - it refuses an UNSIGNED request with 401, by design. That 401 proves the
// serve endpoint is mounted and the SDK is in the mode the keys imply; reading
// it as "degraded" painted the Inngest dot amber on every durable-mode install
// (measured). Pure, so the rule can be tested without loading the engine.

export type InngestServeVerdict = { state: "ok" | "degraded"; detail: string };

export function interpretInngestServeProbe(input: {
  status: number;
  ok: boolean;
  signingKeyConfigured: boolean;
  latencyMs: number;
}): InngestServeVerdict {
  if (input.ok) return { state: "ok", detail: `serve responding (${input.latencyMs}ms)` };
  if (input.status === 401 && input.signingKeyConfigured) {
    return {
      state: "ok",
      detail: `serve wired (${input.latencyMs}ms; unsigned introspection refused, as cloud mode should)`,
    };
  }
  return { state: "degraded", detail: `HTTP ${input.status}` };
}
