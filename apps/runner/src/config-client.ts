// Phase 5 — best-effort pull of this runner's per-tenant config from the engine.
//
// GET /api/runners/config returns an allow-listed subset of the tenant's
// resolved platform secrets ({ secrets: { ANTHROPIC_API_KEY?,
// CLAUDE_CODE_OAUTH_TOKEN?, ENGINEER_REPO_URL?, ENGINEER_QA_COMMAND? },
// ttlSeconds }). The runner overlays these on top of its own env (see the
// getter in index.ts) so an operator can rotate them in the UI without
// redeploying the runner.
//
// This is STRICTLY best-effort: any failure (engine down, feature flag off,
// non-2xx, malformed body) returns null and the runner keeps using its env
// floor exactly as before. Boot and job-pulling must never depend on it.

import { env } from "./env.js";

// Same auth + tenant headers the engine-client uses for every other runner
// route. Duplicated here (rather than imported) to keep config-client a
// standalone best-effort module with no coupling to engine-client internals.
const headers = () => ({
  "Content-Type": "application/json",
  "x-devpilot-runner-key": env.REGISTRATION_KEY,
  "x-devpilot-runner-tenant": env.TENANT_ID,
});

export type RunnerConfig = {
  secrets: Record<string, string>;
  ttlSeconds: number;
};

export async function fetchRunnerConfig(): Promise<RunnerConfig | null> {
  try {
    const res = await fetch(`${env.ENGINE_URL}/api/runners/config`, {
      method: "GET",
      headers: headers(),
    });
    if (!res.ok) {
      // Non-fatal — a 401/404/500 just means we stay on the env floor.
      console.warn(`[devpilot-runner] config fetch failed: ${res.status}`);
      return null;
    }
    const body = (await res.json()) as Partial<RunnerConfig> | null;
    const rawSecrets = body?.secrets;
    // Defensive: coerce to a clean Record<string,string>; drop non-string
    // values rather than trusting the payload shape blindly.
    const secrets: Record<string, string> = {};
    if (rawSecrets && typeof rawSecrets === "object") {
      for (const [k, v] of Object.entries(rawSecrets)) {
        if (typeof v === "string" && v.length > 0) secrets[k] = v;
      }
    }
    const ttlSeconds =
      typeof body?.ttlSeconds === "number" && body.ttlSeconds > 0 ? body.ttlSeconds : 60;
    return { secrets, ttlSeconds };
  } catch (err) {
    console.warn(
      `[devpilot-runner] config fetch network failure: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
