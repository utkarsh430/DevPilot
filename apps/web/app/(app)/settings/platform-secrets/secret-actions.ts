"use server";

// Platform secrets server actions. Per-tenant: every write/read is scoped to the
// caller's tenant via requireTenantId. Writes go through the security-definer
// RPCs so plaintext never crosses the RLS layer. Only catalog keys flagged
// `editable` may be set here — bootstrap / shared-infra keys are read-only
// (managed in the environment).

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import {
  deletePlatformSecret,
  loadPlatformSecretsOverview,
  setPlatformSecret,
  type PlatformSecretsOverview,
} from "@/lib/platform-secrets/store";
import { platformCatalogEntry } from "@/lib/platform-secrets/catalog";
import { invalidatePlatformSecrets, platformSecretsEnabled } from "@/lib/platform-secrets/resolver";
import { isInstanceOperator } from "@/lib/platform-secrets/operator";
import { operatorOnlyRefusal } from "@/lib/platform-secrets/operator-gate";

type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

/** The store is default-on; only an explicit DEVPILOT_PLATFORM_SECRETS_ENABLED=0
 *  turns it off. When it IS off, writes must say so loudly — saving into a
 *  store nothing reads was the old silent-no-op failure mode. */
function assertStoreEnabled(): string | null {
  if (platformSecretsEnabled()) return null;
  return "The platform-secrets store is disabled on this install (DEVPILOT_PLATFORM_SECRETS_ENABLED=0) — values saved here would never be read. Remove the flag or manage this key in .env.local.";
}

const SetInput = z.object({
  secretKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Z][A-Z0-9_]{0,127}$/, "key must be UPPER_SNAKE_CASE"),
  value: z.string().min(1).max(64_000),
});

const DeleteInput = z.object({
  secretKey: z.string().min(1).max(128),
});

/** Guard: only known, editable catalog keys are settable from this surface. */
function assertEditable(key: string): string | null {
  const entry = platformCatalogEntry(key);
  if (!entry) return `${key} is not a recognized platform key`;
  if (!entry.editable) return `${key} is managed in the environment and can't be set here`;
  return null;
}

/** Guard: a catalog key marked `operatorOnly` needs the instance-operator role
 *  even in the TENANT scope.
 *
 *  This closes a real privilege-escalation gap: until this existed the tenant
 *  path had NO role check at all, so any authenticated member could set a
 *  tenant override for any editable key — and the resolver reads tenant »
 *  instance » env, so that override wins for the whole tenant. For a deploy
 *  credential that redirects every environment variable DevPilot pushes; see
 *  `operatorOnly` in the catalog.
 *
 *  Ordered AFTER the cheap catalog checks and BEFORE any write, and applied to
 *  the delete path too — removing an operator's override silently swaps which
 *  credential the tenant resolves to, which is the same capability.
 *
 *  The decision itself lives in `lib/platform-secrets/operator-gate.ts` so it is
 *  unit-testable; this file can't load under Vitest (`next/headers`). */
async function assertOperatorAllowed(key: string, userId: string): Promise<string | null> {
  return operatorOnlyRefusal(key, userId, isInstanceOperator);
}

export async function setPlatformSecretAction(
  input: z.infer<typeof SetInput>,
): Promise<ActionResult> {
  const parsed = SetInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const editErr = assertEditable(parsed.data.secretKey);
  if (editErr) return { ok: false, error: editErr };
  const disabledErr = assertStoreEnabled();
  if (disabledErr) return { ok: false, error: disabledErr };

  const user = await requireUser();
  const tenantId = await requireTenantId();
  const opErr = await assertOperatorAllowed(parsed.data.secretKey, user.id);
  if (opErr) return { ok: false, error: opErr };
  try {
    await setPlatformSecret({
      tenantId,
      secretKey: parsed.data.secretKey,
      value: parsed.data.value,
      userId: user.id,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  invalidatePlatformSecrets(tenantId);
  revalidatePath("/settings/platform-secrets");
  return { ok: true, value: undefined };
}

export async function deletePlatformSecretAction(
  input: z.infer<typeof DeleteInput>,
): Promise<ActionResult> {
  const parsed = DeleteInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const editErr = assertEditable(parsed.data.secretKey);
  if (editErr) return { ok: false, error: editErr };

  const user = await requireUser();
  const tenantId = await requireTenantId();
  const opErr = await assertOperatorAllowed(parsed.data.secretKey, user.id);
  if (opErr) return { ok: false, error: opErr };
  try {
    await deletePlatformSecret({ tenantId, secretKey: parsed.data.secretKey });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  invalidatePlatformSecrets(tenantId);
  revalidatePath("/settings/platform-secrets");
  return { ok: true, value: undefined };
}

export async function getPlatformSecretsOverviewAction(): Promise<
  ActionResult<PlatformSecretsOverview>
> {
  await requireUser();
  const tenantId = await requireTenantId();
  const overview = await loadPlatformSecretsOverview(tenantId);
  return { ok: true, value: overview };
}

// ── Instance scope (tenant_id NULL) ─────────────────────────────────────────
// Written from the Settings → Setup wizard. Instance rows are the default every
// tenant without its own override resolves to, so writes are gated on the
// instance-operator check (owner/admin of the first tenant — see
// lib/platform-secrets/operator.ts), not mere tenant membership.

/** Guard: only known INSTANCE-storage catalog keys land in the instance scope. */
function assertInstanceScoped(key: string): string | null {
  const entry = platformCatalogEntry(key);
  if (!entry) return `${key} is not a recognized platform key`;
  if (entry.storage !== "instance") {
    return `${key} is env-managed — set it in .env.local (or the setup wizard's env steps), not the store`;
  }
  return null;
}

export async function setInstanceSecretAction(
  input: z.infer<typeof SetInput>,
): Promise<ActionResult> {
  const parsed = SetInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const scopeErr = assertInstanceScoped(parsed.data.secretKey);
  if (scopeErr) return { ok: false, error: scopeErr };
  const disabledErr = assertStoreEnabled();
  if (disabledErr) return { ok: false, error: disabledErr };

  const user = await requireUser();
  const tenantId = await requireTenantId();
  if (!(await isInstanceOperator(user.id))) {
    return { ok: false, error: "Only an instance operator can set instance-wide defaults" };
  }
  try {
    await setPlatformSecret({
      tenantId: null,
      secretKey: parsed.data.secretKey,
      value: parsed.data.value,
      userId: user.id,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // The caller's tenant map caches the merged (tenant-over-instance) view, so
  // both scopes must drop. Other processes converge within the resolver TTL.
  invalidatePlatformSecrets(null);
  invalidatePlatformSecrets(tenantId);
  revalidatePath("/settings/setup");
  revalidatePath("/settings/platform-secrets");
  return { ok: true, value: undefined };
}

export async function deleteInstanceSecretAction(
  input: z.infer<typeof DeleteInput>,
): Promise<ActionResult> {
  const parsed = DeleteInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const scopeErr = assertInstanceScoped(parsed.data.secretKey);
  if (scopeErr) return { ok: false, error: scopeErr };

  const user = await requireUser();
  const tenantId = await requireTenantId();
  if (!(await isInstanceOperator(user.id))) {
    return { ok: false, error: "Only an instance operator can remove instance-wide defaults" };
  }
  try {
    await deletePlatformSecret({ tenantId: null, secretKey: parsed.data.secretKey });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  invalidatePlatformSecrets(null);
  invalidatePlatformSecrets(tenantId);
  revalidatePath("/settings/setup");
  revalidatePath("/settings/platform-secrets");
  return { ok: true, value: undefined };
}
