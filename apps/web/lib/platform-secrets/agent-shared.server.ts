// IO wiring for the agent-shared platform secrets. The decision half — which
// keys are eligible, and how they merge with the project vault — is the pure,
// Vitest-loadable `agent-shared.ts`; this file only supplies the resolver.
//
// Reading through the ordinary platform-secrets resolver means a shared key
// follows the SAME precedence every other consumer sees (tenant override »
// instance » process.env) rather than a second, divergent read path.

import "server-only";

import { resolveSharedPlatformSecrets } from "@/lib/platform-secrets/agent-shared";
import { resolvePlatformSecret } from "@/lib/platform-secrets/resolver";

export async function loadSharedPlatformSecrets(tenantId: string): Promise<Record<string, string>> {
  return resolveSharedPlatformSecrets(tenantId, resolvePlatformSecret);
}
