// Phase 2.5++ / Slice A — Per-project secrets vault helpers.
//
// Server-only. Reads/writes the per-project secrets with app-layer AES-256-GCM
// (`@/lib/secrets/crypto`) directly against the `project_secrets` table via the
// service-role client — replacing the old pgcrypto security-definer RPCs
// (`set_project_secret`, `get_project_secrets_json`, `get_project_secret_tails`,
// `delete_project_secret`), which a migration drops. Plaintext only exists in
// the Node layer; the DB stores opaque `value_encrypted`/`value_iv` bytea.
// Used by:
//
//   • `run-agent.ts` — dispatch-time fetch + thread JSON into the runner
//     job payload (LPUSH to devpilot:jobs:local-cc:ready).
//   • `dev-server-control.ts` — when an operator starts a localhost server,
//     the same JSON is included in the control message so `pnpm dev` etc.
//     sees the env vars.
//
// Returns a string-encoded JSON object (`{"KEY":"value",…}`) or null when
// the project has no secrets. JSON shape is the contract the runner reads.

import "server-only";

import { supabaseService } from "@/lib/db/server";
import { decryptColumns, encryptSecret, last4, toBytea } from "@/lib/secrets/crypto";

export async function loadProjectSecretsJson(
  projectId: string | null,
  tenantId: string,
): Promise<string | null> {
  if (!projectId) return null;
  const supabase = supabaseService();
  // Read the encrypted columns directly and decrypt in-process. Best-effort: a
  // missing migration, transient DB blip, or missing/invalid master key must
  // not block a dispatch — the runner has its own fallback path (.env.local
  // already present from a prior run, env values from registration, …).
  const { data, error } = await supabase
    .from("project_secrets")
    .select("secret_key, value_encrypted, value_iv")
    .eq("project_id", projectId)
    .eq("tenant_id", tenantId);
  if (error) {
    console.warn(
      `[project-secrets] loadProjectSecretsJson(${projectId}) failed:`,
      error.message ?? error,
    );
    return null;
  }
  const obj: Record<string, string> = {};
  for (const row of data ?? []) {
    let plaintext: string | null = null;
    try {
      plaintext = decryptColumns(
        (row as { value_encrypted?: unknown }).value_encrypted,
        (row as { value_iv?: unknown }).value_iv,
      );
    } catch {
      // Missing/invalid master key or a corrupt row — skip it (read path
      // tolerates decryption failure; never throw and break dispatch).
      plaintext = null;
    }
    if (plaintext !== null) obj[String((row as { secret_key: unknown }).secret_key)] = plaintext;
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;
  return JSON.stringify(obj);
}

/**
 * WI-12 — ONE decrypted secret by name, for the provider-credential resolver
 * (`lib/llm/provider-config.server.ts`, which reaches it through the project's
 * opaque `llm_credential_ref`).
 *
 * Kept separate from `loadProjectSecretsJson` on purpose: that one hands the
 * WHOLE vault to the runner, and a provider credential resolved for a server-side
 * API call has no business being in that blob. This reads exactly the key asked
 * for, and the plaintext never leaves the Node layer — no action returns it, no
 * prompt embeds it, nothing logs it.
 *
 * Tolerant like its sibling: a missing row, a missing master key, or a corrupt
 * value returns null, and the caller falls down its precedence chain rather than
 * exploding.
 */
export async function getProjectSecret(
  projectId: string,
  secretKey: string,
  tenantId: string,
): Promise<string | null> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("project_secrets")
    .select("value_encrypted, value_iv")
    .eq("project_id", projectId)
    .eq("tenant_id", tenantId)
    .eq("secret_key", secretKey)
    .maybeSingle();
  if (error || !data) return null;
  try {
    return decryptColumns(
      (data as { value_encrypted?: unknown }).value_encrypted,
      (data as { value_iv?: unknown }).value_iv,
    );
  } catch {
    return null;
  }
}

export type ProjectSecretName = {
  id: string;
  secretKey: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
};

export async function listProjectSecretNames(
  projectId: string,
  tenantId: string,
): Promise<ProjectSecretName[]> {
  const supabase = supabaseService();
  // Read the underlying TABLE, not the `project_secret_names` view. The view is
  // `security_invoker` + filtered by `current_user_tenants()` for member reads
  // — but this helper uses the SERVICE-ROLE client (no auth.uid()), so the
  // view's tenant filter returns ZERO rows. Service role bypasses RLS on the
  // table, and the action layer already gates by tenant via
  // `assertProjectInTenant`. We never select the value columns, so no plaintext
  // crosses this boundary.
  const { data, error } = await supabase
    .from("project_secrets")
    .select("id, secret_key, created_at, updated_at, created_by")
    .eq("project_id", projectId)
    .eq("tenant_id", tenantId)
    .order("secret_key", { ascending: true });
  if (error) {
    console.warn(`[project-secrets] listProjectSecretNames(${projectId}) failed:`, error.message);
    return [];
  }
  return (data ?? []).map((r) => ({
    id: String(r.id),
    secretKey: String(r.secret_key),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    createdBy: r.created_by ? String(r.created_by) : null,
  }));
}

export async function setProjectSecret(input: {
  projectId: string;
  secretKey: string;
  value: string;
  userId: string | null;
}): Promise<void> {
  const supabase = supabaseService();

  // Resolve the owning tenant (the old RPC derived `tenant_id` from the
  // projects row). Preserve its "project not found" failure mode.
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("tenant_id")
    .eq("id", input.projectId)
    .maybeSingle();
  if (projectError) {
    throw new Error(`set_project_secret failed: ${projectError.message}`);
  }
  if (!project) {
    throw new Error(`set_project_secret failed: project not found: ${input.projectId}`);
  }

  // Encrypt in-process. A missing/invalid master key throws here — and it
  // should: the operator must configure SECRETS_ENCRYPTION_KEY before a SET.
  const { ciphertext, iv } = encryptSecret(input.value);

  const { error } = await supabase.from("project_secrets").upsert(
    {
      project_id: input.projectId,
      tenant_id: (project as { tenant_id: unknown }).tenant_id,
      secret_key: input.secretKey,
      value_encrypted: toBytea(ciphertext),
      value_iv: toBytea(iv),
      created_by: input.userId,
    },
    { onConflict: "project_id,secret_key" },
  );
  if (error) {
    throw new Error(`set_project_secret failed: ${error.message}`);
  }
}

export async function deleteProjectSecret(input: {
  projectId: string;
  secretKey: string;
  tenantId: string;
}): Promise<void> {
  const supabase = supabaseService();
  const { error } = await supabase
    .from("project_secrets")
    .delete()
    .eq("project_id", input.projectId)
    .eq("tenant_id", input.tenantId)
    .eq("secret_key", input.secretKey);
  if (error) {
    throw new Error(`delete_project_secret failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Secrets-manager surface — masked tails + declared env catalog
// ---------------------------------------------------------------------------
// The redesigned project Secrets card needs two extra reads beyond the bare
// KEY-name list: a masked tail (last ≤4 chars) per configured secret so it can
// render "Configured ••••nwAA", and the project's declared env catalog (parsed
// from `.env.example` by the runner) so it can show EVERY key a project needs
// — configured or not — with a Required/Optional label + description.

/** Last ≤4 chars per configured secret. Decrypts each value in-process (the old
 *  RPC computed `right(value, 4)` in the DB) and keeps only the tail — the full
 *  plaintext is dropped immediately. Best-effort: any error → empty map. */
async function getProjectSecretTailsMap(
  projectId: string,
  tenantId: string,
): Promise<Record<string, string>> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("project_secrets")
    .select("secret_key, value_encrypted, value_iv")
    .eq("project_id", projectId)
    .eq("tenant_id", tenantId);
  if (error) {
    console.warn(`[project-secrets] getProjectSecretTailsMap(${projectId}) failed:`, error.message);
    return {};
  }
  const out: Record<string, string> = {};
  for (const row of data ?? []) {
    let plaintext: string | null = null;
    try {
      plaintext = decryptColumns(
        (row as { value_encrypted?: unknown }).value_encrypted,
        (row as { value_iv?: unknown }).value_iv,
      );
    } catch {
      // Missing/invalid master key or corrupt row — skip (tolerant read).
      plaintext = null;
    }
    if (plaintext) out[String((row as { secret_key: unknown }).secret_key)] = last4(plaintext);
  }
  return out;
}

export type EnvCatalogEntry = {
  key: string;
  required: boolean;
  description: string | null;
};

function isEnvCatalogEntry(v: unknown): v is EnvCatalogEntry {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { key?: unknown }).key === "string" &&
    typeof (v as { required?: unknown }).required === "boolean"
  );
}

/** The project's declared env catalog (`projects.env_catalog`), written by the
 *  runner on each localhost start. Empty array until the project has been run
 *  on localhost at least once (or has no `.env.example`).
 *
 *  `tenantId` is REQUIRED, not optional: this is a service-role read (RLS off)
 *  keyed on a caller-supplied `projectId`, and from PR 3 its result decides
 *  which variable NAMES are offered for push to a Vercel deploy target. The
 *  co-located predicate is the boundary. Optional is what callers forget. */
export async function loadProjectEnvCatalog(
  projectId: string,
  tenantId: string,
): Promise<EnvCatalogEntry[]> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("projects")
    .select("env_catalog")
    .eq("id", projectId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data) return [];
  const raw = (data as { env_catalog?: unknown }).env_catalog;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isEnvCatalogEntry).map((e) => ({
    key: e.key,
    required: e.required,
    description: typeof e.description === "string" ? e.description : null,
  }));
}

export type ConfiguredSecret = {
  key: string;
  /** Masked tail (last ≤4 chars). Null when the value is empty. */
  tail: string | null;
  updatedAt: string;
};

export type ProjectSecretsOverview = {
  configured: ConfiguredSecret[];
  catalog: EnvCatalogEntry[];
};

/** One-shot fetch for the Secrets card: which secrets are set (with masked
 *  tails) + the project's declared env catalog. Merged client-side into rows. */
export async function loadProjectSecretsOverview(
  projectId: string,
  tenantId: string,
): Promise<ProjectSecretsOverview> {
  const [names, tails, catalog] = await Promise.all([
    listProjectSecretNames(projectId, tenantId),
    getProjectSecretTailsMap(projectId, tenantId),
    loadProjectEnvCatalog(projectId, tenantId),
  ]);
  const configured: ConfiguredSecret[] = names.map((n) => ({
    key: n.secretKey,
    tail: tails[n.secretKey] ?? null,
    updatedAt: n.updatedAt,
  }));
  return { configured, catalog };
}
