// Settings ▸ Platform secrets — manage the workspace's credentials & config.
// Server component: loads the tenant's configured overrides + masked tails;
// the static catalog supplies labels / descriptions / required+editable flags.
//
// `isOperator` is resolved here rather than in the client so an `operatorOnly`
// row can render DISABLED with the reason stated, instead of letting someone
// type a value and only then learn the write is refused. The action-side gate
// is the real control; this is just honest UI in front of it.

import { getCurrentTenantId, getUser } from "@/lib/auth";
import {
  loadPlatformSecretsOverview,
  type PlatformSecretsOverview,
} from "@/lib/platform-secrets/store";
import { PLATFORM_SECRET_CATALOG } from "@/lib/platform-secrets/catalog";
import { isInstanceOperator } from "@/lib/platform-secrets/operator";
import { vercelTokenConfigured } from "@/lib/vercel/api.server";
import { integrationConfigured, loadVercelConnectionStatus } from "@/lib/vercel/connection.server";
import { PlatformSecretsClient } from "./platform-secrets-client";

export const dynamic = "force-dynamic";

export default async function PlatformSecretsPage() {
  const tenantId = await getCurrentTenantId();
  const user = await getUser();
  const initial: PlatformSecretsOverview = tenantId
    ? await loadPlatformSecretsOverview(tenantId)
    : { configured: [], instanceConfigured: [], catalog: PLATFORM_SECRET_CATALOG };

  const [isOperator, vercelTokenSet, connection, integrationSet] = await Promise.all([
    user ? isInstanceOperator(user.id) : Promise.resolve(false),
    vercelTokenConfigured(tenantId),
    loadVercelConnectionStatus(tenantId),
    integrationConfigured(tenantId),
  ]);

  return (
    <PlatformSecretsClient
      initial={initial}
      isOperator={isOperator}
      vercelTokenConfigured={vercelTokenSet}
      vercelConnection={connection}
      vercelIntegrationConfigured={integrationSet}
    />
  );
}
