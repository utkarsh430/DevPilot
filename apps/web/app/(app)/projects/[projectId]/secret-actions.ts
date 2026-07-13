"use server";

// Slice A — Project Secrets vault server actions.
//
// All three actions are tenant + project membership gated via requireUser +
// requireTenantId. Writes go through the server-only helpers in
// `@/lib/projects/secrets` (setProjectSecret / deleteProjectSecret), which
// AES-256-GCM-encrypt app-side and write opaque bytea directly — plaintext
// never crosses into the DB. Reads of NAMES go through the
// `project_secret_names` view (RLS-gated by tenant member); reads of
// VALUES are not exposed at all — the runner is the only consumer and it
// pulls the decrypted JSON via the server-side `loadProjectSecretsJson`.

import { z } from "zod";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";
import {
  deleteProjectSecret,
  listProjectSecretNames,
  loadProjectSecretsOverview,
  setProjectSecret,
  type ProjectSecretName,
  type ProjectSecretsOverview,
} from "@/lib/projects/secrets";
import { revalidatePath } from "next/cache";

type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

const SetInput = z.object({
  projectId: z.string().uuid(),
  secretKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Z][A-Z0-9_]{0,127}$/, "key must be UPPER_SNAKE_CASE"),
  value: z.string().min(1).max(64_000),
});

const DeleteInput = z.object({
  projectId: z.string().uuid(),
  secretKey: z.string().min(1).max(128),
});

const ListInput = z.object({
  projectId: z.string().uuid(),
});

async function assertProjectInTenant(projectId: string, tenantId: string): Promise<boolean> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("projects")
    .select("id, tenant_id")
    .eq("id", projectId)
    .maybeSingle();
  if (error || !data) return false;
  return data.tenant_id === tenantId;
}

export async function setProjectSecretAction(
  input: z.infer<typeof SetInput>,
): Promise<ActionResult> {
  const parsed = SetInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const user = await requireUser();
  const tenantId = await requireTenantId();
  if (!(await assertProjectInTenant(parsed.data.projectId, tenantId))) {
    return { ok: false, error: "forbidden" };
  }
  try {
    await setProjectSecret({
      projectId: parsed.data.projectId,
      secretKey: parsed.data.secretKey,
      value: parsed.data.value,
      userId: user.id,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath(`/projects/${parsed.data.projectId}`);
  return { ok: true, value: undefined };
}

export async function deleteProjectSecretAction(
  input: z.infer<typeof DeleteInput>,
): Promise<ActionResult> {
  const parsed = DeleteInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  if (!(await assertProjectInTenant(parsed.data.projectId, tenantId))) {
    return { ok: false, error: "forbidden" };
  }
  try {
    await deleteProjectSecret({
      tenantId,
      projectId: parsed.data.projectId,
      secretKey: parsed.data.secretKey,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath(`/projects/${parsed.data.projectId}`);
  return { ok: true, value: undefined };
}

export async function listProjectSecretNamesAction(
  input: z.infer<typeof ListInput>,
): Promise<ActionResult<ProjectSecretName[]>> {
  const parsed = ListInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  if (!(await assertProjectInTenant(parsed.data.projectId, tenantId))) {
    return { ok: false, error: "forbidden" };
  }
  const items = await listProjectSecretNames(parsed.data.projectId, tenantId);
  return { ok: true, value: items };
}

export async function getProjectSecretsOverviewAction(
  input: z.infer<typeof ListInput>,
): Promise<ActionResult<ProjectSecretsOverview>> {
  const parsed = ListInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  if (!(await assertProjectInTenant(parsed.data.projectId, tenantId))) {
    return { ok: false, error: "forbidden" };
  }
  const overview = await loadProjectSecretsOverview(parsed.data.projectId, tenantId);
  return { ok: true, value: overview };
}
