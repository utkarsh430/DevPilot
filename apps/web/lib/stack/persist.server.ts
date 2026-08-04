// Phase 2.5++ / WI-15 — read/write `public.project_stack_tags`.
//
// The single seam between the catalog and the DB. Two invariants live here and
// nowhere else:
//
//   1. **`tenant_id` comes from the verified caller.** These writes go through
//      the SERVICE ROLE, which bypasses RLS entirely — the row-level policies
//      on the table protect member-facing reads, not this path. The caller
//      passes the tenantId it got from `requireTenantId()`; a tenantId from a
//      form body would be an authorization hole with an RLS-shaped fig leaf
//      over it.
//   2. **Only catalog keys land, and the LABEL is the catalog's.** Both the
//      write and the read re-derive every tag through `toCatalogEntries`, so a
//      key that isn't in the catalog (a hand-crafted form post, a row left
//      behind by a since-deleted catalog entry) is dropped rather than carried
//      toward a prompt.
//
// Stage 4 (stack advisor) adds a second write/read pair on the same table -
// `persistStackSelection`/`loadStackSelection` - scoped to the `capability IS
// NOT NULL` rows only. Same two invariants apply: tenantId from the verified
// caller, and every capability/service key re-validated through the catalog
// gates (`getCapability`/`getServiceEntry`) regardless of what the caller
// (ultimately, model output) claims.

import { supabaseService } from "@/lib/db/server";
import { toCatalogEntries } from "@/lib/stack/detect-stack-tags";
import { getServiceEntry } from "@/lib/stack/service-catalog";
import { getCapability, type CapabilityEntry, type CapabilityKey } from "@/lib/stack/capabilities";
import type { ServiceCatalogEntry } from "@/lib/stack/service-catalog";
import type { StackTag, StackTagInput, StackTagSource } from "@/lib/plan/types";

/**
 * Normalise an untrusted `{serviceKey, source}[]` (straight off the create
 * form) into rows. Unknown keys are dropped; duplicates collapse to the first
 * occurrence; the label is taken from the catalog, never from the caller.
 */
export function toStackTags(input: readonly StackTagInput[]): StackTag[] {
  const sourceByKey = new Map<string, StackTagSource>();
  for (const item of input) {
    if (!sourceByKey.has(item.serviceKey)) sourceByKey.set(item.serviceKey, item.source);
  }
  return toCatalogEntries([...sourceByKey.keys()]).map((entry) => ({
    provider: entry.provider,
    serviceKey: entry.key,
    label: entry.displayName,
    source: sourceByKey.get(entry.key) ?? "manual",
  }));
}

/**
 * Insert the project's stack tags. Best-effort: a failure here logs and
 * returns false rather than failing the project create — the repo and the
 * project row already exist on GitHub and in Postgres by the time we get here,
 * and the operator can re-pick the stack later. Never throws.
 */
export async function insertProjectStackTags(args: {
  tenantId: string;
  projectId: string;
  tags: readonly StackTag[];
}): Promise<boolean> {
  if (args.tags.length === 0) return true;
  const supabase = supabaseService();
  const { error } = await supabase.from("project_stack_tags").insert(
    args.tags.map((t) => ({
      // Authoritative, from `requireTenantId()` — never from the submitted form.
      tenant_id: args.tenantId,
      project_id: args.projectId,
      provider: t.provider,
      service_key: t.serviceKey,
      label: t.label,
      source: t.source,
    })),
  );
  if (error) {
    console.warn(
      `[stack-tags] insert failed for project ${args.projectId}: ${error.message}. ` +
        "Project was created without stack tags; the operator can re-pick them.",
    );
    return false;
  }
  return true;
}

/**
 * Replace the project's EXTRA (`capability IS NULL`) tags in one shot —
 * delete-then-insert, same contract as `persistStackSelection` below, but
 * scoped to the opposite partition of the table. This is the persistence
 * behind the stack advisor panel's "Advanced: extra services" disclosure
 * (`StackTagPicker`, post-creation edits): everything the operator ticks
 * there is a manually-picked service outside the capability taxonomy, so
 * `source` is always `"manual"`. Never touches capability-keyed rows.
 */
export async function replaceExtraStackTags(args: {
  tenantId: string;
  projectId: string;
  serviceKeys: readonly string[];
}): Promise<boolean> {
  const supabase = supabaseService();
  const { error: deleteError } = await supabase
    .from("project_stack_tags")
    .delete()
    .eq("tenant_id", args.tenantId)
    .eq("project_id", args.projectId)
    .is("capability", null);
  if (deleteError) {
    console.warn(
      `[stack-tags] replaceExtraStackTags delete failed for project ${args.projectId}: ${deleteError.message}.`,
    );
    return false;
  }
  const tags = toStackTags(
    args.serviceKeys.map((serviceKey) => ({ serviceKey, source: "manual" as const })),
  );
  if (tags.length === 0) return true;
  return insertProjectStackTags({ tenantId: args.tenantId, projectId: args.projectId, tags });
}

/**
 * Load a project's stack tags for the plan prompt. Tenant-scoped even though
 * the service role bypasses RLS — an unscoped read keyed on project_id alone is
 * exactly the cross-tenant leak the denormalized column exists to prevent.
 *
 * Includes the stack-advisor `capability`/`overridden` fields (Stage 4) so a
 * later stage's plan-frame rewrite can read them without a second seam - this
 * stays the ONE loader `loadProjectContext` calls.
 */
export async function loadProjectStackTags(args: {
  tenantId: string;
  projectId: string;
}): Promise<StackTag[]> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("project_stack_tags")
    .select("provider, service_key, label, source, capability")
    .eq("tenant_id", args.tenantId)
    .eq("project_id", args.projectId);
  if (error || !data) return [];
  const tags: StackTag[] = [];
  for (const row of data) {
    // Re-derive through the catalog: the stored `label` is a denormalized
    // convenience for SQL consumers, and a row whose key has since left the
    // catalog must not render at all.
    const entry = getServiceEntry(row.service_key as string);
    if (!entry) continue;
    const source = (row.source as StackTagSource) ?? "manual";
    const capabilityKey = row.capability as string | null;
    const capability = capabilityKey ? getCapability(capabilityKey) : undefined;
    tags.push({
      provider: entry.provider,
      serviceKey: entry.key,
      label: entry.displayName,
      source,
      capability: capability ? capability.key : null,
      overridden: source === "user_override",
    });
  }
  return tags;
}

// ─── Stack advisor (Stage 4): the capability-keyed selection ──────────────
//
// A SECOND write/read pair on the same table, scoped to `capability IS NOT
// NULL` rows only - the advisor's durable selection, one row per capability
// per project (D6, enforced by the partial unique index in migration
// 20260722000000). Rows with `capability IS NULL` (pre-advisor tags, the
// manual picker's "extra services") are never touched by either function.

export type StackSelectionInput = {
  /** Validated through getCapability() below; an unknown key is dropped. */
  capability: CapabilityKey;
  /** Validated through getServiceEntry() below; an unknown key is dropped. */
  serviceKey: string;
  /** What the ranker recommended for this capability, so we can record
   *  whether the operator swapped. Equal to `serviceKey` when they took the
   *  recommendation. */
  recommendedServiceKey: string;
};

/**
 * Replace the project's CAPABILITY-KEYED rows in one shot (delete-then-insert,
 * matching WI-15's "re-writes the whole set on save" contract). Rows with
 * `capability IS NULL` are left alone - this never touches the manual
 * picker's tags. `tenantId` from `requireTenantId()`, never the form. Every
 * key is re-validated through the catalog gates regardless of what the
 * (model-influenced) caller claims; an unknown capability or service key is
 * dropped, not stored. Best-effort: a failure here logs and returns false
 * rather than throwing - same posture as `insertProjectStackTags`.
 */
export async function persistStackSelection(args: {
  tenantId: string;
  projectId: string;
  selections: readonly StackSelectionInput[];
  /**
   * Provenance for every row written by THIS call. Omitted (the advisor panel's
   * "Save stack") = derive it from whether the operator swapped away from the
   * ranker's recommendation. `"detected"` is the import bridge (Stage 8): the
   * repo's own manifests chose these services, not the model and not a swap, so
   * neither `ai_suggested` nor `user_override` would be true. The DB `source`
   * CHECK already allows all four values.
   */
  source?: "detected";
}): Promise<boolean> {
  const supabase = supabaseService();

  const rows = args.selections.flatMap((sel) => {
    const capability = getCapability(sel.capability);
    const service = getServiceEntry(sel.serviceKey);
    if (!capability || !service) return [];
    const recommendedEntry = getServiceEntry(sel.recommendedServiceKey);
    const overridden = recommendedEntry !== undefined && recommendedEntry.key !== service.key;
    return [
      {
        tenant_id: args.tenantId,
        project_id: args.projectId,
        provider: service.provider,
        service_key: service.key,
        label: service.displayName,
        source: args.source ?? (overridden ? "user_override" : "ai_suggested"),
        capability: capability.key,
        recommended_service_key: overridden ? recommendedEntry.key : null,
      },
    ];
  });

  const { error: deleteError } = await supabase
    .from("project_stack_tags")
    .delete()
    .eq("tenant_id", args.tenantId)
    .eq("project_id", args.projectId)
    .not("capability", "is", null);
  if (deleteError) {
    console.warn(
      `[stack-tags] persistStackSelection delete-before-replace failed for project ${args.projectId}: ${deleteError.message}.`,
    );
    return false;
  }
  if (rows.length === 0) return true;

  const { error: insertError } = await supabase.from("project_stack_tags").insert(rows);
  if (insertError) {
    console.warn(
      `[stack-tags] persistStackSelection insert failed for project ${args.projectId}: ${insertError.message}.`,
    );
    return false;
  }
  return true;
}

/** Read the capability-keyed selection back, catalog-normalised. A stale
 *  capability or service key (either has since left the catalog) drops the
 *  row rather than rendering it. */
export async function loadStackSelection(args: {
  tenantId: string;
  projectId: string;
}): Promise<
  Array<{ capability: CapabilityEntry; service: ServiceCatalogEntry; overridden: boolean }>
> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("project_stack_tags")
    .select("capability, service_key, source")
    .eq("tenant_id", args.tenantId)
    .eq("project_id", args.projectId)
    .not("capability", "is", null);
  if (error || !data) return [];

  const results: Array<{
    capability: CapabilityEntry;
    service: ServiceCatalogEntry;
    overridden: boolean;
  }> = [];
  for (const row of data) {
    const capability = getCapability(row.capability as string);
    const service = getServiceEntry(row.service_key as string);
    if (!capability || !service) continue;
    results.push({
      capability,
      service,
      overridden: (row.source as string) === "user_override",
    });
  }
  results.sort((a, b) => a.capability.order - b.capability.order);
  return results;
}
