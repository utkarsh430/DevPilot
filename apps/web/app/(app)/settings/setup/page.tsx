// Settings → Setup — the post-auth instance wizard. One page that walks every
// credential the platform uses, in dependency order, each step showing where
// the value lives (env file vs encrypted store), whether it's detected, and a
// guided get-one → paste → validate → save path. Operators can write;
// everyone else gets the same page read-only.

import { requireTenantId, requireUser } from "@/lib/auth";
import { loadSetupWizardStatus } from "@/lib/setup/wizard-status";
import { SetupWizardClient } from "./setup-wizard-client";

export const dynamic = "force-dynamic";

export default async function SetupSettingsPage() {
  const user = await requireUser();
  const tenantId = await requireTenantId();
  const status = await loadSetupWizardStatus(user.id, tenantId);

  return <SetupWizardClient status={status} />;
}
